export const poolAbi = [
  "function getCampaign(uint256 campaignId) view returns ((address sponsor,address recipient,uint256 minimumAmount,uint64 startBlock,uint64 endBlock,uint64 registrationDeadline,uint64 withdrawalDeadline,uint256 fundedPool,uint256 claimantCount,uint256 sharePerClaim,uint256 withdrawnCount,bool finalized))",
  "function registered(uint256 campaignId,address claimant) view returns (bool)",
  "function withdrawn(uint256 campaignId,address claimant) view returns (bool)",
  "function registerClaim(uint256 campaignId,(uint64 sourceBlock,bytes encodedTransaction,bytes32 merkleRoot,(bytes32 hash,bool isLeft)[] siblings,bytes32 lowerEndpointDigest,bytes32[] continuityRoots) proof)",
];
