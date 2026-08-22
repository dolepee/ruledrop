import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserProvider, formatEther, getAddress } from "ethers";
import { ArrowRight, Check, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck, Wallet, X, Zap } from "lucide-react";
import "./styles.css";

const SEPOLIA_CHAIN_HEX = "0xaa36a7";
const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";
const CREDITCOIN_EXPLORER = "https://creditcoin-testnet.blockscout.com";
const STORAGE_KEY = "retrycredit-public-session-v1";
const HISTORICAL = {
  failed: "0x5ef2e6e47da2892774967c69aa48814d4db08141d76e53418ad7886d67683722",
  successful: "0xb6f516f52d0286bf274ae63a000df67583250c13d3645e6ce5e80ae40716766b",
  release: "0xbc44875c384fa4a9a67a7cdfd390d2322db84570c60e54fe65fed1e0b7a40e84",
};

function App() {
  const [account, setAccount] = useState("");
  const [config, setConfig] = useState(null);
  const [session, setSession] = useState(readSession);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    fetchJson("/api/retry-credit/config").then(setConfig).catch((error) => setNotice({ tone: "error", text: error.message }));
    if (!window.ethereum) return undefined;
    window.ethereum.request({ method: "eth_accounts" }).then((items) => {
      if (items?.[0]) setAccount(getAddress(items[0]));
    }).catch(() => undefined);
    const changed = (items) => setAccount(items?.[0] ? getAddress(items[0]) : "");
    window.ethereum.on?.("accountsChanged", changed);
    return () => window.ethereum.removeListener?.("accountsChanged", changed);
  }, []);

  useEffect(() => {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  }, [session]);

  const phase = useMemo(() => currentPhase(session), [session]);
  const wrongWallet = Boolean(session?.trader && account && session.trader.toLowerCase() !== account.toLowerCase());

  async function connect() {
    if (!window.ethereum) throw new Error("Install an EVM wallet to run the public testnet journey");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const next = getAddress(accounts[0]);
    setAccount(next);
    return next;
  }

  async function act() {
    setBusy(true);
    setNotice(null);
    try {
      const wallet = account || await connect();
      if (wrongWallet) throw new Error(`Reconnect ${short(session.trader)} to resume this run`);
      if (!session) {
        if (!config?.enabled) throw new Error("The bounded public allocation is not live yet");
        const challenge = await postJson("/api/retry-credit/challenge", { trader: wallet });
        const signer = await new BrowserProvider(window.ethereum).getSigner();
        const signature = await signer.signMessage(challenge.message);
        const prepared = await postJson("/api/retry-credit/prepare", { ...challenge, signature });
        setSession({ ...prepared, stage: "prepared", createdAt: Date.now() });
        setNotice({ tone: "success", text: "Service credit funded. Your two signed routes are ready." });
        return;
      }
      if (!session.failedTransactionHash) {
        await ensureSepolia();
        await waitForSourceWindow(session.sourceWindow.startBlock, setNotice);
        const hash = await sendPrepared(session.transactions.failed);
        const receipt = await waitReceipt(hash);
        if (Number(receipt.status) !== 0) throw new Error("The controlled stale route unexpectedly succeeded; no credit can be claimed");
        setSession((value) => ({ ...value, stage: "failed", failedTransactionHash: hash, failedBlock: receipt.blockNumber }));
        setNotice({ tone: "success", text: "The included route failed as expected. Refresh the quote next." });
        return;
      }
      if (!session.successfulTransactionHash) {
        await ensureSepolia();
        const hash = await sendPrepared(session.transactions.successful);
        const receipt = await waitReceipt(hash);
        if (Number(receipt.status) !== 1) throw new Error("The refreshed route did not settle");
        setSession((value) => ({ ...value, stage: "settled", successfulTransactionHash: hash, successfulBlock: receipt.blockNumber }));
        setNotice({ tone: "success", text: "Swap settled. Attestcoin is finalizing both receipts." });
        return;
      }
      const released = await releaseUntilReady(session);
      setSession((value) => ({ ...value, stage: "released", release: released.release }));
      setNotice({ tone: "success", text: "Credit released on Creditcoin. Replay is blocked onchain." });
    } catch (error) {
      setNotice({ tone: "error", text: cleanError(error) });
    } finally {
      setBusy(false);
    }
  }

  function startAnother() {
    setSession(null);
    setNotice({ tone: "success", text: "Local receipt cleared. Each wallet can receive one sponsored run." });
  }

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="RetryCredit home"><span className="brand-mark">R</span><span>RetryCredit</span></a>
      <nav aria-label="Primary navigation"><a href="#journey">Live journey</a><a href="#proof">Proof</a><a href="#boundaries">Boundaries</a></nav>
      <button className="wallet-button" disabled={!session && config?.enabled !== true} onClick={() => connect().catch((error) => setNotice({ tone: "error", text: error.message }))}><Wallet size={16} /> {account ? short(account) : config?.enabled === true ? "Connect wallet" : config ? "Allocation paused" : "Checking…"}</button>
    </header>
    {notice && <Notice {...notice} onClose={() => setNotice(null)} />}
    <main id="top">
      <section className="hero">
        <div className="hero-copy"><div className="eyebrow"><span className="live-dot" /> LIVE TESTNET EXECUTION CREDIT</div><h1>Finish the swap.<br /><span>The retry earns the credit.</span></h1><p>One signed Uniswap route fails on Ethereum Sepolia. A refreshed route settles. One native Attestcoin batch proves both receipts before Creditcoin releases a fixed service credit exactly once.</p><div className="hero-tags"><span>Official Uniswap router</span><span>Native Attestcoin batch</span><span>Onchain replay protection</span></div></div>
        <div className="credit-card"><span>Sponsored recovery credit</span><strong>{config ? formatEther(config.creditAmount) : "0.01"} <small>tCTC</small></strong><div><ShieldCheck size={16} /> Pre-funded before your routes execute</div></div>
      </section>
      <section className="journey" id="journey">
        <div className="journey-map">
          <JourneyStep number="01" title="Stale route" copy="Included · status 0" state={phaseIndex(phase) >= 1 ? "done" : "current"} /><ArrowRight />
          <JourneyStep number="02" title="Fresh route" copy="Settles on Uniswap" state={phaseIndex(phase) >= 2 ? "done" : phaseIndex(phase) === 1 ? "current" : "future"} /><ArrowRight />
          <JourneyStep number="03" title="One batch" copy="Attestcoin verifies both" state={phaseIndex(phase) >= 3 ? "done" : phaseIndex(phase) === 2 ? "current" : "future"} /><ArrowRight />
          <JourneyStep number="04" title="Credit" copy="Released once on CC3" state={phase === "released" ? "done" : "future"} />
        </div>
        <div className="action-grid">
          <div className="action-copy"><div className="eyebrow">PUBLIC PRIMARY ACTION</div><h2>{phaseTitle(phase)}</h2><p>{phaseCopy(phase)}</p><ul><li><Check /> Testnets only; no mainnet asset or approval</li><li><Check /> One bounded sponsor credit per wallet</li><li><Check /> Your wallet sends both source transactions</li></ul></div>
          <div className="action-panel">
            {wrongWallet && <div className="inline-warning">This saved run belongs to {short(session.trader)}.</div>}
            <RunStatus session={session} account={account} />
            <button className="primary" onClick={act} disabled={busy || wrongWallet || (!session && config?.enabled !== true)}>{busy ? <><LoaderCircle className="spin" /> {busyLabel(phase)}</> : <>{phaseIcon(phase)} {phaseButton(phase, account, config)}</>}</button>
            <small className="transaction-note">The first route is intentionally configured to revert after inclusion. Your wallet shows the exact testnet transaction before sending.</small>
            {phase === "released" && <button className="secondary" onClick={startAnother}><RefreshCw /> Clear local receipt</button>}
          </div>
        </div>
      </section>
      <section className="proof" id="proof"><div className="section-heading"><div className="eyebrow">PUBLIC RECEIPTS</div><h2>The complete loop already ran in 477 seconds.</h2><p>These are public chain facts, not screenshots or private logs.</p></div><div className="receipt-grid"><Receipt title="Included failure" chain="Ethereum Sepolia" hash={HISTORICAL.failed} href={`${SEPOLIA_EXPLORER}/tx/${HISTORICAL.failed}`} /><Receipt title="Settled retry" chain="Sepolia · 2.192412 test USDC" hash={HISTORICAL.successful} href={`${SEPOLIA_EXPLORER}/tx/${HISTORICAL.successful}`} /><Receipt title="Credit released" chain="Creditcoin · 0.1 tCTC" hash={HISTORICAL.release} href={`${CREDITCOIN_EXPLORER}/tx/${HISTORICAL.release}`} /></div></section>
      <section className="boundaries" id="boundaries"><div><div className="eyebrow">WHAT THE CHAIN PROVES</div><h2>Authorized failure, refreshed settlement, one payout.</h2></div><div className="boundary-grid"><p><Check /> The same wallet and funded action bind both signed routes.</p><p><Check /> The first receipt has status 0; the later receipt has status 1.</p><p><Check /> The exact Uniswap pool swap and Circle test-USDC transfer settled.</p><p><Check /> Query, pair, action, and credit replay keys are consumed.</p></div><div className="truth-note"><strong>Honest boundary.</strong> Attestcoin proves receipt state and settlement, not the human-readable revert reason. This pilot uses Sepolia, Creditcoin Testnet, test USDC, and tCTC—not production assets or insurance.</div></section>
    </main>
    <footer><span>RetryCredit public testnet pilot</span><span>DeFi · Ethereum Sepolia → Creditcoin</span><a href="https://github.com/dolepee/retrycredit" target="_blank" rel="noreferrer">Source <ExternalLink size={13} /></a></footer>
  </div>;
}

