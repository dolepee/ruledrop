import assert from "node:assert/strict";
import test from "node:test";
import {
  AbiCoder,
  Interface,
  SigningKey,
  Signature,
  TypedDataEncoder,
  computeAddress,
  id,
  keccak256,
  zeroPadValue,
} from "ethers";
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
const RETRY_CREDIT_POOL = "0x4444444444444444444444444444444444444444";
const RETRY_CREDIT_VERIFIER = "0x5555555555555555555555555555555555555555";
const RETRY_CREDIT_PREDICATE = "0x6666666666666666666666666666666666666666";
const CLAIMANT = "0xbad35FA6e368e90fC4faf63507F2D0A2Fdf94BAF";
const TX_HASH = `0x${"ab".repeat(32)}`;
const RETRY_TX_HASH = `0x${"cd".repeat(32)}`;
const TARGET = "0x1111111111111111111111111111111111111111";
const SETTLEMENT_ASSET = "0x2222222222222222222222222222222222222222";
const SETTLEMENT_RECIPIENT = "0x3333333333333333333333333333333333333333";
const POLICY_ID = `0x${"44".repeat(32)}`;
const ACTION_ID = `0x${"55".repeat(32)}`;
const ATTEMPT_SIGNER_KEY = `0x${"11".repeat(32)}`;
const ATTEMPT_SIGNER = computeAddress(new SigningKey(ATTEMPT_SIGNER_KEY).publicKey);
const CHECKOUT_ABI = [
  "function checkout((uint256 sourceChainId,address target,address beneficiary,address settlementAsset,address settlementRecipient,bytes32 policyId,bytes32 actionId,uint64 quoteVersion,uint256 settledValue,bytes32 payloadHash,uint64 validUntil) attempt,bytes payload,bytes attemptSignature)",
];
const RETRY_CREDIT_RELEASE_ABI = [
  "function releaseCredit(uint256 serviceCreditNumber,(uint64[] sourceBlocks,bytes[] encodedTransactions,(bytes32 root,(bytes32 hash,bool isLeft)[] siblings)[] merkleProofs,bytes32 lowerEndpointDigest,bytes32[] continuityRoots) proof)",
];
const checkoutInterface = new Interface(CHECKOUT_ABI);
const retryCreditReleaseInterface = new Interface(RETRY_CREDIT_RELEASE_ABI);
const checkoutSettledEvent = id("CheckoutSettled(bytes32,bytes32,address,address,address,uint256,bytes32,uint64)");
const transferEvent = id("Transfer(address,address,uint256)");
const retryCreditTypes = {
  Attempt: [
    { name: "sourceChainId", type: "uint256" },
    { name: "target", type: "address" },
    { name: "beneficiary", type: "address" },
    { name: "settlementAsset", type: "address" },
    { name: "settlementRecipient", type: "address" },
    { name: "policyId", type: "bytes32" },
    { name: "actionId", type: "bytes32" },
    { name: "quoteVersion", type: "uint64" },
    { name: "settledValue", type: "uint256" },
    { name: "payloadHash", type: "bytes32" },
    { name: "validUntil", type: "uint64" },
  ],
};
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

test("builds and caches a validated signed RetryCredit batch proof", async () => {
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

  const first = await worker.getRetryCreditBatchProof({
    failedTransactionHash: TX_HASH,
    successfulTransactionHash: RETRY_TX_HASH,
    serviceCreditNumber: 1,
  });
  const second = await worker.getRetryCreditBatchProof({
    failedTransactionHash: TX_HASH,
    successfulTransactionHash: RETRY_TX_HASH,
    serviceCreditNumber: 1,
  });
  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(first.summary.failed.receiptStatus, 0);
  assert.equal(first.summary.successful.receiptStatus, 1);
  assert.equal(first.summary.failed.sender, CLAIMANT);
  assert.equal(first.summary.successful.target, TARGET);
  assert.equal(first.summary.failed.retryCredit.actionId, ACTION_ID);
  assert.equal(first.summary.successful.retryCredit.quoteVersion, 2);
  assert.equal(first.summary.successful.retryCredit.recoveredAttemptSigner, ATTEMPT_SIGNER);
  assert.equal(first.summary.blockSpan, 1);
  assert.equal(first.summary.continuityRootCount, 2);

  const contractProof = toContractBatchProof(first);
  assert.deepEqual(contractProof.sourceBlocks, [25_000_000, 25_000_001]);
  assert.equal(contractProof.encodedTransactions.length, 2);
  assert.equal(contractProof.merkleProofs.length, 2);
  assert.equal(contractProof.lowerEndpointDigest, `0x${"22".repeat(32)}`);
  assert.deepEqual(contractProof.continuityRoots, [`0x${"33".repeat(32)}`, `0x${"44".repeat(32)}`]);
  assert.equal("chainKey" in contractProof, false);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.entries), true);
  assert.throws(() => { first.entries[0].sourceBlock = 1; }, TypeError);
});

