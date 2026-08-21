import { appendFile, chmod, readFile, rename, writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  AbiCoder,
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  ZeroHash,
  concat,
  getAddress,
  getBytes,
  isHexString,
  keccak256,
  parseEther,
  solidityPacked,
  toUtf8Bytes,
} from "ethers";
import { proofProvider } from "@gluwa/usc-sdk";
import {
  RuleDropWorker,
  SEPOLIA_CHAIN_KEY,
} from "../src/proof-worker.mjs";

const EXPECTED_OPERATOR = "0x813C4BF413BeeA09a7f61450Bd9a9Fa321ED25Db";
const MERCHANT = "0x9fEAcC0d3BC179B6022B4aAf96F7a8217F422642";
const CC_CHAIN_ID = 102_031;
const SEPOLIA_CHAIN_ID = 11_155_111;
const CC_RPC = process.env.CREDITCOIN_RPC ?? "https://rpc.cc3-testnet.creditcoin.network";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const PROOF_BUILDER = process.env.ATTESTCOIN_PROOF_BUILDER
  ?? "https://prover.cc3-testnet.creditcoin.network";
const NATIVE_VERIFIER = getAddress("0x0000000000000000000000000000000000000fd2");
const CHAIN_INFO = getAddress("0x0000000000000000000000000000000000000fd3");
const MINIMUM_CC_BALANCE = parseEther("0.5");
const MINIMUM_SEPOLIA_BALANCE = parseEther("0.0015");
const RELAYER_TARGET_BALANCE = parseEther("0.02");
const CREDIT_AMOUNT = parseEther("0.1");
const TEST_TOKEN_MINT = 100n * 10n ** 18n;
const SETTLED_VALUE = 1n * 10n ** 18n;
const SOURCE_GAS_LIMIT = 300_000n;
const MINIMUM_ATTEMPT_GAS_LIMIT = 250_000n;
const MAX_FAILURE_GAS_USED = 200_000n;
const MAX_BLOCK_GAP = 10;
const SOURCE_WINDOW_BLOCKS = 80;
const SOURCE_START_DELAY_BLOCKS = 8;
const REFUND_DELAY_SECONDS = 3 * 60 * 60;
const PROOF_BUILDER_POLL_MS = 15_000;
const PROOF_BUILDER_WAIT_TIMEOUT_MS = 15 * 60 * 1_000;
const PROOF_BUILDER_CONSISTENCY_DELAY_MS = 5_000;
const abiCoder = AbiCoder.defaultAbiCoder();
const ruleTupleType = "tuple(address attemptSigner,address beneficiary,address target,address settlementAsset,address settlementRecipient,bytes32 policyId,bytes32 actionId,uint256 minimumSettledValue,uint64 startBlock,uint64 endBlock,uint32 maxBlockGap,uint64 minimumAttemptGasLimit,uint64 maxFailureGasUsed)";
const attemptTypes = {
  Attempt: [
    { name: "sourceChainId", type: "uint256" },
    { name: "target", type: "address" },
    { name: "beneficiary", type: "address" },
    { name: "settlementAsset", type: "address" },
    { name: "settlementRecipient", type: "address" },
    { name: "policyId", type: "bytes32" },
    { name: "actionId", type: "bytes32" },
    { name: "quoteVersion", type: "uint64" },
    { name: "settledValue", type: "uint256" },
    { name: "payloadHash", type: "bytes32" },
    { name: "validUntil", type: "uint64" },
  ],
};
const chainInfoAbi = [
  "function get_latest_attestation_height_and_hash(uint64 chainKey) view returns ((uint64 height,bytes32 hash,bool isAttestation,bool exists))",
];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const artifacts = {
  token: "out/RetryCredit.t.sol/MockSettlementToken.json",
  checkout: "out/RetryCreditCheckout.sol/RetryCreditCheckout.json",
  decoder: "out/EvmV1Decoder.sol/EvmV1Decoder.json",
  predicate: "out/RetryCreditPredicateV2.sol/RetryCreditPredicateV2.json",
  verifier: "out/AttestcoinRetryCreditVerifier.sol/AttestcoinRetryCreditVerifier.json",
  pool: "out/RetryCreditPool.sol/RetryCreditPool.json",
};

async function main() {
  const [mode, statePath, label] = process.argv.slice(2);
  if (![
    "source-infra-status",
    "infrastructure-status",
    "recover-release",
    "deploy-infra",
    "prepare-credit",
    "execute-source",
    "attestation-status",
    "prove-release",
  ].includes(mode)) {
    throw new Error(
      "usage: node scripts/retrycredit-spike-runner.mjs <source-infra-status|infrastructure-status|recover-release|deploy-infra|prepare-credit|execute-source|attestation-status|prove-release> [state.json] [label]",
    );
  }
  const ccProvider = new JsonRpcProvider(CC_RPC, CC_CHAIN_ID, { staticNetwork: true });
  const sepoliaProvider = new JsonRpcProvider(SEPOLIA_RPC, SEPOLIA_CHAIN_ID, { staticNetwork: true });
  await Promise.all([
    assertNetwork(ccProvider, CC_CHAIN_ID, "Creditcoin CC3"),
    assertNetwork(sepoliaProvider, SEPOLIA_CHAIN_ID, "Sepolia"),
  ]);
  if (mode === "source-infra-status") {
    const sourceState = await loadSourceInfrastructureState(statePath);
    await authenticateSourceInfrastructure(sourceState, sepoliaProvider, EXPECTED_OPERATOR);
    output({
      schemaVersion: sourceState.schemaVersion,
      stage: "source-infrastructure-authenticated",
      checkedAt: new Date().toISOString(),
      operator: sourceState.operator,
      contracts: sourceState.contracts,
      truthBoundary: sourceState.truthBoundary,
      ready: true,
    });
    return;
  }
  if (mode === "infrastructure-status") {
    const state = await loadState(statePath);
    validateInfrastructureState(state, EXPECTED_OPERATOR);
    await authenticateInfrastructure(state, ccProvider, sepoliaProvider);
    output({
      schemaVersion: state.schemaVersion,
      stage: "infrastructure-authenticated",
      checkedAt: new Date().toISOString(),
      operator: state.operator,
      relayer: state.relayer,
      contracts: state.contracts,
      truthBoundary: state.truthBoundary,
      ready: true,
    });
    return;
  }
  if (mode === "recover-release") {
    const state = await loadState(statePath);
    validateInfrastructureState(state, EXPECTED_OPERATOR);
    await authenticateInfrastructure(state, ccProvider, sepoliaProvider);
    requireMutationOutputPaths();
    const result = await recoverRelease({
      state,
      releaseTransactionHash: label,
      ccProvider,
    });
    await persistState(result);
    await journal("service-credit-release-recovered", {
      transactionHash: result.releaseEvidence.releaseTransaction,
      blockNumber: result.releaseEvidence.releaseBlock,
      serviceCreditNumber: result.credit.serviceCreditNumber,
    });
    output(result);
    return;
  }
  if (mode === "attestation-status") {
    const state = await loadState(statePath);
    validateInfrastructureState(state, EXPECTED_OPERATOR);
    await authenticateInfrastructure(state, ccProvider, sepoliaProvider);
    await authenticateActiveCredit(state, ccProvider);
    output(await attestationStatus({ state, ccProvider }));
    return;
  }

  const signerKey = requirePrivateKey();
  const ccOperator = new Wallet(signerKey, ccProvider);
  const sepoliaOperator = new Wallet(signerKey, sepoliaProvider);
  requireExpectedOperator(ccOperator.address);
  requireExpectedOperator(sepoliaOperator.address);
  const relayerKey = deriveRelayerKey(signerKey);
  const ccRelayer = new Wallet(relayerKey, ccProvider);
  requireMutationOutputPaths();

  if (mode === "deploy-infra") {
    const sourceState = statePath ? await loadSourceInfrastructureState(statePath) : null;
    const result = await deployInfrastructure({
      ccProvider,
      sepoliaProvider,
      ccOperator,
      sepoliaOperator,
      ccRelayer,
      sourceState,
    });
    await persistState(result);
    output(result);
    return;
  }
  const state = await loadState(statePath);
  validateInfrastructureState(state, ccOperator.address, ccRelayer.address);
  let result;
  if (mode === "prepare-credit") {
    result = await prepareCredit({ state, label, ccProvider, sepoliaProvider, ccOperator, sepoliaOperator });
  } else if (mode === "execute-source") {
    result = await executeSource({ state, ccProvider, sepoliaProvider, ccOperator, sepoliaOperator });
  } else if (mode === "prove-release") {
    result = await proveRelease({ state, ccProvider, sepoliaProvider, ccRelayer, ccOperator });
  }
  await persistState(result);
  output(result);
}

