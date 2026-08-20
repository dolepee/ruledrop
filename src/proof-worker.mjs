import {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
  formatEther,
  formatUnits,
  getAddress,
  id,
  isHexString,
  keccak256,
  verifyTypedData,
  zeroPadValue,
} from "ethers";
import { proofProvider } from "@gluwa/usc-sdk";

export const ETHEREUM_CHAIN_KEY = 3;
export const SEPOLIA_CHAIN_KEY = 1;
export const CREDITCOIN_CHAIN_ID = 102031;
export const CANONICAL_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const TRANSFER_SELECTOR = "0xa9059cbb";
export const CLAIM_TEMPLATES = Object.freeze({ TRANSFER: 0, INTERACTION: 1 });
export const PAYOUT_POLICIES = Object.freeze({ EQUAL: 0, SOURCE_AMOUNT_WEIGHTED: 1 });

const DEFAULT_PROOF_BUILDER = "https://prover.cc3-testnet.creditcoin.network";
const DEFAULT_CREDITCOIN_RPC = "https://rpc.cc3-testnet.creditcoin.network";
const RETRY_CREDIT_NATIVE_VERIFIER = "0x0000000000000000000000000000000000000FD2";
const RETRY_CREDIT_NATIVE_CHAIN_INFO = "0x0000000000000000000000000000000000000fD3";
const RETRY_BATCH_SIZE = 2;
const MAX_BATCH_BLOCK_SPAN = 1_000;
const abiCoder = AbiCoder.defaultAbiCoder();
const RETRY_CREDIT_CHECKOUT_ABI = [
  "function checkout((uint256 sourceChainId,address target,address beneficiary,address settlementAsset,address settlementRecipient,bytes32 policyId,bytes32 actionId,uint64 quoteVersion,uint256 settledValue,bytes32 payloadHash,uint64 validUntil) attempt,bytes payload,bytes attemptSignature)",
];
const RETRY_CREDIT_POOL_ABI = [
  "function getRule(uint256 serviceCreditNumber) view returns ((address attemptSigner,address beneficiary,address target,address settlementAsset,address settlementRecipient,bytes32 policyId,bytes32 actionId,uint256 minimumSettledValue,uint64 startBlock,uint64 endBlock,uint32 maxBlockGap,uint64 minimumAttemptGasLimit,uint64 maxFailureGasUsed))",
  "function getServiceCredit(uint256 serviceCreditNumber) view returns ((address sponsor,uint256 creditAmount,uint64 refundAfter,uint256 creationBlock,bytes32 termsHash,bool released,bool refunded))",
  "function sourceChainKey() view returns (uint64)",
  "function sourceChainId() view returns (uint64)",
  "function retryVerifier() view returns (address)",
  "function predicate() view returns (address)",
  "function chainInfo() view returns (address)",
  "function releaseCredit(uint256 serviceCreditNumber,(uint64[] sourceBlocks,bytes[] encodedTransactions,(bytes32 root,(bytes32 hash,bool isLeft)[] siblings)[] merkleProofs,bytes32 lowerEndpointDigest,bytes32[] continuityRoots) proof)",
];
const RETRY_CREDIT_VERIFIER_ABI = [
  "function sourceChainKey() view returns (uint64)",
  "function sourceChainId() view returns (uint64)",
  "function predicate() view returns (address)",
  "function verifier() view returns (address)",
];
const retryCreditCheckoutInterface = new Interface(RETRY_CREDIT_CHECKOUT_ABI);
const RETRY_CREDIT_CHECKOUT_SELECTOR = retryCreditCheckoutInterface.getFunction("checkout").selector;
const RETRY_CREDIT_SETTLED_EVENT = id(
  "CheckoutSettled(bytes32,bytes32,address,address,address,uint256,bytes32,uint64)",
);
const ERC20_TRANSFER_EVENT = id("Transfer(address,address,uint256)");
const RETRY_CREDIT_DOMAIN = Object.freeze({ name: "RetryCredit Checkout", version: "1" });
const RETRY_CREDIT_TYPES = Object.freeze({
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
});
const SOURCE_CHAIN_IDS = Object.freeze({
  [ETHEREUM_CHAIN_KEY]: 1,
  [SEPOLIA_CHAIN_KEY]: 11_155_111,
});

export class WorkerError extends Error {
  constructor(code, message, status = 400, cause) {
    super(message, { cause });
    this.name = "WorkerError";
    this.code = code;
    this.status = status;
  }
}