function JourneyStep({ number, title, copy, state }) { return <div className={`journey-step ${state}`}><span>{state === "done" ? <Check /> : number}</span><div><strong>{title}</strong><small>{copy}</small></div></div>; }
function RunStatus({ session, account }) {
  if (!session) return <div className="run-status"><span>Wallet</span><strong>{account ? short(account) : "Not connected"}</strong><span>Allocation</span><strong>Available while funded</strong></div>;
  return <div className="run-status"><span>Service credit</span><strong>#{session.serviceCreditNumber}</strong><span>Wallet</span><strong>{short(session.trader)}</strong><span>Source window</span><strong>{session.sourceWindow.startBlock.toLocaleString()}–{session.sourceWindow.endBlock.toLocaleString()}</strong>{session.failedTransactionHash && <><span>Failed route</span><ExplorerHash hash={session.failedTransactionHash} base={SEPOLIA_EXPLORER} /></>}{session.successfulTransactionHash && <><span>Settled route</span><ExplorerHash hash={session.successfulTransactionHash} base={SEPOLIA_EXPLORER} /></>}{session.release?.transactionHash && <><span>Credit release</span><ExplorerHash hash={session.release.transactionHash} base={CREDITCOIN_EXPLORER} /></>}</div>;
}
function Receipt({ title, chain, hash, href }) { return <a className="receipt" href={href} target="_blank" rel="noreferrer"><div><span>{title}</span><strong>{chain}</strong><code>{short(hash, 10)}</code></div><ExternalLink /></a>; }
function ExplorerHash({ hash, base }) { return <a href={`${base}/tx/${hash}`} target="_blank" rel="noreferrer">{short(hash, 8)} <ExternalLink /></a>; }
function Notice({ tone, text, onClose }) { return <div className={`notice ${tone}`} role="status"><span>{tone === "error" ? <X /> : <Check />}{text}</span><button onClick={onClose} aria-label="Dismiss"><X /></button></div>; }
function currentPhase(session) { if (!session) return "start"; if (session.release) return "released"; if (session.successfulTransactionHash) return "settled"; if (session.failedTransactionHash) return "failed"; return "prepared"; }
function phaseIndex(phase) { return ({ start: 0, prepared: 0, failed: 1, settled: 2, released: 4 })[phase] ?? 0; }
function phaseTitle(phase) { return ({ start: "Run the full journey from your wallet.", prepared: "Send the controlled stale route.", failed: "Refresh and finish the swap.", settled: "Release the Attestcoin credit.", released: "The retry paid for the failure." })[phase]; }
function phaseCopy(phase) { return ({ start: "Sign a wallet challenge. The sponsor funds a small testnet reserve and prepares two tightly bound official Uniswap routes.", prepared: "The first signed route has an impossible minimum output. It must be included and fail with no settlement logs.", failed: "The second route carries a newer signed quote and realistic minimum. The same action now settles through Uniswap.", settled: "Both receipts need Sepolia finality. RetryCredit builds one native Attestcoin batch and submits the one-time release on Creditcoin.", released: "The fixed testnet credit moved from the funded pool to your wallet. The same receipts cannot release it again." })[phase]; }
function phaseButton(phase, account, config) { if (phase === "start" && !config) return "Checking public allocation…"; if (phase === "start" && config.enabled !== true) return "Public allocation replenishing"; if (!account) return "Connect wallet"; return ({ start: "Fund my testnet credit", prepared: "Send expected-failure route", failed: "Send refreshed route", settled: "Verify receipts and release", released: "Credit released" })[phase]; }
function busyLabel(phase) { return ({ start: "Funding and signing…", prepared: "Waiting for failure receipt…", failed: "Settling swap…", settled: "Waiting for Attestcoin…", released: "Complete" })[phase]; }
function phaseIcon(phase) { return phase === "released" ? <Check /> : phase === "settled" ? <ShieldCheck /> : phase === "start" ? <Zap /> : <ArrowRight />; }