async function deployInfrastructure({
  ccProvider,
  sepoliaProvider,
  ccOperator,
  sepoliaOperator,
  ccRelayer,
  sourceState,
}) {
  const [ccBalance, sepoliaBalance] = await Promise.all([
    ccProvider.getBalance(ccOperator.address),
    sepoliaProvider.getBalance(sepoliaOperator.address),
  ]);
  if (ccBalance < MINIMUM_CC_BALANCE) throw new Error("insufficient CC3 balance for the bounded spike");
  if (sepoliaBalance < MINIMUM_SEPOLIA_BALANCE) throw new Error("insufficient Sepolia ETH for the bounded spike");

  const tokenArtifact = await readArtifact(artifacts.token);
  let source;
  if (sourceState) {
    await authenticateSourceInfrastructure(sourceState, sepoliaProvider, ccOperator.address);
    status("reusing the authenticated partial Sepolia source infrastructure");
    source = sourceState;
  } else {
    status("deploying disclosed test settlement token on Sepolia");
    const token = await deploy("test settlement token", artifacts.token, sepoliaOperator, []);
    const tokenContract = new Contract(token.address, tokenArtifact.abi, sepoliaOperator);
    const mintReceipt = await sendAndRequireSuccess(tokenContract.mint(sepoliaOperator.address, TEST_TOKEN_MINT));
    await journal("token-minted", { transactionHash: mintReceipt.hash, blockNumber: mintReceipt.blockNumber });

    status("deploying signed RetryCredit checkout on Sepolia");
    const checkout = await deploy(
      "RetryCredit checkout",
      artifacts.checkout,
      sepoliaOperator,
      [sepoliaOperator.address, token.address],
    );
    const approveReceipt = await sendAndRequireSuccess(tokenContract.approve(checkout.address, TEST_TOKEN_MINT));
    await journal("token-approved", { transactionHash: approveReceipt.hash, blockNumber: approveReceipt.blockNumber });
    source = {
      schemaVersion: "retrycredit.source-infra.v1",
      stage: "source-infrastructure-deployed",
      createdAt: new Date().toISOString(),
      operator: ccOperator.address,
      merchant: MERCHANT,
      networks: { source: { chainId: SEPOLIA_CHAIN_ID, name: "Sepolia" } },
      contracts: { testSettlementToken: token.address, checkout: checkout.address },
      transactions: {
        tokenDeployment: token.transactionHash,
        tokenMint: mintReceipt.hash,
        checkoutDeployment: checkout.transactionHash,
        tokenApproval: approveReceipt.hash,
      },
      truthBoundary: "The source asset is a disclosed disposable test token, not canonical USDC.",
    };
  }

  status("deploying RetryCredit predicate, Attestcoin verifier, and funded pool on CC3");
  const decoder = await deploy("EvmV1Decoder library", artifacts.decoder, ccOperator, []);
  const predicate = await deploy(
    "RetryCredit predicate",
    artifacts.predicate,
    ccOperator,
    [],
    { EvmV1Decoder: decoder.address },
  );
  const verifier = await deploy(
    "Attestcoin RetryCredit verifier",
    artifacts.verifier,
    ccOperator,
    [predicate.address, ZeroAddress, SEPOLIA_CHAIN_KEY, SEPOLIA_CHAIN_ID],
  );
  const pool = await deploy("RetryCredit pool", artifacts.pool, ccOperator, [verifier.address, ZeroAddress]);

  let relayerFundingTransaction = null;
  const relayerBalance = await ccProvider.getBalance(ccRelayer.address);
  if (relayerBalance < RELAYER_TARGET_BALANCE) {
    const receipt = await sendAndRequireSuccess(ccOperator.sendTransaction({
      to: ccRelayer.address,
      value: RELAYER_TARGET_BALANCE - relayerBalance,
    }));
    relayerFundingTransaction = receipt.hash;
    await journal("relayer-funded", {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      relayer: ccRelayer.address,
    });
  }

  const result = {
    schemaVersion: "retrycredit.spike-state.v1",
    stage: "infrastructure-deployed",
    createdAt: source.createdAt,
    operator: ccOperator.address,
    relayer: ccRelayer.address,
    merchant: MERCHANT,
    networks: {
      creditcoin: { chainId: CC_CHAIN_ID, sourceChainKey: SEPOLIA_CHAIN_KEY },
      source: { chainId: SEPOLIA_CHAIN_ID, name: "Sepolia" },
    },
    contracts: {
      testSettlementToken: source.contracts.testSettlementToken,
      checkout: source.contracts.checkout,
      evmV1Decoder: decoder.address,
      predicate: predicate.address,
      verifier: verifier.address,
      pool: pool.address,
    },
    transactions: {
      ...source.transactions,
      decoderDeployment: decoder.transactionHash,
      predicateDeployment: predicate.transactionHash,
      verifierDeployment: verifier.transactionHash,
      poolDeployment: pool.transactionHash,
      relayerFunding: relayerFundingTransaction,
    },
    truthBoundary: "The source asset is a disclosed disposable test token, not canonical USDC.",
  };
  await authenticateInfrastructure(result, ccProvider, sepoliaProvider);
  return result;
}

async function prepareCredit({ state, label, ccProvider, sepoliaProvider, ccOperator, sepoliaOperator }) {
  requireStage(state, "infrastructure-deployed");
  await authenticateInfrastructure(state, ccProvider, sepoliaProvider);
  if (!label || !/^[a-z0-9][a-z0-9-]{0,31}$/i.test(label)) {
    throw new Error("prepare-credit requires a short alphanumeric run label");
  }
  const [checkoutArtifact, poolArtifact] = await Promise.all([
    readArtifact(artifacts.checkout),
    readArtifact(artifacts.pool),
  ]);
  const checkout = new Contract(state.contracts.checkout, checkoutArtifact.abi, sepoliaOperator);
  const pool = new Contract(state.contracts.pool, poolArtifact.abi, ccOperator);
  const chainInfo = new Contract(CHAIN_INFO, chainInfoAbi, ccProvider);
  const [sourceBlock, attestation, latestCreditcoinBlock] = await Promise.all([
    sepoliaProvider.getBlockNumber(),
    chainInfo.get_latest_attestation_height_and_hash(SEPOLIA_CHAIN_KEY),
    ccProvider.getBlock("latest"),
  ]);
  if (!attestation.exists || !attestation.isAttestation) throw new Error("Sepolia attestation state is unavailable");
  const startBlock = Math.max(sourceBlock + SOURCE_START_DELAY_BLOCKS, Number(attestation.height) + 1);
  const endBlock = startBlock + SOURCE_WINDOW_BLOCKS;
  const actionId = keccak256(solidityPacked(
    ["string", "address", "address", "string"],
    ["RETRYCREDIT_ACTION_V1", state.contracts.pool, state.contracts.checkout, label],
  ));
  const sku = keccak256(solidityPacked(["string", "bytes32"], ["RETRYCREDIT_SPIKE_SKU", actionId]));
  const inventoryReceipt = await sendAndRequireSuccess(checkout.setInventoryVersion(sku, 2));
  await journal("inventory-version-set", {
    transactionHash: inventoryReceipt.hash,
    blockNumber: inventoryReceipt.blockNumber,
    sku,
  });
  const refundAfter = Number(latestCreditcoinBlock.timestamp) + REFUND_DELAY_SECONDS;
  const terms = {
    attemptSigner: state.operator,
    beneficiary: state.operator,
    target: state.contracts.checkout,
    settlementAsset: state.contracts.testSettlementToken,
    settlementRecipient: state.merchant,
    policyId: ZeroHash,
    actionId,
    minimumSettledValue: SETTLED_VALUE,
    startBlock,
    endBlock,
    maxBlockGap: MAX_BLOCK_GAP,
    minimumAttemptGasLimit: MINIMUM_ATTEMPT_GAS_LIMIT,
    maxFailureGasUsed: MAX_FAILURE_GAS_USED,
  };
  status(`funding service credit for Sepolia blocks ${startBlock}-${endBlock}`);
  const creationReceipt = await sendAndRequireSuccess(pool.createServiceCredit(terms, refundAfter, {
    value: CREDIT_AMOUNT,
  }));
  const draft = parseServiceCreditDraft(pool, creationReceipt, terms, refundAfter, state.operator);
  const serviceCreditNumber = draft.serviceCreditNumber;
  await verifyStoredDraft(
    pool,
    serviceCreditNumber,
    terms,
    draft,
    refundAfter,
    creationReceipt.blockNumber,
    state.operator,
  );
  await journal("service-credit-created", {
    transactionHash: creationReceipt.hash,
    blockNumber: creationReceipt.blockNumber,
    serviceCreditNumber,
    termsHash: draft.termsHash,
  });
  await waitForBlockAfter(ccProvider, creationReceipt.blockNumber, 45_000);
  const activationReceipt = await sendAndRequireSuccess(pool.activateServiceCredit(serviceCreditNumber));
  await journal("service-credit-activated", {
    transactionHash: activationReceipt.hash,
    blockNumber: activationReceipt.blockNumber,
    serviceCreditNumber,
  });
  const fundedRule = await pool.getRule(serviceCreditNumber);
  if (!isHexString(fundedRule.policyId, 32) || fundedRule.policyId === ZeroHash) {
    throw new Error("service credit activation did not produce a policy ID");
  }
  verifyServiceCreditActivation(pool, activationReceipt, serviceCreditNumber, fundedRule.policyId);
  const result = {
    ...state,
    stage: "service-credit-active",
    updatedAt: new Date().toISOString(),
    credit: {
      label,
      serviceCreditNumber,
      sponsor: state.operator,
      creditAmount: CREDIT_AMOUNT.toString(),
      refundAfter,
      creationBlock: draft.creationBlock,
      termsHash: draft.termsHash,
      activatedAt: new Date().toISOString(),
      attemptSigner: getAddress(fundedRule.attemptSigner),
      beneficiary: getAddress(fundedRule.beneficiary),
      policyId: String(fundedRule.policyId).toLowerCase(),
      actionId,
      sku,
      startBlock,
      endBlock,
      maxBlockGap: MAX_BLOCK_GAP,
      minimumSettledValue: SETTLED_VALUE.toString(),
      minimumAttemptGasLimit: MINIMUM_ATTEMPT_GAS_LIMIT.toString(),
      maxFailureGasUsed: MAX_FAILURE_GAS_USED.toString(),
    },
    transactions: {
      ...state.transactions,
      inventoryVersion: inventoryReceipt.hash,
      serviceCreditCreation: creationReceipt.hash,
      serviceCreditActivation: activationReceipt.hash,
    },
  };
  await authenticateActiveCredit(result, ccProvider);
  return result;
}

