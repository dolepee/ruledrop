import {
  AbiCoder,
  Contract,
  Interface,
  MaxUint256,
  Wallet,
  ZeroAddress,
  concat,
  getAddress,
  getBytes,
  isHexString,
  keccak256,
  parseEther,
  toQuantity,
  toUtf8Bytes,
  verifyMessage,
  zeroPadValue,
} from "ethers";
import {
  RETRY_CREDIT_UNISWAP_SEPOLIA,
  RuleDropWorker,
  WorkerError,
  computeUniswapRetryCreditIntent,
} from "./proof-worker.mjs";

export const PUBLIC_DEMO_DEFAULTS = Object.freeze({
  creditAmount: parseEther("0.01"),
  amountIn: parseEther("0.00001"),
  sourceFundingTarget: parseEther("0.0011"),
  minimumAttemptGasLimit: 250_000n,
  maxFailureGasUsed: 220_000n,
  sourceGasLimit: 300_000n,
  sourceStartDelayBlocks: 8,
  sourceWindowBlocks: 120,
  maxBlockGap: 10,
  refundDelaySeconds: 4 * 60 * 60,
  maxSponsoredCredits: 10,
  poolDeploymentBlock: 5_352_892,
  challengeWindowMs: 5 * 60_000,
});

export const PUBLIC_DEMO_POOL_ABI = [
  "event ServiceCreditDraftCreated(uint256 indexed serviceCreditNumber,address indexed sponsor,address indexed trader,uint256 creditAmount,uint64 refundAfter,uint256 creationBlock,bytes32 termsHash)",
  "event ServiceCreditActivated(uint256 indexed serviceCreditNumber,bytes32 indexed policyId,bytes32 creationBlockHash)",
  "event CreditReleased(uint256 indexed serviceCreditNumber,bytes32 indexed policyId,address indexed trader,uint256 creditAmount,bytes32 failureQueryId,bytes32 successQueryId,bytes32 pairId,address prover)",
  "function serviceCreditCount() view returns(uint256)",
  "function createServiceCredit((address routeSigner,address trader,address router,address weth,address usdc,address pool,bytes32 policyId,bytes32 actionId,uint256 amountIn,uint256 minimumSuccessfulOut,uint64 startBlock,uint64 endBlock,uint32 maxBlockGap,uint64 minimumAttemptGasLimit,uint64 maxFailureGasUsed) terms,uint64 refundAfter) payable returns(uint256)",
  "function activateServiceCredit(uint256 serviceCreditNumber) returns(bytes32)",
  "function getRule(uint256 serviceCreditNumber) view returns ((address routeSigner,address trader,address router,address weth,address usdc,address pool,bytes32 policyId,bytes32 actionId,uint256 amountIn,uint256 minimumSuccessfulOut,uint64 startBlock,uint64 endBlock,uint32 maxBlockGap,uint64 minimumAttemptGasLimit,uint64 maxFailureGasUsed))",
  "function getServiceCredit(uint256 serviceCreditNumber) view returns ((address sponsor,uint256 creditAmount,uint64 refundAfter,uint256 creationBlock,bytes32 termsHash,bool released,bool refunded))",
  "function sourceChainKey() view returns(uint64)",
  "function sourceChainId() view returns(uint64)",
  "function retryVerifier() view returns(address)",
  "function predicate() view returns(address)",
  "function chainInfo() view returns(address)",
  "function releaseCredit(uint256 serviceCreditNumber,(uint64[] sourceBlocks,bytes[] encodedTransactions,(bytes32 root,(bytes32 hash,bool isLeft)[] siblings)[] merkleProofs,bytes32 lowerEndpointDigest,bytes32[] continuityRoots) proof)",
];

export const PUBLIC_DEMO_VERIFIER_ABI = [
  "function sourceChainKey() view returns(uint64)",
  "function sourceChainId() view returns(uint64)",
  "function predicate() view returns(address)",
  "function verifier() view returns(address)",
];

const CHAIN_INFO = getAddress("0x0000000000000000000000000000000000000fd3");
const QUOTER = getAddress("0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3");
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const abiCoder = AbiCoder.defaultAbiCoder();
const routerInterface = new Interface([
  "function executeSigned(bytes commands,bytes[] inputs,bytes32 intent,bytes32 data,bool verifySender,bytes32 nonce,bytes signature,uint256 deadline) payable",
]);
const quoterAbi = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];
const chainInfoAbi = [
  "function get_latest_attestation_height_and_hash(uint64 chainKey) view returns((uint64 height,bytes32 hash,bool isAttestation,bool exists))",
];
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

