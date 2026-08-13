import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { proofProvider } from "@gluwa/usc-sdk";
import { Contract, Interface, JsonRpcProvider } from "ethers";

const PORT = Number(process.env.PORT ?? 4178);
const POOL = "0x6f8dE7e1599A0c8D38eB25996cB841a4920ed999";
const CLAIMANT = "0xbad35FA6e368e90fC4faf63507F2D0A2Fdf94BAF";
const SOURCE_TX = "0x7e6c853f85d4db4040206d7d49e1327b009894f7f0b8cba7c5c1fab640bd1227";
const RPC_URL = "https://rpc.cc3-testnet.creditcoin.network";
const artifact = JSON.parse(await readFile(new URL("../out/RuleDropPool.sol/RuleDropPool.json", import.meta.url)));
const provider = new JsonRpcProvider(RPC_URL, 102031, { staticNetwork: true });
const contract = new Contract(POOL, artifact.abi, provider);
const contractInterface = new Interface(artifact.abi);

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

async function preparedClaim() {
  const data = await claimData();
  await contract.registerClaim.staticCall(data.campaignId, data.proof, {
    from: CLAIMANT,
    gasLimit: 5_000_000n,
  });
  const transaction = {
    from: CLAIMANT,
    to: POOL,
    data: contractInterface.encodeFunctionData("registerClaim", [data.campaignId, data.proof]),
    gas: "0x989680",
    value: "0x0",
  };
  return { ...data, transaction };
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
  import { getAddress } from "https://cdn.jsdelivr.net/npm/ethers@6.17.0/+esm";
  const button = document.querySelector('#claim');
  const status = document.querySelector('#status');
  const write = (message) => status.textContent = message;
  button.addEventListener('click', async () => {
    button.disabled = true;
    let phase = 'wallet connection';
    try {
      if (!window.ethereum) throw new Error('No injected wallet found');
      write('Connecting wallet...');
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const address = accounts[0];
      if (getAddress(address) !== getAddress('${CLAIMANT}')) throw new Error('Connect the historical source wallet ${CLAIMANT}');
      phase = 'network switch';
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x18e8f' }] });
      } catch (error) {
        const unknownChain = error.code === 4902 || /unrecognized chain|unknown chain/i.test(error.message ?? '');
        if (!unknownChain) throw error;
        phase = 'network addition';
        await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: '0x18e8f', chainName: 'Creditcoin Testnet', nativeCurrency: { name:'Test CTC', symbol:'tCTC', decimals:18 },
          rpcUrls:['https://rpc.cc3-testnet.creditcoin.network'], blockExplorerUrls:['https://creditcoin-testnet.blockscout.com']
        }] });
        phase = 'network switch after addition';
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x18e8f' }] });
      }
      phase = 'server-side proof simulation';
      write('Building and simulating the Attestcoin proof...');
      const data = await fetch('/prepare-claim').then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? 'Claim preparation failed');
        return body;
      });
      write('Simulation passed. Confirm the registration in your wallet.');
      phase = 'wallet transaction submission';
      const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [data.transaction] });
      write('Submitted ' + hash + '. The onchain verifier will confirm registration.');
    } catch (error) {
      const detail = error.shortMessage ?? error.message ?? error.data?.message ?? String(error);
      write('Stopped during ' + phase + ': ' + detail + (error.code ? ' [' + error.code + ']' : ''));
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
    if (request.url === "/prepare-claim") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(await preparedClaim()));
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