async function executeSource({ state, ccProvider, sepoliaProvider, sepoliaOperator }) {
  requireStage(state, "service-credit-active");
  await authenticateInfrastructure(state, ccProvider, sepoliaProvider);
  await authenticateActiveCredit(state, ccProvider);
  const checkoutArtifact = await readArtifact(artifacts.checkout);
  const tokenArtifact = await readArtifact(artifacts.token);
  const checkout = new Contract(state.contracts.checkout, checkoutArtifact.abi, sepoliaOperator);
  const token = new Contract(state.contracts.testSettlementToken, tokenArtifact.abi, sepoliaProvider);
  await waitForSourceWindow(sepoliaProvider, state.credit.startBlock, state.credit.endBlock);
  const failurePayload = abiCoder.encode(
    ["address", "bytes32", "uint64"],
    [state.merchant, state.credit.sku, 1],
  );
  const successPayload = abiCoder.encode(
    ["address", "bytes32", "uint64"],
    [state.merchant, state.credit.sku, 2],
  );
  const failureAttempt = attemptFor(state, 1, failurePayload);
  const successAttempt = attemptFor(state, 2, successPayload);
  const domain = {
    name: "RetryCredit Checkout",
    version: "1",
    chainId: SEPOLIA_CHAIN_ID,
    verifyingContract: state.contracts.checkout,
  };
  const [failureSignature, successSignature] = await Promise.all([
    sepoliaOperator.signTypedData(domain, attemptTypes, failureAttempt),
    sepoliaOperator.signTypedData(domain, attemptTypes, successAttempt),
  ]);

  let observedFailure;
  try {
    await checkout.checkout.staticCall(failureAttempt, failurePayload, failureSignature, {
      gasLimit: SOURCE_GAS_LIMIT,
    });
    throw new Error("stale attempt unexpectedly simulated successfully");
  } catch (error) {
    const parsed = parseContractError(checkout, error);
    if (parsed !== "StaleQuote") throw new Error(`expected StaleQuote before broadcast, received ${parsed}`);
    observedFailure = parsed;
  }

  status("broadcasting the authorized stale quote; an included status-0 receipt is expected");
  const sourceJourneyStartedAt = new Date().toISOString();
  const failureRequest = await checkout.checkout.populateTransaction(
    failureAttempt,
    failurePayload,
    failureSignature,
  );
  const failureTransaction = await sepoliaOperator.sendTransaction({
    ...failureRequest,
    gasLimit: SOURCE_GAS_LIMIT,
  });
  const failureReceipt = await sepoliaProvider.waitForTransaction(failureTransaction.hash, 1, 180_000);
  if (!failureReceipt || Number(failureReceipt.status) !== 0) throw new Error("the first source receipt did not fail");
  await journal("source-attempt-failed", {
    transactionHash: failureReceipt.hash,
    blockNumber: failureReceipt.blockNumber,
    gasUsed: failureReceipt.gasUsed.toString(),
  });

  await checkout.checkout.staticCall(successAttempt, successPayload, successSignature, {
    gasLimit: SOURCE_GAS_LIMIT,
  });
  const beneficiaryBefore = await token.balanceOf(state.operator);
  const merchantBefore = await token.balanceOf(state.merchant);
  status("broadcasting the refreshed authorized checkout; a settled status-1 receipt is expected");
  const successReceipt = await sendAndRequireSuccess(checkout.checkout(
    successAttempt,
    successPayload,
    successSignature,
    { gasLimit: SOURCE_GAS_LIMIT },
  ));
  await journal("source-attempt-settled", {
    transactionHash: successReceipt.hash,
    blockNumber: successReceipt.blockNumber,
    gasUsed: successReceipt.gasUsed.toString(),
  });
  const beneficiaryAfter = await token.balanceOf(state.operator);
  const merchantAfter = await token.balanceOf(state.merchant);
  const [failedSourceTransaction, successfulSourceTransaction] = await Promise.all([
    sepoliaProvider.getTransaction(failureReceipt.hash),
    sepoliaProvider.getTransaction(successReceipt.hash),
  ]);
  validateIncludedSourceReceipts(state, failureReceipt, successReceipt, failedSourceTransaction, successfulSourceTransaction);
  if (beneficiaryBefore - beneficiaryAfter !== SETTLED_VALUE || merchantAfter - merchantBefore !== SETTLED_VALUE) {
    throw new Error("source checkout did not move the exact bound settlement amount");
  }
  if (successReceipt.blockNumber <= failureReceipt.blockNumber) {
    throw new Error("successful retry was not included in a later source block");
  }
  if (successReceipt.blockNumber - failureReceipt.blockNumber > state.credit.maxBlockGap) {
    throw new Error("source retry exceeded the funded block gap");
  }
  return {
    ...state,
    stage: "source-failure-and-settlement-complete",
    updatedAt: new Date().toISOString(),
    sourceEvidence: {
      startedAt: sourceJourneyStartedAt,
      completedAt: new Date().toISOString(),
      failureTransaction: failureReceipt.hash,
      failureBlock: failureReceipt.blockNumber,
      failureStatus: Number(failureReceipt.status),
      failureGasUsed: failureReceipt.gasUsed.toString(),
      preflightFailure: observedFailure,
      successfulTransaction: successReceipt.hash,
      successfulBlock: successReceipt.blockNumber,
      successfulStatus: Number(successReceipt.status),
      successfulGasUsed: successReceipt.gasUsed.toString(),
      settledValue: SETTLED_VALUE.toString(),
      beneficiaryTokenDelta: (beneficiaryAfter - beneficiaryBefore).toString(),
      merchantTokenDelta: (merchantAfter - merchantBefore).toString(),
    },
    transactions: {
      ...state.transactions,
      sourceFailure: failureReceipt.hash,
      sourceSuccess: successReceipt.hash,
    },
  };
}

async function attestationStatus({ state, ccProvider }) {
  requireStage(state, "source-failure-and-settlement-complete");
  const chainInfo = new Contract(CHAIN_INFO, chainInfoAbi, ccProvider);
  const latest = await chainInfo.get_latest_attestation_height_and_hash(SEPOLIA_CHAIN_KEY);
  let proofBuilderReady = false;
  let proofBuilderStatus = "not-yet-available";
  try {
    const builder = new proofProvider.service.ProofBuilder(SEPOLIA_CHAIN_KEY, PROOF_BUILDER, 120_000);
    await builder.waitUntilHeightAttested(
      SEPOLIA_CHAIN_KEY,
      state.sourceEvidence.successfulBlock,
      1,
      1,
      0,
    );
    proofBuilderReady = true;
    proofBuilderStatus = "available";
  } catch (error) {
    proofBuilderStatus = String(error?.message ?? "proof builder readiness check failed");
  }
  const nativeReady = Boolean(
    latest.exists && latest.isAttestation && Number(latest.height) >= state.sourceEvidence.successfulBlock
  );
  return {
    schemaVersion: state.schemaVersion,
    stage: "attestation-status",
    checkedAt: new Date().toISOString(),
    latestAttestedHeight: Number(latest.height),
    successfulSourceBlock: state.sourceEvidence.successfulBlock,
    nativeReady,
    proofBuilderReady,
    proofBuilderStatus,
    ready: nativeReady && proofBuilderReady,
  };
}

