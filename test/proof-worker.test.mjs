import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder } from "ethers";
import {
  ExpiringCache,
  RuleDropWorker,
  SEPOLIA_CHAIN_KEY,
  WorkerError,
  decodeAttestedTransaction,
  serializeCampaign,
  toContractBatchProof,
  validateTransactionHash,
} from "../src/proof-worker.mjs";
import { poolAbiV2 } from "../src/pool-abi.mjs";

const POOL = "0x6f8dE7e1599A0c8D38eB25996cB841a4920ed999";
const CLAIMANT = "0xbad35FA6e368e90fC4faf63507F2D0A2Fdf94BAF";
const TX_HASH = `0x${"ab".repeat(32)}`;
const RETRY_TX_HASH = `0x${"cd".repeat(32)}`;
const TARGET = "0x1111111111111111111111111111111111111111";
const abiCoder = AbiCoder.defaultAbiCoder();
const ABI = [
  "function registerClaim(uint256 campaignId,(uint64 sourceBlock,bytes encodedTransaction,bytes32 merkleRoot,(bytes32 hash,bool isLeft)[] siblings,bytes32 lowerEndpointDigest,bytes32[] continuityRoots) proof)",
];

test("validates transaction hashes", () => {
  assert.equal(validateTransactionHash(TX_HASH.toUpperCase().replace("0X", "0x")), TX_HASH);
  assert.throws(() => validateTransactionHash("0x1234"), (error) => error.code === "INVALID_TRANSACTION_HASH");
});

