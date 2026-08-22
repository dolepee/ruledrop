import { appendFile, chmod, readFile, rename, writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  AbiCoder,
  Contract,
  ContractFactory,
  Interface,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  concat,
  getAddress,
  getBytes,
  id,
  isHexString,
  keccak256,
  parseEther,
  toUtf8Bytes,
  zeroPadValue,
} from "ethers";
import { proofProvider } from "@gluwa/usc-sdk";
import {
  CREDITCOIN_CHAIN_ID,
  RETRY_CREDIT_UNISWAP_SEPOLIA,
  RuleDropWorker,
  computeUniswapRetryCreditIntent,
} from "../src/proof-worker.mjs";

const EXPECTED_OPERATOR = "0x813C4BF413BeeA09a7f61450Bd9a9Fa321ED25Db";
const CC_RPC = process.env.CREDITCOIN_RPC ?? "https://rpc.cc3-testnet.creditcoin.network";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const PROOF_BUILDER_URL = process.env.ATTESTCOIN_PROOF_BUILDER
  ?? "https://prover.cc3-testnet.creditcoin.network";
const NATIVE_VERIFIER = getAddress("0x0000000000000000000000000000000000000fd2");
const CHAIN_INFO = getAddress("0x0000000000000000000000000000000000000fd3");
const QUOTER = getAddress("0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3");
const CREDIT_AMOUNT = parseEther("0.1");
const RELAYER_TARGET_BALANCE = parseEther("0.02");
const AMOUNT_IN = parseEther("0.0001");
const SOURCE_GAS_LIMIT = 500_000n;
const MINIMUM_ATTEMPT_GAS_LIMIT = 450_000n;
const MAX_FAILURE_GAS_USED = 300_000n;
const SOURCE_START_DELAY = 6;
const SOURCE_WINDOW = 80;
const MAX_BLOCK_GAP = 10;
const REFUND_DELAY_SECONDS = 3 * 60 * 60;
const PROOF_WAIT_TIMEOUT_MS = 15 * 60_000;
const PROOF_POLL_MS = 15_000;
const CONTROL_ROOT = path.resolve("/Users/qdee/Documents/Codex/competition-controls/buidl-ctc-2026-fall");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const abiCoder = AbiCoder.defaultAbiCoder();

