import { ethers } from "ethers";
import { blockProver, chainInfo, proofProvider } from "@gluwa/usc-sdk";

const CREDITCOIN_RPC = "https://rpc.cc3-testnet.creditcoin.network";
const PROOF_BUILDER = "https://prover.cc3-testnet.creditcoin.network";
const ETHEREUM_CHAIN_KEY = 3;
const HISTORICAL_TRANSFER =
  process.env.RULEDROP_SOURCE_TX ??
  "0x7e6c853f85d4db4040206d7d49e1327b009894f7f0b8cba7c5c1fab640bd1227";

const provider = new ethers.JsonRpcProvider(CREDITCOIN_RPC);
const network = await provider.getNetwork();
if (network.chainId !== 102031n) throw new Error(`unexpected destination chain ${network.chainId}`);

const chainProvider = new chainInfo.PrecompileChainInfoProvider(provider);
const ethereum = await chainProvider.getSupportedChainByKey(ETHEREUM_CHAIN_KEY);
if (!ethereum || ethereum.chainId !== 1) throw new Error("Ethereum mainnet chain key 3 is unavailable");

const latest = await chainProvider.getLatestAttestedHeightAndHash(ETHEREUM_CHAIN_KEY);
if (!latest.exists) throw new Error("Ethereum mainnet has no live attestation");

const builder = new proofProvider.service.ProofBuilder(ETHEREUM_CHAIN_KEY, PROOF_BUILDER, 120_000);
const proofStarted = Date.now();
const result = await builder.getProof(HISTORICAL_TRANSFER);
if (!result.success) throw new Error(result.error);

const proof = result.data;
const proofMs = Date.now() - proofStarted;
const verifier = new blockProver.PrecompileBlockProver(provider);
const verifyStarted = Date.now();
const [verified, transactionIndex] = await Promise.all([
  verifier.verifySingle(
    proof.chainKey,
    proof.headerNumber,
    proof.txBytes,
    proof.merkleProof,
    proof.continuityProof,
  ),
  verifier.computeTransactionIndex(proof.merkleProof),
]);
const verifyMs = Date.now() - verifyStarted;
if (!verified) throw new Error("native verifier rejected the historical transaction proof");

console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      destinationChainId: Number(network.chainId),
      source: ethereum,
      latestAttestedHeight: latest.height,
      transactionHash: HISTORICAL_TRANSFER,
      transactionBlock: proof.headerNumber,
      transactionIndex: Number(transactionIndex),
      proofGenerationMs: proofMs,
      nativeVerificationMs: verifyMs,
      merkleSiblingCount: proof.merkleProof.siblings.length,
      continuityRootCount: proof.continuityProof.roots.length,
      verified,
    },
    null,
    2,
  ),
);