export class UniswapRetryCreditDemoService {
  constructor({
    ccProvider,
    sepoliaProvider,
    sponsorWallet,
    sourceFunderWallet,
    routeSignerWallet,
    relayerWallet,
    poolAddress,
    verifierAddress,
    proofBuilder,
    publicOrigin,
    config = {},
    poolContract,
    workerPoolContract,
    verifierContract,
    chainInfoContract,
    quoterContract,
  }) {
    this.ccProvider = ccProvider;
    this.sepoliaProvider = sepoliaProvider;
    this.sponsorWallet = sponsorWallet;
    this.sourceFunderWallet = sourceFunderWallet;
    this.routeSignerWallet = routeSignerWallet;
    this.relayerWallet = relayerWallet;
    this.poolAddress = requireNonzeroAddress(poolAddress, "public RetryCredit pool");
    this.verifierAddress = requireNonzeroAddress(verifierAddress, "public RetryCredit verifier");
    this.publicOrigin = new URL(publicOrigin).origin;
    this.config = { ...PUBLIC_DEMO_DEFAULTS, ...config };
    this.pool = poolContract ?? new Contract(this.poolAddress, PUBLIC_DEMO_POOL_ABI, sponsorWallet);
    this.workerPool = workerPoolContract
      ?? (poolContract || new Contract(this.poolAddress, PUBLIC_DEMO_POOL_ABI, ccProvider));
    this.verifier = verifierContract ?? new Contract(this.verifierAddress, PUBLIC_DEMO_VERIFIER_ABI, ccProvider);
    this.chainInfo = chainInfoContract ?? new Contract(CHAIN_INFO, chainInfoAbi, ccProvider);
    this.quoter = quoterContract ?? new Contract(QUOTER, quoterAbi, sepoliaProvider);
    this.worker = new RuleDropWorker({
      poolAddress: this.poolAddress,
      poolAbi: ["function serviceCreditCount() view returns(uint256)"],
      poolContract: {},
      creditcoinProvider: ccProvider,
      sourceChainKey: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainKey,
      sourceChainId: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId,
      proofBuilder,
      uniswapRetryCreditPoolAddress: this.poolAddress,
      uniswapRetryCreditPoolContract: this.workerPool,
      uniswapRetryCreditVerifierContract: this.verifier,
    });
    this.prepareQueue = Promise.resolve();
  }

  static fromPrivateKey({ privateKey, ccProvider, sepoliaProvider, ...options }) {
    if (!isHexString(privateKey, 32) || /^0x0+$/.test(privateKey)) {
      throw new Error("public RetryCredit service requires a nonzero 32-byte private key secret");
    }
    return new UniswapRetryCreditDemoService({
      ...options,
      ccProvider,
      sepoliaProvider,
      sponsorWallet: new Wallet(privateKey, ccProvider),
      sourceFunderWallet: new Wallet(privateKey, sepoliaProvider),
      routeSignerWallet: new Wallet(deriveRoleKey(privateKey, "RETRYCREDIT_PUBLIC_ROUTE_SIGNER_V1")),
      relayerWallet: new Wallet(deriveRoleKey(privateKey, "RETRYCREDIT_PUBLIC_CC3_RELAYER_V1"), ccProvider),
    });
  }

  challenge(trader, timeBucket = currentChallengeBucket(this.config.challengeWindowMs)) {
    const address = requireNonzeroAddress(trader, "trader");
    return {
      trader: address,
      timeBucket,
      message: publicDemoChallengeMessage({
        origin: this.publicOrigin,
        trader: address,
        timeBucket,
      }),
      expiresAt: (timeBucket + 1) * this.config.challengeWindowMs,
    };
  }