export class ExpiringCache {
  constructor({ ttlMs = 15 * 60_000, maxEntries = 100 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return value;
  }
}

export function validateTransactionHash(value) {
  if (typeof value !== "string" || !isHexString(value, 32)) {
    throw new WorkerError("INVALID_TRANSACTION_HASH", "A 32-byte Ethereum transaction hash is required");
  }
  return value.toLowerCase();
}

export function validateAddress(value, label = "address") {
  try {
    return getAddress(value);
  } catch (error) {
    throw new WorkerError("INVALID_ADDRESS", `Invalid ${label}`, 400, error);
  }
}

export function toContractProof(proof) {
  return {
    sourceBlock: proof.headerNumber,
    encodedTransaction: proof.txBytes,
    merkleRoot: proof.merkleProof.root,
    siblings: proof.merkleProof.siblings,
    lowerEndpointDigest: proof.continuityProof.lowerEndpointDigest,
    continuityRoots: proof.continuityProof.roots,
  };
}

export function decodeAttestedTransaction(encodedTransaction) {
  return decodeAttestedTransactionEnvelope(encodedTransaction).metadata;
}

function decodeAttestedTransactionEnvelope(encodedTransaction) {
  try {
    if (!isHexString(encodedTransaction) || encodedTransaction === "0x") {
      throw new Error("empty or non-hex encoded transaction");
    }
    const [transactionTypeValue, chunksValue] = abiCoder.decode(["uint8", "bytes[]"], encodedTransaction);
    const transactionType = Number(transactionTypeValue);
    const chunks = Array.from(chunksValue);
    const expectedChunkCount = transactionType <= 2 ? 3 : 4;
    if (!Number.isInteger(transactionType) || transactionType < 0 || transactionType > 4) {
      throw new Error(`unsupported EVM transaction type ${transactionType}`);
    }
    if (chunks.length !== expectedChunkCount) {
      throw new Error(`invalid chunk count ${chunks.length} for EVM transaction type ${transactionType}`);
    }

    const [nonce, gasLimit, sender, toIsNull, target, value, data] = abiCoder.decode(
      ["uint64", "uint64", "address", "bool", "address", "uint256", "bytes"],
      chunks[0],
    );
    const receiptChunk = chunks[expectedChunkCount - 1];
    const [receiptStatus, receiptGasUsed, receiptLogs] = abiCoder.decode(
      ["uint8", "uint64", "tuple(address address_,bytes32[] topics,bytes data)[]", "bytes"],
      receiptChunk,
    );
    const calldata = String(data).toLowerCase();

    return {
      metadata: {
        transactionType,
        nonce: nonce.toString(),
        gasLimit: gasLimit.toString(),
        sender: getAddress(sender),
        target: toIsNull ? null : getAddress(target),
        value: value.toString(),
        selector: calldata.length >= 10 ? calldata.slice(0, 10) : "0x",
        calldataHash: keccak256(calldata),
        receiptStatus: Number(receiptStatus),
        receiptGasUsed: receiptGasUsed.toString(),
        logCount: receiptLogs.length,
      },
      calldata,
      receiptLogs: Array.from(receiptLogs, (entry) => ({
        address: getAddress(entry.address_),
        topics: Array.from(entry.topics, (topic) => String(topic).toLowerCase()),
        data: String(entry.data).toLowerCase(),
      })),
    };
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError("BATCH_PROOF_INVALID", "The Attestcoin proof contains an invalid encoded transaction", 502, error);
  }
}

export function toContractBatchProof(batchProof) {
  return {
    sourceBlocks: batchProof.entries.map((entry) => entry.sourceBlock),
    encodedTransactions: batchProof.entries.map((entry) => entry.encodedTransaction),
    merkleProofs: batchProof.entries.map((entry) => entry.merkleProof),
    lowerEndpointDigest: batchProof.continuityProof.lowerEndpointDigest,
    continuityRoots: batchProof.continuityProof.roots,
  };
}

export function serializeCampaign(campaign, campaignId, now = Math.floor(Date.now() / 1000)) {
  const registrationDeadline = Number(campaign.registrationDeadline);
  const withdrawalDeadline = Number(campaign.withdrawalDeadline);
  const claimTemplate = Number(campaign.claimTemplate ?? CLAIM_TEMPLATES.TRANSFER);
  const payoutPolicy = Number(campaign.payoutPolicy ?? PAYOUT_POLICIES.EQUAL);
  return {
    id: Number(campaignId),
    sponsor: campaign.sponsor,
    recipient: campaign.recipient,
    minimumAmount: campaign.minimumAmount.toString(),
    minimumAmountUsdc: formatUnits(campaign.minimumAmount, 6),
    maximumWeight: (campaign.maximumWeight ?? 0n).toString(),
    startBlock: Number(campaign.startBlock),
    endBlock: Number(campaign.endBlock),
    registrationDeadline,
    withdrawalDeadline,
    fundedPool: campaign.fundedPool.toString(),
    fundedPoolTctc: formatEther(campaign.fundedPool),
    claimantCount: Number(campaign.claimantCount),
    totalWeight: (campaign.totalWeight ?? BigInt(campaign.claimantCount)).toString(),
    sharePerClaim: campaign.sharePerClaim.toString(),
    totalPaid: (campaign.totalPaid ?? (BigInt(campaign.withdrawnCount) * campaign.sharePerClaim)).toString(),
    withdrawnCount: Number(campaign.withdrawnCount),
    claimTemplate,
    claimTemplateName: claimTemplate === CLAIM_TEMPLATES.INTERACTION ? "contract-interaction" : "direct-usdc-transfer",
    payoutPolicy,
    payoutPolicyName: payoutPolicy === PAYOUT_POLICIES.SOURCE_AMOUNT_WEIGHTED ? "source-amount-weighted" : "equal-pro-rata",
    finalized: campaign.finalized,
    registrationOpen: !campaign.finalized && now <= registrationDeadline,
    withdrawalOpen: campaign.finalized && now <= withdrawalDeadline,
  };
}

export class RuleDropWorker {
  constructor({
    poolAddress,
    poolAbi,
    creditcoinRpc = DEFAULT_CREDITCOIN_RPC,
    proofBuilderUrl = DEFAULT_PROOF_BUILDER,
    ethereumProviders = [],
    cache = new ExpiringCache(),
    proofAttempts = 3,
    proofBuilder,
    creditcoinProvider,
    poolContract,
    sourceChainKey = ETHEREUM_CHAIN_KEY,
    sourceChainId,
    retryCreditPoolAddress,
    retryCreditPoolContract,
    retryCreditVerifierContract,
  }) {
    this.poolAddress = validateAddress(poolAddress, "pool address");
    this.poolAbi = poolAbi;
    this.poolInterface = new Interface(poolAbi);
    this.creditcoinProvider = creditcoinProvider ?? new JsonRpcProvider(creditcoinRpc, CREDITCOIN_CHAIN_ID, { staticNetwork: true });
    this.pool = poolContract ?? new Contract(this.poolAddress, poolAbi, this.creditcoinProvider);
    this.sourceChainKey = validateSourceChainKey(sourceChainKey);
    this.sourceChainId = validateSourceChainId(sourceChainId ?? SOURCE_CHAIN_IDS[this.sourceChainKey]);
    this.retryCreditPoolAddress = retryCreditPoolAddress
      ? validateAddress(retryCreditPoolAddress, "RetryCredit pool address")
      : null;
    this.retryCreditPool = retryCreditPoolContract
      ?? (this.retryCreditPoolAddress
        ? new Contract(this.retryCreditPoolAddress, RETRY_CREDIT_POOL_ABI, this.creditcoinProvider)
        : null);
    this.retryCreditPoolInterface = new Interface(RETRY_CREDIT_POOL_ABI);
    this.retryCreditVerifierContract = retryCreditVerifierContract ?? null;
    this.proofBuilder = proofBuilder
      ?? new proofProvider.service.ProofBuilder(this.sourceChainKey, proofBuilderUrl, 120_000);
    this.ethereumProviders = ethereumProviders;
    this.cache = cache;
    this.proofAttempts = proofAttempts;
  }