test("revalidates a cached proof against the latest authenticated funded rule", async () => {
  let calls = 0;
  const fundedRule = retryCreditRuleFixture();
  const worker = makeWorker({
    retryCreditPoolContract: retryCreditPoolFixture({ rule: fundedRule }),
    proofBuilder: {
      async getBatchProof() {
        calls += 1;
        return { success: true, data: batchProofFixture() };
      },
    },
  });
  await worker.getRetryCreditBatchProof({
    failedTransactionHash: TX_HASH,
    successfulTransactionHash: RETRY_TX_HASH,
    serviceCreditNumber: 1,
  });
  fundedRule.actionId = `0x${"77".repeat(32)}`;
  await assert.rejects(
    worker.getRetryCreditBatchProof({
      failedTransactionHash: TX_HASH,
      successfulTransactionHash: RETRY_TX_HASH,
      serviceCreditNumber: 1,
    }),
    (error) => error instanceof WorkerError && error.code === "BATCH_PROOF_INVALID",
  );
  assert.equal(calls, 1);
});

test("prepares executable RetryCredit calldata only after native release simulation passes", async () => {
  const retryCreditPoolContract = retryCreditPoolFixture();
  const worker = makeWorker({
    retryCreditPoolContract,
    proofBuilder: { async getBatchProof() { return { success: true, data: batchProofFixture() }; } },
  });
  const result = await worker.prepareRetryCreditRelease({
    serviceCreditNumber: 1,
    failedTransactionHash: TX_HASH,
    successfulTransactionHash: RETRY_TX_HASH,
    relayer: CLAIMANT,
  });
  assert.equal(result.simulationPassed, true);
  assert.equal(result.poolAddress, RETRY_CREDIT_POOL);
  assert.equal(result.transaction.from, CLAIMANT);
  assert.equal(result.transaction.to, RETRY_CREDIT_POOL);
  assert.equal(result.transaction.value, "0x0");
  assert.equal(retryCreditPoolContract.simulationCalls, 1);
  const decoded = retryCreditReleaseInterface.decodeFunctionData("releaseCredit", result.transaction.data);
  assert.equal(decoded.serviceCreditNumber, 1n);
  assert.deepEqual(Array.from(decoded.proof.sourceBlocks, Number), [25_000_000, 25_000_001]);
});

test("does not return RetryCredit calldata when native release simulation rejects", async () => {
  const simulationError = new Error("reverted");
  simulationError.revert = { name: "Replay" };
  const worker = makeWorker({
    retryCreditPoolContract: retryCreditPoolFixture({ simulationError }),
    proofBuilder: { async getBatchProof() { return { success: true, data: batchProofFixture() }; } },
  });
  await assert.rejects(
    worker.prepareRetryCreditRelease({
      serviceCreditNumber: 1,
      failedTransactionHash: TX_HASH,
      successfulTransactionHash: RETRY_TX_HASH,
      relayer: CLAIMANT,
    }),
    (error) => error instanceof WorkerError
      && error.code === "RETRY_CREDIT_SIMULATION_REJECTED"
      && error.message === "Replay",
  );
});

