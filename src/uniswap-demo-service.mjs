import {
  AbiCoder,
  Contract,
  Interface,
  Transaction,
  Wallet,
  ZeroAddress,
  concat,
  getAddress,
  getBytes,
  isHexString,
  keccak256,
  parseEther,
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
  minimumAttemptGasLimit: 250_000n,
  maxFailureGasUsed: 220_000n,
  sourceGasLimit: 300_000n,
  sourceStartDelayBlocks: 1,
  sourceWindowBlocks: 120,
  maxBlockGap: 10,
  refundDelaySeconds: 4 * 60 * 60,
  maxSponsoredCredits: 10,
  challengeWindowMs: 5 * 60_000,
});

export const PUBLIC_DEMO_POOL_ABI = [
  "event ServiceCreditDraftCreated(uint256 indexed serviceCreditNumber,address indexed sponsor,address indexed beneficiary,address trader,uint256 creditAmount,uint64 refundAfter,uint256 creationBlock,bytes32 termsHash)",
  "event ServiceCreditActivated(uint256 indexed serviceCreditNumber,bytes32 indexed policyId,bytes32 creationBlockHash)",
  "event SourceTransactionsCommitted(uint256 indexed serviceCreditNumber,bytes32 indexed failureTransactionHash,bytes32 indexed successTransactionHash)",
  "event CreditReleased(uint256 indexed serviceCreditNumber,bytes32 indexed policyId,address indexed beneficiary,address trader,uint256 creditAmount,bytes32 failureQueryId,bytes32 successQueryId,bytes32 pairId,address prover)",
  "function serviceCreditCount() view returns(uint256)",
  "function createServiceCredit((address routeSigner,address trader,address beneficiary,address router,address weth,address usdc,address pool,bytes32 policyId,bytes32 actionId,uint256 amountIn,uint256 minimumSuccessfulOut,uint64 startBlock,uint64 endBlock,uint32 maxBlockGap,uint64 minimumAttemptGasLimit,uint64 maxFailureGasUsed) terms,uint64 refundAfter) payable returns(uint256)",
  "function activateServiceCredit(uint256 serviceCreditNumber) returns(bytes32)",
  "function commitSourceTransactions(uint256 serviceCreditNumber,bytes failedTransaction,bytes successfulTransaction)",
  "function getSourceTransactions(uint256 serviceCreditNumber) view returns ((bytes failed,bytes successful))",
  "function getRule(uint256 serviceCreditNumber) view returns ((address routeSigner,address trader,address beneficiary,address router,address weth,address usdc,address pool,bytes32 policyId,bytes32 actionId,uint256 amountIn,uint256 minimumSuccessfulOut,uint64 startBlock,uint64 endBlock,uint32 maxBlockGap,uint64 minimumAttemptGasLimit,uint64 maxFailureGasUsed))",
  "function getServiceCredit(uint256 serviceCreditNumber) view returns ((address sponsor,uint256 creditAmount,uint64 refundAfter,uint256 creationBlock,bytes32 termsHash,bool released,bool refunded))",
  "function sourceChainKey() view returns(uint64)",
  "function sourceChainId() view returns(uint64)",
  "function retryVerifier() view returns(address)",
  "function predicate() view returns(address)",
  "function chainInfo() view returns(address)",
  "function PUBLIC_PILOT_VERSION() view returns(bytes32)",
  "function releaseCredit(uint256 serviceCreditNumber,(uint64[] sourceBlocks,bytes[] encodedTransactions,(bytes32 root,(bytes32 hash,bool isLeft)[] siblings)[] merkleProofs,bytes32 lowerEndpointDigest,bytes32[] continuityRoots) proof)",
  "function refundServiceCredit(uint256 serviceCreditNumber)",
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
const PUBLIC_PILOT_VERSION = keccak256(toUtf8Bytes("RETRYCREDIT_PUBLIC_V2"));
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
      uniswapRetryCreditPoolVersion: 2,
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
      routeSignerWallet: new Wallet(deriveRoleKey(privateKey, "RETRYCREDIT_PUBLIC_ROUTE_SIGNER_V2")),
      relayerWallet: new Wallet(deriveRoleKey(privateKey, "RETRYCREDIT_PUBLIC_CC3_RELAYER_V2"), ccProvider),
    });
  }

  challenge(beneficiary, timeBucket = currentChallengeBucket(this.config.challengeWindowMs)) {
    const address = requireNonzeroAddress(beneficiary, "beneficiary");
    return {
      beneficiary: address,
      timeBucket,
      message: publicDemoChallengeMessage({
        origin: this.publicOrigin,
        beneficiary: address,
        timeBucket,
      }),
      expiresAt: (timeBucket + 1) * this.config.challengeWindowMs,
    };
  }

  async prepare({ beneficiary, timeBucket, signature }) {
    const ownership = this.verifyChallenge({ beneficiary, timeBucket, signature });
    const run = this.prepareQueue.then(() => this.#prepareAuthenticated(ownership.beneficiary));
    this.prepareQueue = run.catch(() => undefined);
    return run;
  }

  async readiness() {
    await this.#authenticateInfrastructure();
    return true;
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
      beneficiary: getAddress(rule.beneficiary),
      creditAmount: credit.creditAmount.toString(),
      refundAfter: Number(credit.refundAfter),
      policyId: String(rule.policyId).toLowerCase(),
      actionId: String(rule.actionId).toLowerCase(),
      sourceWindow: { startBlock: Number(rule.startBlock), endBlock: Number(rule.endBlock) },
    };
    const committed = await this.pool.getSourceTransactions(idValue);
    if (committed.failed !== "0x" && committed.successful !== "0x") {
      const failedTransactionHash = keccak256(committed.failed);
      const successfulTransactionHash = keccak256(committed.successful);
      const [failedReceipt, successfulReceipt] = await Promise.all([
        this.sepoliaProvider.getTransactionReceipt(failedTransactionHash),
        this.sepoliaProvider.getTransactionReceipt(successfulTransactionHash),
      ]);
      output.source = {
        failedTransactionHash,
        successfulTransactionHash,
        failedIncluded: failedReceipt != null,
        successfulIncluded: successfulReceipt != null,
      };
    }
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

  async execute(serviceCreditNumber) {
    const idValue = parseServiceCreditNumber(serviceCreditNumber);
    const existing = await this.status(idValue);
    if (existing.state !== "active") {
      if (existing.state === "released") {
        return {
          ...existing,
          failedTransactionHash: existing.source?.failedTransactionHash,
          successfulTransactionHash: existing.source?.successfulTransactionHash,
        };
      }
      throw new WorkerError("SERVICE_CREDIT_NOT_ACTIVE", "Service credit is not active", 409);
    }
    const [rule, committed] = await Promise.all([
      this.pool.getRule(idValue),
      this.pool.getSourceTransactions(idValue),
    ]);
    if (committed.failed === "0x" || committed.successful === "0x") {
      throw new WorkerError("SOURCE_TRANSACTIONS_MISSING", "The sponsored routes are not committed", 503);
    }
    const failedTransactionHash = keccak256(committed.failed);
    const successfulTransactionHash = keccak256(committed.successful);
    let failedReceipt = await this.sepoliaProvider.getTransactionReceipt(failedTransactionHash);
    let successfulReceipt = await this.sepoliaProvider.getTransactionReceipt(successfulTransactionHash);

    if (!failedReceipt) {
      await this.#requireSourceHeadroom(rule, "stale route");
      await broadcastIdempotently(this.sepoliaProvider, committed.failed, failedTransactionHash);
      failedReceipt = await waitForReceipt(this.sepoliaProvider, failedTransactionHash);
    }
    if (Number(failedReceipt.status) !== 0) {
      throw new WorkerError("STALE_ROUTE_DID_NOT_FAIL", "The stale route did not fail as bounded", 409);
    }
    if (
      Number(failedReceipt.blockNumber) < Number(rule.startBlock)
      || Number(failedReceipt.blockNumber) > Number(rule.endBlock)
      || BigInt(failedReceipt.gasUsed ?? 0) > BigInt(rule.maxFailureGasUsed)
    ) {
      throw new WorkerError("SOURCE_WINDOW_EXPIRED", "The stale route was not included inside the funded bounds", 409);
    }
    if (!successfulReceipt) {
      await this.#requireSourceHeadroom(rule, "refreshed route", Number(failedReceipt.blockNumber));
      await broadcastIdempotently(this.sepoliaProvider, committed.successful, successfulTransactionHash);
      successfulReceipt = await waitForReceipt(this.sepoliaProvider, successfulTransactionHash);
    }
    if (Number(successfulReceipt.status) !== 1) {
      throw new WorkerError("REFRESHED_ROUTE_DID_NOT_SETTLE", "The refreshed route did not settle", 409);
    }
    if (
      Number(successfulReceipt.blockNumber) <= Number(failedReceipt.blockNumber)
      || Number(successfulReceipt.blockNumber) - Number(failedReceipt.blockNumber) > Number(rule.maxBlockGap)
      || Number(successfulReceipt.blockNumber) > Number(rule.endBlock)
    ) {
      throw new WorkerError("SOURCE_WINDOW_EXPIRED", "The two routes did not land inside the funded source window", 409);
    }
    return {
      ...(await this.status(idValue)),
      failedTransactionHash,
      successfulTransactionHash,
    };
  }

  async release({ serviceCreditNumber, failedTransactionHash, successfulTransactionHash }) {
    const idValue = parseServiceCreditNumber(serviceCreditNumber);
    const existing = await this.status(idValue);
    if (existing.state === "released") return existing;
    if (existing.state !== "active") throw new WorkerError("SERVICE_CREDIT_NOT_ACTIVE", "Service credit is not active", 409);
    const failedHash = failedTransactionHash ?? existing.source?.failedTransactionHash;
    const successfulHash = successfulTransactionHash ?? existing.source?.successfulTransactionHash;
    if (!existing.source?.failedIncluded || !existing.source?.successfulIncluded) {
      throw new WorkerError("SOURCE_TRANSACTIONS_PENDING", "The sponsored routes are not both included yet", 425);
    }
    let prepared;
    try {
      prepared = await this.worker.prepareUniswapRetryCreditRelease({
        serviceCreditNumber: idValue,
        failedTransactionHash: failedHash,
        successfulTransactionHash: successfulHash,
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

  verifyChallenge({ beneficiary, timeBucket, signature }) {
    const address = requireNonzeroAddress(beneficiary, "beneficiary");
    const bucket = Number(timeBucket);
    const current = currentChallengeBucket(this.config.challengeWindowMs);
    if (!Number.isSafeInteger(bucket) || ![current, current - 1].includes(bucket)) {
      throw new WorkerError("CHALLENGE_EXPIRED", "Wallet challenge expired; sign a fresh one", 401);
    }
    if (typeof signature !== "string" || !isHexString(signature, 65)) {
      throw new WorkerError("INVALID_SIGNATURE", "A 65-byte wallet signature is required", 401);
    }
    const message = publicDemoChallengeMessage({ origin: this.publicOrigin, beneficiary: address, timeBucket: bucket });
    let recovered;
    try {
      recovered = verifyMessage(message, signature);
    } catch (error) {
      throw new WorkerError("INVALID_SIGNATURE", "Wallet challenge signature is invalid", 401, error);
    }
    if (getAddress(recovered) !== address) {
      throw new WorkerError("INVALID_SIGNATURE", "Wallet challenge was signed by a different address", 401);
    }
    return { beneficiary: address, timeBucket: bucket };
  }

  async #prepareAuthenticated(beneficiary) {
    await this.#authenticateInfrastructure();
    const count = Number(await this.pool.serviceCreditCount());
    const sourceHead = await this.sepoliaProvider.getBlockNumber();
    let sponsoredCount = 0;
    for (let idValue = 1; idValue <= count; idValue += 1) {
      const [credit, initialRule] = await Promise.all([
        this.pool.getServiceCredit(idValue),
        this.pool.getRule(idValue),
      ]);
      if (getAddress(credit.sponsor) !== this.sponsorWallet.address) continue;
      sponsoredCount += 1;
      let rule = initialRule;
      const belongsToBeneficiary = getAddress(rule.beneficiary) === beneficiary;
      const unresolved = !credit.released && !credit.refunded;
      if (unresolved && Number(credit.refundAfter) < Math.floor(Date.now() / 1000)) {
        const committed = await this.pool.getSourceTransactions(idValue);
        await this.#reclaimExpiredCredit(idValue, committed);
        continue;
      }
      if (unresolved && rule.policyId === ZERO_BYTES32) {
        const currentCcBlock = await this.ccProvider.getBlockNumber();
        if (currentCcBlock > Number(credit.creationBlock) + 256) {
          const committed = await this.pool.getSourceTransactions(idValue);
          await this.#reclaimExpiredCredit(idValue, committed);
          continue;
        }
      }
      if (belongsToBeneficiary && credit.released) return this.status(idValue);
      if (belongsToBeneficiary && unresolved) {
        if (rule.policyId === ZERO_BYTES32) {
          await waitForNextBlock(this.ccProvider, Number(credit.creationBlock));
          const activation = await this.pool.activateServiceCredit(idValue);
          const activationReceipt = await activation.wait();
          requireExactEvent(this.pool.interface, activationReceipt, "ServiceCreditActivated", this.poolAddress);
          rule = await this.pool.getRule(idValue);
        }
        const committed = await this.pool.getSourceTransactions(idValue);
        const sourceWindowOpen = sourceHead < Number(rule.endBlock)
          && Number(credit.refundAfter) > Math.floor(Date.now() / 1000);
        if (sourceWindowOpen && committed.failed === "0x" && committed.successful === "0x") {
          const quoteResult = await this.quoter.quoteExactInputSingle.staticCall({
            tokenIn: RETRY_CREDIT_UNISWAP_SEPOLIA.weth,
            tokenOut: RETRY_CREDIT_UNISWAP_SEPOLIA.usdc,
            amountIn: this.config.amountIn,
            fee: RETRY_CREDIT_UNISWAP_SEPOLIA.fee,
            sqrtPriceLimitX96: 0,
          });
          await this.#commitRoutes(idValue, rule, BigInt(quoteResult.amountOut ?? quoteResult[0]));
        }
        if (!sourceWindowOpen && committed.failed === "0x" && committed.successful === "0x") {
          throw new WorkerError(
            "DEMO_RECOVERING",
            "The previous source window closed; retry after its bounded service credit is refundable",
            409,
          );
        }
        return this.status(idValue);
      }
      if (unresolved) {
        throw new WorkerError("DEMO_BUSY", "Another sponsored recovery is completing; try again shortly", 409);
      }
    }
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
      ["RETRYCREDIT_PUBLIC_ACTION_V2", beneficiary, this.poolAddress, count + 1, ccBlock.number],
    ));
    const terms = {
      routeSigner: this.routeSignerWallet.address,
      trader: this.sourceFunderWallet.address,
      beneficiary,
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
    const sourceTransactionTerms = await this.#sourceTransactionTerms();
    const creation = await this.pool.createServiceCredit(terms, refundAfter, { value: this.config.creditAmount });
    const creationReceipt = await creation.wait();
    const draft = requireExactEvent(this.pool.interface, creationReceipt, "ServiceCreditDraftCreated", this.poolAddress);
    const serviceCreditNumber = Number(draft.serviceCreditNumber);
    await waitForNextBlock(this.ccProvider, creationReceipt.blockNumber);
    const activation = await this.pool.activateServiceCredit(serviceCreditNumber);
    const activationReceipt = await activation.wait();
    requireExactEvent(this.pool.interface, activationReceipt, "ServiceCreditActivated", this.poolAddress);
    const rule = await this.pool.getRule(serviceCreditNumber);

    const committed = await this.#commitRoutes(serviceCreditNumber, rule, quote, sourceTransactionTerms);
    return {
      serviceCreditNumber,
      trader: this.sourceFunderWallet.address,
      beneficiary,
      creditAmount: this.config.creditAmount.toString(),
      creationTransaction: creationReceipt.hash,
      activationTransaction: activationReceipt.hash,
      sourceCommitmentTransaction: committed.receipt.hash,
      policyId: String(rule.policyId).toLowerCase(),
      actionId,
      sourceWindow: { startBlock, endBlock },
      quote: quote.toString(),
      transactions: {
        failedTransactionHash: committed.routes.failed.transactionHash,
        successfulTransactionHash: committed.routes.successful.transactionHash,
      },
    };
  }

  async #reclaimExpiredCredit(serviceCreditNumber, committed) {
    if (committed.failed !== "0x") await this.#consumeSourceNonce(committed.failed);
    if (committed.successful !== "0x") await this.#consumeSourceNonce(committed.successful);

    const refund = await this.pool.refundServiceCredit(serviceCreditNumber);
    const receipt = await refund.wait();
    if (!receipt || Number(receipt.status) !== 1) {
      throw new WorkerError("DEMO_RECOVERY_FAILED", "An expired sponsored recovery could not be reclaimed", 503);
    }
  }

  async #consumeSourceNonce(rawTransaction) {
    const committed = Transaction.from(rawTransaction);
    if (getAddress(committed.from) !== this.sourceFunderWallet.address) {
      throw new WorkerError("DEMO_RECOVERY_FAILED", "Committed source transaction signer is invalid", 503);
    }
    const latestNonce = await this.sepoliaProvider.getTransactionCount(this.sourceFunderWallet.address, "latest");
    if (latestNonce > committed.nonce) return;
    if (latestNonce < committed.nonce) {
      throw new WorkerError("DEMO_RECOVERY_FAILED", "Committed source nonce cannot be reclaimed safely", 503);
    }

    const fee = await this.sepoliaProvider.getFeeData();
    const maxPriorityFeePerGas = maxBigInt(
      BigInt(fee.maxPriorityFeePerGas ?? 0n) * 2n,
      BigInt(committed.maxPriorityFeePerGas ?? 0n) * 2n,
      1n,
    );
    const maxFeePerGas = maxBigInt(
      BigInt(fee.maxFeePerGas ?? 0n) * 2n,
      BigInt(committed.maxFeePerGas ?? 0n) * 2n,
      maxPriorityFeePerGas,
    );

    const replacementRaw = await this.sourceFunderWallet.signTransaction({
      type: 2,
      chainId: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId,
      nonce: committed.nonce,
      to: this.sourceFunderWallet.address,
      value: 0,
      data: "0x",
      gasLimit: 21_000,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    const replacementHash = keccak256(replacementRaw);
    try {
      await broadcastIdempotently(this.sepoliaProvider, replacementRaw, replacementHash);
      await waitForReceipt(this.sepoliaProvider, replacementHash);
    } catch (error) {
      const updatedNonce = await this.sepoliaProvider.getTransactionCount(this.sourceFunderWallet.address, "latest");
      if (updatedNonce <= committed.nonce) throw error;
    }
  }

  async #commitRoutes(serviceCreditNumber, rule, quote, sourceTransactionTerms) {
    const routes = await this.#signedRouteBundle(
      rule,
      quote,
      sourceTransactionTerms ?? await this.#sourceTransactionTerms(),
    );
    const sourceCommitment = await this.pool.commitSourceTransactions(
      serviceCreditNumber,
      routes.failed.rawTransaction,
      routes.successful.rawTransaction,
    );
    const receipt = await sourceCommitment.wait();
    requireExactEvent(this.pool.interface, receipt, "SourceTransactionsCommitted", this.poolAddress);
    return { routes, receipt };
  }

  async #signedRouteBundle(rule, quote, sourceTransactionTerms) {
    const intent = computeUniswapRetryCreditIntent(rule);
    const now = Math.floor(Date.now() / 1000);
    const failureMinimum = quote * 2n;
    const successMinimum = quote * 90n / 100n;
    if (successMinimum < BigInt(rule.minimumSuccessfulOut)) {
      throw new WorkerError("ROUTE_LIQUIDITY_UNAVAILABLE", "The refreshed route no longer meets the funded minimum", 409);
    }
    const { chainId, fee, sourceNonce } = sourceTransactionTerms;
    return {
      failed: await this.#signedRouteTransaction({
        rule,
        intent,
        data: zeroPadValue("0x01", 32),
        nonce: keccak256(abiCoder.encode(["bytes32", "string"], [rule.actionId, "failure"])),
        deadline: now + 3600,
        amountOutMinimum: failureMinimum,
        transactionNonce: sourceNonce,
        chainId,
        fee,
      }),
      successful: await this.#signedRouteTransaction({
        rule,
        intent,
        data: zeroPadValue("0x02", 32),
        nonce: keccak256(abiCoder.encode(["bytes32", "string"], [rule.actionId, "success"])),
        deadline: now + 3660,
        amountOutMinimum: successMinimum,
        transactionNonce: sourceNonce + 1,
        chainId,
        fee,
      }),
    };
  }

  async #sourceTransactionTerms() {
    const [network, feeData, sourceNonce, sourceBalance] = await Promise.all([
      this.sepoliaProvider.getNetwork(),
      this.sepoliaProvider.getFeeData(),
      this.sepoliaProvider.getTransactionCount(this.sourceFunderWallet.address, "pending"),
      this.sepoliaProvider.getBalance(this.sourceFunderWallet.address),
    ]);
    const fee = feeData.maxFeePerGas && feeData.maxPriorityFeePerGas
      ? {
          type: 2,
          maxFeePerGas: feeData.maxFeePerGas * 2n,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 2n,
        }
      : { gasPrice: (feeData.gasPrice ?? 1_000_000_000n) * 2n };
    const maximumGasPrice = fee.maxFeePerGas ?? fee.gasPrice;
    const requiredBalance = 2n * (
      this.config.sourceGasLimit * maximumGasPrice
      + this.config.amountIn
    );
    if (sourceBalance < requiredBalance) {
      throw new WorkerError("SOURCE_FAUCET_EMPTY", "The bounded Sepolia demo faucet is temporarily empty", 503);
    }
    return { chainId: Number(network.chainId), fee, sourceNonce };
  }

  async #signedRouteTransaction({
    rule,
    intent,
    data,
    nonce,
    deadline,
    amountOutMinimum,
    transactionNonce,
    chainId,
    fee,
  }) {
    const pathValue = `0x${RETRY_CREDIT_UNISWAP_SEPOLIA.weth.slice(2)}0001f4${RETRY_CREDIT_UNISWAP_SEPOLIA.usdc.slice(2)}`;
    const inputs = [
      abiCoder.encode(
        ["address", "uint256"],
        ["0x0000000000000000000000000000000000000002", rule.amountIn],
      ),
      abiCoder.encode(
        ["address", "uint256", "uint256", "bytes", "bool", "uint256[]"],
        [rule.beneficiary, rule.amountIn, amountOutMinimum, pathValue, false, []],
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
    const transaction = {
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
      value: rule.amountIn,
      gasLimit: this.config.sourceGasLimit,
      nonce: transactionNonce,
      chainId,
      ...fee,
    };
    const rawTransaction = await this.sourceFunderWallet.signTransaction(transaction);
    return {
      rawTransaction,
      transactionHash: keccak256(rawTransaction),
      amountOutMinimum: amountOutMinimum.toString(),
    };
  }

  async #requireSourceHeadroom(rule, label, afterBlock = null) {
    const current = await this.sepoliaProvider.getBlockNumber();
    if (current < Number(rule.startBlock)) {
      throw new WorkerError("SOURCE_WINDOW_NOT_OPEN", `The ${label} window is not open yet`, 425);
    }
    if (current >= Number(rule.endBlock)) {
      throw new WorkerError("SOURCE_WINDOW_EXPIRED", `The ${label} window expired`, 409);
    }
    if (afterBlock != null && current - afterBlock >= Number(rule.maxBlockGap)) {
      throw new WorkerError("SOURCE_WINDOW_EXPIRED", `The ${label} block gap expired`, 409);
    }
  }

  async #authenticateInfrastructure() {
    const [poolVerifier, poolPredicate, poolChainInfo, pilotVersion, keyValue, idValue, verifierPredicate, nativeVerifier] = await Promise.all([
      this.pool.retryVerifier(),
      this.pool.predicate(),
      this.pool.chainInfo(),
      this.pool.PUBLIC_PILOT_VERSION(),
      this.verifier.sourceChainKey(),
      this.verifier.sourceChainId(),
      this.verifier.predicate(),
      this.verifier.verifier(),
    ]);
    if (
      getAddress(poolVerifier) !== this.verifierAddress
      || getAddress(poolPredicate) !== getAddress(verifierPredicate)
      || getAddress(poolChainInfo) !== CHAIN_INFO
      || String(pilotVersion).toLowerCase() !== PUBLIC_PILOT_VERSION
      || Number(keyValue) !== RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainKey
      || Number(idValue) !== RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId
      || getAddress(nativeVerifier) !== getAddress("0x0000000000000000000000000000000000000fd2")
    ) throw new WorkerError("PUBLIC_DEMO_MISCONFIGURED", "Public RetryCredit infrastructure is not authentic", 503);
  }
}

