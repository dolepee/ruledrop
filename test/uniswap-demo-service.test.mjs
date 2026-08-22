import assert from "node:assert/strict";
import test from "node:test";
import {
  Interface,
  Wallet,
  getAddress,
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
  assert.equal(service.verifyChallenge({ ...challenge, signature }).trader, trader.address);
  await assert.rejects(
    Promise.resolve().then(() => service.verifyChallenge({ ...challenge, signature: `0x${"00".repeat(65)}` })),
    (error) => error instanceof WorkerError && error.code === "INVALID_SIGNATURE",
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
  assert.equal(result.trader, trader.address);
  assert.equal(result.creditAmount, parseEther("0.01").toString());
  assert.equal(result.sourceFundingTransaction, fixture.sourceFundingHash);
  assert.equal(fixture.pool.createCalls, 1);
  assert.equal(fixture.pool.activateCalls, 1);
  assert.equal(fixture.sourceFunder.sendCalls, 1);
  assert.equal(fixture.createdTerms.trader, trader.address);
  assert.equal(fixture.createdTerms.routeSigner, routeSigner.address);
  assert.equal(fixture.createdTerms.router, RETRY_CREDIT_UNISWAP_SEPOLIA.router);
  assert.equal(fixture.createdTerms.minimumSuccessfulOut, 1_600_000n);
  assert.equal(fixture.createdTerms.maxBlockGap, 100);
  assert.equal(fixture.createdTerms.endBlock - fixture.createdTerms.startBlock, 240);

  const failed = routerInterface.decodeFunctionData("executeSigned", result.transactions.failed.data);
  const successful = routerInterface.decodeFunctionData("executeSigned", result.transactions.successful.data);
  assert.equal(failed.commands, "0x0b00");
  assert.equal(failed.verifySender, true);
  assert.equal(failed.sender ?? trader.address, trader.address);
  assert.equal(failed.intent, successful.intent);
  assert.notEqual(failed.data, successful.data);
  assert.notEqual(failed.nonce, successful.nonce);
  assert.equal(result.transactions.failed.from, trader.address);
  assert.equal(result.transactions.failed.to, RETRY_CREDIT_UNISWAP_SEPOLIA.router);
  assert.equal(BigInt(result.transactions.failed.value), PUBLIC_DEMO_DEFAULTS.amountIn);
  assert.equal(BigInt(result.transactions.failed.gas), PUBLIC_DEMO_DEFAULTS.sourceGasLimit);

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
      sender: trader.address,
      nonce: decoded.nonce,
      deadline: decoded.deadline,
    }, decoded.signature);
    assert.equal(recovered, routeSigner.address);
  }
});

