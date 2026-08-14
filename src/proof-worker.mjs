import { Contract, Interface, JsonRpcProvider, formatEther, formatUnits, getAddress, isHexString } from "ethers";
import { proofProvider } from "@gluwa/usc-sdk";

export const ETHEREUM_CHAIN_KEY = 3;
export const CREDITCOIN_CHAIN_ID = 102031;
export const CANONICAL_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const TRANSFER_SELECTOR = "0xa9059cbb";
export const CLAIM_TEMPLATES = Object.freeze({ TRANSFER: 0, INTERACTION: 1 });
export const PAYOUT_POLICIES = Object.freeze({ EQUAL: 0, SOURCE_AMOUNT_WEIGHTED: 1 });

const DEFAULT_PROOF_BUILDER = "https://prover.cc3-testnet.creditcoin.network";
const DEFAULT_CREDITCOIN_RPC = "https://rpc.cc3-testnet.creditcoin.network";

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
  }) {
    this.poolAddress = validateAddress(poolAddress, "pool address");
    this.poolAbi = poolAbi;
    this.poolInterface = new Interface(poolAbi);
    this.creditcoinProvider = creditcoinProvider ?? new JsonRpcProvider(creditcoinRpc, CREDITCOIN_CHAIN_ID, { staticNetwork: true });
    this.pool = poolContract ?? new Contract(this.poolAddress, poolAbi, this.creditcoinProvider);
    this.proofBuilder = proofBuilder
      ?? new proofProvider.service.ProofBuilder(ETHEREUM_CHAIN_KEY, proofBuilderUrl, 120_000);
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