export function publicDemoChallengeMessage({ origin, beneficiary, timeBucket }) {
  return [
    "RetryCredit public demo",
    `Origin: ${new URL(origin).origin}`,
    `Credit recipient: ${getAddress(beneficiary)}`,
    `Window: ${Number(timeBucket)}`,
    "Authorize one bounded testnet service credit. No mainnet transaction or token approval.",
  ].join("\n");
}

async function broadcastIdempotently(provider, rawTransaction, expectedHash) {
  if (await provider.getTransactionReceipt(expectedHash)) return;
  try {
    const pending = await provider.broadcastTransaction(rawTransaction);
    if (pending.hash.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new Error("broadcast transaction hash does not match the committed source transaction");
    }
  } catch (error) {
    if (!await provider.getTransaction(expectedHash)) throw error;
  }
}

async function waitForReceipt(provider, transactionHash) {
  const receipt = await provider.waitForTransaction(transactionHash, 1, 120_000);
  if (!receipt) throw new WorkerError("SOURCE_TRANSACTION_TIMEOUT", "A sponsored source transaction timed out", 503);
  return receipt;
}

export function deriveRoleKey(privateKey, label) {
  const value = keccak256(concat([getBytes(privateKey), toUtf8Bytes(label)]));
  if (/^0x0+$/.test(value)) throw new Error(`derived an invalid ${label} key`);
  return value;
}

function currentChallengeBucket(windowMs) {
  return Math.floor(Date.now() / windowMs);
}

function maxBigInt(...values) {
  return values.reduce((maximum, value) => value > maximum ? value : maximum, 0n);
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
