import { AbiCoder, Contract, Interface, JsonRpcProvider, formatEther, formatUnits, getAddress, isHexString, keccak256 } from "ethers";
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
const RETRY_BATCH_SIZE = 2;
const MAX_BATCH_BLOCK_SPAN = 1_000;
const abiCoder = AbiCoder.defaultAbiCoder();

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
    };
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError("BATCH_PROOF_INVALID", "The Attestcoin proof contains an invalid encoded transaction", 502, error);
  }
}

export function toContractBatchProof(batchProof) {
  return {
    chainKey: batchProof.chainKey,
    sourceBlocks: batchProof.entries.map((entry) => entry.sourceBlock),
    encodedTransactions: batchProof.entries.map((entry) => entry.encodedTransaction),
    merkleProofs: batchProof.entries.map((entry) => entry.merkleProof),
    continuityProof: batchProof.continuityProof,
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
  }) {
    this.poolAddress = validateAddress(poolAddress, "pool address");
    this.poolAbi = poolAbi;
    this.poolInterface = new Interface(poolAbi);
    this.creditcoinProvider = creditcoinProvider ?? new JsonRpcProvider(creditcoinRpc, CREDITCOIN_CHAIN_ID, { staticNetwork: true });
    this.pool = poolContract ?? new Contract(this.poolAddress, poolAbi, this.creditcoinProvider);
    this.sourceChainKey = validateSourceChainKey(sourceChainKey);
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

  async getRetryBatchProof({ failedTransactionHash, successfulTransactionHash }) {
    const hashes = validateRetryBatchHashes(failedTransactionHash, successfulTransactionHash);
    const cacheKey = `retry-batch:${this.sourceChainKey}:${hashes.join(":")}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let lastError;
    for (let attempt = 1; attempt <= this.proofAttempts; attempt += 1) {
      try {
        const result = await this.proofBuilder.getBatchProof(hashes);
        if (!result.success || !result.data) {
          throw new Error(result.error || "Proof builder rejected the batch request");
        }
        const normalized = normalizeRetryBatchProof(result.data, hashes, this.sourceChainKey);
        return this.cache.set(cacheKey, normalized);
      } catch (error) {
        if (error instanceof WorkerError) throw error;
        lastError = error;
        if (attempt < this.proofAttempts) await delay(250 * 2 ** (attempt - 1));
      }
    }
    throw new WorkerError("BATCH_PROOF_UNAVAILABLE", "The Attestcoin batch proof service is temporarily unavailable", 503, lastError);
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

function normalizeRetryBatchProof(proof, requestedHashes, expectedChainKey) {
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
        entriesByHash.set(transactionHash, {
          transactionHash,
          sourceBlock,
          transactionIndex,
          encodedTransaction: entry.txBytes,
          merkleProof: entry.merkleProof,
          metadata: decodeAttestedTransaction(entry.txBytes),
        });
      }
    }

    if (entriesByHash.size !== RETRY_BATCH_SIZE || requestedHashes.some((hash) => !entriesByHash.has(hash))) {
      throw new Error("batch proof did not contain exactly the two requested transactions");
    }
    validateContinuityProof(proof.continuityProof);

    const failed = entriesByHash.get(requestedHashes[0]);
    const successful = entriesByHash.get(requestedHashes[1]);
    validateRetryRelationship(failed, successful);
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

function validateRetryRelationship(failed, successful) {
  if (failed.metadata.receiptStatus !== 0) throw new Error("the first transaction did not fail");
  if (successful.metadata.receiptStatus !== 1) throw new Error("the retry transaction did not succeed");
  if (failed.metadata.sender !== successful.metadata.sender) throw new Error("failure and retry senders differ");
  if (!failed.metadata.target || failed.metadata.target !== successful.metadata.target) {
    throw new Error("failure and retry targets differ");
  }
  if (failed.metadata.selector === "0x" || failed.metadata.selector !== successful.metadata.selector) {
    throw new Error("failure and retry function selectors differ");
  }
  if (failed.metadata.calldataHash !== successful.metadata.calldataHash) {
    throw new Error("failure and retry calldata differ");
  }
  if (failed.metadata.value !== successful.metadata.value) throw new Error("failure and retry values differ");
  if (BigInt(successful.metadata.nonce) !== BigInt(failed.metadata.nonce) + 1n) {
    throw new Error("the retry nonce is not consecutive");
  }
  if (failed.sourceBlock >= successful.sourceBlock) {
    throw new Error("the successful retry does not occur after the failed transaction");
  }
}

function summarizeBatchEntry(entry) {
  return {
    transactionHash: entry.transactionHash,
    sourceBlock: entry.sourceBlock,
    transactionIndex: entry.transactionIndex,
    ...entry.metadata,
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