async function proveRelease({ state, ccProvider, sepoliaProvider, ccRelayer, ccOperator }) {
  requireStage(state, "source-failure-and-settlement-complete");
  await authenticateInfrastructure(state, ccProvider, sepoliaProvider);
  await authenticateActiveCredit(state, ccProvider);
  const poolArtifact = await readArtifact(artifacts.pool);
  const pool = new Contract(state.contracts.pool, poolArtifact.abi, ccRelayer);
  const builder = new proofProvider.service.ProofBuilder(SEPOLIA_CHAIN_KEY, PROOF_BUILDER, 120_000);
  status(
    `waiting up to ${PROOF_BUILDER_WAIT_TIMEOUT_MS / 60_000} minutes for proof-builder height ${state.sourceEvidence.successfulBlock}`,
  );
  await builder.waitUntilHeightAttested(
    SEPOLIA_CHAIN_KEY,
    state.sourceEvidence.successfulBlock,
    PROOF_BUILDER_POLL_MS,
    PROOF_BUILDER_WAIT_TIMEOUT_MS,
    PROOF_BUILDER_CONSISTENCY_DELAY_MS,
  );
  const worker = new RuleDropWorker({
    poolAddress: state.contracts.pool,
    poolAbi: poolArtifact.abi,
    creditcoinProvider: ccProvider,
    proofBuilderUrl: PROOF_BUILDER,
    sourceChainKey: SEPOLIA_CHAIN_KEY,
    sourceChainId: SEPOLIA_CHAIN_ID,
    retryCreditPoolAddress: state.contracts.pool,
    retryCreditPoolContract: pool,
    proofBuilder: builder,
  });
  const beneficiaryBefore = await ccProvider.getBalance(ccOperator.address);
  status("building one native Attestcoin batch and simulating the exact CC3 release");
  const prepared = await worker.prepareRetryCreditRelease({
    serviceCreditNumber: state.credit.serviceCreditNumber,
    failedTransactionHash: state.sourceEvidence.failureTransaction,
    successfulTransactionHash: state.sourceEvidence.successfulTransaction,
    relayer: ccRelayer.address,
  });
  const releaseReceipt = await sendAndRequireSuccess(ccRelayer.sendTransaction({
    to: prepared.transaction.to,
    data: prepared.transaction.data,
    gasLimit: 8_000_000n,
    value: 0,
  }));
  await journal("service-credit-released", {
    transactionHash: releaseReceipt.hash,
    blockNumber: releaseReceipt.blockNumber,
    serviceCreditNumber: state.credit.serviceCreditNumber,
  });
  const beneficiaryAfter = await ccProvider.getBalance(ccOperator.address);
  const releasedAt = new Date().toISOString();
  const sourceJourneyStartedAt = Date.parse(state.sourceEvidence.startedAt);
  if (!Number.isFinite(sourceJourneyStartedAt)) throw new Error("source journey start time is invalid");
  const sourceToCreditSeconds = Math.ceil((Date.parse(releasedAt) - sourceJourneyStartedAt) / 1_000);
  if (beneficiaryAfter - beneficiaryBefore !== CREDIT_AMOUNT) {
    throw new Error("Creditcoin beneficiary did not receive the exact pre-funded service credit");
  }
  const credit = await pool.getServiceCredit(state.credit.serviceCreditNumber);
  if (!credit.released || credit.refunded) throw new Error("service credit did not reach the released state");
  let replayRejection = "";
  try {
    await ccProvider.call({
      from: ccRelayer.address,
      to: prepared.transaction.to,
      data: prepared.transaction.data,
      gasLimit: 8_000_000n,
      value: 0,
    });
    throw new Error("released service credit unexpectedly replayed");
  } catch (error) {
    replayRejection = parseContractError(pool, error);
    if (replayRejection !== "AlreadyResolved") {
      throw new Error(`expected AlreadyResolved on replay, received ${replayRejection}`);
    }
  }
  return {
    ...state,
    stage: "credit-released",
    updatedAt: new Date().toISOString(),
    releaseEvidence: {
      releasedAt,
      sourceToCreditSeconds,
      withinTwelveMinutes: sourceToCreditSeconds <= 12 * 60,
      simulationPassed: prepared.simulationPassed,
      proof: prepared.proof,
      releaseTransaction: releaseReceipt.hash,
      creditAmount: CREDIT_AMOUNT.toString(),
      beneficiaryBalanceDelta: (beneficiaryAfter - beneficiaryBefore).toString(),
      relayer: ccRelayer.address,
      replayRejection,
    },
    transactions: {
      ...state.transactions,
      creditRelease: releaseReceipt.hash,
    },
  };
}

async function recoverRelease({ state, releaseTransactionHash, ccProvider }) {
  requireStage(state, "source-failure-and-settlement-complete");
  if (!isHexString(releaseTransactionHash, 32)) throw new Error("recover-release requires the exact release transaction hash");
  const poolArtifact = await readArtifact(artifacts.pool);
  const pool = new Contract(state.contracts.pool, poolArtifact.abi, ccProvider);
  const id = BigInt(state.credit.serviceCreditNumber);
  const [receipt, transaction, credit, rule] = await Promise.all([
    ccProvider.getTransactionReceipt(releaseTransactionHash),
    ccProvider.getTransaction(releaseTransactionHash),
    pool.getServiceCredit(id),
    pool.getRule(id),
  ]);
  if (
    !receipt
    || !transaction
    || Number(receipt.status) !== 1
    || getAddress(transaction.from) !== getAddress(state.relayer)
    || getAddress(transaction.to) !== getAddress(state.contracts.pool)
    || BigInt(transaction.value) !== 0n
  ) {
    throw new Error("release transaction does not match the bounded relayer and pool");
  }
  const decoded = pool.interface.decodeFunctionData("releaseCredit", transaction.data);
  if (BigInt(decoded.serviceCreditNumber) !== id) throw new Error("release transaction used a different service credit");
  assertResolvedCreditMatchesState(credit, rule, state);

  const event = parseCreditReleasedEvent(pool, receipt, state.contracts.pool);
  const failureQueryId = requireNonzeroBytes32(event.failureQueryId, "failure query ID");
  const successQueryId = requireNonzeroBytes32(event.successQueryId, "success query ID");
  const pairId = requireNonzeroBytes32(event.pairId, "pair ID");
  if (
    BigInt(event.serviceCreditNumber) !== id
    || String(event.policyId).toLowerCase() !== String(state.credit.policyId).toLowerCase()
    || getAddress(event.beneficiary) !== getAddress(state.operator)
    || BigInt(event.creditAmount) !== CREDIT_AMOUNT
    || getAddress(event.prover) !== getAddress(state.relayer)
    || failureQueryId === successQueryId
  ) {
    throw new Error("CreditReleased event does not match the pre-funded service credit");
  }
  const actionKey = keccak256(abiCoder.encode(
    ["uint64", "uint64", "address", "address", "bytes32"],
    [SEPOLIA_CHAIN_KEY, SEPOLIA_CHAIN_ID, state.contracts.checkout, state.operator, state.credit.actionId],
  ));
  const [
    failureConsumed,
    successConsumed,
    pairConsumed,
    actionConsumed,
    beneficiaryBefore,
    beneficiaryAfter,
    poolBefore,
    poolAfter,
    releaseBlock,
  ] = await Promise.all([
    pool.consumedQueries(failureQueryId),
    pool.consumedQueries(successQueryId),
    pool.consumedPairs(pairId),
    pool.consumedActions(actionKey),
    ccProvider.getBalance(state.operator, receipt.blockNumber - 1),
    ccProvider.getBalance(state.operator, receipt.blockNumber),
    ccProvider.getBalance(state.contracts.pool, receipt.blockNumber - 1),
    ccProvider.getBalance(state.contracts.pool, receipt.blockNumber),
    ccProvider.getBlock(receipt.blockNumber),
  ]);
  if (!failureConsumed || !successConsumed || !pairConsumed || !actionConsumed) {
    throw new Error("release replay keys were not all consumed");
  }
  if (
    BigInt(beneficiaryAfter) - BigInt(beneficiaryBefore) !== CREDIT_AMOUNT
    || BigInt(poolBefore) - BigInt(poolAfter) !== CREDIT_AMOUNT
  ) {
    throw new Error("historical balances do not prove the exact service-credit transfer");
  }
  let replayRejection = "";
  try {
    await ccProvider.call({
      from: state.relayer,
      to: state.contracts.pool,
      data: transaction.data,
      gasLimit: 8_000_000n,
      value: 0,
    });
    throw new Error("released service credit unexpectedly replayed");
  } catch (error) {
    replayRejection = parseContractError(pool, error);
    if (replayRejection !== "AlreadyResolved") {
      throw new Error(`expected AlreadyResolved on recovered replay, received ${replayRejection}`);
    }
  }
  if (!releaseBlock) throw new Error("release block is unavailable");
  const releasedAt = new Date(Number(releaseBlock.timestamp) * 1_000).toISOString();
  const startedAtMs = Date.parse(state.sourceEvidence.startedAt);
  if (!Number.isFinite(startedAtMs)) throw new Error("source journey start time is invalid");
  const sourceToCreditSeconds = Number(releaseBlock.timestamp) - Math.floor(startedAtMs / 1_000);
  return {
    ...state,
    stage: "credit-released",
    updatedAt: new Date().toISOString(),
    releaseEvidence: {
      recoveredFromReceipt: true,
      releasedAt,
      releaseBlock: receipt.blockNumber,
      sourceToCreditSeconds,
      withinTwelveMinutes: sourceToCreditSeconds <= 12 * 60,
      releaseTransaction: receipt.hash,
      creditAmount: CREDIT_AMOUNT.toString(),
      beneficiaryBalanceDelta: (BigInt(beneficiaryAfter) - BigInt(beneficiaryBefore)).toString(),
      poolBalanceDelta: (BigInt(poolBefore) - BigInt(poolAfter)).toString(),
      relayer: getAddress(state.relayer),
      failureQueryId,
      successQueryId,
      pairId,
      actionKey,
      replayRejection,
    },
    transactions: {
      ...state.transactions,
      creditRelease: receipt.hash,
    },
  };
}