test("rejects a zero RetryCredit relayer before building or simulating a proof", async () => {
  let calls = 0;
  const retryCreditPoolContract = retryCreditPoolFixture();
  const worker = makeWorker({
    retryCreditPoolContract,
    proofBuilder: { async getBatchProof() { calls += 1; return { success: true, data: batchProofFixture() }; } },
  });
  await assert.rejects(
    worker.prepareRetryCreditRelease({
      serviceCreditNumber: 1,
      failedTransactionHash: TX_HASH,
      successfulTransactionHash: RETRY_TX_HASH,
      relayer: "0x0000000000000000000000000000000000000000",
    }),
    (error) => error instanceof WorkerError && error.code === "INVALID_ADDRESS",
  );
  assert.equal(calls, 0);
  assert.equal(retryCreditPoolContract.simulationCalls, 0);
});

test("rejects unauthenticated RetryCredit pool or verifier chain bindings before proof construction", async (context) => {
  const cases = [
    {
      name: "pool address",
      overrides: {
        retryCreditPoolContract: {
          ...retryCreditPoolFixture(),
          target: "0x7777777777777777777777777777777777777777",
        },
      },
    },
    {
      name: "pool source key",
      overrides: { retryCreditPoolContract: retryCreditPoolFixture({ sourceChainKey: 4 }) },
    },
    {
      name: "verifier source ID",
      overrides: { retryCreditVerifierContract: retryCreditVerifierFixture({ sourceChainId: 11_155_111 }) },
    },
    {
      name: "verifier address",
      overrides: {
        retryCreditVerifierContract: {
          ...retryCreditVerifierFixture(),
          target: "0x7777777777777777777777777777777777777777",
        },
      },
    },
    {
      name: "verifier predicate",
      overrides: {
        retryCreditVerifierContract: {
          ...retryCreditVerifierFixture(),
          async predicate() { return "0x7777777777777777777777777777777777777777"; },
        },
      },
    },
    {
      name: "native verifier",
      overrides: {
        retryCreditVerifierContract: {
          ...retryCreditVerifierFixture(),
          async verifier() { return "0x7777777777777777777777777777777777777777"; },
        },
      },
    },
    {
      name: "native chain info",
      overrides: {
        retryCreditPoolContract: {
          ...retryCreditPoolFixture(),
          async chainInfo() { return "0x7777777777777777777777777777777777777777"; },
        },
      },
    },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      let calls = 0;
      const worker = makeWorker({
        ...scenario.overrides,
        proofBuilder: { async getBatchProof() { calls += 1; return { success: true, data: batchProofFixture() }; } },
      });
      await assert.rejects(
        worker.getRetryCreditBatchProof({
          failedTransactionHash: TX_HASH,
          successfulTransactionHash: RETRY_TX_HASH,
          serviceCreditNumber: 1,
        }),
        (error) => error instanceof WorkerError && error.code === "RETRY_CREDIT_STATE_UNAVAILABLE",
      );
      assert.equal(calls, 0);
    });
  }
});

test("rejects malformed Merkle and continuity proof structures", async (context) => {
  const cases = [
    {
      name: "Merkle root",
      mutate(data) { data.merkleProofs.get(25_000_000).get(3).merkleProof.root = "0x12"; },
    },
    {
      name: "Merkle sibling",
      mutate(data) { data.merkleProofs.get(25_000_000).get(3).merkleProof.siblings = [{ hash: "0x12", isLeft: true }]; },
    },
    {
      name: "continuity endpoint",
      mutate(data) { data.continuityProof.lowerEndpointDigest = "0x12"; },
    },
    {
      name: "continuity root",
      mutate(data) { data.continuityProof.roots[0] = "0x12"; },
    },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const worker = makeWorker({
        proofAttempts: 1,
        proofBuilder: {
          async getBatchProof() {
            const data = batchProofFixture();
            scenario.mutate(data);
            return { success: true, data };
          },
        },
      });
      await assert.rejects(
        worker.getRetryCreditBatchProof({
          failedTransactionHash: TX_HASH,
          successfulTransactionHash: RETRY_TX_HASH,
          serviceCreditNumber: 1,
        }),
        (error) => error instanceof WorkerError && error.code === "BATCH_PROOF_INVALID",
      );
    });
  }
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
  const proof = await worker.getRetryCreditBatchProof({
    failedTransactionHash: TX_HASH,
    successfulTransactionHash: RETRY_TX_HASH,
    serviceCreditNumber: 1,
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
    worker.getRetryCreditBatchProof({
      failedTransactionHash: TX_HASH,
      successfulTransactionHash: RETRY_TX_HASH,
      serviceCreditNumber: 1,
    }),
    (error) => error instanceof WorkerError && error.code === "BATCH_PROOF_INVALID",
  );
});

