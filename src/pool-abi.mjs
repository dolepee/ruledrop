const proofTuple = "(uint64 sourceBlock,bytes encodedTransaction,bytes32 merkleRoot,(bytes32 hash,bool isLeft)[] siblings,bytes32 lowerEndpointDigest,bytes32[] continuityRoots)";

export const poolAbiV1 = [
  "function campaignCount() view returns (uint256)",
  "function getCampaign(uint256 campaignId) view returns ((address sponsor,address recipient,uint256 minimumAmount,uint64 startBlock,uint64 endBlock,uint64 registrationDeadline,uint64 withdrawalDeadline,uint256 fundedPool,uint256 claimantCount,uint256 sharePerClaim,uint256 withdrawnCount,bool finalized))",
  "function registered(uint256 campaignId,address claimant) view returns (bool)",
  "function withdrawn(uint256 campaignId,address claimant) view returns (bool)",
  `function registerClaim(uint256 campaignId,${proofTuple} proof)`,
];

export const poolAbiV2 = [
  "function campaignCount() view returns (uint256)",
  "function getCampaign(uint256 campaignId) view returns ((address sponsor,address recipient,uint256 minimumAmount,uint256 maximumWeight,uint64 startBlock,uint64 endBlock,uint64 registrationDeadline,uint64 withdrawalDeadline,uint256 fundedPool,uint256 claimantCount,uint256 totalWeight,uint256 sharePerClaim,uint256 totalPaid,uint256 withdrawnCount,uint8 claimTemplate,uint8 payoutPolicy,bool finalized))",
  "function getInteractionRule(uint256 campaignId) view returns ((address target,bytes4 selector,address requiredEventEmitter,bytes32 requiredEventSignature,uint8 claimantTopicIndex,uint64 startBlock,uint64 endBlock))",
  "function registered(uint256 campaignId,address claimant) view returns (bool)",
  "function withdrawn(uint256 campaignId,address claimant) view returns (bool)",
  "function claimWeights(uint256 campaignId,address claimant) view returns (uint256)",
  `function registerClaim(uint256 campaignId,${proofTuple} proof)`,
  `function registerInteractionClaim(uint256 campaignId,${proofTuple} proof)`,
];

export function selectPoolAbi(version = "1") {
  if (String(version) === "1") return poolAbiV1;
  if (String(version) === "2") return poolAbiV2;
  throw new Error(`Unsupported RULEDROP_POOL_VERSION: ${version}`);
}

export const poolAbi = poolAbiV1;