function parseCreditReleasedEvent(pool, receipt, expectedPool) {
  const releaseEvents = [];
  for (const log of receipt.logs ?? []) {
    if (getAddress(log.address) !== getAddress(expectedPool)) continue;
    try {
      const parsed = pool.interface.parseLog(log);
      if (parsed?.name === "CreditReleased") releaseEvents.push(parsed.args);
    } catch {
      // Ignore non-Pool logs that happen to be emitted by the same transaction.
    }
  }
  if (releaseEvents.length !== 1) throw new Error("release receipt did not emit exactly one CreditReleased event");
  return releaseEvents[0];
}

function attemptFor(state, quoteVersion, payload) {
  return {
    sourceChainId: BigInt(SEPOLIA_CHAIN_ID),
    target: state.contracts.checkout,
    beneficiary: state.operator,
    settlementAsset: state.contracts.testSettlementToken,
    settlementRecipient: state.merchant,
    policyId: state.credit.policyId,
    actionId: state.credit.actionId,
    quoteVersion: BigInt(quoteVersion),
    settledValue: SETTLED_VALUE,
    payloadHash: keccak256(payload),
    validUntil: BigInt(state.credit.endBlock),
  };
}

async function deploy(label, artifactPath, signer, args, libraries = {}) {
  const artifact = await readArtifact(artifactPath);
  const bytecode = linkArtifactBytecode(artifact, libraries);
  const factory = new ContractFactory(artifact.abi, bytecode, signer);
  const contract = await factory.deploy(...args);
  const transaction = contract.deploymentTransaction();
  if (!transaction) throw new Error(`${label} deployment did not produce a transaction`);
  const receipt = await transaction.wait();
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`${label} deployment failed`);
  const address = await contract.getAddress();
  const code = await signer.provider.getCode(address);
  if (code === "0x") throw new Error(`${label} has no deployed bytecode`);
  await journal("contract-deployed", {
    label,
    address,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  });
  return { address, transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
}

async function sendAndRequireSuccess(transactionPromise) {
  const transaction = await transactionPromise;
  const receipt = await transaction.wait();
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`transaction ${transaction.hash} failed`);
  return receipt;
}

async function waitForBlockAfter(provider, blockNumber, timeoutMs) {
  const started = Date.now();
  while (await provider.getBlockNumber() <= blockNumber) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the next Creditcoin block");
    await delay(1_500);
  }
}

async function waitForSourceWindow(provider, startBlock, endBlock) {
  for (;;) {
    const current = await provider.getBlockNumber();
    if (current > endBlock) throw new Error("the funded Sepolia source window expired before execution");
    if (current >= startBlock) return;
    status(`waiting for funded Sepolia start block ${startBlock}; current ${current}`);
    await delay(4_000);
  }
}

async function assertNetwork(provider, expectedChainId, label) {
  const rawChainId = await provider.send("eth_chainId", []);
  const actualChainId = Number(BigInt(rawChainId));
  if (actualChainId !== expectedChainId) {
    throw new Error(`${label} RPC returned chain ${actualChainId}`);
  }
}

async function readArtifact(relativePath) {
  const parsed = JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
  const bytecode = parsed.bytecode?.object;
  const linkReferences = parsed.bytecode?.linkReferences ?? {};
  const hasLinkReferences = Object.values(linkReferences).some(
    (libraries) => Object.values(libraries).some((references) => references.length > 0),
  );
  if (
    !Array.isArray(parsed.abi)
    || typeof bytecode !== "string"
    || !bytecode.startsWith("0x")
    || bytecode === "0x"
    || (!hasLinkReferences && !isHexString(bytecode))
  ) {
    throw new Error(`invalid compiled artifact ${relativePath}; run forge build first`);
  }
  return parsed;
}

function linkArtifactBytecode(artifact, libraries) {
  return linkBytecodeObject(artifact.bytecode.object, artifact.bytecode.linkReferences ?? {}, libraries);
}

function linkBytecodeObject(bytecodeObject, references, libraries) {
  if (typeof bytecodeObject !== "string" || !bytecodeObject.startsWith("0x") || bytecodeObject === "0x") {
    throw new Error("compiled linked bytecode is invalid");
  }
  let bytecode = bytecodeObject;
  for (const [sourceName, sourceLibraries] of Object.entries(references)) {
    for (const [libraryName, positions] of Object.entries(sourceLibraries)) {
      const configured = libraries[`${sourceName}:${libraryName}`] ?? libraries[libraryName];
      if (!configured) throw new Error(`missing deployed library ${sourceName}:${libraryName}`);
      const address = requireNonzeroAddress(configured, `library ${libraryName}`).slice(2).toLowerCase();
      for (const position of positions) {
        if (position.length !== 20) throw new Error(`unsupported ${libraryName} link-reference length`);
        const start = 2 + Number(position.start) * 2;
        const end = start + Number(position.length) * 2;
        bytecode = `${bytecode.slice(0, start)}${address}${bytecode.slice(end)}`;
      }
    }
  }
  if (!isHexString(bytecode) || bytecode === "0x") throw new Error("linked deployment bytecode is still invalid");
  return bytecode;
}

function bindLibrarySelfAddress(runtimeBytecode, address) {
  if (!isHexString(runtimeBytecode) || runtimeBytecode === "0x") {
    throw new Error("compiled library runtime bytecode is invalid");
  }
  if (!runtimeBytecode.toLowerCase().startsWith(`0x73${"0".repeat(40)}`)) {
    throw new Error("compiled library runtime does not contain the expected self-address guard");
  }
  return `0x73${requireNonzeroAddress(address, "library self address").slice(2).toLowerCase()}${runtimeBytecode.slice(44)}`;
}

async function verifyLibraryRuntimeBytecode(provider, address, artifact) {
  const expected = bindLibrarySelfAddress(artifact.deployedBytecode?.object, address);
  const actual = await provider.getCode(address);
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error("deployed library runtime bytecode drifted");
}

async function verifyLinkedRuntimeBytecode(provider, address, artifact, libraries) {
  const expected = linkBytecodeObject(
    artifact.deployedBytecode?.object,
    artifact.deployedBytecode?.linkReferences ?? {},
    libraries,
  );
  const actual = await provider.getCode(address);
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error("deployed linked runtime bytecode drifted");
}

async function loadState(statePath) {
  if (!statePath) throw new Error("a private spike state JSON path is required");
  return JSON.parse(await readFile(path.resolve(statePath), "utf8"));
}