  async getCampaign(campaignId, claimant) {
    const id = parseCampaignId(campaignId);
    let campaign;
    try {
      campaign = await this.pool.getCampaign(id);
    } catch (error) {
      if (error.code === "CALL_EXCEPTION") {
        throw new WorkerError("CAMPAIGN_NOT_FOUND", `Campaign ${id} was not found`, 404, error);
      }
      throw new WorkerError("CREDITCOIN_RPC_UNAVAILABLE", "Campaign state is temporarily unavailable", 503, error);
    }
    const output = serializeCampaign(campaign, id);
    if (output.claimTemplate === CLAIM_TEMPLATES.INTERACTION) {
      try {
        const rule = await this.pool.getInteractionRule(id);
        output.interactionRule = serializeInteractionRule(rule);
      } catch (error) {
        throw new WorkerError("CREDITCOIN_RPC_UNAVAILABLE", "Interaction rule state is temporarily unavailable", 503, error);
      }
    }
    if (claimant) {
      const address = validateAddress(claimant, "claimant address");
      const [registered, withdrawn] = await Promise.all([
        this.pool.registered(id, address),
        this.pool.withdrawn(id, address),
      ]);
      output.claimant = { address, registered, withdrawn };
    }
    return output;
  }

  async getLatestCampaign(claimant) {
    let count;
    try {
      count = await this.pool.campaignCount();
    } catch (error) {
      throw new WorkerError("CREDITCOIN_RPC_UNAVAILABLE", "Latest campaign state is temporarily unavailable", 503, error);
    }
    if (count === 0n) throw new WorkerError("CAMPAIGN_NOT_FOUND", "No campaign has been published", 404);
    return this.getCampaign(count, claimant);
  }

  async prepareClaim({ campaignId, transactionHash, claimant }) {
    const id = parseCampaignId(campaignId);
    const hash = validateTransactionHash(transactionHash);
    const address = validateAddress(claimant, "claimant address");
    const campaign = await this.getCampaign(id, address);
    if (!campaign.registrationOpen) {
      throw new WorkerError("REGISTRATION_CLOSED", `Campaign ${id} is not accepting registrations`, 409);
    }
    if (campaign.claimant.registered) {
      throw new WorkerError("ALREADY_REGISTERED", "This wallet is already registered", 409);
    }

    const source = await this.fetchSourceTransaction(hash);
    if (source) this.validateSourceHints(source, campaign, address);

    const proof = await this.getProof(hash);
    if (Number(proof.headerNumber) < campaign.startBlock || Number(proof.headerNumber) > campaign.endBlock) {
      throw new WorkerError("BLOCK_OUTSIDE_CAMPAIGN", "The source transaction is outside the campaign block range");
    }
    const contractProof = toContractProof(proof);
    const registrationFunction = campaign.claimTemplate === CLAIM_TEMPLATES.INTERACTION
      ? "registerInteractionClaim"
      : "registerClaim";
    try {
      await this.pool[registrationFunction].staticCall(id, contractProof, {
        from: address,
        gasLimit: 5_000_000n,
      });
    } catch (error) {
      throw new WorkerError("CLAIM_SIMULATION_REJECTED", explainSimulationError(error), 422, error);
    }

    return {
      campaign,
      source: source ? summarizeSource(source) : { transactionHash: hash },
      proof: {
        sourceBlock: Number(proof.headerNumber),
        merkleSiblingCount: proof.merkleProof.siblings.length,
        continuityRootCount: proof.continuityProof.roots.length,
      },
      transaction: {
        from: address,
        to: this.poolAddress,
        data: this.poolInterface.encodeFunctionData(registrationFunction, [id, contractProof]),
        gas: "0x4c4b40",
        value: "0x0",
      },
      simulationPassed: true,
    };
  }

  async getProof(transactionHash) {
    const cached = this.cache.get(transactionHash);
    if (cached) return cached;

    let lastError;
    for (let attempt = 1; attempt <= this.proofAttempts; attempt += 1) {
      try {
        const result = await this.proofBuilder.getProof(transactionHash);
        if (!result.success) throw new Error(result.error || "Proof builder rejected the request");
        return this.cache.set(transactionHash, result.data);
      } catch (error) {
        lastError = error;
        if (attempt < this.proofAttempts) await delay(250 * 2 ** (attempt - 1));
      }
    }
    throw new WorkerError("PROOF_UNAVAILABLE", "The Attestcoin proof service is temporarily unavailable", 503, lastError);
  }