test("cache evicts the least recently used entry", () => {
  const cache = new ExpiringCache({ maxEntries: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
});

test("serializes campaign state for the frontend", () => {
  const campaign = campaignFixture();
  const result = serializeCampaign(campaign, 1, 1_786_000_000);
  assert.equal(result.minimumAmountUsdc, "1000.0");
  assert.equal(result.fundedPoolTctc, "10.0");
  assert.equal(result.registrationOpen, true);
});

test("proof retries and caches a successful response", async () => {
  let calls = 0;
  const proof = proofFixture();
  const worker = makeWorker({
    proofBuilder: {
      async getProof() {
        calls += 1;
        if (calls === 1) throw new Error("temporary failure");
        return { success: true, data: proof };
      },
    },
  });
  assert.equal(await worker.getProof(TX_HASH), proof);
  assert.equal(await worker.getProof(TX_HASH), proof);
  assert.equal(calls, 2);
});

test("proof failure returns a stable service error", async () => {
  const worker = makeWorker({ proofAttempts: 1, proofBuilder: { async getProof() { throw new Error("offline"); } } });
  await assert.rejects(worker.getProof(TX_HASH), (error) => {
    assert.equal(error.code, "PROOF_UNAVAILABLE");
    assert.equal(error.status, 503);
    return true;
  });
});

test("decodes only safe metadata from an Attestcoin encoded transaction", () => {
  const encoded = encodedTransactionFixture({ status: 0, nonce: 8n });
  const result = decodeAttestedTransaction(encoded);
  assert.deepEqual(result, {
    transactionType: 2,
    nonce: "8",
    gasLimit: "100000",
    sender: CLAIMANT,
    target: TARGET,
    value: "0",
    selector: "0x12345678",
    calldataHash: "0x30ca65d5da355227c97ff836c9c6719af9d3835fc6bc72bddc50eeecc1bb2b25",
    receiptStatus: 0,
    receiptGasUsed: "50000",
    logCount: 0,
  });
  assert.equal("data" in result, false);
  assert.equal("logs" in result, false);
});

test("builds and caches a validated failed-then-successful batch proof", async () => {
  let calls = 0;
  const worker = makeWorker({
    proofBuilder: {
      async getBatchProof(hashes) {
        calls += 1;
        assert.deepEqual(hashes, [TX_HASH, RETRY_TX_HASH]);
        return { success: true, data: batchProofFixture() };
      },
    },
  });

  const first = await worker.getRetryBatchProof({
    failedTransactionHash: TX_HASH,
    successfulTransactionHash: RETRY_TX_HASH,
  });
  const second = await worker.getRetryBatchProof({
    failedTransactionHash: TX_HASH,
    successfulTransactionHash: RETRY_TX_HASH,
  });
  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(first.summary.failed.receiptStatus, 0);
  assert.equal(first.summary.successful.receiptStatus, 1);
  assert.equal(first.summary.failed.sender, CLAIMANT);
  assert.equal(first.summary.successful.target, TARGET);
  assert.equal(first.summary.blockSpan, 1);
  assert.equal(first.summary.continuityRootCount, 2);

  const contractProof = toContractBatchProof(first);
  assert.deepEqual(contractProof.sourceBlocks, [25_000_000, 25_000_001]);
  assert.equal(contractProof.encodedTransactions.length, 2);
  assert.equal(contractProof.merkleProofs.length, 2);
});

test("accepts a Sepolia batch only when the worker is bound to Sepolia", async () => {
  const worker = makeWorker({
    sourceChainKey: SEPOLIA_CHAIN_KEY,
    proofBuilder: {
      async getBatchProof() {
        return { success: true, data: batchProofFixture({ chainKey: SEPOLIA_CHAIN_KEY }) };
      },
    },
  });
  const proof = await worker.getRetryBatchProof({
    failedTransactionHash: TX_HASH,
    successfulTransactionHash: RETRY_TX_HASH,
  });
  assert.equal(proof.chainKey, SEPOLIA_CHAIN_KEY);
  assert.equal(proof.summary.sourceChainKey, SEPOLIA_CHAIN_KEY);
});

test("rejects a batch from a different Attestcoin source chain", async () => {
  const worker = makeWorker({
    sourceChainKey: SEPOLIA_CHAIN_KEY,
    proofAttempts: 1,
    proofBuilder: {
      async getBatchProof() {
        return { success: true, data: batchProofFixture() };
      },
    },
  });
  await assert.rejects(
    worker.getRetryBatchProof({ failedTransactionHash: TX_HASH, successfulTransactionHash: RETRY_TX_HASH }),
    (error) => error instanceof WorkerError && error.code === "BATCH_PROOF_INVALID",
  );
});

test("rejects duplicate hashes before requesting a batch proof", async () => {
  const worker = makeWorker();
  await assert.rejects(
    worker.getRetryBatchProof({ failedTransactionHash: TX_HASH, successfulTransactionHash: TX_HASH }),
    (error) => error instanceof WorkerError && error.code === "DUPLICATE_TRANSACTION_HASH",
  );
});

test("rejects a batch whose supposed retry also failed", async () => {
  const worker = makeWorker({
    proofAttempts: 1,
    proofBuilder: {
      async getBatchProof() {
        return { success: true, data: batchProofFixture({ retryStatus: 0 }) };
      },
    },
  });
  await assert.rejects(
    worker.getRetryBatchProof({ failedTransactionHash: TX_HASH, successfulTransactionHash: RETRY_TX_HASH }),
    (error) => error instanceof WorkerError && error.code === "BATCH_PROOF_INVALID",
  );
});

test("rejects a retry batch when exact-call identity or order diverges", async (context) => {
  const cases = [
    { name: "sender", overrides: { retrySender: "0x2222222222222222222222222222222222222222" } },
    { name: "target", overrides: { retryTarget: "0x2222222222222222222222222222222222222222" } },
    { name: "selector", overrides: { retryData: "0x87654321" } },
    { name: "calldata", overrides: { retryData: "0x1234567801" } },
    { name: "value", overrides: { retryValue: 1n } },
    { name: "nonce", overrides: { retryNonce: 10n } },
    { name: "order", overrides: { retryBlock: 24_999_999 } },
    { name: "same block", overrides: { retryBlock: 25_000_000, retryIndex: 4 } },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const worker = makeWorker({
        proofAttempts: 1,
        proofBuilder: { async getBatchProof() { return { success: true, data: batchProofFixture(scenario.overrides) }; } },
      });
      await assert.rejects(
        worker.getRetryBatchProof({ failedTransactionHash: TX_HASH, successfulTransactionHash: RETRY_TX_HASH }),
        (error) => error instanceof WorkerError && error.code === "BATCH_PROOF_INVALID",
      );
    });
  }
});

