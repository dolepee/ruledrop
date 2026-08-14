import { Interface, JsonRpcProvider, formatUnits, getAddress, id, zeroPadValue } from "ethers";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TRANSFER_EVENT = id("Transfer(address,address,uint256)");
const USDC_INTERFACE = new Interface(["function transfer(address to,uint256 amount)"]);
const DEFAULT_CHUNK_SIZE = 2_000;
const MAX_RANGE = 250_000;

const options = parseArgs(process.argv.slice(2));
const rpcUrls = options.rpc
  ? [options.rpc]
  : (process.env.ETHEREUM_RPC_URLS ?? "").split(",").map((value) => value.trim()).filter(Boolean);

if (options.end - options.start > MAX_RANGE) {
  fail(`Block range exceeds ${MAX_RANGE.toLocaleString()} blocks; split the discovery run`);
}

const providers = rpcUrls.map((url) => new JsonRpcProvider(url, 1, { staticNetwork: true }));
const candidates = providers.length > 0
  ? await discoverWithRpc(providers, options)
  : await discoverWithBlockscout(options);

const wallets = new Map();
for (const candidate of candidates) {
  const existing = wallets.get(candidate.sender) ?? { sender: candidate.sender, totalAmount: 0n, transactions: [] };
  existing.totalAmount += candidate.amount;
  existing.transactions.push(candidate);
  wallets.set(candidate.sender, existing);
}

const cohort = [...wallets.values()]
  .sort((a, b) => b.totalAmount > a.totalAmount ? 1 : b.totalAmount < a.totalAmount ? -1 : 0)
  .map((wallet) => ({
    sender: wallet.sender,
    totalUsdc: formatUnits(wallet.totalAmount, 6),
    transactionCount: wallet.transactions.length,
    transactions: wallet.transactions.map(({ transactionHash, blockNumber, amount }) => ({
      transactionHash,
      blockNumber,
      amountUsdc: formatUnits(amount, 6),
    })),
  }));

const output = {
  generatedAt: new Date().toISOString(),
  sourceChain: "ethereum-mainnet",
  token: USDC,
  recipient: options.recipient,
  startBlock: options.start,
  endBlock: options.end,
  minimumUsdc: formatUnits(options.minimumAmount, 6),
  discoverySource: providers.length > 0 ? "ethereum-rpc" : options.indexer,
  qualifyingTransactions: candidates.length,
  distinctWallets: cohort.length,
  cohort,
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

async function discoverWithRpc(providers_, options_) {
  const recipientTopic = zeroPadValue(options_.recipient, 32);
  const logs = [];
  for (let fromBlock = options_.start; fromBlock <= options_.end; fromBlock += options_.chunkSize) {
    const toBlock = Math.min(options_.end, fromBlock + options_.chunkSize - 1);
    const chunk = await withProviderFallback(providers_, (provider) => provider.getLogs({
      address: USDC,
      fromBlock,
      toBlock,
      topics: [TRANSFER_EVENT, null, recipientTopic],
    }));
    logs.push(...chunk);
  }

  const results = [];
  for (const log of logs) {
    const result = await validateDirectTransfer(providers_, log, options_.recipient, options_.minimumAmount);
    if (result) results.push(result);
  }
  return results;
}

async function discoverWithBlockscout(options_) {
  let url = new URL(`${options_.indexer}/addresses/${options_.recipient}/token-transfers`);
  url.searchParams.set("type", "ERC-20");
  url.searchParams.set("filter", "to");
  const transfers = [];

  for (let page = 0; page < 100 && url; page += 1) {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Blockscout transfer lookup failed with HTTP ${response.status}`);
    const body = await response.json();
    for (const item of body.items ?? []) {
      if (Number(item.block_number) < options_.start || Number(item.block_number) > options_.end) continue;
      if (getAddress(item.to.hash) !== options_.recipient || getAddress(item.token.address_hash) !== USDC) continue;
      if (BigInt(item.total.value) < options_.minimumAmount) continue;
      transfers.push(item);
    }
    if (!body.next_page_params) break;
    const next = new URL(`${options_.indexer}/addresses/${options_.recipient}/token-transfers`);
    next.searchParams.set("type", "ERC-20");
    next.searchParams.set("filter", "to");
    for (const [key, value] of Object.entries(body.next_page_params)) next.searchParams.set(key, String(value));
    url = next;
  }

  const results = [];
  for (const transfer of transfers) {
    const response = await fetch(`${options_.indexer}/transactions/${transfer.transaction_hash}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) continue;
    const transaction = await response.json();
    if (transaction.status !== "ok" || !transaction.to?.hash || getAddress(transaction.to.hash) !== USDC) continue;
    let decoded;
    try {
      decoded = USDC_INTERFACE.decodeFunctionData("transfer", transaction.raw_input);
    } catch {
      continue;
    }
    const amount = BigInt(decoded.amount);
    const sender = getAddress(transaction.from.hash);
    if (
      getAddress(decoded.to) !== options_.recipient || amount !== BigInt(transfer.total.value)
        || sender !== getAddress(transfer.from.hash)
    ) continue;
    results.push({
      sender,
      transactionHash: transfer.transaction_hash,
      blockNumber: Number(transfer.block_number),
      amount,
    });
  }
  return results;
}

