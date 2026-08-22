import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatEther, getAddress, hexlify, toUtf8Bytes } from "ethers";
import { ArrowRight, Check, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck, Wallet, X, Zap } from "lucide-react";
import "./styles.css";

const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";
const CREDITCOIN_EXPLORER = "https://creditcoin-testnet.blockscout.com";
const STORAGE_KEY = "retrycredit-public-session-v2";
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
    fetchJson("/api/retry-credit/config").then(setConfig).catch((error) => {
      setConfig({ enabled: false, unavailable: true });
      setNotice({ tone: "error", text: error.message });
    });
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
  const wrongWallet = Boolean(session?.beneficiary && account && session.beneficiary.toLowerCase() !== account.toLowerCase());

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
      if (wrongWallet) throw new Error(`Reconnect ${short(session.beneficiary)} to resume this run`);
      if (!session) {
        if (!config?.enabled) throw new Error("The bounded public allocation is not live yet");
        const challenge = await postJson("/api/retry-credit/challenge", { beneficiary: wallet });
        const signature = await window.ethereum.request({
          method: "personal_sign",
          params: [hexlify(toUtf8Bytes(challenge.message)), wallet],
        });
        const prepared = await postJson("/api/retry-credit/prepare", { ...challenge, signature });
        setSession({ ...prepared, stage: "prepared", createdAt: Date.now() });
        setNotice({ tone: "success", text: "Your service credit is funded and both sponsored routes are committed." });
        return;
      }
      if (!session.failedTransactionHash) {
        const executed = await postJson(`/api/retry-credit/${session.serviceCreditNumber}/execute`, {});
        setSession((value) => ({
          ...value,
          stage: "settled",
          failedTransactionHash: executed.failedTransactionHash,
          successfulTransactionHash: executed.successfulTransactionHash,
          release: executed.release,
        }));
        setNotice({ tone: "success", text: executed.release ? "Your swap output and service credit arrived." : "The stale route was included, the refreshed swap settled, and Attestcoin is finalizing both receipts." });
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
    setNotice({ tone: "success", text: "Saved browser state cleared. RetryCredit will resume any active onchain recovery or start a new one." });
  }

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="RetryCredit home"><span className="brand-mark">R</span><span>RetryCredit</span></a>
      <nav aria-label="Primary navigation"><a href="#how-it-works">How it works</a><a href="#activity">Activity</a><a href="#safety">Safety</a></nav>
      <button className="wallet-button" disabled={!session && config?.enabled !== true} onClick={() => connect().catch((error) => setNotice({ tone: "error", text: error.message }))}><Wallet size={16} /> {account ? short(account) : config?.enabled === true ? "Connect wallet" : config?.unavailable ? "Temporarily unavailable" : config ? "Allocation paused" : "Checking…"}</button>
    </header>
    {notice && <Notice {...notice} onClose={() => setNotice(null)} />}
    <main id="top">
      <section className="hero">
        <div className="hero-copy"><div className="eyebrow"><span className="live-dot" /> STALE-SWAP RECOVERY · TESTNET</div><h1>Finish the swap.<br /><span>The retry earns the credit.</span></h1><p>RetryCredit completes a stale Uniswap swap to your wallet, then releases a fixed service credit after the refreshed route settles. Connect once; the testnet input and gas are sponsored.</p><div className="hero-tags"><span>Official Uniswap route</span><span>Fixed recovery credit</span><span>One wallet · no deposit</span></div></div>
        <div className="credit-card"><span>Sponsored recovery credit</span><strong>{config?.creditAmount ? formatEther(config.creditAmount) : "0.01"} <small>tCTC</small></strong><div><ShieldCheck size={16} /> Pre-funded before your routes execute</div></div>
      </section>
      <section className="journey" id="how-it-works">
        <div className="journey-map">
          <JourneyStep number="01" title="Route goes stale" copy="Included · no swap" state={phaseIndex(phase) >= 1 ? "done" : "current"} /><ArrowRight />
          <JourneyStep number="02" title="Quote refreshes" copy="Swap completes" state={phaseIndex(phase) >= 2 ? "done" : "future"} /><ArrowRight />
          <JourneyStep number="03" title="Receipts confirm" copy="Both attempts checked" state={phaseIndex(phase) >= 3 ? "done" : phaseIndex(phase) === 2 ? "current" : "future"} /><ArrowRight />
          <JourneyStep number="04" title="Credit arrives" copy="Released once" state={phase === "released" ? "done" : "future"} />
        </div>
        <div className="action-grid">
          <div className="action-copy"><div className="eyebrow">YOUR RECOVERY</div><h2>{phaseTitle(phase)}</h2><p>{phaseCopy(phase)}</p><ul><li><Check /> Testnets only; no mainnet asset or token approval</li><li><Check /> Gas, swap input, and one fixed credit are sponsored</li><li><Check /> One wallet signature names the credit recipient</li></ul></div>
          <div className="action-panel" aria-busy={busy}>
            {wrongWallet && <div className="inline-warning">This saved run belongs to {short(session.beneficiary)}.</div>}
            <RunStatus session={session} account={account} config={config} />
            <details className="verification-details"><summary>How this recovery is verified</summary><p>The first included route must fail without settlement. The refreshed route must complete through the bound Uniswap pool. RetryCredit then checks both receipts together before releasing one credit.</p></details>
            <button className="primary" onClick={act} disabled={busy || wrongWallet || (!session && config?.enabled !== true)}>{busy ? <><LoaderCircle className="spin" /> {busyLabel(phase)}</> : <>{phaseIcon(phase)} {phaseButton(phase, account, config)}</>}</button>
            <small className="transaction-note">The service sends two bounded Sepolia transactions from its own test wallet. The first is expected to fail after inclusion; your wallet never deposits funds or approves a token.</small>
            {session && <button className="secondary" onClick={startAnother}><RefreshCw /> {phase === "released" ? "Clear local receipt" : "Restart saved run"}</button>}
          </div>
        </div>
      </section>
      <section className="activity" id="activity"><div className="section-heading"><div className="eyebrow">RECENT RECOVERY</div><h2>From stale route to credit in 477 seconds.</h2><p>Every completed recovery leaves a simple activity trail you can open on the relevant network.</p></div><div className="receipt-grid"><Receipt title="Route did not settle" chain="Ethereum Sepolia" hash={HISTORICAL.failed} href={`${SEPOLIA_EXPLORER}/tx/${HISTORICAL.failed}`} /><Receipt title="Refreshed swap completed" chain="Sepolia · 2.192412 test USDC" hash={HISTORICAL.successful} href={`${SEPOLIA_EXPLORER}/tx/${HISTORICAL.successful}`} /><Receipt title="Service credit received" chain="Creditcoin · 0.1 tCTC" hash={HISTORICAL.release} href={`${CREDITCOIN_EXPLORER}/tx/${HISTORICAL.release}`} /></div></section>
      <section className="boundaries" id="safety"><div><div className="eyebrow">SAFETY AND LIMITS</div><h2>A bounded testnet recovery—not custody or insurance.</h2></div><div className="boundary-grid"><p><Check /> The same wallet and funded action bind both routes.</p><p><Check /> No credit is released until the refreshed swap settles.</p><p><Check /> The exact Uniswap swap and test-USDC transfer must match.</p><p><Check /> The same recovery cannot release a second credit.</p></div><div className="truth-note"><strong>Current pilot.</strong> RetryCredit verifies receipt state and settlement, not the human-readable reason a route failed. It uses Sepolia, Creditcoin Testnet, test USDC, and tCTC—not production assets or insurance.</div></section>
    </main>
    <footer><span>RetryCredit public testnet pilot</span><span>DeFi · Ethereum Sepolia → Creditcoin</span><a href="https://github.com/dolepee/retrycredit" target="_blank" rel="noreferrer">Source <ExternalLink size={13} /></a></footer>
  </div>;
}