function validateInfrastructureState(state, operator, relayer) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("spike state must be an object");
  if (state.schemaVersion !== "retrycredit.spike-state.v1") throw new Error("unexpected spike state schema");
  if (![
    "infrastructure-deployed",
    "service-credit-active",
    "source-failure-and-settlement-complete",
    "credit-released",
  ].includes(state.stage)) {
    throw new Error(`unexpected spike state stage ${state.stage}`);
  }
  const storedOperator = requireNonzeroAddress(state.operator, "state operator");
  const storedRelayer = requireNonzeroAddress(state.relayer, "state relayer");
  if (operator && storedOperator !== getAddress(operator)) {
    throw new Error("state operator does not match the Keychain signer");
  }
  if (relayer && storedRelayer !== getAddress(relayer)) {
    throw new Error("state relayer does not match the derived relayer");
  }
  if (requireNonzeroAddress(state.merchant, "state merchant") !== getAddress(MERCHANT)) {
    throw new Error("state merchant does not match the bounded spike merchant");
  }
  if (
    Number(state.networks?.creditcoin?.chainId) !== CC_CHAIN_ID
    || Number(state.networks?.creditcoin?.sourceChainKey) !== SEPOLIA_CHAIN_KEY
    || Number(state.networks?.source?.chainId) !== SEPOLIA_CHAIN_ID
    || state.networks?.source?.name !== "Sepolia"
  ) {
    throw new Error("state network constants do not match the bounded spike");
  }
  const expectedContractKeys = ["checkout", "evmV1Decoder", "pool", "predicate", "testSettlementToken", "verifier"];
  const actualContractKeys = Object.keys(state.contracts ?? {}).sort();
  if (JSON.stringify(actualContractKeys) !== JSON.stringify(expectedContractKeys)) {
    throw new Error("state contract set is incomplete or unexpected");
  }
  const addresses = expectedContractKeys.map((key) => requireNonzeroAddress(state.contracts[key], `state ${key}`));
  if (new Set(addresses).size !== addresses.length) throw new Error("state contract addresses must be distinct");
  for (const key of [
    "tokenDeployment",
    "tokenMint",
    "checkoutDeployment",
    "tokenApproval",
    "decoderDeployment",
    "predicateDeployment",
    "verifierDeployment",
    "poolDeployment",
  ]) {
    if (!isHexString(state.transactions?.[key], 32)) throw new Error(`state is missing transaction ${key}`);
  }
  if (state.transactions?.relayerFunding != null && !isHexString(state.transactions.relayerFunding, 32)) {
    throw new Error("state relayer funding transaction is invalid");
  }
  if (state.truthBoundary !== "The source asset is a disclosed disposable test token, not canonical USDC.") {
    throw new Error("state truth boundary is missing or changed");
  }
  return { operator: storedOperator, relayer: storedRelayer };
}

async function authenticateInfrastructure(state, ccProvider, sepoliaProvider) {
  validateInfrastructureState(state, state.operator, state.relayer);
  const [tokenArtifact, checkoutArtifact, decoderArtifact, predicateArtifact, verifierArtifact, poolArtifact] = await Promise.all([
    readArtifact(artifacts.token),
    readArtifact(artifacts.checkout),
    readArtifact(artifacts.decoder),
    readArtifact(artifacts.predicate),
    readArtifact(artifacts.verifier),
    readArtifact(artifacts.pool),
  ]);
  const token = new Contract(state.contracts.testSettlementToken, tokenArtifact.abi, sepoliaProvider);
  const checkout = new Contract(state.contracts.checkout, checkoutArtifact.abi, sepoliaProvider);
  const verifier = new Contract(state.contracts.verifier, verifierArtifact.abi, ccProvider);
  const pool = new Contract(state.contracts.pool, poolArtifact.abi, ccProvider);
  const contractLocations = [
    [sepoliaProvider, state.contracts.testSettlementToken, state.transactions.tokenDeployment, "test settlement token"],
    [sepoliaProvider, state.contracts.checkout, state.transactions.checkoutDeployment, "checkout"],
    [ccProvider, state.contracts.evmV1Decoder, state.transactions.decoderDeployment, "EvmV1Decoder library"],
    [ccProvider, state.contracts.predicate, state.transactions.predicateDeployment, "predicate"],
    [ccProvider, state.contracts.verifier, state.transactions.verifierDeployment, "verifier"],
    [ccProvider, state.contracts.pool, state.transactions.poolDeployment, "pool"],
  ];
  await Promise.all(contractLocations.map(async ([provider, address, transactionHash, label]) => {
    const [code] = await Promise.all([
      provider.getCode(address),
      verifyDeploymentReceipt(provider, transactionHash, address, label),
    ]);
    if (code === "0x") throw new Error(`${label} has no bytecode`);
  }));
  await Promise.all([
    verifySuccessfulReceipt(sepoliaProvider, state.transactions.tokenMint, "test-token mint"),
    verifySuccessfulReceipt(sepoliaProvider, state.transactions.tokenApproval, "test-token approval"),
    state.transactions.relayerFunding
      ? verifySuccessfulReceipt(ccProvider, state.transactions.relayerFunding, "relayer funding")
      : Promise.resolve(),
  ]);
  await Promise.all([
    verifyLibraryRuntimeBytecode(ccProvider, state.contracts.evmV1Decoder, decoderArtifact),
    verifyLinkedRuntimeBytecode(
      ccProvider,
      state.contracts.predicate,
      predicateArtifact,
      { EvmV1Decoder: state.contracts.evmV1Decoder },
    ),
  ]);
  const [
    decimals,
    tokenBalance,
    tokenAllowance,
    checkoutAttemptSigner,
    checkoutSettlementAsset,
    poolSourceChainKey,
    poolSourceChainId,
    poolVerifier,
    poolPredicate,
    poolChainInfo,
    verifierSourceChainKey,
    verifierSourceChainId,
    verifierPredicate,
    nativeVerifier,
  ] = await Promise.all([
    token.decimals(),
    token.balanceOf(state.operator),
    token.allowance(state.operator, state.contracts.checkout),
    checkout.attemptSigner(),
    checkout.settlementAsset(),
    pool.sourceChainKey(),
    pool.sourceChainId(),
    pool.retryVerifier(),
    pool.predicate(),
    pool.chainInfo(),
    verifier.sourceChainKey(),
    verifier.sourceChainId(),
    verifier.predicate(),
    verifier.verifier(),
  ]);
  if (Number(decimals) !== 18) throw new Error("disclosed test settlement token decimals drifted");
  if (BigInt(tokenBalance) < SETTLED_VALUE || BigInt(tokenAllowance) < SETTLED_VALUE) {
    throw new Error("source operator no longer has enough approved test settlement tokens");
  }
  if (
    getAddress(checkoutAttemptSigner) !== getAddress(state.operator)
    || getAddress(checkoutSettlementAsset) !== getAddress(state.contracts.testSettlementToken)
  ) {
    throw new Error("source checkout immutables do not match the private state");
  }
  if (
    Number(poolSourceChainKey) !== SEPOLIA_CHAIN_KEY
    || Number(poolSourceChainId) !== SEPOLIA_CHAIN_ID
    || getAddress(poolVerifier) !== getAddress(state.contracts.verifier)
    || getAddress(poolPredicate) !== getAddress(state.contracts.predicate)
    || getAddress(poolChainInfo) !== getAddress(CHAIN_INFO)
  ) {
    throw new Error("RetryCredit pool immutables do not match the bounded spike");
  }
  if (
    Number(verifierSourceChainKey) !== SEPOLIA_CHAIN_KEY
    || Number(verifierSourceChainId) !== SEPOLIA_CHAIN_ID
    || getAddress(verifierPredicate) !== getAddress(state.contracts.predicate)
    || getAddress(nativeVerifier) !== NATIVE_VERIFIER
  ) {
    throw new Error("Attestcoin verifier immutables do not match the native sponsor stack");
  }
}

async function loadSourceInfrastructureState(statePath) {
  if (!statePath) return null;
  return JSON.parse(await readFile(path.resolve(statePath), "utf8"));
}