test("funds source gas before reserving CC3 credit and fails safely when faucet is empty", async () => {
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

test("resumes an existing sponsored demo for the same trader without another write", async () => {
  const fixture = serviceFixture({ existingCredits: [{ sponsor: sponsor.address, trader: trader.address }] });
  const service = makeService(fixture);
  const challenge = service.challenge(trader.address);
  const result = await service.prepare({ ...challenge, signature: await trader.signMessage(challenge.message) });
  assert.equal(result.serviceCreditNumber, 1);
  assert.equal(result.trader, trader.address);
  assert.equal(result.creationTransaction, fixture.existingCreationHash);
  assert.equal(result.activationTransaction, fixture.existingActivationHash);
  assert.equal(result.sourceWindow.maxBlockGap, 10);
  assert.equal(result.sourceWindow.minimumRouteHeadroomBlocks, 12);
  assert.equal(fixture.pool.createCalls, 0);
  assert.equal(fixture.pool.activateCalls, 0);
  assert.equal(fixture.sourceFunder.sendCalls, 0);
});

test("counts only sponsor-indexed draft events from the pinned deployment block", async () => {
  const outsider = Wallet.createRandom();
  const fixture = serviceFixture({ existingCredits: Array.from({ length: 25 }, () => ({ sponsor: outsider.address, trader: outsider.address })) });
  const service = makeService(fixture);
  const challenge = service.challenge(trader.address);
  const result = await service.prepare({ ...challenge, signature: await trader.signMessage(challenge.message) });
  assert.equal(result.serviceCreditNumber, 26);
  assert.equal(fixture.pool.queryFromBlocks.every((value) => value === PUBLIC_DEMO_DEFAULTS.poolDeploymentBlock), true);
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
    trader: trader.address,
    timeBucket: 123,
  });
  assert.equal(output, [
    "RetryCredit public demo",
    "Origin: https://retrycredit.dolepee.com",
    `Trader: ${trader.address}`,
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
    sourceFunderWallet: fixture.sourceFunder,
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
  });
}

function serviceFixture({
  sourceFunderBalance = parseEther("1"),
  existingCredits = [],
  released = false,
  releaseHash = `0x${"66".repeat(32)}`,
} = {}) {
  let createdTerms;
  const activatedPolicy = `0x${"44".repeat(32)}`;
  const sourceFundingHash = `0x${"51".repeat(32)}`;
  const creationHash = `0x${"52".repeat(32)}`;
  const activationHash = `0x${"53".repeat(32)}`;
  const existingCreationHash = `0x${"56".repeat(32)}`;
  const existingActivationHash = `0x${"57".repeat(32)}`;
  const nextServiceCreditNumber = existingCredits.length + 1;
  const pool = {
    target: poolAddress,
    interface: poolInterface,
    filters: {
      CreditReleased: (idValue) => ({ name: "CreditReleased", idValue }),
      ServiceCreditDraftCreated: (idValue, sponsorAddress, traderAddress) => ({ name: "ServiceCreditDraftCreated", idValue, sponsorAddress, traderAddress }),
      ServiceCreditActivated: (idValue) => ({ name: "ServiceCreditActivated", idValue }),
    },
    createCalls: 0,
    activateCalls: 0,
    queryFromBlocks: [],
    async serviceCreditCount() { return BigInt(existingCredits.length); },
    async getServiceCredit(idValue) {
      const existing = existingCredits[idValue - 1];
      return {
        sponsor: existing?.sponsor ?? sponsor.address,
        creditAmount: parseEther("0.01"),
        refundAfter: 4_102_444_800n,
        creationBlock: 100n,
        termsHash: `0x${"54".repeat(32)}`,
        released: existing ? false : released,
        refunded: false,
      };
    },
    async getRule(idValue) {
      const existing = existingCredits[idValue - 1];
      const terms = createdTerms ?? baseRule(existing?.trader ?? trader.address);
      return { ...terms, policyId: activatedPolicy };
    },
    async retryVerifier() { return verifierAddress; },
    async predicate() { return predicateAddress; },
    async chainInfo() { return "0x0000000000000000000000000000000000000fD3"; },
    async createServiceCredit(terms) {
      pool.createCalls += 1;
      createdTerms = terms;
      return {
        async wait() {
          return receiptWithEvent("ServiceCreditDraftCreated", [
            BigInt(nextServiceCreditNumber),
            sponsor.address,
            terms.trader,
            parseEther("0.01"),
            4_102_444_800n,
            100n,
            `0x${"54".repeat(32)}`,
          ], creationHash, 100);
        },
      };
    },
    async activateServiceCredit() {
      pool.activateCalls += 1;
      return {
        async wait() {
          return receiptWithEvent("ServiceCreditActivated", [BigInt(nextServiceCreditNumber), activatedPolicy, `0x${"55".repeat(32)}`], activationHash, 101);
        },
      };
    },
    async queryFilter(filter, fromBlock) {
      if (filter.name === "ServiceCreditDraftCreated") {
        pool.queryFromBlocks.push(fromBlock);
        return existingCredits.flatMap((existing, index) => {
          if (filter.sponsorAddress && getAddress(existing.sponsor) !== getAddress(filter.sponsorAddress)) return [];
          if (filter.traderAddress && getAddress(existing.trader) !== getAddress(filter.traderAddress)) return [];
          return [{
            address: poolAddress,
            transactionHash: existingCreationHash,
            blockNumber: 100 + index,
            args: { serviceCreditNumber: BigInt(index + 1), sponsor: existing.sponsor, trader: existing.trader },
          }];
        });
      }
      if (filter.name === "ServiceCreditActivated") return [{
        address: poolAddress,
        transactionHash: existingActivationHash,
        blockNumber: 101,
        args: { serviceCreditNumber: BigInt(filter.idValue) },
      }];
      return released ? [{
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
  const sourceFunder = {
    address: sponsor.address,
    sendCalls: 0,
    async sendTransaction() {
      sourceFunder.sendCalls += 1;
      return { async wait() { return { status: 1, hash: sourceFundingHash }; } };
    },
  };
  const relayerFixture = {
    address: relayer.address,
    sendCalls: 0,
    async sendTransaction() { relayerFixture.sendCalls += 1; throw new Error("unexpected relayer send"); },
  };
  const fixture = {
    sponsor: { address: sponsor.address },
    sourceFunder,
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
      async getBlock() { return { number: 1_000, timestamp: 4_000_000_000 }; },
      async getBlockNumber() { return 101; },
    },
    sepoliaProvider: {
      async getBlockNumber() { return 11_000_010; },
      async getBalance(address) { return getAddress(address) === sponsor.address ? sourceFunderBalance : 0n; },
    },
    sourceFundingHash,
    existingCreationHash,
    existingActivationHash,
    get createdTerms() { return createdTerms; },
  };
  return fixture;
}

function baseRule(traderAddress) {
  return {
    routeSigner: routeSigner.address,
    trader: traderAddress,
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