const artifacts = {
  decoder: "out/EvmV1Decoder.sol/EvmV1Decoder.json",
  predicate: "out/RetryCreditUniversalRouterPredicateV1.sol/RetryCreditUniversalRouterPredicateV1.json",
  verifier: "out/AttestcoinRetryCreditUniversalRouterVerifier.sol/AttestcoinRetryCreditUniversalRouterVerifier.json",
  pool: "out/RetryCreditUniversalRouterPool.sol/RetryCreditUniversalRouterPool.json",
};
const publicV3Artifacts = {
  decoder: "out/EvmV1Decoder.sol/EvmV1Decoder.json",
  predicate: "out/RetryCreditUniversalRouterPredicateV2.sol/RetryCreditUniversalRouterPredicateV2.json",
  verifier: "out/AttestcoinRetryCreditUniversalRouterVerifierV2.sol/AttestcoinRetryCreditUniversalRouterVerifierV2.json",
  pool: "out/RetryCreditUniversalRouterPoolV2.sol/RetryCreditUniversalRouterPoolV2.json",
};
const poolAbi = [
  "event ServiceCreditDraftCreated(uint256 indexed serviceCreditNumber,address indexed sponsor,address indexed trader,uint256 creditAmount,uint64 refundAfter,uint256 creationBlock,bytes32 termsHash)",
  "event ServiceCreditActivated(uint256 indexed serviceCreditNumber,bytes32 indexed policyId,bytes32 creationBlockHash)",
  "event CreditReleased(uint256 indexed serviceCreditNumber,bytes32 indexed policyId,address indexed trader,uint256 creditAmount,bytes32 failureQueryId,bytes32 successQueryId,bytes32 pairId,address prover)",
  "function createServiceCredit((address routeSigner,address trader,address router,address weth,address usdc,address pool,bytes32 policyId,bytes32 actionId,uint256 amountIn,uint256 minimumSuccessfulOut,uint64 startBlock,uint64 endBlock,uint32 maxBlockGap,uint64 minimumAttemptGasLimit,uint64 maxFailureGasUsed) terms,uint64 refundAfter) payable returns(uint256)",
  "function activateServiceCredit(uint256 serviceCreditNumber) returns(bytes32)",
  "function getRule(uint256 serviceCreditNumber) view returns ((address routeSigner,address trader,address router,address weth,address usdc,address pool,bytes32 policyId,bytes32 actionId,uint256 amountIn,uint256 minimumSuccessfulOut,uint64 startBlock,uint64 endBlock,uint32 maxBlockGap,uint64 minimumAttemptGasLimit,uint64 maxFailureGasUsed))",
  "function getServiceCredit(uint256 serviceCreditNumber) view returns ((address sponsor,uint256 creditAmount,uint64 refundAfter,uint256 creationBlock,bytes32 termsHash,bool released,bool refunded))",
  "function sourceChainKey() view returns(uint64)",
  "function sourceChainId() view returns(uint64)",
  "function retryVerifier() view returns(address)",
  "function predicate() view returns(address)",
  "function chainInfo() view returns(address)",
  "function consumedQueries(bytes32) view returns(bool)",
  "function consumedPairs(bytes32) view returns(bool)",
  "function consumedActions(bytes32) view returns(bool)",
  "function releaseCredit(uint256 serviceCreditNumber,(uint64[] sourceBlocks,bytes[] encodedTransactions,(bytes32 root,(bytes32 hash,bool isLeft)[] siblings)[] merkleProofs,bytes32 lowerEndpointDigest,bytes32[] continuityRoots) proof)",
];
const verifierAbi = [
  "function sourceChainKey() view returns(uint64)",
  "function sourceChainId() view returns(uint64)",
  "function predicate() view returns(address)",
  "function verifier() view returns(address)",
];
const routerInterface = new Interface([
  "function executeSigned(bytes commands,bytes[] inputs,bytes32 intent,bytes32 data,bool verifySender,bytes32 nonce,bytes signature,uint256 deadline) payable",
]);
const quoterAbi = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];
const routeTypes = {
  ExecuteSigned: [
    { name: "commands", type: "bytes" },
    { name: "inputs", type: "bytes[]" },
    { name: "intent", type: "bytes32" },
    { name: "data", type: "bytes32" },
    { name: "sender", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

async function main() {
  const [mode, inputStatePath, label = "run"] = process.argv.slice(2);
  if (!["deploy", "deploy-public-v3", "prepare", "source", "release", "status"].includes(mode)) {
    throw new Error("usage: node scripts/retrycredit-uniswap-spike-runner.mjs <deploy|deploy-public-v3|prepare|source|release|status> [input-state.json] [label]");
  }
  const ccProvider = new JsonRpcProvider(CC_RPC, CREDITCOIN_CHAIN_ID, { staticNetwork: true });
  const sepoliaProvider = new JsonRpcProvider(SEPOLIA_RPC, RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId, { staticNetwork: true });
  await Promise.all([
    assertNetwork(ccProvider, CREDITCOIN_CHAIN_ID, "Creditcoin CC3"),
    assertNetwork(sepoliaProvider, RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId, "Sepolia"),
  ]);
  if (mode === "status") {
    const state = await loadState(inputStatePath);
    await authenticateState(state, ccProvider);
    print({ stage: state.stage, contracts: state.contracts, credit: state.credit, source: state.source, release: state.release });
    return;
  }
  requireOutputPaths();
  const privateKey = requirePrivateKey();
  const operator = new Wallet(privateKey, ccProvider);
  const trader = new Wallet(privateKey, sepoliaProvider);
  requireExpectedOperator(operator.address);
  requireExpectedOperator(trader.address);
  const routeSigner = new Wallet(deriveKey(privateKey, "RETRYCREDIT_UNISWAP_ROUTE_SIGNER_V1"));
  const relayer = new Wallet(deriveKey(privateKey, "RETRYCREDIT_UNISWAP_CC3_RELAYER_V1"), ccProvider);

  if (mode === "deploy-public-v3") {
    const state = await deployPublicV3Infrastructure({ ccProvider, operator, label });
    await persistState(state);
    print(state);
    return;
  }

  if (mode === "deploy") {
    const state = await deployInfrastructure({ ccProvider, operator, routeSigner, relayer, label });
    await persistState(state);
    print(state);
    return;
  }
  const state = await loadState(inputStatePath);
  const { statePath: outputStatePath } = requireOutputPaths();
  if (path.resolve(inputStatePath) === outputStatePath) {
    throw new Error("each mutating phase must write a distinct state file from its input checkpoint");
  }
  await authenticateState(state, ccProvider);
  if (getAddress(state.routeSigner) !== routeSigner.address || getAddress(state.relayer) !== relayer.address) {
    throw new Error("private state role addresses do not match the keys derived for this run");
  }
  if (mode === "prepare") {
    const result = await prepareCredit({ state, ccProvider, sepoliaProvider, operator, routeSigner, label });
    await persistState(result);
    print(result);
    return;
  }
  if (mode === "source") {
    const result = await executeSource({ state, sepoliaProvider, trader, routeSigner });
    await persistState(result);
    print(result);
    return;
  }
  const result = await releaseCredit({ state, ccProvider, operator, relayer });
  await persistState(result);
  print(result);
}

async function deployPublicV3Infrastructure({ ccProvider, operator, label }) {
  await requireBalance(ccProvider, operator.address, parseEther("0.5"), "CC3 public-demo sponsor");
  const routeSigner = new Wallet(deriveKey(operator.privateKey, "RETRYCREDIT_PUBLIC_ROUTE_SIGNER_V2"));
  const relayer = new Wallet(deriveKey(operator.privateKey, "RETRYCREDIT_PUBLIC_CC3_RELAYER_V2"), ccProvider);
  const decoder = await deploy("decoder", publicV3Artifacts.decoder, operator, []);
  const predicate = await deploy("predicate-v3", publicV3Artifacts.predicate, operator, [], { EvmV1Decoder: decoder.address });
  const verifier = await deploy("verifier-v3", publicV3Artifacts.verifier, operator, [
    predicate.address,
    ZeroAddress,
    RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainKey,
    RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId,
  ]);
  const pool = await deploy(
    "pool-v3",
    publicV3Artifacts.pool,
    operator,
    [verifier.address, ZeroAddress],
    { EvmV1Decoder: decoder.address },
  );
  const relayerBalance = await ccProvider.getBalance(relayer.address);
  let relayerFundingTransaction = null;
  if (relayerBalance < RELAYER_TARGET_BALANCE) {
    const receipt = await sendSuccess(operator.sendTransaction({
      to: relayer.address,
      value: RELAYER_TARGET_BALANCE - relayerBalance,
    }));
    relayerFundingTransaction = receipt.hash;
  }
  return {
    schemaVersion: "retrycredit.public-v3.v1",
    stage: "deployed",
    label,
    operator: operator.address,
    routeSigner: routeSigner.address,
    relayer: relayer.address,
    contracts: {
      decoder: decoder.address,
      predicate: predicate.address,
      verifier: verifier.address,
      pool: pool.address,
    },
    runtimeCodeHashes: {
      decoder: decoder.runtimeCodeHash,
      predicate: predicate.runtimeCodeHash,
      verifier: verifier.runtimeCodeHash,
      pool: pool.runtimeCodeHash,
    },
    deploymentTransactions: {
      decoder: decoder.transactionHash,
      predicate: predicate.transactionHash,
      verifier: verifier.transactionHash,
      pool: pool.transactionHash,
      relayerFunding: relayerFundingTransaction,
    },
    truthBoundary: "Public relayed testnet pilot infrastructure; user receives tCTC while a service wallet executes the bounded Sepolia route. Not production insurance or demand evidence.",
  };
}

async function deployInfrastructure({ ccProvider, operator, routeSigner, relayer, label }) {
  await requireBalance(ccProvider, operator.address, parseEther("0.5"), "CC3 operator");
  const decoder = await deploy("decoder", artifacts.decoder, operator, []);
  const predicate = await deploy("predicate", artifacts.predicate, operator, [], { EvmV1Decoder: decoder.address });
  const verifier = await deploy("verifier", artifacts.verifier, operator, [
    predicate.address,
    ZeroAddress,
    RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainKey,
    RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId,
  ]);
  const pool = await deploy("pool", artifacts.pool, operator, [verifier.address, ZeroAddress]);
  const relayerBalance = await ccProvider.getBalance(relayer.address);
  let relayerFundingTransaction = null;
  if (relayerBalance < RELAYER_TARGET_BALANCE) {
    const receipt = await sendSuccess(operator.sendTransaction({
      to: relayer.address,
      value: RELAYER_TARGET_BALANCE - relayerBalance,
    }));
    relayerFundingTransaction = receipt.hash;
  }
  return {
    schemaVersion: "retrycredit.uniswap-spike.v1",
    stage: "deployed",
    label,
    operator: operator.address,
    routeSigner: routeSigner.address,
    relayer: relayer.address,
    contracts: {
      decoder: decoder.address,
      predicate: predicate.address,
      verifier: verifier.address,
      pool: pool.address,
    },
    runtimeCodeHashes: {
      decoder: decoder.runtimeCodeHash,
      predicate: predicate.runtimeCodeHash,
      verifier: verifier.runtimeCodeHash,
      pool: pool.runtimeCodeHash,
    },
    deploymentTransactions: {
      decoder: decoder.transactionHash,
      predicate: predicate.transactionHash,
      verifier: verifier.transactionHash,
      pool: pool.transactionHash,
      relayerFunding: relayerFundingTransaction,
    },
    truthBoundary: "Founder-operated public-testnet spike using official Sepolia Universal Router and Circle test USDC; not demand evidence.",
  };
}

async function prepareCredit({ state, ccProvider, sepoliaProvider, operator, routeSigner, label }) {
  requireStage(state, "deployed");
  const pool = new Contract(state.contracts.pool, poolAbi, operator);
  const chainInfo = new Contract(CHAIN_INFO, [
    "function get_latest_attestation_height_and_hash(uint64 chainKey) view returns((uint64 height,bytes32 hash,bool isAttestation,bool exists))",
  ], ccProvider);
  const [attested, currentSourceBlock, quote] = await Promise.all([
    chainInfo.get_latest_attestation_height_and_hash(RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainKey),
    sepoliaProvider.getBlockNumber(),
    getQuote(sepoliaProvider),
  ]);
  if (!attested.exists || !attested.isAttestation) throw new Error("Sepolia native attestation height is unavailable");
  const startBlock = Math.max(Number(attested.height) + 1, currentSourceBlock + SOURCE_START_DELAY);
  const endBlock = startBlock + SOURCE_WINDOW;
  const minimumSuccessfulOut = quote * 80n / 100n;
  const actionId = keccak256(abiCoder.encode(
    ["string", "address", "address", "uint256", "uint256", "string"],
    ["RETRYCREDIT_UNISWAP_ACTION_V1", operator.address, state.contracts.pool, startBlock, Date.now(), label],
  ));
  const terms = {
    routeSigner: routeSigner.address,
    trader: operator.address,
    router: RETRY_CREDIT_UNISWAP_SEPOLIA.router,
    weth: RETRY_CREDIT_UNISWAP_SEPOLIA.weth,
    usdc: RETRY_CREDIT_UNISWAP_SEPOLIA.usdc,
    pool: RETRY_CREDIT_UNISWAP_SEPOLIA.pool,
    policyId: `0x${"00".repeat(32)}`,
    actionId,
    amountIn: AMOUNT_IN,
    minimumSuccessfulOut,
    startBlock,
    endBlock,
    maxBlockGap: MAX_BLOCK_GAP,
    minimumAttemptGasLimit: MINIMUM_ATTEMPT_GAS_LIMIT,
    maxFailureGasUsed: MAX_FAILURE_GAS_USED,
  };
  const currentCcBlock = await ccProvider.getBlock("latest");
  const refundAfter = Number(currentCcBlock.timestamp) + REFUND_DELAY_SECONDS;
  const creationReceipt = await sendSuccess(pool.createServiceCredit(terms, refundAfter, { value: CREDIT_AMOUNT }));
  const draft = requireEvent(pool.interface, creationReceipt, "ServiceCreditDraftCreated", state.contracts.pool);
  if (getAddress(draft.sponsor) !== operator.address || getAddress(draft.trader) !== operator.address) {
    throw new Error("funded draft participants do not match the operator");
  }
  const serviceCreditNumber = Number(draft.serviceCreditNumber);
  await waitForNextBlock(ccProvider, creationReceipt.blockNumber);
  const activationReceipt = await sendSuccess(pool.activateServiceCredit(serviceCreditNumber));
  const activation = requireEvent(pool.interface, activationReceipt, "ServiceCreditActivated", state.contracts.pool);
  const rule = await pool.getRule(serviceCreditNumber);
  if (String(rule.policyId).toLowerCase() !== String(activation.policyId).toLowerCase()) {
    throw new Error("activated policy ID does not match stored rule");
  }
  await journal("credit-activated", {
    serviceCreditNumber,
    creationTransaction: creationReceipt.hash,
    activationTransaction: activationReceipt.hash,
    policyId: rule.policyId,
    actionId,
  });
  return {
    ...state,
    stage: "credit-active",
    credit: {
      serviceCreditNumber,
      sponsor: operator.address,
      creditAmount: CREDIT_AMOUNT.toString(),
      refundAfter,
      creationBlock: creationReceipt.blockNumber,
      creationTransaction: creationReceipt.hash,
      activationTransaction: activationReceipt.hash,
      policyId: String(rule.policyId).toLowerCase(),
      actionId,
      quoteAtCreation: quote.toString(),
      rule: serializeRule(rule),
    },
  };
}

async function executeSource({ state, sepoliaProvider, trader, routeSigner }) {
  requireStage(state, "credit-active");
  await requireBalance(sepoliaProvider, trader.address, AMOUNT_IN * 3n, "Sepolia trader");
  await waitForSourceWindow(sepoliaProvider, state.credit.rule.startBlock, state.credit.rule.endBlock);
  const quote = await getQuote(sepoliaProvider);
  const failureMinimum = quote * 2n;
  const successMinimum = quote * 90n / 100n;
  if (successMinimum < BigInt(state.credit.rule.minimumSuccessfulOut)) {
    throw new Error("live quote fell below the funded successful-output floor");
  }
  const intent = computeUniswapRetryCreditIntent(state.credit.rule);
  const now = Math.floor(Date.now() / 1000);
  const failure = await signedRoute({
    state,
    routeSigner,
    intent,
    data: zeroPadValue("0x01", 32),
    nonce: keccak256(abiCoder.encode(["bytes32", "string"], [state.credit.actionId, "failure"])),
    deadline: now + 3600,
    amountOutMinimum: failureMinimum,
  });
  const success = await signedRoute({
    state,
    routeSigner,
    intent,
    data: zeroPadValue("0x02", 32),
    nonce: keccak256(abiCoder.encode(["bytes32", "string"], [state.credit.actionId, "success"])),
    deadline: now + 3660,
    amountOutMinimum: successMinimum,
  });
  const failedReceipt = await sendExpectedFailure(trader.sendTransaction({
    to: RETRY_CREDIT_UNISWAP_SEPOLIA.router,
    data: failure.calldata,
    value: AMOUNT_IN,
    gasLimit: SOURCE_GAS_LIMIT,
  }));
  const successReceipt = await sendSuccess(trader.sendTransaction({
    to: RETRY_CREDIT_UNISWAP_SEPOLIA.router,
    data: success.calldata,
    value: AMOUNT_IN,
    gasLimit: SOURCE_GAS_LIMIT,
  }));
  if (
    successReceipt.blockNumber <= failedReceipt.blockNumber
    || successReceipt.blockNumber - failedReceipt.blockNumber > state.credit.rule.maxBlockGap
    || failedReceipt.blockNumber < state.credit.rule.startBlock
    || successReceipt.blockNumber > state.credit.rule.endBlock
    || BigInt(failedReceipt.gasUsed) > BigInt(state.credit.rule.maxFailureGasUsed)
  ) {
    throw new Error("included source receipts violate the funded rule window or gas bounds");
  }
  await journal("source-pair-included", {
    failureTransaction: failedReceipt.hash,
    failureBlock: failedReceipt.blockNumber,
    successfulTransaction: successReceipt.hash,
    successfulBlock: successReceipt.blockNumber,
  });
  return {
    ...state,
    stage: "source-included",
    source: {
      startedAt: new Date().toISOString(),
      failureTransaction: failedReceipt.hash,
      failureBlock: failedReceipt.blockNumber,
      failureGasUsed: failedReceipt.gasUsed.toString(),
      successfulTransaction: successReceipt.hash,
      successfulBlock: successReceipt.blockNumber,
      successfulGasUsed: successReceipt.gasUsed.toString(),
      quote: quote.toString(),
      failureMinimum: failureMinimum.toString(),
      successMinimum: successMinimum.toString(),
    },
  };
}

async function releaseCredit({ state, ccProvider, operator, relayer }) {
  requireStage(state, "source-included");
  const proofBuilder = new proofProvider.service.ProofBuilder(
    RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainKey,
    PROOF_BUILDER_URL,
    120_000,
  );
  await waitForProofBuilder(proofBuilder, state.source.successfulBlock);
  const pool = new Contract(state.contracts.pool, poolAbi, ccProvider);
  const verifier = new Contract(state.contracts.verifier, verifierAbi, ccProvider);
  const worker = new RuleDropWorker({
    poolAddress: state.contracts.pool,
    poolAbi: ["function serviceCreditCount() view returns(uint256)"],
    poolContract: {},
    creditcoinProvider: ccProvider,
    sourceChainKey: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainKey,
    sourceChainId: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId,
    proofBuilder,
    uniswapRetryCreditPoolAddress: state.contracts.pool,
    uniswapRetryCreditPoolContract: pool,
    uniswapRetryCreditVerifierContract: verifier,
  });
  const prepared = await worker.prepareUniswapRetryCreditRelease({
    serviceCreditNumber: state.credit.serviceCreditNumber,
    failedTransactionHash: state.source.failureTransaction,
    successfulTransactionHash: state.source.successfulTransaction,
    relayer: relayer.address,
  });
  const beforeTrader = await ccProvider.getBalance(operator.address);
  const beforePool = await ccProvider.getBalance(state.contracts.pool);
  const releaseReceipt = await sendSuccess(relayer.sendTransaction({
    to: prepared.transaction.to,
    data: prepared.transaction.data,
    gasLimit: BigInt(prepared.transaction.gas),
    value: 0,
  }));
  const event = requireEvent(pool.interface, releaseReceipt, "CreditReleased", state.contracts.pool);
  const [afterTrader, afterPool] = await Promise.all([
    ccProvider.getBalance(operator.address),
    ccProvider.getBalance(state.contracts.pool),
  ]);
  if (afterTrader - beforeTrader !== CREDIT_AMOUNT || beforePool - afterPool !== CREDIT_AMOUNT) {
    throw new Error("release did not move the exact funded service credit to the trader");
  }
  let replaySelector;
  try {
    await ccProvider.call({ from: relayer.address, to: prepared.transaction.to, data: prepared.transaction.data });
    throw new Error("release replay unexpectedly simulated successfully");
  } catch (error) {
    replaySelector = extractRevertData(error)?.slice(0, 10) ?? null;
    if (replaySelector !== id("AlreadyResolved()").slice(0, 10)) throw error;
  }
  await journal("credit-released", {
    releaseTransaction: releaseReceipt.hash,
    releaseBlock: releaseReceipt.blockNumber,
    serviceCreditNumber: state.credit.serviceCreditNumber,
    failureQueryId: event.failureQueryId,
    successQueryId: event.successQueryId,
    pairId: event.pairId,
    replaySelector,
  });
  return {
    ...state,
    stage: "credit-released",
    release: {
      transaction: releaseReceipt.hash,
      block: releaseReceipt.blockNumber,
      creditAmount: CREDIT_AMOUNT.toString(),
      failureQueryId: event.failureQueryId,
      successQueryId: event.successQueryId,
      pairId: event.pairId,
      replaySelector,
      traderDelta: (afterTrader - beforeTrader).toString(),
      poolDelta: (beforePool - afterPool).toString(),
      completedAt: new Date().toISOString(),
    },
  };
}

export async function signedRoute({ state, routeSigner, intent, data, nonce, deadline, amountOutMinimum }) {
  const wrapInput = abiCoder.encode(
    ["address", "uint256"],
    ["0x0000000000000000000000000000000000000002", AMOUNT_IN],
  );
  const pathBytes = `0x${RETRY_CREDIT_UNISWAP_SEPOLIA.weth.slice(2)}0001f4${RETRY_CREDIT_UNISWAP_SEPOLIA.usdc.slice(2)}`;
  const swapInput = abiCoder.encode(
    ["address", "uint256", "uint256", "bytes", "bool", "uint256[]"],
    ["0x0000000000000000000000000000000000000001", AMOUNT_IN, amountOutMinimum, pathBytes, false, []],
  );
  const inputs = [wrapInput, swapInput];
  const value = {
    commands: "0x0b00",
    inputs,
    intent,
    data,
    sender: state.operator,
    nonce,
    deadline,
  };
  const signature = await routeSigner.signTypedData({
    name: "UniversalRouter",
    version: "2",
    chainId: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId,
    verifyingContract: RETRY_CREDIT_UNISWAP_SEPOLIA.router,
  }, routeTypes, value);
  return {
    calldata: routerInterface.encodeFunctionData("executeSigned", [
      value.commands,
      value.inputs,
      value.intent,
      value.data,
      true,
      value.nonce,
      signature,
      value.deadline,
    ]),
  };
}

async function getQuote(provider) {
  const quoter = new Contract(QUOTER, quoterAbi, provider);
  const result = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: RETRY_CREDIT_UNISWAP_SEPOLIA.weth,
    tokenOut: RETRY_CREDIT_UNISWAP_SEPOLIA.usdc,
    amountIn: AMOUNT_IN,
    fee: RETRY_CREDIT_UNISWAP_SEPOLIA.fee,
    sqrtPriceLimitX96: 0,
  });
  const quote = BigInt(result.amountOut ?? result[0]);
  if (quote <= 0n) throw new Error("official Sepolia Uniswap quote is zero");
  return quote;
}

async function authenticateState(state, ccProvider) {
  if (!state || state.schemaVersion !== "retrycredit.uniswap-spike.v1") throw new Error("invalid direct-Uniswap spike state");
  if (getAddress(state.operator) !== EXPECTED_OPERATOR) throw new Error("state operator mismatch");
  for (const [label, address] of Object.entries(state.contracts ?? {})) {
    const code = await ccProvider.getCode(address);
    if (
      getAddress(address) === ZeroAddress
      || code === "0x"
      || keccak256(code) !== state.runtimeCodeHashes?.[label]
    ) {
      throw new Error(`${label} deployment is missing`);
    }
  }
  const pool = new Contract(state.contracts.pool, poolAbi, ccProvider);
  const verifier = new Contract(state.contracts.verifier, verifierAbi, ccProvider);
  const [poolVerifier, poolPredicate, poolChainInfo, sourceKey, sourceId, nativeVerifier] = await Promise.all([
    pool.retryVerifier(), pool.predicate(), pool.chainInfo(), verifier.sourceChainKey(), verifier.sourceChainId(), verifier.verifier(),
  ]);
  if (
    getAddress(poolVerifier) !== getAddress(state.contracts.verifier)
    || getAddress(poolPredicate) !== getAddress(state.contracts.predicate)
    || getAddress(poolChainInfo) !== CHAIN_INFO
    || Number(sourceKey) !== RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainKey
    || Number(sourceId) !== RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId
    || getAddress(nativeVerifier) !== NATIVE_VERIFIER
  ) throw new Error("direct-Uniswap infrastructure immutables drifted");
}

async function deploy(label, artifactPath, signer, args, libraries = {}) {
  const artifact = JSON.parse(await readFile(path.join(repoRoot, artifactPath), "utf8"));
  const bytecode = linkBytecode(artifact.bytecode.object, artifact.bytecode.linkReferences ?? {}, libraries);
  const contract = await new ContractFactory(artifact.abi, bytecode, signer).deploy(...args);
  const receipt = await contract.deploymentTransaction().wait();
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`${label} deployment failed`);
  const address = await contract.getAddress();
  const runtimeCode = await signer.provider.getCode(address);
  if (runtimeCode === "0x") throw new Error(`${label} deployment has no code`);
  await journal("contract-deployed", { label, address, transactionHash: receipt.hash, blockNumber: receipt.blockNumber });
  return { address, transactionHash: receipt.hash, runtimeCodeHash: keccak256(runtimeCode) };
}

