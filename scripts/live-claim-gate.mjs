import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { proofProvider } from "@gluwa/usc-sdk";

const PORT = Number(process.env.PORT ?? 4178);
const POOL = "0x6f8dE7e1599A0c8D38eB25996cB841a4920ed999";
const CLAIMANT = "0xbad35FA6e368e90fC4faf63507F2D0A2Fdf94BAF";
const SOURCE_TX = "0x7e6c853f85d4db4040206d7d49e1327b009894f7f0b8cba7c5c1fab640bd1227";
const artifact = JSON.parse(await readFile(new URL("../out/RuleDropPool.sol/RuleDropPool.json", import.meta.url)));

let proofCache;
async function claimData() {
  if (!proofCache) {
    const builder = new proofProvider.service.ProofBuilder(
      3,
      "https://prover.cc3-testnet.creditcoin.network",
      120_000,
    );
    const result = await builder.getProof(SOURCE_TX);
    if (!result.success) throw new Error(result.error);
    const proof = result.data;
    proofCache = {
      campaignId: 1,
      claimant: CLAIMANT,
      pool: POOL,
      sourceTx: SOURCE_TX,
      proof: {
        sourceBlock: proof.headerNumber,
        encodedTransaction: proof.txBytes,
        merkleRoot: proof.merkleProof.root,
        siblings: proof.merkleProof.siblings,
        lowerEndpointDigest: proof.continuityProof.lowerEndpointDigest,
        continuityRoots: proof.continuityProof.roots,
      },
    };
  }
  return proofCache;
}

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>RuleDrop live claim gate</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#090b0d; color:#edf3ee; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:linear-gradient(145deg,#090b0d,#111711); }
    main { width:min(620px,calc(100% - 32px)); border:1px solid #303933; background:#111512; padding:30px; box-sizing:border-box; }
    h1 { margin:0 0 8px; font-size:28px; letter-spacing:0; } p { color:#aeb9b1; line-height:1.55; }
    dl { display:grid; grid-template-columns:130px 1fr; gap:10px 18px; margin:26px 0; font-size:14px; }
    dt { color:#849087; } dd { margin:0; overflow-wrap:anywhere; }
    button { width:100%; min-height:48px; border:0; background:#b8f248; color:#10140b; font-weight:750; font-size:15px; cursor:pointer; }
    button:disabled { cursor:not-allowed; background:#4d554b; color:#aeb5aa; }
    #status { min-height:48px; margin:18px 0 0; padding:13px; box-sizing:border-box; border-left:3px solid #5d685f; background:#0b0e0c; font-family:ui-monospace,SFMono-Regular,monospace; font-size:12px; color:#c7d0c9; }
  </style>
</head>
<body><main>
  <h1>RuleDrop</h1>
  <p>Live mainnet-history claim for campaign 1.</p>
  <dl>
    <dt>Reward pool</dt><dd>10 tCTC</dd>
    <dt>Rule</dt><dd>Direct transfer of at least 1,000 USDC</dd>
    <dt>Ethereum tx</dt><dd>${SOURCE_TX}</dd>
    <dt>Claimant</dt><dd>${CLAIMANT}</dd>
  </dl>
  <button id="claim">Connect and register claim</button>
  <div id="status">Ready.</div>
</main>
<script type="module">
  import { BrowserProvider, Contract, getAddress } from "https://cdn.jsdelivr.net/npm/ethers@6.17.0/+esm";
  const button = document.querySelector('#claim');
  const status = document.querySelector('#status');
  const write = (message) => status.textContent = message;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (!window.ethereum) throw new Error('No injected wallet found');
      write('Connecting wallet...');
      const provider = new BrowserProvider(window.ethereum);
      await provider.send('eth_requestAccounts', []);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      if (getAddress(address) !== getAddress('${CLAIMANT}')) throw new Error('Connect the historical source wallet ${CLAIMANT}');
      try {
        await provider.send('wallet_switchEthereumChain', [{ chainId: '0x18e8f' }]);
      } catch (error) {
        if (error.code !== 4902) throw error;
        await provider.send('wallet_addEthereumChain', [{
          chainId: '0x18e8f', chainName: 'Creditcoin Testnet', nativeCurrency: { name:'Test CTC', symbol:'tCTC', decimals:18 },
          rpcUrls:['https://rpc.cc3-testnet.creditcoin.network'], blockExplorerUrls:['https://creditcoin-testnet.blockscout.com']
        }]);
      }
      write('Fetching and simulating the Attestcoin proof...');
      const data = await fetch('/claim-data').then((response) => response.json());
      const contract = new Contract(data.pool, ${JSON.stringify(artifact.abi)}, signer);
      await contract.registerClaim.staticCall(data.campaignId, data.proof);
      write('Simulation passed. Confirm the registration in your wallet.');
      const tx = await contract.registerClaim(data.campaignId, data.proof, { gasLimit: 5000000n });
      write('Submitted ' + tx.hash + '. Waiting for confirmation...');
      const receipt = await tx.wait();
      write('Claim registered in Creditcoin block ' + receipt.blockNumber + '. Tx: ' + tx.hash);
    } catch (error) {
      write('Stopped: ' + (error.shortMessage ?? error.message ?? String(error)));
      button.disabled = false;
    }
  });
</script></body></html>`;

createServer(async (request, response) => {
  try {
    if (request.url === "/claim-data") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(await claimData()));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error.message }));
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`RuleDrop live claim gate: http://127.0.0.1:${PORT}`);
});