  async getRetryCreditBatchProof({ failedTransactionHash, successfulTransactionHash, serviceCreditNumber }) {
    const hashes = validateRetryBatchHashes(failedTransactionHash, successfulTransactionHash);
    const state = await this.getRetryCreditState(serviceCreditNumber);
    const expectedRule = state.rule;
    const cacheKey = [
      "retry-credit-batch",
      this.retryCreditPoolAddress,
      state.serviceCreditNumber,
      this.sourceChainKey,
      this.sourceChainId,
      ...hashes,
    ].join(":");
    const cached = this.cache.get(cacheKey);
    if (cached) {
      validateRetryCreditRule(cached, expectedRule);
      return cached;
    }

    let lastError;
    for (let attempt = 1; attempt <= this.proofAttempts; attempt += 1) {
      try {
        const result = await this.proofBuilder.getBatchProof(hashes);
        if (!result.success || !result.data) {
          throw new Error(result.error || "Proof builder rejected the batch request");
        }
        const normalized = normalizeRetryCreditBatchProof(
          result.data,
          hashes,
          this.sourceChainKey,
          this.sourceChainId,
        );
        validateRetryCreditRule(normalized, expectedRule);
        return this.cache.set(cacheKey, freezeDeep(normalized));
      } catch (error) {
        if (error instanceof WorkerError) throw error;
        lastError = error;
        if (attempt < this.proofAttempts) await delay(250 * 2 ** (attempt - 1));
      }
    }
    throw new WorkerError("BATCH_PROOF_UNAVAILABLE", "The Attestcoin batch proof service is temporarily unavailable", 503, lastError);
  }

  async prepareRetryCreditRelease({
    serviceCreditNumber,
    failedTransactionHash,
    successfulTransactionHash,
    relayer,
  }) {
    const id = parseServiceCreditNumber(serviceCreditNumber);
    const sender = validateAddress(relayer, "RetryCredit relayer address");
    if (/^0x0{40}$/i.test(sender)) {
      throw new WorkerError("INVALID_ADDRESS", "RetryCredit relayer address must be nonzero");
    }
    const batchProof = await this.getRetryCreditBatchProof({
      serviceCreditNumber: id,
      failedTransactionHash,
      successfulTransactionHash,
    });
    const contractProof = toContractBatchProof(batchProof);
    try {
      await this.retryCreditPool.releaseCredit.staticCall(id, contractProof, {
        from: sender,
        gasLimit: 8_000_000n,
      });
    } catch (error) {
      throw new WorkerError(
        "RETRY_CREDIT_SIMULATION_REJECTED",
        explainSimulationError(error),
        422,
        error,
      );
    }
    return {
      serviceCreditNumber: id,
      poolAddress: this.retryCreditPoolAddress,
      proof: batchProof.summary,
      transaction: {
        from: sender,
        to: this.retryCreditPoolAddress,
        data: this.retryCreditPoolInterface.encodeFunctionData("releaseCredit", [id, contractProof]),
        gas: "0x7a1200",
        value: "0x0",
      },
      simulationPassed: true,
    };
  }

  async getRetryCreditState(serviceCreditNumber) {
    const id = parseServiceCreditNumber(serviceCreditNumber);
    if (!this.retryCreditPool || !this.retryCreditPoolAddress) {
      throw new WorkerError(
        "RETRY_CREDIT_NOT_CONFIGURED",
        "A source-bound RetryCredit pool is not configured",
        503,
      );
    }
    try {
      if (this.retryCreditPool.target && getAddress(this.retryCreditPool.target) !== this.retryCreditPoolAddress) {
        throw new Error("configured RetryCredit pool contract does not match its transaction target");
      }
      const [
        ruleValue,
        credit,
        poolChainKeyValue,
        poolChainIdValue,
        verifierAddressValue,
        poolPredicateValue,
        chainInfoValue,
      ] =
        await Promise.all([
          this.retryCreditPool.getRule(id),
          this.retryCreditPool.getServiceCredit(id),
          this.retryCreditPool.sourceChainKey(),
          this.retryCreditPool.sourceChainId(),
          this.retryCreditPool.retryVerifier(),
          this.retryCreditPool.predicate(),
          this.retryCreditPool.chainInfo(),
        ]);
      const poolChainKey = validateSourceChainKey(poolChainKeyValue);
      const poolChainId = validateSourceChainId(poolChainIdValue);
      if (poolChainKey !== this.sourceChainKey || poolChainId !== this.sourceChainId) {
        throw new Error("RetryCredit pool source-chain immutables do not match the worker");
      }
      const verifierAddress = getAddress(verifierAddressValue);
      const poolPredicate = getAddress(poolPredicateValue);
      const chainInfo = getAddress(chainInfoValue);
      if (/^0x0{40}$/i.test(verifierAddress) || /^0x0{40}$/i.test(poolPredicate)) {
        throw new Error("RetryCredit pool returned a zero verifier or predicate");
      }
      if (chainInfo !== getAddress(RETRY_CREDIT_NATIVE_CHAIN_INFO)) {
        throw new Error("RetryCredit pool is not bound to the native ChainInfo precompile");
      }
      const verifier = this.retryCreditVerifierContract
        ?? new Contract(verifierAddress, RETRY_CREDIT_VERIFIER_ABI, this.creditcoinProvider);
      if (verifier.target && getAddress(verifier.target) !== verifierAddress) {
        throw new Error("configured RetryCredit verifier does not match the pool");
      }
      const [verifierChainKeyValue, verifierChainIdValue, verifierPredicateValue, nativeVerifierValue] = await Promise.all([
        verifier.sourceChainKey(),
        verifier.sourceChainId(),
        verifier.predicate(),
        verifier.verifier(),
      ]);
      if (
        validateSourceChainKey(verifierChainKeyValue) !== poolChainKey
        || validateSourceChainId(verifierChainIdValue) !== poolChainId
        || getAddress(verifierPredicateValue) !== poolPredicate
        || getAddress(nativeVerifierValue) !== getAddress(RETRY_CREDIT_NATIVE_VERIFIER)
      ) {
        throw new Error("RetryCredit verifier immutables do not match the pool");
      }
      if (credit.released || credit.refunded || /^0x0{40}$/i.test(getAddress(credit.sponsor))) {
        throw new Error("RetryCredit service credit is missing or already resolved");
      }
      const rule = normalizeRetryCreditRule(ruleValue);
      return { serviceCreditNumber: id, rule, credit, verifierAddress, poolPredicate };
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError(
        "RETRY_CREDIT_STATE_UNAVAILABLE",
        "The funded RetryCredit rule could not be authenticated",
        503,
        error,
      );
    }
  }