function JourneyStep({ number, title, copy, state }) { return <div className={`journey-step ${state}`}><span>{state === "done" ? <Check /> : number}</span><div><strong>{title}</strong><small>{copy}</small></div></div>; }
function RunStatus({ session, account, config }) {
  if (!session) return <div className="run-status"><span>Wallet</span><strong>{account ? short(account) : "Not connected"}</strong><span>Allocation</span><strong>{config?.unavailable ? "Temporarily unavailable" : config?.enabled === true ? "Available while funded" : config ? "Replenishing" : "Checking"}</strong></div>;
  return <div className="run-status"><span>Service credit</span><strong>#{session.serviceCreditNumber}</strong><span>Recipient</span><strong>{short(session.beneficiary)}</strong><span>Source window</span><strong>{session.sourceWindow.startBlock.toLocaleString()}–{session.sourceWindow.endBlock.toLocaleString()}</strong>{session.failedTransactionHash && <><span>Failed route</span><ExplorerHash hash={session.failedTransactionHash} base={SEPOLIA_EXPLORER} /></>}{session.successfulTransactionHash && <><span>Settled route</span><ExplorerHash hash={session.successfulTransactionHash} base={SEPOLIA_EXPLORER} /></>}{session.release?.transactionHash && <><span>Credit release</span><ExplorerHash hash={session.release.transactionHash} base={CREDITCOIN_EXPLORER} /></>}</div>;
}
function Receipt({ title, chain, hash, href }) { return <a className="receipt" href={href} target="_blank" rel="noreferrer"><div><span>{title}</span><strong>{chain}</strong><code>{short(hash, 10)}</code></div><ExternalLink /></a>; }
function ExplorerHash({ hash, base }) { return <a href={`${base}/tx/${hash}`} target="_blank" rel="noreferrer">{short(hash, 8)} <ExternalLink /></a>; }
function Notice({ tone, text, onClose }) { return <div className={`notice ${tone}`} role={tone === "error" ? "alert" : "status"}><span>{tone === "error" ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}{text}</span><button onClick={onClose} aria-label="Dismiss message"><X aria-hidden="true" /></button></div>; }
function currentPhase(session) { if (!session) return "start"; if (session.release) return "released"; if (session.successfulTransactionHash) return "settled"; return "prepared"; }
function phaseIndex(phase) { return ({ start: 0, prepared: 0, settled: 2, released: 4 })[phase] ?? 0; }
function phaseTitle(phase) { return ({ start: "Recover a stale testnet swap.", prepared: "Run the sponsored retry.", settled: "Your swap settled. Finish the credit.", released: "Your service credit arrived." })[phase]; }
function phaseCopy(phase) { return ({ start: "Connect your wallet and authorize one bounded testnet recovery. RetryCredit pre-funds the credit and commits both sponsored routes before either is sent.", prepared: "RetryCredit will include the controlled stale route, refresh the quote, and send the settled test-USDC output to your wallet. No transaction is sent from your wallet.", settled: "Your test-USDC arrived on Sepolia. RetryCredit is checking both receipts together and releasing the fixed credit to the same address on Creditcoin Testnet.", released: "The swap output and fixed credit reached your wallet. This recovery cannot be paid twice." })[phase]; }
function phaseButton(phase, account, config) { if (phase === "start" && !config) return "Checking availability…"; if (phase === "start" && config.unavailable) return "Temporarily unavailable"; if (phase === "start" && config.enabled !== true) return "Service credits replenishing"; if (!account) return "Connect wallet to start"; return ({ start: "Start protected retry", prepared: "Run sponsored retry", settled: "Finish credit release", released: "Credit received" })[phase]; }
function busyLabel(phase) { return ({ start: "Preparing your recovery…", prepared: "Running both routes…", settled: "Finalizing your credit…", released: "Complete" })[phase]; }
function phaseIcon(phase) { return phase === "released" ? <Check /> : phase === "settled" ? <ShieldCheck /> : phase === "start" ? <Zap /> : <ArrowRight />; }