test("rejects duplicate hashes before requesting a batch proof", async () => {
  const worker = makeWorker();
  await assert.rejects(
    worker.getRetryCreditBatchProof({
      failedTransactionHash: TX_HASH,
      successfulTransactionHash: TX_HASH,
      serviceCreditNumber: 1,
    }),
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
    worker.getRetryCreditBatchProof({
      failedTransactionHash: TX_HASH,
      successfulTransactionHash: RETRY_TX_HASH,
      serviceCreditNumber: 1,
    }),
    (error) => error instanceof WorkerError && error.code === "BATCH_PROOF_INVALID",
  );
});

test("rejects a RetryCredit batch when signed identity, economics, or order diverge", async (context) => {
  const cases = [
    { name: "sender", overrides: { retrySender: "0x4444444444444444444444444444444444444444" } },
    { name: "target", overrides: { retryTarget: "0x4444444444444444444444444444444444444444" } },
    { name: "selector", overrides: { retryData: "0x87654321" } },
    { name: "action", overrides: { retryAttemptOverrides: { actionId: `0x${"77".repeat(32)}` } } },
    { name: "asset", overrides: { retryAttemptOverrides: { settlementAsset: "0x4444444444444444444444444444444444444444" } } },
    { name: "recipient", overrides: { retryAttemptOverrides: { settlementRecipient: "0x4444444444444444444444444444444444444444" } } },
    { name: "signer", overrides: { retrySignerKey: `0x${"22".repeat(32)}` } },
    { name: "failure-legacy-v", overrides: { failureLegacyV: true } },
    { name: "retry-legacy-v", overrides: { retryLegacyV: true } },
    { name: "quote-version", overrides: { retryAttemptOverrides: { quoteVersion: 1n } } },
    {
      name: "payload-merchant",
      overrides: {
        retryAttemptOverrides: {
          payload: abiCoder.encode(
            ["address", "bytes32", "uint64"],
            ["0x4444444444444444444444444444444444444444", `0x${"66".repeat(32)}`, 2n],
          ),
        },
      },
    },
    {
      name: "payload-sku",
      overrides: {
        retryAttemptOverrides: {
          payload: abiCoder.encode(
            ["address", "bytes32", "uint64"],
            [SETTLEMENT_RECIPIENT, `0x${"77".repeat(32)}`, 2n],
          ),
        },
      },
    },
    {
      name: "payload-zero-sku",
      overrides: {
        retryAttemptOverrides: {
          payload: abiCoder.encode(
            ["address", "bytes32", "uint64"],
            [SETTLEMENT_RECIPIENT, `0x${"00".repeat(32)}`, 2n],
          ),
        },
      },
    },
    {
      name: "payload-version",
      overrides: {
        retryAttemptOverrides: {
          payload: abiCoder.encode(
            ["address", "bytes32", "uint64"],
            [SETTLEMENT_RECIPIENT, `0x${"66".repeat(32)}`, 3n],
          ),
        },
      },
    },
    {
      name: "payload-length",
      overrides: {
        retryAttemptOverrides: {
          payload: abiCoder.encode(["address", "bytes32"], [SETTLEMENT_RECIPIENT, `0x${"66".repeat(32)}`]),
        },
      },
    },
    { name: "expired", overrides: { retryAttemptOverrides: { validUntil: 24_999_999n } } },
    { name: "missing-transfer", overrides: { retryLogMode: "missing-transfer" } },
    { name: "duplicate-transfer", overrides: { retryLogMode: "duplicate-transfer" } },
    { name: "missing-event", overrides: { retryLogMode: "missing-event" } },
    { name: "value", overrides: { retryValue: 1n } },
    { name: "nonce", overrides: { retryNonce: 8n } },
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
        worker.getRetryCreditBatchProof({
          failedTransactionHash: TX_HASH,
          successfulTransactionHash: RETRY_TX_HASH,
          serviceCreditNumber: 1,
        }),
        (error) => error instanceof WorkerError && error.code === "BATCH_PROOF_INVALID",
      );
    });
  }
});