  async fetchSourceTransaction(transactionHash) {
    if (this.ethereumProviders.length === 0) return null;
    let lastError;
    for (const provider of this.ethereumProviders) {
      try {
        const network = await provider.getNetwork();
        if (network.chainId !== 1n) throw new Error(`unexpected Ethereum chain ${network.chainId}`);
        const [transaction, receipt] = await Promise.all([
          provider.getTransaction(transactionHash),
          provider.getTransactionReceipt(transactionHash),
        ]);
        if (!transaction || !receipt) throw new Error("transaction or receipt not found");
        return { transaction, receipt };
      } catch (error) {
        lastError = error;
      }
    }
    throw new WorkerError("ETHEREUM_RPC_UNAVAILABLE", "Ethereum transaction lookup failed on every configured RPC", 503, lastError);
  }

  validateSourceHints(source, campaign, claimant) {
    const { transaction, receipt } = source;
    if (receipt.status !== 1) throw new WorkerError("SOURCE_TRANSACTION_REVERTED", "The Ethereum transaction reverted");
    if (getAddress(transaction.from) !== claimant) {
      throw new WorkerError("SOURCE_SENDER_MISMATCH", "The connected wallet did not send this transaction");
    }
    if (campaign.claimTemplate === CLAIM_TEMPLATES.INTERACTION) {
      if (!transaction.to || getAddress(transaction.to) !== campaign.interactionRule.target) {
        throw new WorkerError("SOURCE_TARGET_MISMATCH", "The transaction does not call the campaign contract");
      }
      if (!transaction.data.toLowerCase().startsWith(campaign.interactionRule.selector.toLowerCase())) {
        throw new WorkerError("SOURCE_FUNCTION_MISMATCH", "The transaction does not call the required function");
      }
    } else {
      if (!transaction.to || getAddress(transaction.to) !== CANONICAL_USDC) {
        throw new WorkerError("SOURCE_TOKEN_MISMATCH", "The transaction does not call canonical Ethereum USDC");
      }
      if (!transaction.data.toLowerCase().startsWith(TRANSFER_SELECTOR)) {
        throw new WorkerError("SOURCE_FUNCTION_MISMATCH", "The transaction is not a direct USDC transfer");
      }
    }
    if (receipt.blockNumber < campaign.startBlock || receipt.blockNumber > campaign.endBlock) {
      throw new WorkerError("BLOCK_OUTSIDE_CAMPAIGN", "The source transaction is outside the campaign block range");
    }
  }
}

function validateRetryBatchHashes(failedTransactionHash, successfulTransactionHash) {
  const hashes = [
    validateTransactionHash(failedTransactionHash),
    validateTransactionHash(successfulTransactionHash),
  ];
  if (new Set(hashes).size !== RETRY_BATCH_SIZE) {
    throw new WorkerError("DUPLICATE_TRANSACTION_HASH", "Failure and retry transaction hashes must be different");
  }
  return hashes;
}

function validateSourceChainKey(value) {
  const chainKey = Number(value);
  if (!Number.isSafeInteger(chainKey) || chainKey <= 0) {
    throw new WorkerError("INVALID_SOURCE_CHAIN", "A positive Attestcoin source chain key is required");
  }
  return chainKey;
}

function validateSourceChainId(value) {
  const chainId = Number(value);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new WorkerError("INVALID_SOURCE_CHAIN", "A positive EVM source chain ID is required");
  }
  return chainId;
}

function normalizeRetryCreditRule(rule) {
  try {
    if (!rule || typeof rule !== "object") throw new Error("an onchain RetryCredit rule is required");
    const normalized = {
      attemptSigner: getAddress(rule.attemptSigner),
      beneficiary: getAddress(rule.beneficiary),
      target: getAddress(rule.target),
      settlementAsset: getAddress(rule.settlementAsset),
      settlementRecipient: getAddress(rule.settlementRecipient),
      policyId: String(rule.policyId).toLowerCase(),
      actionId: String(rule.actionId).toLowerCase(),
      minimumSettledValue: BigInt(rule.minimumSettledValue),
      startBlock: requireSafeInteger(rule.startBlock, "rule.startBlock"),
      endBlock: requireSafeInteger(rule.endBlock, "rule.endBlock"),
      maxBlockGap: requireSafeInteger(rule.maxBlockGap, "rule.maxBlockGap"),
      minimumAttemptGasLimit: BigInt(rule.minimumAttemptGasLimit),
      maxFailureGasUsed: BigInt(rule.maxFailureGasUsed),
    };
    if (!isHexString(normalized.policyId, 32) || /^0x0+$/.test(normalized.policyId)) {
      throw new Error("invalid rule policy ID");
    }
    if (!isHexString(normalized.actionId, 32) || /^0x0+$/.test(normalized.actionId)) {
      throw new Error("invalid rule action ID");
    }
    if (
      normalized.minimumSettledValue <= 0n
      || normalized.startBlock >= normalized.endBlock
      || normalized.maxBlockGap <= 0
      || normalized.maxBlockGap > MAX_BATCH_BLOCK_SPAN
      || normalized.minimumAttemptGasLimit <= 0n
      || normalized.maxFailureGasUsed <= 0n
      || normalized.settlementRecipient === normalized.beneficiary
      || [
        normalized.attemptSigner,
        normalized.beneficiary,
        normalized.target,
        normalized.settlementAsset,
        normalized.settlementRecipient,
      ].some((value) => /^0x0{40}$/i.test(value))
    ) {
      throw new Error("invalid RetryCredit rule bounds");
    }
    return normalized;
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError("INVALID_RETRY_CREDIT_RULE", error.message, 400, error);
  }
}