export function linkBytecode(bytecodeObject, references, libraries) {
  let bytecode = bytecodeObject;
  for (const [sourceName, sourceLibraries] of Object.entries(references)) {
    for (const [libraryName, positions] of Object.entries(sourceLibraries)) {
      const configured = libraries[`${sourceName}:${libraryName}`] ?? libraries[libraryName];
      if (!configured) throw new Error(`missing deployed library ${sourceName}:${libraryName}`);
      const address = getAddress(configured).slice(2).toLowerCase();
      for (const position of positions) {
        if (position.length !== 20) throw new Error(`unsupported ${libraryName} link reference`);
        const start = 2 + Number(position.start) * 2;
        bytecode = `${bytecode.slice(0, start)}${address}${bytecode.slice(start + 40)}`;
      }
    }
  }
  if (!isHexString(bytecode) || bytecode === "0x") throw new Error("linked artifact bytecode is invalid");
  return bytecode;
}

export function requireEvent(contractInterface, receipt, name, expectedEmitter) {
  const matches = [];
  for (const log of receipt.logs ?? []) {
    if (getAddress(log.address) !== getAddress(expectedEmitter)) continue;
    try {
      const parsed = contractInterface.parseLog(log);
      if (parsed?.name === name) matches.push(parsed.args);
    } catch {
      // Ignore other events from the exact contract.
    }
  }
  if (matches.length !== 1) throw new Error(`expected exactly one ${name} event from ${expectedEmitter}`);
  return matches[0];
}