test("rejects a valid batch when it falls outside the exact funded RetryCredit rule", async (context) => {
  const cases = [
    { name: "attempt signer", rule: { attemptSigner: "0x4444444444444444444444444444444444444444" } },
    { name: "beneficiary", rule: { beneficiary: "0x4444444444444444444444444444444444444444" } },
    { name: "target", rule: { target: "0x4444444444444444444444444444444444444444" } },
    { name: "asset", rule: { settlementAsset: "0x4444444444444444444444444444444444444444" } },
    { name: "recipient", rule: { settlementRecipient: "0x4444444444444444444444444444444444444444" } },
    { name: "policy", rule: { policyId: `0x${"77".repeat(32)}` } },
    { name: "action", rule: { actionId: `0x${"77".repeat(32)}` } },
    { name: "minimum settlement", rule: { minimumSettledValue: 43_000_000n } },
    { name: "start block", rule: { startBlock: 25_000_001 } },
    { name: "end block", rule: { startBlock: 24_999_999, endBlock: 25_000_000 } },
    { name: "minimum gas limit", rule: { minimumAttemptGasLimit: 100_001n } },
    { name: "maximum failure gas", rule: { maxFailureGasUsed: 49_999n } },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const worker = makeWorker({
        proofAttempts: 1,
        proofBuilder: { async getBatchProof() { return { success: true, data: batchProofFixture() }; } },
        retryCreditPoolContract: retryCreditPoolFixture({ rule: retryCreditRuleFixture(scenario.rule) }),
      });
      await assert.rejects(
        worker.getRetryCreditBatchProof({
          failedTransactionHash: TX_HASH,
          successfulTransactionHash: RETRY_TX_HASH,
          serviceCreditNumber: 1,
        }),
        (error) => error instanceof WorkerError && error.code === "BATCH_PROOF_INVALID",
      );
    });
  }
});