function validateRetryCreditRule(batchProof, rule) {
  try {
    const failed = batchProof.entries[0];
    const successful = batchProof.entries[1];
    const stableFields = [
      "attemptSigner",
      "beneficiary",
      "target",
      "settlementAsset",
      "settlementRecipient",
      "policyId",
      "actionId",
    ];
    const checkoutRuleView = {
      attemptSigner: failed.checkout.recoveredAttemptSigner,
      beneficiary: failed.checkout.beneficiary,
      target: failed.checkout.target,
      settlementAsset: failed.checkout.settlementAsset,
      settlementRecipient: failed.checkout.settlementRecipient,
      policyId: failed.checkout.policyId,
      actionId: failed.checkout.actionId,
    };
    for (const field of stableFields) {
      if (checkoutRuleView[field] !== rule[field]) throw new Error(`batch does not match rule ${field}`);
    }
    if (failed.sourceBlock < rule.startBlock || successful.sourceBlock > rule.endBlock) {
      throw new Error("batch source blocks are outside the funded rule window");
    }
    if (successful.sourceBlock - failed.sourceBlock > rule.maxBlockGap) {
      throw new Error("batch exceeds the funded rule block gap");
    }
    if (BigInt(failed.metadata.gasLimit) < rule.minimumAttemptGasLimit
        || BigInt(successful.metadata.gasLimit) < rule.minimumAttemptGasLimit) {
      throw new Error("one source attempt used less gas than the funded rule requires");
    }
    if (BigInt(failed.metadata.receiptGasUsed) > rule.maxFailureGasUsed) {
      throw new Error("failed attempt used more gas than the funded rule allows");
    }
    if (BigInt(successful.checkout.settledValue) < rule.minimumSettledValue) {
      throw new Error("successful settlement is below the funded rule minimum");
    }
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError("BATCH_PROOF_INVALID", error.message, 502, error);
  }
}

function normalizeRetryCreditBatchProof(
  proof,
  requestedHashes,
  expectedChainKey,
  expectedSourceChainId,
) {
  try {
    if (Number(proof.chainKey) !== expectedChainKey) {
      throw new Error(`unexpected source chain key ${proof.chainKey}`);
    }
    const fromHeader = requireSafeInteger(proof.fromHeader, "fromHeader");
    const toHeader = requireSafeInteger(proof.toHeader, "toHeader");
    if (fromHeader > toHeader || toHeader - fromHeader > MAX_BATCH_BLOCK_SPAN) {
      throw new Error(`invalid batch block range ${fromHeader}-${toHeader}`);
    }
    if (!(proof.merkleProofs instanceof Map)) throw new Error("merkleProofs must be a Map");

    const entriesByHash = new Map();
    for (const [sourceBlockValue, blockProofs] of proof.merkleProofs.entries()) {
      const sourceBlock = requireSafeInteger(sourceBlockValue, "sourceBlock");
      if (sourceBlock < fromHeader || sourceBlock > toHeader) {
        throw new Error(`source block ${sourceBlock} is outside the shared proof range`);
      }
      if (!(blockProofs instanceof Map)) throw new Error("per-block merkle proofs must be a Map");
      for (const [transactionIndexValue, entry] of blockProofs.entries()) {
        const transactionIndex = requireSafeInteger(transactionIndexValue, "transactionIndex");
        const transactionHash = validateTransactionHash(entry.txHash);
        if (!requestedHashes.includes(transactionHash)) {
          throw new Error(`unexpected transaction ${transactionHash} in batch proof`);
        }
        if (entriesByHash.has(transactionHash)) {
          throw new Error(`duplicate transaction ${transactionHash} in batch proof`);
        }
        validateMerkleProof(entry.merkleProof);
        const decoded = decodeAttestedTransactionEnvelope(entry.txBytes);
        entriesByHash.set(transactionHash, {
          transactionHash,
          sourceBlock,
          transactionIndex,
          encodedTransaction: entry.txBytes,
          merkleProof: entry.merkleProof,
          metadata: decoded.metadata,
          checkout: decodeRetryCreditCheckout(decoded, expectedSourceChainId),
          receiptLogs: decoded.receiptLogs,
        });
      }
    }

    if (entriesByHash.size !== RETRY_BATCH_SIZE || requestedHashes.some((hash) => !entriesByHash.has(hash))) {
      throw new Error("batch proof did not contain exactly the two requested transactions");
    }
    validateContinuityProof(proof.continuityProof);

    const failed = entriesByHash.get(requestedHashes[0]);
    const successful = entriesByHash.get(requestedHashes[1]);
    validateRetryCreditRelationship(failed, successful, expectedSourceChainId);
    const entries = [failed, successful];

    return {
      chainKey: expectedChainKey,
      fromHeader,
      toHeader,
      entries,
      continuityProof: proof.continuityProof,
      summary: {
        sourceChainKey: expectedChainKey,
        fromBlock: fromHeader,
        toBlock: toHeader,
        blockSpan: toHeader - fromHeader,
        continuityRootCount: proof.continuityProof.roots.length,
        failed: summarizeBatchEntry(failed),
        successful: summarizeBatchEntry(successful),
      },
    };
  } catch (error) {
    if (error instanceof WorkerError && error.code === "BATCH_PROOF_INVALID") throw error;
    throw new WorkerError("BATCH_PROOF_INVALID", "The Attestcoin batch proof did not match the requested retry", 502, error);
  }
}