async function sendSuccess(transactionPromise) {
  const transaction = await transactionPromise;
  const receipt = await transaction.wait();
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`transaction ${transaction.hash} failed`);
  return receipt;
}

async function sendExpectedFailure(transactionPromise) {
  const transaction = await transactionPromise;
  try {
    const receipt = await transaction.wait();
    if (receipt && Number(receipt.status) === 0) return receipt;
  } catch (error) {
    const receipt = error.receipt ?? await transaction.provider.getTransactionReceipt(transaction.hash);
    if (receipt && Number(receipt.status) === 0) return receipt;
    throw error;
  }
  throw new Error(`transaction ${transaction.hash} did not produce the required status-0 receipt`);
}

async function waitForProofBuilder(builder, targetHeight) {
  await builder.waitUntilHeightAttested(
    RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainKey,
    targetHeight,
    PROOF_POLL_MS,
    PROOF_WAIT_TIMEOUT_MS,
    5_000,
  );
}

async function waitForSourceWindow(provider, startBlock, endBlock) {
  for (;;) {
    const current = await provider.getBlockNumber();
    if (current > endBlock) throw new Error("funded Sepolia source window expired");
    if (current >= startBlock) return;
    await delay(4_000);
  }
}

async function waitForNextBlock(provider, blockNumber) {
  const deadline = Date.now() + 90_000;
  while (await provider.getBlockNumber() <= blockNumber) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a new CC3 block");
    await delay(1_500);
  }
}