async function authenticateSourceInfrastructure(state, sepoliaProvider, expectedOperator) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("partial source infrastructure state must be an object");
  }
  if (
    state.schemaVersion !== "retrycredit.source-infra.v1"
    || state.stage !== "source-infrastructure-deployed"
    || requireNonzeroAddress(state.operator, "source operator") !== getAddress(expectedOperator)
    || requireNonzeroAddress(state.merchant, "source merchant") !== getAddress(MERCHANT)
    || Number(state.networks?.source?.chainId) !== SEPOLIA_CHAIN_ID
    || state.networks?.source?.name !== "Sepolia"
    || state.truthBoundary !== "The source asset is a disclosed disposable test token, not canonical USDC."
  ) {
    throw new Error("partial source infrastructure state does not match the bounded spike");
  }
  const expectedContractKeys = ["checkout", "testSettlementToken"];
  if (JSON.stringify(Object.keys(state.contracts ?? {}).sort()) !== JSON.stringify(expectedContractKeys)) {
    throw new Error("partial source infrastructure contract set is incomplete or unexpected");
  }
  const tokenAddress = requireNonzeroAddress(state.contracts.testSettlementToken, "source test settlement token");
  const checkoutAddress = requireNonzeroAddress(state.contracts.checkout, "source checkout");
  if (tokenAddress === checkoutAddress) throw new Error("partial source infrastructure addresses must be distinct");
  for (const key of ["tokenDeployment", "tokenMint", "checkoutDeployment", "tokenApproval"]) {
    if (!isHexString(state.transactions?.[key], 32)) throw new Error(`partial source state is missing ${key}`);
  }
  const [tokenArtifact, checkoutArtifact] = await Promise.all([
    readArtifact(artifacts.token),
    readArtifact(artifacts.checkout),
  ]);
  const token = new Contract(tokenAddress, tokenArtifact.abi, sepoliaProvider);
  const checkout = new Contract(checkoutAddress, checkoutArtifact.abi, sepoliaProvider);
  await Promise.all([
    verifyDeploymentReceipt(sepoliaProvider, state.transactions.tokenDeployment, tokenAddress, "partial test token"),
    verifySuccessfulReceipt(sepoliaProvider, state.transactions.tokenMint, "partial test-token mint"),
    verifyDeploymentReceipt(sepoliaProvider, state.transactions.checkoutDeployment, checkoutAddress, "partial checkout"),
    verifySuccessfulReceipt(sepoliaProvider, state.transactions.tokenApproval, "partial test-token approval"),
  ]);
  const [tokenCode, checkoutCode, decimals, balance, allowance, attemptSigner, settlementAsset] = await Promise.all([
    sepoliaProvider.getCode(tokenAddress),
    sepoliaProvider.getCode(checkoutAddress),
    token.decimals(),
    token.balanceOf(expectedOperator),
    token.allowance(expectedOperator, checkoutAddress),
    checkout.attemptSigner(),
    checkout.settlementAsset(),
  ]);
  if (tokenCode === "0x" || checkoutCode === "0x") throw new Error("partial source infrastructure bytecode is missing");
  if (
    Number(decimals) !== 18
    || BigInt(balance) < SETTLED_VALUE
    || BigInt(allowance) < SETTLED_VALUE
    || getAddress(attemptSigner) !== getAddress(expectedOperator)
    || getAddress(settlementAsset) !== tokenAddress
  ) {
    throw new Error("partial source infrastructure state failed live contract authentication");
  }
}

async function authenticateActiveCredit(state, ccProvider) {
  if (!state.credit || typeof state.credit !== "object") throw new Error("active credit state is missing");
  const poolArtifact = await readArtifact(artifacts.pool);
  const pool = new Contract(state.contracts.pool, poolArtifact.abi, ccProvider);
  const id = BigInt(state.credit.serviceCreditNumber);
  if (id <= 0n) throw new Error("active service credit number must be positive");
  const [credit, rule, count] = await Promise.all([
    pool.getServiceCredit(id),
    pool.getRule(id),
    pool.serviceCreditCount(),
  ]);
  if (id > BigInt(count)) throw new Error("active service credit exceeds the onchain count");
  if (
    getAddress(credit.sponsor) !== getAddress(state.operator)
    || getAddress(state.credit.sponsor) !== getAddress(state.operator)
    || BigInt(credit.creditAmount) !== BigInt(state.credit.creditAmount)
    || BigInt(credit.creditAmount) !== CREDIT_AMOUNT
    || Number(credit.refundAfter) !== Number(state.credit.refundAfter)
    || Number(credit.creationBlock) !== Number(state.credit.creationBlock)
    || String(credit.termsHash).toLowerCase() !== String(state.credit.termsHash).toLowerCase()
    || credit.released
    || credit.refunded
  ) {
    throw new Error("onchain service credit does not match the active private state");
  }
  assertRuleMatchesState(rule, state);
}

function assertResolvedCreditMatchesState(credit, rule, state) {
  if (
    getAddress(credit.sponsor) !== getAddress(state.operator)
    || getAddress(state.credit.sponsor) !== getAddress(state.operator)
    || BigInt(credit.creditAmount) !== BigInt(state.credit.creditAmount)
    || BigInt(credit.creditAmount) !== CREDIT_AMOUNT
    || Number(credit.refundAfter) !== Number(state.credit.refundAfter)
    || Number(credit.creationBlock) !== Number(state.credit.creationBlock)
    || String(credit.termsHash).toLowerCase() !== String(state.credit.termsHash).toLowerCase()
    || !credit.released
    || credit.refunded
  ) {
    throw new Error("resolved onchain service credit does not match the private source state");
  }
  assertRuleMatchesState(rule, state);
}

function parseServiceCreditDraft(pool, receipt, terms, refundAfter, expectedSponsor) {
  const matches = [];
  for (const log of receipt.logs ?? []) {
    try {
      const parsed = pool.interface.parseLog(log);
      if (parsed?.name === "ServiceCreditDraftCreated") matches.push(parsed.args);
    } catch {
      // Ignore logs emitted by other contracts in the same receipt.
    }
  }
  if (matches.length !== 1) throw new Error("service credit creation did not emit exactly one draft event");
  const event = matches[0];
  if (
    getAddress(event.sponsor) !== getAddress(expectedSponsor)
    || getAddress(event.beneficiary) !== getAddress(terms.beneficiary)
    || BigInt(event.creditAmount) !== CREDIT_AMOUNT
    || Number(event.refundAfter) !== Number(refundAfter)
    || Number(event.creationBlock) !== Number(receipt.blockNumber)
    || !isHexString(event.termsHash, 32)
  ) {
    throw new Error("service credit draft event does not match the submitted terms");
  }
  return {
    serviceCreditNumber: BigInt(event.serviceCreditNumber),
    creationBlock: Number(event.creationBlock),
    termsHash: String(event.termsHash).toLowerCase(),
  };
}

async function verifyStoredDraft(
  pool,
  serviceCreditNumber,
  terms,
  draft,
  refundAfter,
  creationBlock,
  expectedSponsor,
) {
  const [credit, rule, sourceChainKey, sourceChainId] = await Promise.all([
    pool.getServiceCredit(serviceCreditNumber),
    pool.getRule(serviceCreditNumber),
    pool.sourceChainKey(),
    pool.sourceChainId(),
  ]);
  const expectedTermsHash = keccak256(abiCoder.encode(
    ["uint64", "uint64", ruleTupleType, "uint64", "uint256"],
    [sourceChainKey, sourceChainId, terms, refundAfter, CREDIT_AMOUNT],
  ));
  if (
    getAddress(credit.sponsor) !== getAddress(expectedSponsor)
    || BigInt(credit.creditAmount) !== CREDIT_AMOUNT
    || Number(credit.refundAfter) !== Number(refundAfter)
    || Number(credit.creationBlock) !== Number(creationBlock)
    || Number(credit.creationBlock) !== Number(draft.creationBlock)
    || String(credit.termsHash).toLowerCase() !== expectedTermsHash.toLowerCase()
    || draft.termsHash !== expectedTermsHash.toLowerCase()
    || credit.released
    || credit.refunded
  ) {
    throw new Error("stored service credit draft does not match the emitted funded draft");
  }
  assertRuleMatchesTerms(rule, terms);
}

function verifyServiceCreditActivation(pool, receipt, serviceCreditNumber, policyId) {
  const matches = [];
  for (const log of receipt.logs ?? []) {
    try {
      const parsed = pool.interface.parseLog(log);
      if (parsed?.name === "ServiceCreditActivated") matches.push(parsed.args);
    } catch {
      // Ignore unrelated logs.
    }
  }
  if (matches.length !== 1) throw new Error("service credit activation did not emit exactly one activation event");
  const event = matches[0];
  if (
    BigInt(event.serviceCreditNumber) !== BigInt(serviceCreditNumber)
    || String(event.policyId).toLowerCase() !== String(policyId).toLowerCase()
    || !isHexString(event.creationBlockHash, 32)
    || event.creationBlockHash === ZeroHash
  ) {
    throw new Error("service credit activation event does not match the stored rule");
  }
}

