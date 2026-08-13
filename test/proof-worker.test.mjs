import assert from "node:assert/strict";
import test from "node:test";
import { ExpiringCache, RuleDropWorker, WorkerError, serializeCampaign, validateTransactionHash } from "../src/proof-worker.mjs";

const POOL = "0x6f8dE7e1599A0c8D38eB25996cB841a4920ed999";
const CLAIMANT = "0xbad35FA6e368e90fC4faf63507F2D0A2Fdf94BAF";
const TX_HASH = `0x${"ab".repeat(32)}`;
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

function campaignFixture() {
  return {
    sponsor: "0x813C4BF413BeeA09a7f61450Bd9a9Fa321ED25Db",
    recipient: "0x9fEAcC0d3BC179B6022B4aAf96F7a8217F422642",
    minimumAmount: 1_000_000_000n,
    startBlock: 25_049_872n,
    endBlock: 25_049_872n,
    registrationDeadline: 1_786_730_502n,
    withdrawalDeadline: 1_786_903_302n,
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