  async prepare({ trader, timeBucket, signature }) {
    const ownership = this.verifyChallenge({ trader, timeBucket, signature });
    const run = this.prepareQueue.then(() => this.#prepareAuthenticated(ownership.trader));
    this.prepareQueue = run.catch(() => undefined);
    return run;
  }

  async status(serviceCreditNumber) {
    const idValue = parseServiceCreditNumber(serviceCreditNumber);
    const [credit, rule] = await Promise.all([
      this.pool.getServiceCredit(idValue),
      this.pool.getRule(idValue),
    ]);
    const output = {
      serviceCreditNumber: idValue,
      state: credit.released ? "released" : credit.refunded ? "refunded" : rule.policyId === ZERO_BYTES32 ? "draft" : "active",
      sponsor: getAddress(credit.sponsor),
      trader: getAddress(rule.trader),
      creditAmount: credit.creditAmount.toString(),
      refundAfter: Number(credit.refundAfter),
      policyId: String(rule.policyId).toLowerCase(),
      actionId: String(rule.actionId).toLowerCase(),
      sourceWindow: { startBlock: Number(rule.startBlock), endBlock: Number(rule.endBlock) },
    };
    if (credit.released) {
      const events = await this.pool.queryFilter(this.pool.filters.CreditReleased(idValue), Number(credit.creationBlock));
      const exact = events.filter((event) => getAddress(event.address) === this.poolAddress);
      if (exact.length !== 1) throw new WorkerError("RELEASE_EVIDENCE_UNAVAILABLE", "Exact release evidence is unavailable", 503);
      const event = exact[0];
      output.release = {
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        failureQueryId: event.args.failureQueryId,
        successQueryId: event.args.successQueryId,
        pairId: event.args.pairId,
      };
    }
    return output;
  }

  async release({ serviceCreditNumber, failedTransactionHash, successfulTransactionHash }) {
    const idValue = parseServiceCreditNumber(serviceCreditNumber);
    const existing = await this.status(idValue);
    if (existing.state === "released") return existing;
    if (existing.state !== "active") throw new WorkerError("SERVICE_CREDIT_NOT_ACTIVE", "Service credit is not active", 409);
    let prepared;
    try {
      prepared = await this.worker.prepareUniswapRetryCreditRelease({
        serviceCreditNumber: idValue,
        failedTransactionHash,
        successfulTransactionHash,
        relayer: this.relayerWallet.address,
      });
    } catch (error) {
      if (error instanceof WorkerError && [503, 502].includes(error.status)) {
        throw new WorkerError("ATTESTCOIN_PENDING", "Attestcoin has not finalized both Sepolia receipts yet", 425, error);
      }
      throw error;
    }
    try {
      const transaction = await this.relayerWallet.sendTransaction({
        to: prepared.transaction.to,
        data: prepared.transaction.data,
        gasLimit: BigInt(prepared.transaction.gas),
        value: 0,
      });
      const receipt = await transaction.wait();
      if (!receipt || Number(receipt.status) !== 1) throw new Error("release transaction failed");
    } catch (error) {
      const raced = await this.status(idValue);
      if (raced.state !== "released") throw error;
      return raced;
    }
    return this.status(idValue);
  }

  verifyChallenge({ trader, timeBucket, signature }) {
    const address = requireNonzeroAddress(trader, "trader");
    const bucket = Number(timeBucket);
    const current = currentChallengeBucket(this.config.challengeWindowMs);
    if (!Number.isSafeInteger(bucket) || ![current, current - 1].includes(bucket)) {
      throw new WorkerError("CHALLENGE_EXPIRED", "Wallet challenge expired; sign a fresh one", 401);
    }
    if (typeof signature !== "string" || !isHexString(signature, 65)) {
      throw new WorkerError("INVALID_SIGNATURE", "A 65-byte wallet signature is required", 401);
    }
    const message = publicDemoChallengeMessage({ origin: this.publicOrigin, trader: address, timeBucket: bucket });
    let recovered;
    try {
      recovered = verifyMessage(message, signature);
    } catch (error) {
      throw new WorkerError("INVALID_SIGNATURE", "Wallet challenge signature is invalid", 401, error);
    }
    if (getAddress(recovered) !== address) {
      throw new WorkerError("INVALID_SIGNATURE", "Wallet challenge was signed by a different address", 401);
    }
    return { trader: address, timeBucket: bucket };
  }

  async #prepareAuthenticated(trader) {
    await this.#authenticateInfrastructure();
    const existing = await this.#sponsoredDraftEvents(trader);
    if (existing.length > 1) throw new WorkerError("DEMO_STATE_INVALID", "Multiple sponsored recoveries exist for this wallet", 503);
    if (existing.length === 1) return this.#resumeSponsoredRun(existing[0], trader);

    const sponsored = await this.#sponsoredDraftEvents();
    const sponsoredCount = sponsored.length;
    if (sponsoredCount >= this.config.maxSponsoredCredits) {
      throw new WorkerError("DEMO_CAP_REACHED", "The bounded public demo allocation has been used", 409);
    }
    const [attested, currentSourceBlock, quoteResult, ccBlock] = await Promise.all([
      this.chainInfo.get_latest_attestation_height_and_hash(RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainKey),
      this.sepoliaProvider.getBlockNumber(),
      this.quoter.quoteExactInputSingle.staticCall({
        tokenIn: RETRY_CREDIT_UNISWAP_SEPOLIA.weth,
        tokenOut: RETRY_CREDIT_UNISWAP_SEPOLIA.usdc,
        amountIn: this.config.amountIn,
        fee: RETRY_CREDIT_UNISWAP_SEPOLIA.fee,
        sqrtPriceLimitX96: 0,
      }),
      this.ccProvider.getBlock("latest"),
    ]);
    if (!attested.exists || !attested.isAttestation) {
      throw new WorkerError("ATTESTCOIN_UNAVAILABLE", "Sepolia attestation height is unavailable", 503);
    }
    const quote = BigInt(quoteResult.amountOut ?? quoteResult[0]);
    const startBlock = Math.max(Number(attested.height) + 1, currentSourceBlock + this.config.sourceStartDelayBlocks);
    const endBlock = startBlock + this.config.sourceWindowBlocks;
    const actionId = keccak256(abiCoder.encode(
      ["string", "address", "address", "uint256", "uint256"],
      ["RETRYCREDIT_PUBLIC_ACTION_V1", trader, this.poolAddress, sponsoredCount + 1, ccBlock.number],
    ));
    const terms = {
      routeSigner: this.routeSignerWallet.address,
      trader,
      router: RETRY_CREDIT_UNISWAP_SEPOLIA.router,
      weth: RETRY_CREDIT_UNISWAP_SEPOLIA.weth,
      usdc: RETRY_CREDIT_UNISWAP_SEPOLIA.usdc,
      pool: RETRY_CREDIT_UNISWAP_SEPOLIA.pool,
      policyId: ZERO_BYTES32,
      actionId,
      amountIn: this.config.amountIn,
      minimumSuccessfulOut: quote * 80n / 100n,
      startBlock,
      endBlock,
      maxBlockGap: this.config.maxBlockGap,
      minimumAttemptGasLimit: this.config.minimumAttemptGasLimit,
      maxFailureGasUsed: this.config.maxFailureGasUsed,
    };
    const refundAfter = Number(ccBlock.timestamp) + this.config.refundDelaySeconds;
    let sourceFundingTransaction = null;
    const sourceBalance = await this.sepoliaProvider.getBalance(trader);
    if (sourceBalance < this.config.sourceFundingTarget) {
      const requiredFunding = this.config.sourceFundingTarget - sourceBalance;
      const funderBalance = await this.sepoliaProvider.getBalance(this.sourceFunderWallet.address);
      if (funderBalance < requiredFunding) {
        throw new WorkerError("SOURCE_FAUCET_EMPTY", "The bounded Sepolia demo faucet is temporarily empty", 503);
      }
      const funding = await this.sourceFunderWallet.sendTransaction({ to: trader, value: requiredFunding });
      const fundingReceipt = await funding.wait();
      if (!fundingReceipt || Number(fundingReceipt.status) !== 1) throw new Error("Sepolia demo funding failed");
      sourceFundingTransaction = fundingReceipt.hash;
    }
    const creation = await this.pool.createServiceCredit(terms, refundAfter, { value: this.config.creditAmount });
    const creationReceipt = await creation.wait();
    const draft = requireExactEvent(this.pool.interface, creationReceipt, "ServiceCreditDraftCreated", this.poolAddress);
    const serviceCreditNumber = Number(draft.serviceCreditNumber);
    await waitForNextBlock(this.ccProvider, creationReceipt.blockNumber);
    const activation = await this.pool.activateServiceCredit(serviceCreditNumber);
    const activationReceipt = await activation.wait();
    requireExactEvent(this.pool.interface, activationReceipt, "ServiceCreditActivated", this.poolAddress);
    const rule = await this.pool.getRule(serviceCreditNumber);

    return this.#preparedResponse({
      serviceCreditNumber,
      trader,
      sourceFundingTransaction,
      creationTransaction: creationReceipt.hash,
      activationTransaction: activationReceipt.hash,
      rule,
    });
  }

  async #sponsoredDraftEvents(trader = null) {
    const filter = this.pool.filters.ServiceCreditDraftCreated(
      null,
      this.sponsorWallet.address,
      trader,
    );
    const events = await this.pool.queryFilter(filter, this.config.poolDeploymentBlock);
    return events.filter((event) => (
      getAddress(event.address) === this.poolAddress
      && getAddress(event.args.sponsor) === this.sponsorWallet.address
      && (!trader || getAddress(event.args.trader) === trader)
    ));
  }

  async #resumeSponsoredRun(event, trader) {
    const serviceCreditNumber = Number(event.args.serviceCreditNumber);
    const credit = await this.pool.getServiceCredit(serviceCreditNumber);
    if (getAddress(credit.sponsor) !== this.sponsorWallet.address || getAddress(event.args.trader) !== trader) {
      throw new WorkerError("DEMO_STATE_INVALID", "The saved recovery does not match this wallet", 503);
    }
    if (credit.released || credit.refunded) {
      throw new WorkerError("DEMO_ALREADY_USED", "This wallet already completed or closed its sponsored recovery", 409);
    }
    let rule = await this.pool.getRule(serviceCreditNumber);
    let activationTransaction = null;
    if (rule.policyId === ZERO_BYTES32) {
      await waitForNextBlock(this.ccProvider, Number(credit.creationBlock));
      try {
        const activation = await this.pool.activateServiceCredit(serviceCreditNumber);
        const activationReceipt = await activation.wait();
        requireExactEvent(this.pool.interface, activationReceipt, "ServiceCreditActivated", this.poolAddress);
        activationTransaction = activationReceipt.hash;
        rule = await this.pool.getRule(serviceCreditNumber);
      } catch (error) {
        rule = await this.pool.getRule(serviceCreditNumber);
        if (rule.policyId === ZERO_BYTES32) throw error;
      }
    }
    if (!activationTransaction) {
      const activations = await this.pool.queryFilter(
        this.pool.filters.ServiceCreditActivated(serviceCreditNumber),
        Number(credit.creationBlock),
      );
      const exact = activations.filter((item) => getAddress(item.address) === this.poolAddress);
      if (exact.length !== 1) throw new WorkerError("DEMO_STATE_INVALID", "Exact activation evidence is unavailable", 503);
      activationTransaction = exact[0].transactionHash;
    }
    return this.#preparedResponse({
      serviceCreditNumber,
      trader,
      sourceFundingTransaction: null,
      creationTransaction: event.transactionHash,
      activationTransaction,
      rule,
    });
  }

  async #preparedResponse({ serviceCreditNumber, trader, sourceFundingTransaction, creationTransaction, activationTransaction, rule }) {
    return {
      serviceCreditNumber,
      trader,
      creditAmount: this.config.creditAmount.toString(),
      sourceFundingTransaction,
      creationTransaction,
      activationTransaction,
      policyId: String(rule.policyId).toLowerCase(),
      actionId: String(rule.actionId).toLowerCase(),
      sourceWindow: {
        startBlock: Number(rule.startBlock),
        endBlock: Number(rule.endBlock),
        maxBlockGap: Number(rule.maxBlockGap),
      },
      transactions: await this.#signedRouteBundle(rule),
    };
  }

  async #signedRouteBundle(rule) {
    const intent = computeUniswapRetryCreditIntent(rule);
    const now = Math.floor(Date.now() / 1000);
    const failureMinimum = MaxUint256;
    const successMinimum = BigInt(rule.minimumSuccessfulOut);
    return {
      failed: await this.#signedRouteTransaction({
        rule,
        intent,
        data: zeroPadValue("0x01", 32),
        nonce: keccak256(abiCoder.encode(["bytes32", "string"], [rule.actionId, "failure"])),
        deadline: now + 3600,
        amountOutMinimum: failureMinimum,
      }),
      successful: await this.#signedRouteTransaction({
        rule,
        intent,
        data: zeroPadValue("0x02", 32),
        nonce: keccak256(abiCoder.encode(["bytes32", "string"], [rule.actionId, "success"])),
        deadline: now + 3660,
        amountOutMinimum: successMinimum,
      }),
    };
  }

  async #signedRouteTransaction({ rule, intent, data, nonce, deadline, amountOutMinimum }) {
    const pathValue = `0x${RETRY_CREDIT_UNISWAP_SEPOLIA.weth.slice(2)}0001f4${RETRY_CREDIT_UNISWAP_SEPOLIA.usdc.slice(2)}`;
    const inputs = [
      abiCoder.encode(
        ["address", "uint256"],
        ["0x0000000000000000000000000000000000000002", rule.amountIn],
      ),
      abiCoder.encode(
        ["address", "uint256", "uint256", "bytes", "bool", "uint256[]"],
        ["0x0000000000000000000000000000000000000001", rule.amountIn, amountOutMinimum, pathValue, false, []],
      ),
    ];
    const message = {
      commands: "0x0b00",
      inputs,
      intent,
      data,
      sender: getAddress(rule.trader),
      nonce,
      deadline,
    };
    const signature = await this.routeSignerWallet.signTypedData({
      name: "UniversalRouter",
      version: "2",
      chainId: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId,
      verifyingContract: RETRY_CREDIT_UNISWAP_SEPOLIA.router,
    }, routeTypes, message);
    return {
      from: getAddress(rule.trader),
      to: RETRY_CREDIT_UNISWAP_SEPOLIA.router,
      data: routerInterface.encodeFunctionData("executeSigned", [
        message.commands,
        message.inputs,
        message.intent,
        message.data,
        true,
        message.nonce,
        signature,
        message.deadline,
      ]),
      value: toQuantity(rule.amountIn),
      gas: toQuantity(this.config.sourceGasLimit),
      amountOutMinimum: amountOutMinimum.toString(),
    };
  }

  async #authenticateInfrastructure() {
    const [poolVerifier, poolPredicate, poolChainInfo, keyValue, idValue, verifierPredicate, nativeVerifier] = await Promise.all([
      this.pool.retryVerifier(),
      this.pool.predicate(),
      this.pool.chainInfo(),
      this.verifier.sourceChainKey(),
      this.verifier.sourceChainId(),
      this.verifier.predicate(),
      this.verifier.verifier(),
    ]);
    if (
      getAddress(poolVerifier) !== this.verifierAddress
      || getAddress(poolPredicate) !== getAddress(verifierPredicate)
      || getAddress(poolChainInfo) !== CHAIN_INFO
      || Number(keyValue) !== RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainKey
      || Number(idValue) !== RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId
      || getAddress(nativeVerifier) !== getAddress("0x0000000000000000000000000000000000000fd2")
    ) throw new WorkerError("PUBLIC_DEMO_MISCONFIGURED", "Public RetryCredit infrastructure is not authentic", 503);
  }
}