function assertRuleMatchesTerms(rule, expected) {
  const addressFields = ["attemptSigner", "beneficiary", "target", "settlementAsset", "settlementRecipient"];
  for (const key of addressFields) {
    if (getAddress(rule[key]) !== getAddress(expected[key])) throw new Error(`service credit rule ${key} drifted`);
  }
  const bytesFields = ["policyId", "actionId"];
  for (const key of bytesFields) {
    if (String(rule[key]).toLowerCase() !== String(expected[key]).toLowerCase()) {
      throw new Error(`service credit rule ${key} drifted`);
    }
  }
  const numberFields = [
    "minimumSettledValue",
    "startBlock",
    "endBlock",
    "maxBlockGap",
    "minimumAttemptGasLimit",
    "maxFailureGasUsed",
  ];
  for (const key of numberFields) {
    if (BigInt(rule[key]) !== BigInt(expected[key])) throw new Error(`service credit rule ${key} drifted`);
  }
}

function assertRuleMatchesState(rule, state) {
  assertRuleMatchesTerms(rule, {
    attemptSigner: state.credit.attemptSigner,
    beneficiary: state.operator,
    target: state.contracts.checkout,
    settlementAsset: state.contracts.testSettlementToken,
    settlementRecipient: state.merchant,
    policyId: state.credit.policyId,
    actionId: state.credit.actionId,
    minimumSettledValue: state.credit.minimumSettledValue,
    startBlock: state.credit.startBlock,
    endBlock: state.credit.endBlock,
    maxBlockGap: state.credit.maxBlockGap,
    minimumAttemptGasLimit: state.credit.minimumAttemptGasLimit,
    maxFailureGasUsed: state.credit.maxFailureGasUsed,
  });
  if (!isHexString(state.credit.sku, 32) || state.credit.sku === ZeroHash) {
    throw new Error("active service credit SKU is invalid");
  }
}

function validateIncludedSourceReceipts(state, failureReceipt, successReceipt, failureTransaction, successTransaction) {
  if (!failureReceipt || !successReceipt || !failureTransaction || !successTransaction) {
    throw new Error("source receipts and transactions must all be available");
  }
  const failureBlock = Number(failureReceipt.blockNumber);
  const successBlock = Number(successReceipt.blockNumber);
  if (Number(failureReceipt.status) !== 0 || Number(successReceipt.status) !== 1) {
    throw new Error("source receipt sequence must be status 0 then status 1");
  }
  if (
    failureBlock < Number(state.credit.startBlock)
    || successBlock > Number(state.credit.endBlock)
    || successBlock <= failureBlock
    || successBlock - failureBlock > Number(state.credit.maxBlockGap)
  ) {
    throw new Error("source receipt blocks are outside the funded rule");
  }
  if (BigInt(failureReceipt.gasUsed) > BigInt(state.credit.maxFailureGasUsed)) {
    throw new Error("failed source receipt exceeded the funded gas-used ceiling");
  }
  for (const [label, transaction, receipt] of [
    ["failed", failureTransaction, failureReceipt],
    ["successful", successTransaction, successReceipt],
  ]) {
    if (
      getAddress(transaction.from) !== getAddress(state.operator)
      || getAddress(transaction.to) !== getAddress(state.contracts.checkout)
      || BigInt(transaction.value) !== 0n
      || BigInt(transaction.gasLimit) < BigInt(state.credit.minimumAttemptGasLimit)
      || Number(transaction.blockNumber) !== Number(receipt.blockNumber)
      || String(transaction.hash).toLowerCase() !== String(receipt.hash).toLowerCase()
    ) {
      throw new Error(`${label} source transaction does not match its funded receipt`);
    }
  }
  if (Number(successTransaction.nonce) <= Number(failureTransaction.nonce)) {
    throw new Error("successful source transaction nonce did not increase");
  }
}

async function verifyDeploymentReceipt(provider, transactionHash, expectedAddress, label) {
  const receipt = await provider.getTransactionReceipt(transactionHash);
  if (
    !receipt
    || Number(receipt.status) !== 1
    || !receipt.contractAddress
    || getAddress(receipt.contractAddress) !== getAddress(expectedAddress)
  ) {
    throw new Error(`${label} deployment receipt does not match the private state`);
  }
}

async function verifySuccessfulReceipt(provider, transactionHash, label) {
  const receipt = await provider.getTransactionReceipt(transactionHash);
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`${label} receipt is missing or failed`);
}

function requireNonzeroAddress(value, label) {
  const address = getAddress(value);
  if (address === ZeroAddress) throw new Error(`${label} must be nonzero`);
  return address;
}

function requireNonzeroBytes32(value, label) {
  if (!isHexString(value, 32) || String(value).toLowerCase() === ZeroHash) {
    throw new Error(`${label} must be a nonzero bytes32 value`);
  }
  return String(value).toLowerCase();
}

function requireStage(state, expected) {
  if (state.stage !== expected) throw new Error(`expected state stage ${expected}, received ${state.stage}`);
}

function requirePrivateKey() {
  const value = process.env.SPIKE_PRIVATE_KEY;
  if (!value || !isHexString(value, 32) || /^0x0+$/.test(value)) {
    throw new Error("SPIKE_PRIVATE_KEY must be loaded from Keychain as a nonzero 32-byte key");
  }
  return value;
}

function requireExpectedOperator(address) {
  if (getAddress(address) !== EXPECTED_OPERATOR) {
    throw new Error(`refusing to use unexpected spike operator ${address}`);
  }
}

function deriveRelayerKey(privateKey) {
  const derived = keccak256(concat([getBytes(privateKey), toUtf8Bytes("RETRYCREDIT_CC3_RELAYER_V1")]));
  if (/^0x0+$/.test(derived)) throw new Error("derived an invalid relayer key");
  return derived;
}

function requireMutationOutputPaths() {
  return getMutationOutputPaths(true);
}

function getMutationOutputPaths(required) {
  const privateControlRoot = path.resolve(
    "/Users/qdee/Documents/Codex/competition-controls/buidl-ctc-2026-fall",
  );
  const rawStatePath = process.env.SPIKE_STATE_OUTPUT;
  const rawJournalPath = process.env.SPIKE_JOURNAL_PATH;
  if (required && (!rawStatePath || !rawJournalPath)) {
    throw new Error("SPIKE_STATE_OUTPUT and SPIKE_JOURNAL_PATH are required for every mutating phase");
  }
  if (!rawStatePath || !rawJournalPath) return null;
  const statePath = path.resolve(rawStatePath);
  const journalPath = path.resolve(rawJournalPath);
  for (const [label, candidate] of [["state", statePath], ["journal", journalPath]]) {
    const relative = path.relative(privateControlRoot, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${label} output must be a file inside the private CTC competition-control directory`);
    }
  }
  if (path.extname(statePath) !== ".json" || path.extname(journalPath) !== ".jsonl") {
    throw new Error("spike state must end in .json and the journal must end in .jsonl");
  }
  if (statePath === journalPath) throw new Error("spike state and journal paths must be distinct");
  return { statePath, journalPath };
}

async function persistState(state) {
  validateInfrastructureState(state, state.operator, state.relayer);
  const { statePath } = requireMutationOutputPaths();
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  const serialized = `${JSON.stringify(state, bigintJsonReplacer, 2)}\n`;
  await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, statePath);
  await chmod(statePath, 0o600);
}

async function journal(event, evidence) {
  const paths = getMutationOutputPaths(false);
  if (!paths) throw new Error("mutation journal paths were not configured before an onchain action");
  if (!event || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(event)) throw new Error("invalid mutation journal event");
  const record = {
    schemaVersion: "retrycredit.spike-journal.v1",
    recordedAt: new Date().toISOString(),
    event,
    evidence,
  };
  await appendFile(paths.journalPath, `${JSON.stringify(record, bigintJsonReplacer)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(paths.journalPath, 0o600);
}

function bigintJsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function parseContractError(contract, error) {
  const data = error?.data ?? error?.revert?.data ?? error?.info?.error?.data;
  if (typeof data === "string" && data.startsWith("0x")) {
    try {
      return contract.interface.parseError(data)?.name ?? error.shortMessage ?? error.message;
    } catch {
      // Fall through to the stable text error below.
    }
  }
  return error?.revert?.name ?? error?.reason ?? error?.shortMessage ?? error?.message ?? "unknown revert";
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, bigintJsonReplacer, 2)}\n`);
}

function status(message) {
  process.stderr.write(`[retrycredit-spike] ${message}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`[retrycredit-spike] FAILED: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

export {
  assertNetwork,
  assertRuleMatchesTerms,
  bindLibrarySelfAddress,
  getMutationOutputPaths,
  linkArtifactBytecode,
  parseCreditReleasedEvent,
  parseServiceCreditDraft,
  validateIncludedSourceReceipts,
  validateInfrastructureState,
  verifyStoredDraft,
  verifyServiceCreditActivation,
};