test("rejects malformed funded RetryCredit rules before requesting a proof", async (context) => {
  const cases = [
    { name: "missing rule", rule: null },
    { name: "zero signer", rule: retryCreditRuleFixture({ attemptSigner: "0x0000000000000000000000000000000000000000" }) },
    { name: "self settlement", rule: retryCreditRuleFixture({ settlementRecipient: CLAIMANT }) },
    { name: "empty policy", rule: retryCreditRuleFixture({ policyId: `0x${"00".repeat(32)}` }) },
    { name: "empty action", rule: retryCreditRuleFixture({ actionId: `0x${"00".repeat(32)}` }) },
    { name: "zero minimum", rule: retryCreditRuleFixture({ minimumSettledValue: 0n }) },
    { name: "empty window", rule: retryCreditRuleFixture({ endBlock: 25_000_000 }) },
    { name: "zero gap", rule: retryCreditRuleFixture({ maxBlockGap: 0 }) },
    { name: "oversized gap", rule: retryCreditRuleFixture({ maxBlockGap: 1_001 }) },
    { name: "zero minimum gas", rule: retryCreditRuleFixture({ minimumAttemptGasLimit: 0n }) },
    { name: "zero failure gas", rule: retryCreditRuleFixture({ maxFailureGasUsed: 0n }) },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      let calls = 0;
      const worker = makeWorker({
        proofBuilder: { async getBatchProof() { calls += 1; return { success: true, data: batchProofFixture() }; } },
        retryCreditPoolContract: retryCreditPoolFixture({ rule: scenario.rule }),
      });
      await assert.rejects(
        worker.getRetryCreditBatchProof({
          failedTransactionHash: TX_HASH,
          successfulTransactionHash: RETRY_TX_HASH,
          serviceCreditNumber: 1,
        }),
        (error) => error instanceof WorkerError && error.code === "INVALID_RETRY_CREDIT_RULE",
      );
      assert.equal(calls, 0);
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
  const sourceChainKey = overrides.sourceChainKey ?? 3;
  const sourceChainId = overrides.sourceChainId ?? (sourceChainKey === SEPOLIA_CHAIN_KEY ? 11_155_111 : 1);
  const retryCreditPoolContract = overrides.retryCreditPoolContract
    ?? retryCreditPoolFixture({ sourceChainKey, sourceChainId });
  return new RuleDropWorker({
    poolAddress: POOL,
    poolAbi: ABI,
    proofBuilder: { async getProof() { return { success: true, data: proofFixture() }; } },
    poolContract: poolFixture(),
    creditcoinProvider: {},
    proofAttempts: 2,
    sourceChainKey,
    sourceChainId,
    retryCreditPoolAddress: RETRY_CREDIT_POOL,
    retryCreditPoolContract,
    retryCreditVerifierContract: retryCreditVerifierFixture({ sourceChainKey, sourceChainId }),
    ...overrides,
  });
}

function retryCreditPoolFixture({
  rule = retryCreditRuleFixture(),
  sourceChainKey = 3,
  sourceChainId = sourceChainKey === SEPOLIA_CHAIN_KEY ? 11_155_111 : 1,
  simulationError,
} = {}) {
  const fixture = {
    target: RETRY_CREDIT_POOL,
    simulationCalls: 0,
    async getRule() { return rule; },
    async getServiceCredit() {
      return {
        sponsor: "0x7777777777777777777777777777777777777777",
        creditAmount: 100_000_000_000_000_000n,
        refundAfter: 4_102_444_800n,
        creationBlock: 100n,
        termsHash: `0x${"88".repeat(32)}`,
        released: false,
        refunded: false,
      };
    },
    async sourceChainKey() { return BigInt(sourceChainKey); },
    async sourceChainId() { return BigInt(sourceChainId); },
    async retryVerifier() { return RETRY_CREDIT_VERIFIER; },
    async predicate() { return RETRY_CREDIT_PREDICATE; },
    async chainInfo() { return "0x0000000000000000000000000000000000000fD3"; },
    releaseCredit: {
      staticCall: async () => {
        fixture.simulationCalls += 1;
        if (simulationError) throw simulationError;
      },
    },
  };
  return fixture;
}

function retryCreditVerifierFixture({
  sourceChainKey = 3,
  sourceChainId = sourceChainKey === SEPOLIA_CHAIN_KEY ? 11_155_111 : 1,
} = {}) {
  return {
    target: RETRY_CREDIT_VERIFIER,
    async sourceChainKey() { return BigInt(sourceChainKey); },
    async sourceChainId() { return BigInt(sourceChainId); },
    async predicate() { return RETRY_CREDIT_PREDICATE; },
    async verifier() { return "0x0000000000000000000000000000000000000FD2"; },
  };
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

function retryCreditRuleFixture(overrides = {}) {
  return {
    attemptSigner: ATTEMPT_SIGNER,
    beneficiary: CLAIMANT,
    target: TARGET,
    settlementAsset: SETTLEMENT_ASSET,
    settlementRecipient: SETTLEMENT_RECIPIENT,
    policyId: POLICY_ID,
    actionId: ACTION_ID,
    minimumSettledValue: 40_000_000n,
    startBlock: 25_000_000,
    endBlock: 25_000_010,
    maxBlockGap: 10,
    minimumAttemptGasLimit: 100_000n,
    maxFailureGasUsed: 60_000n,
    ...overrides,
  };
}

function batchProofFixture({
  chainKey = 3,
  failureStatus = 0,
  retryStatus = 1,
  failureSender = CLAIMANT,
  retrySender = CLAIMANT,
  failureTarget = TARGET,
  retryTarget = TARGET,
  retryData,
  failureValue = 0n,
  retryValue = 0n,
  failureNonce = 8n,
  retryNonce = 10n,
  failureAttemptOverrides = {},
  retryAttemptOverrides = {},
  failureSignerKey = ATTEMPT_SIGNER_KEY,
  retrySignerKey = ATTEMPT_SIGNER_KEY,
  failureLegacyV = false,
  retryLegacyV = false,
  retryBlock = 25_000_001,
  retryIndex = 1,
  retryLogMode = "valid",
} = {}) {
  const failureBlock = 25_000_000;
  const sourceChainId = chainKey === SEPOLIA_CHAIN_KEY ? 11_155_111 : 1;
  const failedCheckout = retryCreditAttemptFixture({
    sourceChainId,
    quoteVersion: 1n,
    settledValue: 45_000_000n,
    validUntil: 25_000_010n,
    overrides: failureAttemptOverrides,
    signerKey: failureSignerKey,
    legacyV: failureLegacyV,
  });
  const successfulCheckout = retryCreditAttemptFixture({
    sourceChainId,
    quoteVersion: 2n,
    settledValue: 42_000_000n,
    validUntil: 25_000_010n,
    overrides: retryAttemptOverrides,
    signerKey: retrySignerKey,
    legacyV: retryLegacyV,
  });
  const successfulLogs = retryCreditSettlementLogs(successfulCheckout.attempt, retryLogMode);
  const failureEntry = {
    txHash: TX_HASH,
    txBytes: encodedTransactionFixture({
      status: failureStatus,
      nonce: failureNonce,
      sender: failureSender,
      target: failureTarget,
      data: failedCheckout.data,
      value: failureValue,
    }),
    merkleProof: { root: `0x${"55".repeat(32)}`, siblings: [] },
  };
  const retryEntry = {
    txHash: RETRY_TX_HASH,
    txBytes: encodedTransactionFixture({
      status: retryStatus,
      nonce: retryNonce,
      sender: retrySender,
      target: retryTarget,
      data: retryData ?? successfulCheckout.data,
      value: retryValue,
      logs: successfulLogs,
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

function retryCreditAttemptFixture({
  sourceChainId,
  quoteVersion,
  settledValue,
  validUntil,
  overrides = {},
  signerKey = ATTEMPT_SIGNER_KEY,
  legacyV = false,
}) {
  const payload = overrides.payload ?? abiCoder.encode(
    ["address", "bytes32", "uint64"],
    [SETTLEMENT_RECIPIENT, `0x${"66".repeat(32)}`, quoteVersion],
  );
  const attempt = {
    sourceChainId: BigInt(sourceChainId),
    target: TARGET,
    beneficiary: CLAIMANT,
    settlementAsset: SETTLEMENT_ASSET,
    settlementRecipient: SETTLEMENT_RECIPIENT,
    policyId: POLICY_ID,
    actionId: ACTION_ID,
    quoteVersion,
    settledValue,
    payloadHash: keccak256(payload),
    validUntil,
    ...overrides,
  };
  delete attempt.payload;
  const digest = TypedDataEncoder.hash(
    { name: "RetryCredit Checkout", version: "1", chainId: attempt.sourceChainId, verifyingContract: attempt.target },
    retryCreditTypes,
    attempt,
  );
  const canonicalSignature = Signature.from(new SigningKey(signerKey).sign(digest)).serialized;
  const signature = legacyV
    ? `${canonicalSignature.slice(0, -2)}${canonicalSignature.endsWith("1b") ? "00" : "01"}`
    : canonicalSignature;
  return {
    attempt,
    payload,
    signature,
    data: checkoutInterface.encodeFunctionData("checkout", [attempt, payload, signature]),
  };
}

function retryCreditSettlementLogs(attempt, mode = "valid") {
  const transfer = {
    address_: attempt.settlementAsset,
    topics: [
      transferEvent,
      zeroPadValue(attempt.beneficiary, 32),
      zeroPadValue(attempt.settlementRecipient, 32),
    ],
    data: abiCoder.encode(["uint256"], [attempt.settledValue]),
  };
  const settled = {
    address_: attempt.target,
    topics: [
      checkoutSettledEvent,
      attempt.policyId,
      attempt.actionId,
      zeroPadValue(attempt.beneficiary, 32),
    ],
    data: abiCoder.encode(
      ["address", "address", "uint256", "bytes32", "uint64"],
      [
        attempt.settlementAsset,
        attempt.settlementRecipient,
        attempt.settledValue,
        attempt.payloadHash,
        attempt.quoteVersion,
      ],
    ),
  };
  if (mode === "missing-transfer") return [settled];
  if (mode === "duplicate-transfer") return [transfer, transfer, settled];
  if (mode === "missing-event") return [transfer];
  return [transfer, settled];
}

function encodedTransactionFixture({
  status,
  nonce,
  sender = CLAIMANT,
  target = TARGET,
  data = "0x12345678",
  value = 0n,
  logs = [],
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
    [status, 50_000n, logs, "0x"],
  );
  return abiCoder.encode(["uint8", "bytes[]"], [2, [common, typeSpecific, receipt]]);
}
