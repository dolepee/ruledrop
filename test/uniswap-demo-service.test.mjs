import assert from "node:assert/strict";
import test from "node:test";
import {
  AbiCoder,
  Interface,
  Transaction,
  Wallet,
  getAddress,
  id,
  parseEther,
  verifyTypedData,
} from "ethers";
import {
  PUBLIC_DEMO_DEFAULTS,
  PUBLIC_DEMO_POOL_ABI,
  UniswapRetryCreditDemoService,
  publicDemoChallengeMessage,
} from "../src/uniswap-demo-service.mjs";
import { RETRY_CREDIT_UNISWAP_SEPOLIA, WorkerError } from "../src/proof-worker.mjs";

const sponsor = new Wallet(`0x${"11".repeat(32)}`);
const trader = new Wallet(`0x${"12".repeat(32)}`);
const routeSigner = new Wallet(`0x${"13".repeat(32)}`);
const relayer = new Wallet(`0x${"14".repeat(32)}`);
const otherBeneficiary = new Wallet(`0x${"15".repeat(32)}`);
const poolAddress = "0x1111111111111111111111111111111111111111";
const verifierAddress = "0x2222222222222222222222222222222222222222";
const predicateAddress = "0x3333333333333333333333333333333333333333";
const poolInterface = new Interface(PUBLIC_DEMO_POOL_ABI);
const routerInterface = new Interface([
  "function executeSigned(bytes commands,bytes[] inputs,bytes32 intent,bytes32 data,bool verifySender,bytes32 nonce,bytes signature,uint256 deadline)",
]);
const routeTypes = {
  ExecuteSigned: [
    { name: "commands", type: "bytes" },
    { name: "inputs", type: "bytes[]" },
    { name: "intent", type: "bytes32" },
    { name: "data", type: "bytes32" },
    { name: "sender", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

test("challenge binds origin, wallet, time window, and bounded testnet scope", async () => {
  const service = makeService();
  const challenge = service.challenge(trader.address);
  assert.match(challenge.message, /No mainnet transaction or token approval/);
  assert.match(challenge.message, new RegExp(trader.address));
  const signature = await trader.signMessage(challenge.message);
  assert.equal(service.verifyChallenge({ ...challenge, signature }).beneficiary, trader.address);
  await assert.rejects(
    Promise.resolve().then(() => service.verifyChallenge({ ...challenge, signature: `0x${"00".repeat(65)}` })),
    (error) => error instanceof WorkerError && error.code === "INVALID_SIGNATURE",
  );
});

test("refuses to report readiness for a non-V2 pool deployment", async () => {
  const fixture = serviceFixture({ pilotVersion: `0x${"00".repeat(32)}` });
  await assert.rejects(
    makeService(fixture).readiness(),
    (error) => error instanceof WorkerError && error.code === "PUBLIC_DEMO_MISCONFIGURED",
  );
});

test("prepares one funded service credit and two exact signed official routes", async () => {
  const fixture = serviceFixture();
  const service = makeService(fixture);
  const challenge = service.challenge(trader.address);
  const result = await service.prepare({
    ...challenge,
    signature: await trader.signMessage(challenge.message),
  });

  assert.equal(result.serviceCreditNumber, 1);
  assert.equal(result.trader, sponsor.address);
  assert.equal(result.beneficiary, trader.address);
  assert.equal(result.creditAmount, parseEther("0.01").toString());
  assert.equal(fixture.pool.createCalls, 1);
  assert.equal(fixture.pool.activateCalls, 1);
  assert.equal(fixture.pool.commitCalls, 1);
  assert.equal(fixture.createdTerms.trader, sponsor.address);
  assert.equal(fixture.createdTerms.beneficiary, trader.address);
  assert.equal(fixture.createdTerms.routeSigner, routeSigner.address);
  assert.equal(fixture.createdTerms.router, RETRY_CREDIT_UNISWAP_SEPOLIA.router);
  assert.equal(fixture.createdTerms.minimumSuccessfulOut, 1_600_000n);

  const failedTransaction = Transaction.from(fixture.committed.failed);
  const successfulTransaction = Transaction.from(fixture.committed.successful);
  const failed = routerInterface.decodeFunctionData("executeSigned", failedTransaction.data);
  const successful = routerInterface.decodeFunctionData("executeSigned", successfulTransaction.data);
  assert.equal(failed.commands, "0x0b00");
  assert.equal(failed.verifySender, true);
  assert.equal(failed.intent, successful.intent);
  assert.notEqual(failed.data, successful.data);
  assert.notEqual(failed.nonce, successful.nonce);
  const [outputRecipient] = AbiCoder.defaultAbiCoder().decode(
    ["address", "uint256", "uint256", "bytes", "bool", "uint256[]"],
    failed.inputs[1],
  );
  assert.equal(outputRecipient, trader.address);
  assert.equal(failedTransaction.from, sponsor.address);
  assert.equal(failedTransaction.to, RETRY_CREDIT_UNISWAP_SEPOLIA.router);
  assert.equal(failedTransaction.value, PUBLIC_DEMO_DEFAULTS.amountIn);
  assert.equal(failedTransaction.gasLimit, PUBLIC_DEMO_DEFAULTS.sourceGasLimit);
  assert.equal(failedTransaction.nonce + 1, successfulTransaction.nonce);
  assert.equal(result.transactions.failedTransactionHash, failedTransaction.hash);

  for (const decoded of [failed, successful]) {
    const recovered = verifyTypedData({
      name: "UniversalRouter",
      version: "2",
      chainId: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId,
      verifyingContract: RETRY_CREDIT_UNISWAP_SEPOLIA.router,
    }, routeTypes, {
      commands: decoded.commands,
      inputs: Array.from(decoded.inputs),
      intent: decoded.intent,
      data: decoded.data,
      sender: sponsor.address,
      nonce: decoded.nonce,
      deadline: decoded.deadline,
    }, decoded.signature);
    assert.equal(recovered, routeSigner.address);
  }
});

test("checks source gas before reserving CC3 credit and fails safely when faucet is empty", async () => {
  const fixture = serviceFixture({ sourceFunderBalance: 0n });
  const service = makeService(fixture);
  const challenge = service.challenge(trader.address);
  await assert.rejects(
    service.prepare({ ...challenge, signature: await trader.signMessage(challenge.message) }),
    (error) => error instanceof WorkerError && error.code === "SOURCE_FAUCET_EMPTY",
  );
  assert.equal(fixture.pool.createCalls, 0);
  assert.equal(fixture.pool.activateCalls, 0);
});

test("sizes the faucet reserve against both signed transactions' selected fee caps", async () => {
  const fixture = serviceFixture({ sourceFunderBalance: parseEther("0.0011") });
  const service = makeService(fixture);
  const challenge = service.challenge(trader.address);
  await assert.rejects(
    service.prepare({ ...challenge, signature: await trader.signMessage(challenge.message) }),
    (error) => error instanceof WorkerError && error.code === "SOURCE_FAUCET_EMPTY",
  );
  assert.equal(fixture.pool.createCalls, 0);
});

test("resumes an existing sponsored demo for the same beneficiary", async () => {
  const fixture = serviceFixture({ existingCredits: [{ sponsor: sponsor.address, beneficiary: trader.address }] });
  const service = makeService(fixture);
  const challenge = service.challenge(trader.address);
  const resumed = await service.prepare({ ...challenge, signature: await trader.signMessage(challenge.message) });
  assert.equal(resumed.serviceCreditNumber, 1);
  assert.equal(resumed.beneficiary, trader.address);
  assert.equal(fixture.pool.createCalls, 0);
  assert.equal(fixture.pool.commitCalls, 1);
});

test("activates and resumes a mined draft instead of funding a duplicate", async () => {
  const fixture = serviceFixture({
    existingCredits: [{ sponsor: sponsor.address, beneficiary: trader.address, policyId: `0x${"00".repeat(32)}` }],
  });
  const service = makeService(fixture);
  const challenge = service.challenge(trader.address);
  const resumed = await service.prepare({ ...challenge, signature: await trader.signMessage(challenge.message) });
  assert.equal(resumed.serviceCreditNumber, 1);
  assert.equal(fixture.pool.createCalls, 0);
  assert.equal(fixture.pool.activateCalls, 1);
  assert.equal(fixture.pool.commitCalls, 1);
});

test("refunds an activation-expired draft before preparing a replacement", async () => {
  const fixture = serviceFixture({
    existingCredits: [{ sponsor: sponsor.address, beneficiary: trader.address, policyId: `0x${"00".repeat(32)}` }],
  });
  fixture.ccProvider.currentBlockNumber = 357;
  const service = makeService(fixture);
  const challenge = service.challenge(otherBeneficiary.address);
  const prepared = await service.prepare({
    ...challenge,
    signature: await otherBeneficiary.signMessage(challenge.message),
  });
  assert.equal(fixture.pool.refundCalls, 1);
  assert.equal(fixture.pool.createCalls, 1);
  assert.equal(prepared.serviceCreditNumber, 2);
  assert.equal(prepared.beneficiary, otherBeneficiary.address);
});

test("does not return an active uncommitted credit after its source window", async () => {
  const fixture = serviceFixture({ existingCredits: [{ sponsor: sponsor.address, beneficiary: trader.address }] });
  fixture.sepoliaProvider.currentBlock = 11_000_139;
  const service = makeService(fixture);
  const challenge = service.challenge(trader.address);
  await assert.rejects(
    service.prepare({ ...challenge, signature: await trader.signMessage(challenge.message) }),
    (error) => error instanceof WorkerError && error.code === "DEMO_RECOVERING",
  );
  assert.equal(fixture.pool.createCalls, 0);
  assert.equal(fixture.pool.commitCalls, 0);
});

test("allows only one unresolved source nonce pair at a time", async () => {
  const fixture = serviceFixture({ existingCredits: [{ sponsor: sponsor.address, beneficiary: trader.address }] });
  const service = makeService(fixture);
  const challenge = service.challenge(otherBeneficiary.address);
  await assert.rejects(
    service.prepare({ ...challenge, signature: await otherBeneficiary.signMessage(challenge.message) }),
    (error) => error instanceof WorkerError && error.code === "DEMO_BUSY",
  );
  assert.equal(fixture.pool.createCalls, 0);
  assert.equal(fixture.pool.commitCalls, 0);
});

test("keeps an expired but unmined committed nonce pair reserved", async () => {
  const fixture = serviceFixture();
  const service = makeService(fixture);
  const challenge = service.challenge(trader.address);
  const prepared = await service.prepare({
    ...challenge,
    signature: await trader.signMessage(challenge.message),
  });
  fixture.sepoliaProvider.currentBlock = prepared.sourceWindow.endBlock + 1;
  const next = service.challenge(otherBeneficiary.address);
  await assert.rejects(
    service.prepare({ ...next, signature: await otherBeneficiary.signMessage(next.message) }),
    (error) => error instanceof WorkerError && error.code === "DEMO_BUSY",
  );
  assert.equal(fixture.pool.createCalls, 1);
});

test("cancels abandoned source nonces before refunding and serving the next beneficiary", async () => {
  const fixture = serviceFixture();
  const service = makeService(fixture);
  const first = service.challenge(trader.address);
  await service.prepare({ ...first, signature: await trader.signMessage(first.message) });
  fixture.expireCredit();

  const next = service.challenge(otherBeneficiary.address);
  const prepared = await service.prepare({
    ...next,
    signature: await otherBeneficiary.signMessage(next.message),
  });

  assert.equal(fixture.pool.refundCalls, 1);
  assert.equal(fixture.pool.createCalls, 2);
  assert.equal(prepared.serviceCreditNumber, 2);
  assert.equal(prepared.beneficiary, otherBeneficiary.address);
  assert.equal(fixture.sepoliaProvider.cancellations.length, 2);
  assert.deepEqual(fixture.sepoliaProvider.cancellations.map((transaction) => transaction.nonce), [7, 8]);
  assert.ok(fixture.sepoliaProvider.cancellations.every((transaction) => transaction.to === sponsor.address));
});

test("preserves one credit per beneficiary after both source receipts land", async () => {
  const fixture = serviceFixture();
  const service = makeService(fixture);
  const challenge = service.challenge(trader.address);
  const prepared = await service.prepare({ ...challenge, signature: await trader.signMessage(challenge.message) });
  fixture.sepoliaProvider.currentBlock = prepared.sourceWindow.startBlock;
  await service.execute(prepared.serviceCreditNumber);
  fixture.sepoliaProvider.currentBlock = prepared.sourceWindow.endBlock + 1;
  const resumed = await service.prepare({ ...challenge, signature: await trader.signMessage(challenge.message) });
  assert.equal(resumed.serviceCreditNumber, prepared.serviceCreditNumber);
  assert.equal(fixture.pool.createCalls, 1);
});

test("returns existing release evidence without building or sending a replay", async () => {
  const releaseHash = `0x${"77".repeat(32)}`;
  const fixture = serviceFixture({ released: true, releaseHash });
  const service = makeService(fixture);
  service.worker.prepareUniswapRetryCreditRelease = async () => {
    throw new Error("worker should not run for a resolved credit");
  };
  const result = await service.release({
    serviceCreditNumber: 1,
    failedTransactionHash: `0x${"88".repeat(32)}`,
    successfulTransactionHash: `0x${"99".repeat(32)}`,
  });
  assert.equal(result.state, "released");
  assert.equal(result.release.transactionHash, releaseHash);
  assert.equal(fixture.relayer.sendCalls, 0);
});

test("executes the committed stale and refreshed routes from the service wallet", async () => {
  const fixture = serviceFixture();
  const service = makeService(fixture);
  const challenge = service.challenge(trader.address);
  const prepared = await service.prepare({
    ...challenge,
    signature: await trader.signMessage(challenge.message),
  });
  fixture.sepoliaProvider.currentBlock = prepared.sourceWindow.startBlock;
  const executed = await service.execute(prepared.serviceCreditNumber);
  assert.equal(executed.failedTransactionHash, Transaction.from(fixture.committed.failed).hash);
  assert.equal(executed.successfulTransactionHash, Transaction.from(fixture.committed.successful).hash);
  assert.equal(fixture.sepoliaProvider.broadcasts.length, 2);
  const resumed = await service.execute(prepared.serviceCreditNumber);
  assert.equal(resumed.failedTransactionHash, executed.failedTransactionHash);
  assert.equal(fixture.sepoliaProvider.broadcasts.length, 2);
});

test("does not continue after a committed stale route is broadcast before its funded window", async () => {
  const fixture = serviceFixture();
  const service = makeService(fixture);
  const challenge = service.challenge(trader.address);
  const prepared = await service.prepare({
    ...challenge,
    signature: await trader.signMessage(challenge.message),
  });
  const failedHash = Transaction.from(fixture.committed.failed).hash;
  fixture.sepoliaProvider.receipts.set(failedHash.toLowerCase(), {
    hash: failedHash,
    status: 0,
    blockNumber: prepared.sourceWindow.startBlock - 1,
    gasUsed: 100_000n,
  });
  fixture.sepoliaProvider.currentBlock = prepared.sourceWindow.startBlock;
  await assert.rejects(
    service.execute(prepared.serviceCreditNumber),
    (error) => error instanceof WorkerError && error.code === "SOURCE_WINDOW_EXPIRED",
  );
  assert.equal(fixture.sepoliaProvider.broadcasts.length, 0);
});

test("returns the same top-level source hashes when release wins the execution race", async () => {
  const fixture = serviceFixture();
  const service = makeService(fixture);
  const challenge = service.challenge(trader.address);
  const prepared = await service.prepare({
    ...challenge,
    signature: await trader.signMessage(challenge.message),
  });
  fixture.sepoliaProvider.currentBlock = prepared.sourceWindow.startBlock;
  const executed = await service.execute(prepared.serviceCreditNumber);
  fixture.setReleased(true);
  const raced = await service.execute(prepared.serviceCreditNumber);
  assert.equal(raced.failedTransactionHash, executed.failedTransactionHash);
  assert.equal(raced.successfulTransactionHash, executed.successfulTransactionHash);
  assert.ok(raced.release);
});

test("separates sponsor writes from relayer release simulation", () => {
  const fixture = serviceFixture();
  fixture.workerPool = { target: poolAddress };
  const service = makeService(fixture);
  assert.equal(service.pool, fixture.pool);
  assert.equal(service.worker.uniswapRetryCreditPool, fixture.workerPool);
});

test("public challenge copy is deterministic", () => {
  const output = publicDemoChallengeMessage({
    origin: "https://retrycredit.dolepee.com/path",
    beneficiary: trader.address,
    timeBucket: 123,
  });
  assert.equal(output, [
    "RetryCredit public demo",
    "Origin: https://retrycredit.dolepee.com",
    `Credit recipient: ${trader.address}`,
    "Window: 123",
    "Authorize one bounded testnet service credit. No mainnet transaction or token approval.",
  ].join("\n"));
});

function makeService(overrides = {}) {
  const fixture = overrides.pool ? overrides : serviceFixture(overrides);
  return new UniswapRetryCreditDemoService({
    ccProvider: fixture.ccProvider,
    sepoliaProvider: fixture.sepoliaProvider,
    sponsorWallet: fixture.sponsor,
    sourceFunderWallet: sponsor,
    routeSignerWallet: routeSigner,
    relayerWallet: fixture.relayer,
    poolAddress,
    verifierAddress,
    proofBuilder: {},
    publicOrigin: "https://retrycredit.dolepee.com",
    poolContract: fixture.pool,
    workerPoolContract: fixture.workerPool,
    verifierContract: fixture.verifier,
    chainInfoContract: fixture.chainInfo,
    quoterContract: fixture.quoter,
    config: fixture.config,
  });
}

function serviceFixture({
  sourceFunderBalance = parseEther("1"),
  existingCredits = [],
  released = false,
  releaseHash = `0x${"66".repeat(32)}`,
  pilotVersion = id("RETRYCREDIT_PUBLIC_V2"),
} = {}) {
  let createdTerms;
  let isReleased = released;
  let isRefunded = false;
  let currentRefundAfter = 4_102_444_800n;
  let lastCreatedId = existingCredits.length;
  let committed = { failed: "0x", successful: "0x" };
  const activatedPolicy = `0x${"44".repeat(32)}`;
  const creationHash = `0x${"52".repeat(32)}`;
  const activationHash = `0x${"53".repeat(32)}`;
  const pool = {
    target: poolAddress,
    interface: poolInterface,
    filters: { CreditReleased: () => ({}) },
    createCalls: 0,
    activateCalls: 0,
    commitCalls: 0,
    refundCalls: 0,
    async serviceCreditCount() { return BigInt(existingCredits.length + (createdTerms ? 1 : 0)); },
    async getServiceCredit(idValue) {
      const existing = existingCredits[idValue - 1];
      return {
        sponsor: existing?.sponsor ?? sponsor.address,
        creditAmount: parseEther("0.01"),
        refundAfter: currentRefundAfter,
        creationBlock: 100n,
        termsHash: `0x${"54".repeat(32)}`,
        released: existing ? false : isReleased,
        refunded: existing ? Boolean(existing.refunded) : isRefunded,
      };
    },
    async getRule(idValue) {
      const existing = existingCredits[idValue - 1];
      const terms = createdTerms ?? baseRule(sponsor.address, existing?.beneficiary ?? trader.address);
      return { ...terms, policyId: existing?.policyId ?? activatedPolicy };
    },
    async retryVerifier() { return verifierAddress; },
    async predicate() { return predicateAddress; },
    async chainInfo() { return "0x0000000000000000000000000000000000000fD3"; },
    async PUBLIC_PILOT_VERSION() { return pilotVersion; },
    async createServiceCredit(terms, refundAfter) {
      pool.createCalls += 1;
      lastCreatedId = existingCredits.length + pool.createCalls;
      createdTerms = terms;
      currentRefundAfter = BigInt(refundAfter);
      isRefunded = false;
      return {
        async wait() {
          return receiptWithEvent("ServiceCreditDraftCreated", [
            BigInt(lastCreatedId),
            sponsor.address,
            terms.beneficiary,
            terms.trader,
            parseEther("0.01"),
            currentRefundAfter,
            100n,
            `0x${"54".repeat(32)}`,
          ], creationHash, 100);
        },
      };
    },
    async activateServiceCredit(idValue = 1) {
      pool.activateCalls += 1;
      if (existingCredits[idValue - 1]) existingCredits[idValue - 1].policyId = activatedPolicy;
      return {
        async wait() {
          return receiptWithEvent("ServiceCreditActivated", [BigInt(idValue), activatedPolicy, `0x${"55".repeat(32)}`], activationHash, 101);
        },
      };
    },
    async commitSourceTransactions(_id, failed, successful) {
      pool.commitCalls += 1;
      committed = { failed, successful };
      return {
        async wait() {
          return receiptWithEvent(
            "SourceTransactionsCommitted",
            [BigInt(_id), Transaction.from(failed).hash, Transaction.from(successful).hash],
            `0x${"56".repeat(32)}`,
            102,
          );
        },
      };
    },
    async getSourceTransactions() { return committed; },
    async refundServiceCredit(idValue) {
      pool.refundCalls += 1;
      if (existingCredits[idValue - 1]) existingCredits[idValue - 1].refunded = true;
      else isRefunded = true;
      return { async wait() { return { status: 1, hash: `0x${"57".repeat(32)}`, logs: [] }; } };
    },
    async queryFilter() {
      return isReleased ? [{
        address: poolAddress,
        transactionHash: releaseHash,
        blockNumber: 120,
        args: {
          failureQueryId: `0x${"71".repeat(32)}`,
          successQueryId: `0x${"72".repeat(32)}`,
          pairId: `0x${"73".repeat(32)}`,
        },
      }] : [];
    },
  };
  const relayerFixture = {
    address: relayer.address,
    sendCalls: 0,
    async sendTransaction() { relayerFixture.sendCalls += 1; throw new Error("unexpected relayer send"); },
  };
  const fixture = {
    sponsor: { address: sponsor.address },
    relayer: relayerFixture,
    pool,
    verifier: {
      target: verifierAddress,
      async sourceChainKey() { return 1n; },
      async sourceChainId() { return 11_155_111n; },
      async predicate() { return predicateAddress; },
      async verifier() { return "0x0000000000000000000000000000000000000fd2"; },
    },
    chainInfo: {
      async get_latest_attestation_height_and_hash() {
        return { height: 11_000_000n, hash: `0x${"61".repeat(32)}`, isAttestation: true, exists: true };
      },
    },
    quoter: {
      quoteExactInputSingle: { staticCall: async () => ({ amountOut: 2_000_000n }) },
    },
    ccProvider: {
      currentBlockNumber: 101,
      async getBlock() { return { number: 1_000, timestamp: 4_000_000_000 }; },
      async getBlockNumber() { return this.currentBlockNumber; },
    },
    sepoliaProvider: {
      currentBlock: 11_000_010,
      latestNonce: 7,
      broadcasts: [],
      cancellations: [],
      receipts: new Map(),
      async getBlockNumber() { return this.currentBlock; },
      async getBalance(address) { return getAddress(address) === sponsor.address ? sourceFunderBalance : 0n; },
      async getNetwork() { return { chainId: 11_155_111n }; },
      async getFeeData() { return { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }; },
      async getTransactionCount(_address, blockTag) { return blockTag === "latest" ? this.latestNonce : this.latestNonce; },
      async getTransactionReceipt(hash) { return this.receipts.get(hash.toLowerCase()) ?? null; },
      async broadcastTransaction(raw) {
        const transaction = Transaction.from(raw);
        this.broadcasts.push(transaction.hash);
        const isCancellation = transaction.to === sponsor.address && transaction.data === "0x" && transaction.value === 0n;
        if (isCancellation) this.cancellations.push(transaction);
        const receipt = {
          hash: transaction.hash,
          status: !isCancellation && transaction.nonce === 7 ? 0 : 1,
          blockNumber: transaction.nonce === 7 ? this.currentBlock : this.currentBlock + 1,
        };
        if (transaction.nonce === this.latestNonce) this.latestNonce += 1;
        this.receipts.set(transaction.hash.toLowerCase(), receipt);
        return { hash: transaction.hash };
      },
      async waitForTransaction(hash) { return this.receipts.get(hash.toLowerCase()) ?? null; },
    },
    get createdTerms() { return createdTerms; },
    get committed() { return committed; },
    setReleased(value) { isReleased = value; },
    expireCredit() { currentRefundAfter = 1n; },
    config: { sourceStartDelayBlocks: 0 },
  };
  return fixture;
}

function baseRule(traderAddress, beneficiaryAddress) {
  return {
    routeSigner: routeSigner.address,
    trader: traderAddress,
    beneficiary: beneficiaryAddress,
    router: RETRY_CREDIT_UNISWAP_SEPOLIA.router,
    weth: RETRY_CREDIT_UNISWAP_SEPOLIA.weth,
    usdc: RETRY_CREDIT_UNISWAP_SEPOLIA.usdc,
    pool: RETRY_CREDIT_UNISWAP_SEPOLIA.pool,
    policyId: `0x${"44".repeat(32)}`,
    actionId: `0x${"45".repeat(32)}`,
    amountIn: PUBLIC_DEMO_DEFAULTS.amountIn,
    minimumSuccessfulOut: 1_600_000n,
    startBlock: 11_000_018n,
    endBlock: 11_000_138n,
    maxBlockGap: 10n,
    minimumAttemptGasLimit: 450_000n,
    maxFailureGasUsed: 300_000n,
  };
}

function receiptWithEvent(name, args, hash, blockNumber) {
  const encoded = poolInterface.encodeEventLog(poolInterface.getEvent(name), args);
  return {
    status: 1,
    hash,
    blockNumber,
    logs: [{ address: poolAddress, topics: encoded.topics, data: encoded.data }],
  };
}