function decodeRetryCreditCheckout(envelope, expectedSourceChainId) {
  try {
    if (envelope.metadata.selector !== RETRY_CREDIT_CHECKOUT_SELECTOR) {
      throw new Error("unexpected checkout selector");
    }
    const decoded = retryCreditCheckoutInterface.decodeFunctionData("checkout", envelope.calldata);
    const attempt = decoded.attempt;
    const payload = String(decoded.payload).toLowerCase();
    const signature = String(decoded.attemptSignature).toLowerCase();
    const sourceChainId = requireSafeInteger(attempt.sourceChainId, "attempt.sourceChainId");
    const quoteVersion = requireSafeInteger(attempt.quoteVersion, "attempt.quoteVersion");
    const validUntil = requireSafeInteger(attempt.validUntil, "attempt.validUntil");
    const target = getAddress(attempt.target);
    const beneficiary = getAddress(attempt.beneficiary);
    const settlementAsset = getAddress(attempt.settlementAsset);
    const settlementRecipient = getAddress(attempt.settlementRecipient);
    const policyId = String(attempt.policyId).toLowerCase();
    const actionId = String(attempt.actionId).toLowerCase();
    const payloadHash = String(attempt.payloadHash).toLowerCase();
    const settledValue = BigInt(attempt.settledValue);
    if (!isHexString(payload, 96)) throw new Error("checkout payload must be exactly 96 bytes");
    const [payloadMerchantValue, skuValue, inventoryVersionValue] = abiCoder.decode(
      ["address", "bytes32", "uint64"],
      payload,
    );
    const payloadMerchant = getAddress(payloadMerchantValue);
    const sku = String(skuValue).toLowerCase();
    const inventoryVersion = requireSafeInteger(inventoryVersionValue, "payload.inventoryVersion");

    if (sourceChainId !== expectedSourceChainId) throw new Error(`unexpected source chain ID ${sourceChainId}`);
    if (target !== envelope.metadata.target) throw new Error("signed target does not match transaction target");
    if (beneficiary !== envelope.metadata.sender) throw new Error("signed beneficiary does not match transaction sender");
    if (!isHexString(policyId, 32) || /^0x0+$/.test(policyId)) throw new Error("invalid policy ID");
    if (!isHexString(actionId, 32) || /^0x0+$/.test(actionId)) throw new Error("invalid action ID");
    if (!isHexString(payloadHash, 32) || payloadHash !== keccak256(payload)) {
      throw new Error("signed payload hash does not match the checkout payload");
    }
    if (!isHexString(signature, 65) || !["1b", "1c"].includes(signature.slice(-2))) {
      throw new Error("attempt signature must use canonical 65-byte ECDSA with v 27 or 28");
    }
    if (quoteVersion === 0 || validUntil === 0 || settledValue <= 0n) throw new Error("invalid signed attempt values");
    if ([target, beneficiary, settlementAsset, settlementRecipient].some((value) => /^0x0{40}$/i.test(value))) {
      throw new Error("signed attempt contains a zero address");
    }
    if (settlementRecipient === beneficiary) throw new Error("settlement recipient must differ from beneficiary");
    if (payloadMerchant !== settlementRecipient) throw new Error("checkout payload merchant does not match recipient");
    if (!isHexString(sku, 32) || /^0x0+$/.test(sku)) throw new Error("checkout payload contains an invalid SKU");
    if (inventoryVersion !== quoteVersion) throw new Error("checkout payload version does not match quote version");

    const typedAttempt = {
      sourceChainId: BigInt(sourceChainId),
      target,
      beneficiary,
      settlementAsset,
      settlementRecipient,
      policyId,
      actionId,
      quoteVersion: BigInt(quoteVersion),
      settledValue,
      payloadHash,
      validUntil: BigInt(validUntil),
    };
    const recoveredAttemptSigner = getAddress(verifyTypedData(
      {
        ...RETRY_CREDIT_DOMAIN,
        chainId: sourceChainId,
        verifyingContract: target,
      },
      RETRY_CREDIT_TYPES,
      typedAttempt,
      signature,
    ));

    return {
      sourceChainId,
      target,
      beneficiary,
      settlementAsset,
      settlementRecipient,
      policyId,
      actionId,
      quoteVersion,
      settledValue: settledValue.toString(),
      payloadHash,
      validUntil,
      recoveredAttemptSigner,
      payloadMerchant,
      sku,
      inventoryVersion,
    };
  } catch (error) {
    throw new Error(`invalid RetryCredit checkout envelope: ${error.message}`);
  }
}

function requireRetryCreditSettlementLogs(successful) {
  const { checkout, receiptLogs } = successful;
  const beneficiaryTopic = zeroPadValue(checkout.beneficiary, 32).toLowerCase();
  const recipientTopic = zeroPadValue(checkout.settlementRecipient, 32).toLowerCase();
  let matchingTransfers = 0;
  let matchingSettlementEvents = 0;

  for (const log of receiptLogs) {
    if (
      log.address === checkout.settlementAsset
      && log.topics.length === 3
      && log.topics[0] === ERC20_TRANSFER_EVENT.toLowerCase()
      && log.topics[1] === beneficiaryTopic
      && log.topics[2] === recipientTopic
      && isHexString(log.data, 32)
      && abiCoder.decode(["uint256"], log.data)[0].toString() === checkout.settledValue
    ) {
      matchingTransfers += 1;
    }

    if (
      log.address === checkout.target
      && log.topics.length === 4
      && log.topics[0] === RETRY_CREDIT_SETTLED_EVENT.toLowerCase()
      && log.topics[1] === checkout.policyId
      && log.topics[2] === checkout.actionId
      && log.topics[3] === beneficiaryTopic
      && isHexString(log.data, 160)
    ) {
      const [asset, recipient, settledValue, payloadHash, quoteVersion] = abiCoder.decode(
        ["address", "address", "uint256", "bytes32", "uint64"],
        log.data,
      );
      if (
        getAddress(asset) === checkout.settlementAsset
        && getAddress(recipient) === checkout.settlementRecipient
        && settledValue.toString() === checkout.settledValue
        && String(payloadHash).toLowerCase() === checkout.payloadHash
        && Number(quoteVersion) === checkout.quoteVersion
      ) {
        matchingSettlementEvents += 1;
      }
    }
  }

  if (matchingTransfers !== 1) {
    throw new Error(`expected exactly one bound ERC20 settlement transfer, found ${matchingTransfers}`);
  }
  if (matchingSettlementEvents === 0) throw new Error("required RetryCredit settlement event is missing");
}