async function assertNetwork(provider, expected, label) {
  const chainId = Number(BigInt(await provider.send("eth_chainId", [])));
  if (chainId !== expected) throw new Error(`${label} RPC returned chain ${chainId}`);
}

async function requireBalance(provider, address, minimum, label) {
  const balance = await provider.getBalance(address);
  if (balance < minimum) throw new Error(`${label} balance is below the bounded spike minimum`);
}

export function deriveKey(privateKey, label) {
  const value = keccak256(concat([getBytes(privateKey), toUtf8Bytes(label)]));
  if (/^0x0+$/.test(value)) throw new Error(`derived invalid ${label} key`);
  return value;
}

export function serializeRule(rule) {
  return {
    routeSigner: getAddress(rule.routeSigner), trader: getAddress(rule.trader), router: getAddress(rule.router),
    weth: getAddress(rule.weth), usdc: getAddress(rule.usdc), pool: getAddress(rule.pool),
    policyId: String(rule.policyId).toLowerCase(), actionId: String(rule.actionId).toLowerCase(),
    amountIn: rule.amountIn.toString(), minimumSuccessfulOut: rule.minimumSuccessfulOut.toString(),
    startBlock: Number(rule.startBlock), endBlock: Number(rule.endBlock), maxBlockGap: Number(rule.maxBlockGap),
    minimumAttemptGasLimit: rule.minimumAttemptGasLimit.toString(), maxFailureGasUsed: rule.maxFailureGasUsed.toString(),
  };
}