async function ensureSepolia() {
  try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_CHAIN_HEX }] }); }
  catch (error) { if (error.code !== 4902) throw error; await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: SEPOLIA_CHAIN_HEX, chainName: "Ethereum Sepolia", nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"], blockExplorerUrls: [SEPOLIA_EXPLORER] }] }); }
}
async function waitForSourceWindow(startBlock, setNotice) { const provider = new BrowserProvider(window.ethereum); for (;;) { const current = await provider.getBlockNumber(); if (current >= startBlock) return; setNotice({ tone: "success", text: `Credit funded. Waiting ${startBlock - current} Sepolia block${startBlock - current === 1 ? "" : "s"} for the precommitted window.` }); await delay(6000); } }
async function sendPrepared(transaction) { return window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: transaction.from, to: transaction.to, data: transaction.data, value: transaction.value, gas: transaction.gas }] }); }
async function waitReceipt(hash) { return new BrowserProvider(window.ethereum).waitForTransaction(hash, 1, 180_000); }
async function releaseUntilReady(session) { const deadline = Date.now() + 15 * 60_000; while (Date.now() < deadline) { const response = await fetch(`/api/retry-credit/${session.serviceCreditNumber}/release`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ failedTransactionHash: session.failedTransactionHash, successfulTransactionHash: session.successfulTransactionHash }) }); const data = await response.json(); if (response.ok) return data; if (response.status !== 425) throw new Error(data.error?.message ?? "Credit release failed"); await delay(15_000); } throw new Error("Attestcoin is still finalizing. Your receipt is saved; return and retry release shortly."); }
async function fetchJson(url) { const response = await fetch(url); const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? "Request failed"); return data; }
async function postJson(url, body) { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? "Request failed"); return data; }
function readSession() { try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY)); return value?.serviceCreditNumber ? value : null; } catch { return null; } }
function short(value, size = 6) { return value ? `${value.slice(0, size + 2)}…${value.slice(-4)}` : "—"; }
function cleanError(error) { return error?.shortMessage ?? error?.reason ?? error?.message ?? "Request failed"; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