test("Ethereum lookup falls back to the next RPC", async () => {
  const expected = { transaction: { hash: TX_HASH }, receipt: { status: 1 } };
  const first = { async getNetwork() { throw new Error("offline"); } };
  const second = {
    async getNetwork() { return { chainId: 1n }; },
    async getTransaction() { return expected.transaction; },
    async getTransactionReceipt() { return expected.receipt; },
  };
  const worker = makeWorker({ ethereumProviders: [first, second] });
  assert.deepEqual(await worker.fetchSourceTransaction(TX_HASH), expected);
});

test("prepareClaim only returns calldata after onchain simulation passes", async () => {
  const proof = proofFixture();
  const poolContract = poolFixture();
  const worker = makeWorker({
    poolContract,
    proofBuilder: { async getProof() { return { success: true, data: proof }; } },
  });
  const result = await worker.prepareClaim({ campaignId: 1, transactionHash: TX_HASH, claimant: CLAIMANT });
  assert.equal(result.simulationPassed, true);
  assert.equal(result.transaction.from, CLAIMANT);
  assert.equal(result.transaction.value, "0x0");
  assert.equal(poolContract.simulationCalls, 1);
});

test("prepareClaim exposes deterministic simulation rejection", async () => {
  const poolContract = poolFixture();
  poolContract.registerClaim.staticCall = async () => {
    const error = new Error("reverted");
    error.revert = { name: "ClaimantMismatch" };
    throw error;
  };
  const worker = makeWorker({
    poolContract,
    proofBuilder: { async getProof() { return { success: true, data: proofFixture() }; } },
  });
  await assert.rejects(
    worker.prepareClaim({ campaignId: 1, transactionHash: TX_HASH, claimant: CLAIMANT }),
    (error) => error instanceof WorkerError && error.code === "CLAIM_SIMULATION_REJECTED" && error.message === "ClaimantMismatch",
  );
});

test("prepareClaim routes an interaction campaign through its dedicated registration function", async () => {
  const poolContract = interactionPoolFixture();
  const worker = makeWorker({
    poolAbi: poolAbiV2,
    poolContract,
    proofBuilder: { async getProof() { return { success: true, data: proofFixture() }; } },
  });

  const result = await worker.prepareClaim({ campaignId: 2, transactionHash: TX_HASH, claimant: CLAIMANT });
  assert.equal(result.campaign.claimTemplateName, "contract-interaction");
  assert.equal(result.campaign.interactionRule.selector, "0x12345678");
  assert.equal(poolContract.interactionSimulationCalls, 1);
  assert.match(result.transaction.data, /^0x/);
});

test("latest campaign follows the onchain campaign counter", async () => {
  const poolContract = poolFixture();
  poolContract.campaignCount = async () => 2n;
  let requestedId;
  poolContract.getCampaign = async (campaignId) => {
    requestedId = campaignId;
    return campaignFixture();
  };
  const worker = makeWorker({ poolContract });
  const campaign = await worker.getLatestCampaign();
  assert.equal(requestedId, 2);
  assert.equal(campaign.id, 2);
});

function makeWorker(overrides = {}) {
  return new RuleDropWorker({
    poolAddress: POOL,
    poolAbi: ABI,
    proofBuilder: { async getProof() { return { success: true, data: proofFixture() }; } },
    poolContract: poolFixture(),
    creditcoinProvider: {},
    proofAttempts: 2,
    ...overrides,
  });
}

function poolFixture() {
  const fixture = {
    simulationCalls: 0,
    async getCampaign() { return campaignFixture(); },
    async registered() { return false; },
    async withdrawn() { return false; },
    registerClaim: {
      staticCall: async () => { fixture.simulationCalls += 1; },
    },
  };
  return fixture;
}

function interactionPoolFixture() {
  const fixture = {
    interactionSimulationCalls: 0,
    async getCampaign() {
      return {
        ...campaignFixture(),
        maximumWeight: 0n,
        totalWeight: 0n,
        totalPaid: 0n,
        claimTemplate: 1n,
        payoutPolicy: 0n,
      };
    },
    async getInteractionRule() {
      return {
        target: "0x1111111111111111111111111111111111111111",
        selector: "0x12345678",
        requiredEventEmitter: "0x1111111111111111111111111111111111111111",
        requiredEventSignature: `0x${"33".repeat(32)}`,
        claimantTopicIndex: 1n,
        startBlock: 25_049_872n,
        endBlock: 25_049_872n,
      };
    },
    async registered() { return false; },
    async withdrawn() { return false; },
    registerInteractionClaim: {
      staticCall: async () => { fixture.interactionSimulationCalls += 1; },
    },
  };
  return fixture;
}