function requirePrivateKey() {
  const value = process.env.SPIKE_PRIVATE_KEY;
  if (!value || !isHexString(value, 32) || /^0x0+$/.test(value)) {
    throw new Error("SPIKE_PRIVATE_KEY must be loaded from Keychain as a nonzero 32-byte key");
  }
  return value;
}

function requireExpectedOperator(address) {
  if (getAddress(address) !== EXPECTED_OPERATOR) throw new Error(`refusing unexpected operator ${address}`);
}

function requireStage(state, stage) {
  if (state.stage !== stage) throw new Error(`expected state stage ${stage}, received ${state.stage}`);
}

function requireOutputPaths() {
  const statePath = path.resolve(process.env.UNISWAP_SPIKE_STATE_OUTPUT ?? "");
  const journalPath = path.resolve(process.env.UNISWAP_SPIKE_JOURNAL_PATH ?? "");
  for (const [label, candidate, extension] of [
    ["state", statePath, ".json"], ["journal", journalPath, ".jsonl"],
  ]) {
    const relative = path.relative(CONTROL_ROOT, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(candidate) !== extension) {
      throw new Error(`${label} output must be a ${extension} file inside the private CTC control directory`);
    }
  }
  if (statePath === journalPath) throw new Error("state and journal outputs must differ");
  return { statePath, journalPath };
}

async function loadState(statePath) {
  if (!statePath) throw new Error("an input state path is required");
  return JSON.parse(await readFile(path.resolve(statePath), "utf8"));
}

async function persistState(state) {
  const { statePath } = requireOutputPaths();
  const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, statePath);
  await chmod(statePath, 0o600);
}

async function journal(event, evidence) {
  const { journalPath } = requireOutputPaths();
  await appendFile(journalPath, `${JSON.stringify({ recordedAt: new Date().toISOString(), event, evidence })}\n`, {
    mode: 0o600,
  });
  await chmod(journalPath, 0o600);
}

function extractRevertData(error) {
  const candidates = [error?.data, error?.revert?.data, error?.info?.error?.data, error?.error?.data];
  return candidates.find((value) => typeof value === "string" && isHexString(value));
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
