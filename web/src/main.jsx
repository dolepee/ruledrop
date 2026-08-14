import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserProvider, Contract, formatEther, getAddress, parseEther } from "ethers";
import {
  ArrowUpRight,
  Check,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  FileCheck2,
  Fingerprint,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import "./styles.css";

const CHAIN_ID = "0x18e8f";
const POOL = "0x6f8dE7e1599A0c8D38eB25996cB841a4920ed999";
const EXPLORER = "https://creditcoin-testnet.blockscout.com";
const ETHERSCAN = "https://etherscan.io";
const SOURCE_TX = "0x7e6c853f85d4db4040206d7d49e1327b009894f7f0b8cba7c5c1fab640bd1227";
const POOL_ABI = [
  "function createCampaign(address recipient,uint256 minimumAmount,uint64 startBlock,uint64 endBlock,uint64 registrationDeadline,uint64 withdrawalDeadline) payable returns (uint256)",
  "function finalize(uint256 campaignId)",
  "function withdraw(uint256 campaignId)",
];

function App() {
  const [view, setView] = useState("campaign");
  const [campaign, setCampaign] = useState(null);
  const [account, setAccount] = useState("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);

  const loadCampaign = useCallback(async (wallet = account) => {
    setLoading(true);
    try {
      const query = wallet ? `?claimant=${wallet}` : "";
      const response = await fetch(`/api/campaigns/latest${query}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Campaign unavailable");
      setCampaign(data);
    } catch (error) {
      setNotice({ tone: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => { loadCampaign(); }, [loadCampaign]);

  async function connect() {
    try {
      if (!window.ethereum) throw new Error("Install an EVM wallet to continue");
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const wallet = getAddress(accounts[0]);
      setAccount(wallet);
      await loadCampaign(wallet);
    } catch (error) {
      setNotice({ tone: "error", text: error.message });
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView("campaign")} aria-label="Open RuleDrop claim">
          <span className="brand-mark">R</span><span>RuleDrop</span>
        </button>
        <nav aria-label="Primary navigation">
          <button className={view === "campaign" ? "active" : ""} onClick={() => setView("campaign")}>Live claim</button>
          <button className={view === "sponsor" ? "active" : ""} onClick={() => setView("sponsor")}>Create claim</button>
          <button className={view === "proof" ? "active" : ""} onClick={() => setView("proof")}>Verification</button>
        </nav>
        <button className="wallet-button" onClick={connect}>
          <Wallet size={16} aria-hidden="true" /> {account ? short(account) : "Connect wallet"}
        </button>
      </header>

      {notice && <Notice {...notice} onClose={() => setNotice(null)} />}
      <main>
        {view === "campaign" && <CampaignView campaign={campaign} loading={loading} account={account} connect={connect} reload={loadCampaign} notify={setNotice} />}
        {view === "sponsor" && <SponsorView account={account} connect={connect} notify={setNotice} />}
        {view === "proof" && <ProofView />}
      </main>
      <footer>
        <span>RuleDrop cross-chain claims pilot</span>
        <span>Creditcoin 3 Testnet · Chain 102031</span>
        <a href="https://github.com/dolepee/ruledrop" target="_blank" rel="noreferrer">Source <ExternalLink size={13} aria-hidden="true" /></a>
      </footer>
    </div>
  );
}

function CampaignView({ campaign, loading, account, connect, reload, notify }) {
  if (loading && !campaign) return <LoadingPage />;
  if (!campaign) return <EmptyState />;
  return (
    <>
      <section className="campaign-head">
        <div>
          <div className="eyebrow"><span className="live-dot" /> FUNDED CLAIM · PAYMENT REBATE #{campaign.id}</div>
          <h1>Claim from a payment you already made.</h1>
          <p>Bring the qualifying Ethereum receipt yourself. The published rule—not a private eligibility list—decides who can collect.</p>
        </div>
        <div className="pool-total">
          <span>Funded claim reserve</span>
          <strong>{campaign.fundedPoolTctc} <small>tCTC</small></strong>
          <span className="locked"><LockKeyhole size={14} aria-hidden="true" /> Locked at creation</span>
        </div>
      </section>

      <section className="campaign-grid">
        <div className="rule-panel">
          <div className="section-title">
            <div><span>IMMUTABLE ENTITLEMENT</span><h2>One source event. One funded right.</h2></div>
            <a className="icon-link" href={`${EXPLORER}/address/${POOL}`} target="_blank" rel="noreferrer" aria-label="View RuleDrop pool contract"><ExternalLink size={18} /></a>
          </div>
          <div className="rule-sentence">Sent at least <strong>{campaign.minimumAmountUsdc} USDC</strong> directly to the campaign recipient in Ethereum block <strong>{campaign.startBlock.toLocaleString()}</strong>.</div>
          <div className="route-map" aria-label="Ethereum proof verified and registered on Creditcoin">
            <div className="chain-node ethereum"><span>01</span><strong>Ethereum</strong><small>Payment receipt</small></div>
            <div className="route-line"><span>Attestcoin proof</span><ArrowUpRight aria-hidden="true" /></div>
            <div className="chain-node creditcoin"><span>02</span><strong>Creditcoin</strong><small>Funded claim</small></div>
          </div>
          <dl className="rule-data">
            <div><dt>Recipient</dt><dd>{short(campaign.recipient, 8)}</dd></div>
            <div><dt>Source range</dt><dd>{campaign.startBlock.toLocaleString()} only</dd></div>
            <div><dt>Registered</dt><dd>{campaign.claimantCount} wallet</dd></div>
            <div><dt>Registration ends</dt><dd>{formatDate(campaign.registrationDeadline)}</dd></div>
          </dl>
          <div className="principles">
            <span><Check size={15} /> No claimant cap</span>
            <span><Check size={15} /> Equal pro-rata payout</span>
            <span><Check size={15} /> Reserve cannot be cancelled</span>
          </div>
        </div>

        <ClaimPanel campaign={campaign} account={account} connect={connect} reload={reload} notify={notify} />
      </section>

      <section className="activity-band">
          <div className="section-title"><div><span>LIVE SETTLEMENT EVIDENCE</span><h2>A historical payment already created a Creditcoin claim.</h2></div></div>
        <div className="activity-row">
          <StatusIcon icon={FileCheck2} />
          <div><strong>Payment entitlement registered</strong><span>Ethereum mainnet · 1,000 USDC · block 25,049,872</span></div>
          <code>0x6470…de5e</code>
          <a href={`${EXPLORER}/tx/0x6470d1850b4444a0627cc997bacc982af8757bb2682bf272422e0100f871de5e`} target="_blank" rel="noreferrer">Receipt <ExternalLink size={13} /></a>
        </div>
      </section>
    </>
  );
}

function ClaimPanel({ campaign, account, connect, reload, notify }) {
  const [hash, setHash] = useState(account?.toLowerCase() === "0xbad35fa6e368e90fc4faf63507f2d0a2fdf94baf" ? SOURCE_TX : "");
  const [busy, setBusy] = useState(false);
  const registered = campaign.claimant?.registered;
  const withdrawn = campaign.claimant?.withdrawn;

  async function prepareAndSubmit() {
    if (!account) return connect();
    setBusy(true);
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}/prepare-claim`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transactionHash: hash, claimant: account }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Claim preparation failed");
      await ensureNetwork();
      const transactionHash = await window.ethereum.request({ method: "eth_sendTransaction", params: [data.transaction] });
      notify({ tone: "success", text: `Claim submitted: ${short(transactionHash, 8)}` });
      setTimeout(() => reload(account), 4000);
    } catch (error) {
      notify({ tone: "error", text: error.message });
    } finally { setBusy(false); }
  }

  async function withdraw() {
    if (!account) return connect();
    setBusy(true);
    try {
      const signer = await getSigner();
      const tx = await new Contract(POOL, POOL_ABI, signer).withdraw(campaign.id);
      notify({ tone: "success", text: `Withdrawal submitted: ${short(tx.hash, 8)}` });
      await tx.wait();
      reload(account);
    } catch (error) { notify({ tone: "error", text: cleanError(error) }); }
    finally { setBusy(false); }
  }

  return (
    <aside className="claim-panel" aria-labelledby="claim-heading">
      <div className="step-label">YOUR CLAIM</div>
      <h2 id="claim-heading">{registered ? "Claim confirmed" : "Prove the payment"}</h2>
      {registered ? (
        <div className="registered-state">
          <div className="success-seal"><ShieldCheck size={36} /><span>Verified</span></div>
          <p>This wallet has established its entitlement in claim #{campaign.id}. Its payout becomes fixed when registration closes.</p>
          <div className="claim-state-row"><span>Wallet</span><code>{short(account, 8)}</code></div>
          <div className="claim-state-row"><span>Current estimated share</span><strong>{campaign.claimantCount ? formatShare(campaign) : "—"} tCTC</strong></div>
          {campaign.finalized && !withdrawn && <button className="primary" onClick={withdraw} disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <CircleDollarSign />} Withdraw payout</button>}
          {withdrawn && <div className="complete-message"><Check /> Payout withdrawn</div>}
          {!campaign.finalized && <div className="waiting"><Clock3 /> Final share locks after {formatDate(campaign.registrationDeadline)}</div>}
        </div>
      ) : (
        <>
          <label htmlFor="transactionHash">Ethereum transaction hash</label>
          <input id="transactionHash" value={hash} onChange={(event) => setHash(event.target.value)} placeholder="0x…" spellCheck="false" aria-describedby="hash-help" />
          <p id="hash-help" className="field-help">Use the direct USDC transfer sent from this connected wallet.</p>
          <ol className="check-list">
            <li><Fingerprint /> Sender and wallet match</li>
            <li><FileCheck2 /> Receipt, calldata and event match</li>
            <li><ShieldCheck /> Attestcoin proof passes onchain</li>
          </ol>
          <button className="primary" onClick={prepareAndSubmit} disabled={busy || (!account && false)}>
            {busy ? <><LoaderCircle className="spin" /> Building proof…</> : account ? <><ShieldCheck /> Verify eligibility</> : <><Wallet /> Connect wallet</>}
          </button>
          <small className="transaction-note">Zero-value registration. You only pay Creditcoin testnet gas.</small>
        </>
      )}
    </aside>
  );
}

function SponsorView({ account, connect, notify }) {
  const [form, setForm] = useState({ recipient: "", minimum: "100", startBlock: "", endBlock: "", pool: "100", registrationHours: "72", withdrawalDays: "7" });
  const [busy, setBusy] = useState(false);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  async function createCampaign(event) {
    event.preventDefault();
    if (!account) return connect();
    setBusy(true);
    try {
      const now = Math.floor(Date.now() / 1000);
      const registration = now + Number(form.registrationHours) * 3600;
      const withdrawal = registration + Number(form.withdrawalDays) * 86400;
      const signer = await getSigner();
      const tx = await new Contract(POOL, POOL_ABI, signer).createCampaign(
        form.recipient, BigInt(Math.round(Number(form.minimum) * 1e6)), BigInt(form.startBlock), BigInt(form.endBlock), registration, withdrawal,
        { value: parseEther(form.pool) },
      );
      notify({ tone: "success", text: `Campaign creation submitted: ${short(tx.hash, 8)}` });
    } catch (error) { notify({ tone: "error", text: cleanError(error) }); }
    finally { setBusy(false); }
  }
  return (
    <section className="sponsor-layout">
      <div className="sponsor-copy">
        <div className="eyebrow">FOR PROTOCOLS, DAOS AND MERCHANTS</div>
        <h1>Fund what you owe.<br />Publish who qualifies.</h1>
        <p>Create open compensation, rebate, or recovery claims from verified source-chain activity. Once published, no administrator can rewrite eligibility or withdraw the reserve.</p>
        <div className="sponsor-steps">
          <div><span>01</span><strong>Publish the obligation</strong><small>Choose a reviewed event template and an already-attested Ethereum window.</small></div>
          <div><span>02</span><strong>Reserve the payout</strong><small>The complete displayed claim pool enters the contract immediately.</small></div>
          <div><span>03</span><strong>Let users establish inclusion</strong><small>Claimants bring source evidence; the contract applies the rule.</small></div>
        </div>
      </div>
      <form className="campaign-form" onSubmit={createCampaign}>
        <div className="form-heading"><Plus size={20} /><div><strong>Create payment rebate</strong><span>Live V1 template · Creditcoin testnet</span></div></div>
        <Field label="Ethereum USDC recipient" value={form.recipient} onChange={set("recipient")} placeholder="0x…" />
        <div className="field-grid"><Field label="Minimum USDC" type="number" value={form.minimum} onChange={set("minimum")} /><Field label="Claim reserve (tCTC)" type="number" value={form.pool} onChange={set("pool")} /></div>
        <div className="field-grid"><Field label="Start block" type="number" value={form.startBlock} onChange={set("startBlock")} /><Field label="End block" type="number" value={form.endBlock} onChange={set("endBlock")} /></div>
        <div className="field-grid"><Field label="Registration hours" type="number" value={form.registrationHours} onChange={set("registrationHours")} /><Field label="Withdrawal days" type="number" value={form.withdrawalDays} onChange={set("withdrawalDays")} /></div>
        <div className="immutability-note"><LockKeyhole /> Eligibility and reserve become immutable after signing.</div>
        <button className="primary" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <LockKeyhole />} {account ? "Fund and publish claim" : "Connect funding wallet"}</button>
      </form>
    </section>
  );
}

function ProofView() {
  const checks = ["Ethereum chain key 3", "Transaction inclusion", "Successful receipt", "Exact USDC contract", "Direct transfer selector", "Sender and claimant", "Recipient and amount", "Canonical Transfer event", "Historical block range", "Campaign replay state"];
  return (
    <section className="proof-layout">
      <div className="proof-heading"><div className="eyebrow">PUBLIC VERIFICATION</div><h1>The worker packages evidence.<br />It cannot approve a claim.</h1><p>Every decisive check is repeated by source-verified contracts on Creditcoin.</p></div>
      <div className="verification-ledger">
        <div className="ledger-head"><span>Claim receipt</span><a href={`${EXPLORER}/tx/0x6470d1850b4444a0627cc997bacc982af8757bb2682bf272422e0100f871de5e`} target="_blank" rel="noreferrer">0x6470…de5e <ExternalLink size={13} /></a></div>
        <div className="checks-grid">{checks.map((check, index) => <div key={check}><span>{String(index + 1).padStart(2, "0")}</span><Check size={15} /><strong>{check}</strong></div>)}</div>
        <div className="proof-links">
          <a href={`${ETHERSCAN}/tx/${SOURCE_TX}`} target="_blank" rel="noreferrer"><span>Source fact</span><strong>Ethereum mainnet transaction</strong><ExternalLink /></a>
          <a href={`${EXPLORER}/address/${POOL}`} target="_blank" rel="noreferrer"><span>Decision logic</span><strong>Verified RuleDrop contracts</strong><ExternalLink /></a>
        </div>
      </div>
    </section>
  );
}

function Field({ label, ...props }) { const id = label.toLowerCase().replaceAll(" ", "-"); return <label className="field" htmlFor={id}><span>{label}</span><input id={id} required {...props} /></label>; }
function Notice({ tone, text, onClose }) { return <div className={`notice ${tone}`} role="status"><span>{tone === "error" ? <X /> : <Check />}{text}</span><button onClick={onClose} aria-label="Dismiss notification"><X /></button></div>; }
function StatusIcon({ icon: Icon }) { return <div className="status-icon"><Icon aria-hidden="true" /></div>; }
function LoadingPage() { return <div className="loading-page"><LoaderCircle className="spin" /><span>Reading campaign state…</span></div>; }
function EmptyState() { return <div className="loading-page"><X /><span>Campaign state is unavailable.</span></div>; }
function short(value, size = 5) { return value ? `${value.slice(0, size + 2)}…${value.slice(-size)}` : ""; }
function formatDate(timestamp) { return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" }).format(timestamp * 1000); }
function formatShare(campaign) { return (Number(campaign.fundedPoolTctc) / campaign.claimantCount).toFixed(2); }
function cleanError(error) { return error.shortMessage ?? error.reason ?? error.message ?? "Transaction failed"; }
async function ensureNetwork() {
  try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID }] }); }
  catch (error) {
    if (error.code !== 4902 && !/unrecognized chain|unknown chain/i.test(error.message ?? "")) throw error;
    await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN_ID, chainName: "Creditcoin Testnet", nativeCurrency: { name: "Test CTC", symbol: "tCTC", decimals: 18 }, rpcUrls: ["https://rpc.cc3-testnet.creditcoin.network"], blockExplorerUrls: [EXPLORER] }] });
  }
}
async function getSigner() { await ensureNetwork(); return new BrowserProvider(window.ethereum).getSigner(); }

createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