function campaignFixture() {
  return {
    sponsor: "0x813C4BF413BeeA09a7f61450Bd9a9Fa321ED25Db",
    recipient: "0x9fEAcC0d3BC179B6022B4aAf96F7a8217F422642",
    minimumAmount: 1_000_000_000n,
    startBlock: 25_049_872n,
    endBlock: 25_049_872n,
    registrationDeadline: 4_102_444_800n,
    withdrawalDeadline: 4_102_531_200n,
    fundedPool: 10_000_000_000_000_000_000n,
    claimantCount: 1n,
    sharePerClaim: 0n,
    withdrawnCount: 0n,
    finalized: false,
  };
}

function proofFixture() {
  return {
    headerNumber: 25_049_872,
    txBytes: "0x1234",
    merkleProof: { root: `0x${"11".repeat(32)}`, siblings: [] },
    continuityProof: { lowerEndpointDigest: `0x${"22".repeat(32)}`, roots: [] },
  };
}

function batchProofFixture({
  chainKey = 3,
  retryStatus = 1,
  retrySender = CLAIMANT,
  retryTarget = TARGET,
  retryData = "0x12345678",
  retryValue = 0n,
  retryNonce = 9n,
  retryBlock = 25_000_001,
  retryIndex = 1,
} = {}) {
  const failureBlock = 25_000_000;
  const failureEntry = {
    txHash: TX_HASH,
    txBytes: encodedTransactionFixture({ status: 0, nonce: 8n }),
    merkleProof: { root: `0x${"55".repeat(32)}`, siblings: [] },
  };
  const retryEntry = {
    txHash: RETRY_TX_HASH,
    txBytes: encodedTransactionFixture({
      status: retryStatus,
      nonce: retryNonce,
      sender: retrySender,
      target: retryTarget,
      data: retryData,
      value: retryValue,
    }),
    merkleProof: { root: `0x${"66".repeat(32)}`, siblings: [] },
  };
  const merkleProofs = retryBlock === failureBlock
    ? new Map([[failureBlock, new Map([[3, failureEntry], [retryIndex, retryEntry]])]])
    : new Map([
      [failureBlock, new Map([[3, failureEntry]])],
      [retryBlock, new Map([[retryIndex, retryEntry]])],
    ]);
  return {
    chainKey,
    fromHeader: Math.min(failureBlock, retryBlock),
    toHeader: Math.max(failureBlock, retryBlock),
    continuityProof: {
      lowerEndpointDigest: `0x${"22".repeat(32)}`,
      roots: [`0x${"33".repeat(32)}`, `0x${"44".repeat(32)}`],
    },
    merkleProofs,
    cached: false,
    generatedAt: new Date("2026-08-20T00:00:00Z"),
  };
}

function encodedTransactionFixture({
  status,
  nonce,
  sender = CLAIMANT,
  target = TARGET,
  data = "0x12345678",
  value = 0n,
}) {
  const common = abiCoder.encode(
    ["uint64", "uint64", "address", "bool", "address", "uint256", "bytes"],
    [nonce, 100_000n, sender, false, target, value, data],
  );
  const typeSpecific = abiCoder.encode(
    ["uint64", "uint128", "uint128", "tuple(address account,bytes32[] storageKeys)[]", "uint8", "bytes32", "bytes32"],
    [1n, 1n, 2n, [], 0, `0x${"77".repeat(32)}`, `0x${"88".repeat(32)}`],
  );
  const receipt = abiCoder.encode(
    ["uint8", "uint64", "tuple(address address_,bytes32[] topics,bytes data)[]", "bytes"],
    [status, 50_000n, [], "0x"],
  );
  return abiCoder.encode(["uint8", "bytes[]"], [2, [common, typeSpecific, receipt]]);
}