async function validateDirectTransfer(providers_, log, expectedRecipient, minimumAmount) {
  const [transaction, receipt] = await withProviderFallback(providers_, async (provider) => Promise.all([
    provider.getTransaction(log.transactionHash),
    provider.getTransactionReceipt(log.transactionHash),
  ]));
  if (!transaction || !receipt || receipt.status !== 1 || !transaction.to) return null;
  if (getAddress(transaction.to) !== USDC) return null;

  let decoded;
  try {
    decoded = USDC_INTERFACE.decodeFunctionData("transfer", transaction.data);
  } catch {
    return null;
  }
  const calldataRecipient = getAddress(decoded.to);
  const calldataAmount = BigInt(decoded.amount);
  if (calldataRecipient !== expectedRecipient || calldataAmount < minimumAmount) return null;
  if (log.topics.length !== 3 || getAddress(`0x${log.topics[1].slice(-40)}`) !== getAddress(transaction.from)) {
    return null;
  }
  if (BigInt(log.data) !== calldataAmount) return null;

  return {
    sender: getAddress(transaction.from),
    transactionHash: transaction.hash,
    blockNumber: receipt.blockNumber,
    amount: calldataAmount,
  };
}

async function withProviderFallback(providers_, operation) {
  let lastError;
  for (const provider of providers_) {
    try {
      const network = await provider.getNetwork();
      if (network.chainId !== 1n) throw new Error(`unexpected chain ${network.chainId}`);
      return await operation(provider);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No Ethereum RPC provider available");
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value == null) fail(`Invalid argument near ${key ?? "end of command"}`);
    values.set(key.slice(2), value);
  }

  let recipient;
  try {
    recipient = getAddress(required(values, "recipient"));
  } catch {
    fail("--recipient must be a valid Ethereum address");
  }
  const start = positiveInteger(required(values, "start"), "--start");
  const end = positiveInteger(required(values, "end"), "--end");
  if (end < start) fail("--end must be greater than or equal to --start");
  const minimumText = values.get("minimum-usdc") ?? "0";
  if (!/^\d+(\.\d{1,6})?$/.test(minimumText)) fail("--minimum-usdc supports at most six decimals");
  const [whole, fraction = ""] = minimumText.split(".");
  const minimumAmount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));

  return {
    recipient,
    start,
    end,
    minimumAmount,
    chunkSize: strictlyPositiveInteger(values.get("chunk-size") ?? DEFAULT_CHUNK_SIZE, "--chunk-size"),
    rpc: values.get("rpc"),
    indexer: (values.get("indexer") ?? "https://eth.blockscout.com/api/v2").replace(/\/$/, ""),
  };
}

function required(values, key) {
  const value = values.get(key);
  if (!value) fail(`Missing --${key}`);
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`${label} must be a non-negative integer`);
  return parsed;
}

function strictlyPositiveInteger(value, label) {
  const parsed = positiveInteger(value, label);
  if (parsed === 0) fail(`${label} must be greater than zero`);
  return parsed;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