async function releaseUntilReady(session) { const deadline = Date.now() + 15 * 60_000; while (Date.now() < deadline) { const response = await fetch(`/api/retry-credit/${session.serviceCreditNumber}/release`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ failedTransactionHash: session.failedTransactionHash, successfulTransactionHash: session.successfulTransactionHash }) }); const data = await response.json(); if (response.ok) return data; if (response.status !== 425) throw new Error(data.error?.message ?? "Credit release failed"); await delay(15_000); } throw new Error("Attestcoin is still finalizing. Your receipt is saved; return and retry release shortly."); }
async function fetchJson(url) { return parseJsonResponse(await fetch(url)); }
async function postJson(url, body) { return parseJsonResponse(await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })); }
async function parseJsonResponse(response) {
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error("RetryCredit is temporarily unavailable. Please try again shortly."); }
  if (!response.ok) throw new Error(data?.error?.message ?? "RetryCredit is temporarily unavailable. Please try again shortly.");
  if (!data) throw new Error("RetryCredit is temporarily unavailable. Please try again shortly.");
  return data;
}
function readSession() { try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY)); return value?.serviceCreditNumber && value?.beneficiary ? value : null; } catch { return null; } }
function short(value, size = 6) { return value ? `${value.slice(0, size + 2)}…${value.slice(-4)}` : "—"; }
function cleanError(error) { return error?.shortMessage ?? error?.reason ?? error?.message ?? "Request failed"; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