function validateRetryCreditRelationship(failed, successful, expectedSourceChainId) {
  if (failed.metadata.receiptStatus !== 0) throw new Error("the first transaction did not fail");
  if (successful.metadata.receiptStatus !== 1) throw new Error("the retry transaction did not succeed");
  if (failed.metadata.sender !== successful.metadata.sender) throw new Error("failure and retry senders differ");
  if (!failed.metadata.target || failed.metadata.target !== successful.metadata.target) {
    throw new Error("failure and retry targets differ");
  }
  if (failed.metadata.selector !== RETRY_CREDIT_CHECKOUT_SELECTOR
      || successful.metadata.selector !== RETRY_CREDIT_CHECKOUT_SELECTOR) {
    throw new Error("failure and retry are not RetryCredit checkout calls");
  }
  if (failed.metadata.calldataHash === successful.metadata.calldataHash) {
    throw new Error("the retry did not carry refreshed attempt data");
  }
  if (failed.metadata.value !== "0" || successful.metadata.value !== "0") {
    throw new Error("the ERC20 checkout transactions must not carry native value");
  }
  if (BigInt(successful.metadata.nonce) <= BigInt(failed.metadata.nonce)) {
    throw new Error("the retry nonce does not increase");
  }
  if (failed.sourceBlock >= successful.sourceBlock) {
    throw new Error("the successful retry does not occur after the failed transaction");
  }

  const stableFields = [
    "sourceChainId",
    "target",
    "beneficiary",
    "settlementAsset",
    "settlementRecipient",
    "policyId",
    "actionId",
    "recoveredAttemptSigner",
  ];
  for (const field of stableFields) {
    if (failed.checkout[field] !== successful.checkout[field]) {
      throw new Error(`failure and retry ${field} differ`);
    }
  }
  if (failed.checkout.sourceChainId !== expectedSourceChainId) {
    throw new Error(`unexpected source chain ID ${failed.checkout.sourceChainId}`);
  }
  if (successful.checkout.quoteVersion <= failed.checkout.quoteVersion) {
    throw new Error("the retry quote version does not increase");
  }
  if (successful.checkout.sku !== failed.checkout.sku) {
    throw new Error("failure and retry checkout SKUs differ");
  }
  if (BigInt(successful.checkout.settledValue) <= 0n) {
    throw new Error("the successful settled value is zero");
  }
  if (failed.sourceBlock > failed.checkout.validUntil || successful.sourceBlock > successful.checkout.validUntil) {
    throw new Error("one of the signed attempts expired before inclusion");
  }
  requireRetryCreditSettlementLogs(successful);
}

function summarizeBatchEntry(entry) {
  return {
    transactionHash: entry.transactionHash,
    sourceBlock: entry.sourceBlock,
    transactionIndex: entry.transactionIndex,
    ...entry.metadata,
    retryCredit: entry.checkout,
  };
}

function requireSafeInteger(value, label) {
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < 0) throw new Error(`invalid ${label}`);
  return integer;
}

function validateMerkleProof(proof) {
  if (!proof || !isHexString(proof.root, 32) || !Array.isArray(proof.siblings)) {
    throw new Error("invalid transaction merkle proof");
  }
  for (const sibling of proof.siblings) {
    if (!isHexString(sibling.hash, 32) || typeof sibling.isLeft !== "boolean") {
      throw new Error("invalid transaction merkle proof sibling");
    }
  }
}

function validateContinuityProof(proof) {
  if (!proof || !isHexString(proof.lowerEndpointDigest, 32) || !Array.isArray(proof.roots)) {
    throw new Error("invalid continuity proof");
  }
  if (proof.roots.some((root) => !isHexString(root, 32))) throw new Error("invalid continuity proof root");
}

function serializeInteractionRule(rule) {
  return {
    target: rule.target,
    selector: rule.selector,
    requiredEventEmitter: rule.requiredEventEmitter,
    requiredEventSignature: rule.requiredEventSignature,
    claimantTopicIndex: Number(rule.claimantTopicIndex),
    startBlock: Number(rule.startBlock),
    endBlock: Number(rule.endBlock),
  };
}

export function createEthereumProviders(urls) {
  return urls.filter(Boolean).map((url) => new JsonRpcProvider(url, 1, { staticNetwork: true }));
}

function parseCampaignId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new WorkerError("INVALID_CAMPAIGN_ID", "Campaign ID must be a positive integer");
  }
  return id;
}

function parseServiceCreditNumber(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new WorkerError("INVALID_SERVICE_CREDIT_NUMBER", "Service credit number must be a positive integer");
  }
  return id;
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function summarizeSource({ transaction, receipt }) {
  return {
    transactionHash: transaction.hash,
    sender: transaction.from,
    target: transaction.to,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
  };
}

function explainSimulationError(error) {
  return error.revert?.name
    ?? error.reason
    ?? error.shortMessage
    ?? "The onchain verifier rejected this claim";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