export function publicDemoChallengeMessage({ origin, trader, timeBucket }) {
  return [
    "RetryCredit public demo",
    `Origin: ${new URL(origin).origin}`,
    `Trader: ${getAddress(trader)}`,
    `Window: ${Number(timeBucket)}`,
    "Authorize one bounded testnet service credit. No mainnet transaction or token approval.",
  ].join("\n");
}

export function deriveRoleKey(privateKey, label) {
  const value = keccak256(concat([getBytes(privateKey), toUtf8Bytes(label)]));
  if (/^0x0+$/.test(value)) throw new Error(`derived an invalid ${label} key`);
  return value;
}

function currentChallengeBucket(windowMs) {
  return Math.floor(Date.now() / windowMs);
}

function requireNonzeroAddress(value, label) {
  let address;
  try {
    address = getAddress(value);
  } catch (error) {
    throw new WorkerError("INVALID_ADDRESS", `Invalid ${label} address`, 400, error);
  }
  if (address === ZeroAddress) throw new WorkerError("INVALID_ADDRESS", `${label} address must be nonzero`);
  return address;
}

function parseServiceCreditNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new WorkerError("INVALID_SERVICE_CREDIT_NUMBER", "Service credit number must be positive");
  }
  return number;
}

function requireExactEvent(contractInterface, receipt, name, emitter) {
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`${name} transaction failed`);
  const matches = [];
  for (const log of receipt.logs ?? []) {
    if (getAddress(log.address) !== getAddress(emitter)) continue;
    try {
      const parsed = contractInterface.parseLog(log);
      if (parsed?.name === name) matches.push(parsed.args);
    } catch {
      // Ignore other logs from the exact contract.
    }
  }
  if (matches.length !== 1) throw new Error(`expected exactly one ${name} event from ${emitter}`);
  return matches[0];
}

async function waitForNextBlock(provider, blockNumber) {
  const deadline = Date.now() + 90_000;
  while (await provider.getBlockNumber() <= blockNumber) {
    if (Date.now() > deadline) throw new WorkerError("CREDITCOIN_TIMEOUT", "Timed out waiting to activate the service credit", 503);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}
