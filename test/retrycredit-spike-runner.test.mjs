import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, Interface, ZeroHash, keccak256, parseEther } from "ethers";
import {
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
} from "../scripts/retrycredit-spike-runner.mjs";

const operator = "0x813C4BF413BeeA09a7f61450Bd9a9Fa321ED25Db";
const relayer = "0x1111111111111111111111111111111111111111";
const merchant = "0x9fEAcC0d3BC179B6022B4aAf96F7a8217F422642";
const addresses = {
  testSettlementToken: "0x2222222222222222222222222222222222222222",
  checkout: "0x3333333333333333333333333333333333333333",
  evmV1Decoder: "0x7777777777777777777777777777777777777777",
  predicate: "0x4444444444444444444444444444444444444444",
  verifier: "0x5555555555555555555555555555555555555555",
  pool: "0x6666666666666666666666666666666666666666",
};

function transactionHash(byte) {
  return `0x${byte.repeat(64)}`;
}

function infrastructureState() {
  return {
    schemaVersion: "retrycredit.spike-state.v1",
    stage: "infrastructure-deployed",
    operator,
    relayer,
    merchant,
    networks: {
      creditcoin: { chainId: 102031, sourceChainKey: 1 },
      source: { chainId: 11155111, name: "Sepolia" },
    },
    contracts: { ...addresses },
    transactions: {
      tokenDeployment: transactionHash("1"),
      tokenMint: transactionHash("2"),
      checkoutDeployment: transactionHash("3"),
      tokenApproval: transactionHash("4"),
      decoderDeployment: transactionHash("8"),
      predicateDeployment: transactionHash("5"),
      verifierDeployment: transactionHash("6"),
      poolDeployment: transactionHash("7"),
      relayerFunding: null,
    },
    truthBoundary: "The source asset is a disclosed disposable test token, not canonical USDC.",
  };
}

function activeState() {
  return {
    ...infrastructureState(),
    stage: "service-credit-active",
    credit: {
      serviceCreditNumber: "1",
      sponsor: operator,
      creditAmount: parseEther("0.1").toString(),
      refundAfter: 4_102_444_800,
      creationBlock: 500,
      termsHash: transactionHash("8"),
      attemptSigner: operator,
      beneficiary: operator,
      policyId: transactionHash("9"),
      actionId: transactionHash("a"),
      sku: transactionHash("b"),
      startBlock: 100,
      endBlock: 180,
      maxBlockGap: 10,
      minimumSettledValue: parseEther("1").toString(),
      minimumAttemptGasLimit: "250000",
      maxFailureGasUsed: "200000",
    },
  };
}

test("state validation pins the operator, relayer, networks, contracts, and deployment evidence", () => {
  const state = infrastructureState();
  assert.deepEqual(validateInfrastructureState(state, operator, relayer), { operator, relayer });
  assert.doesNotThrow(() => validateInfrastructureState(state, operator));

  assert.throws(
    () => validateInfrastructureState({ ...state, networks: { ...state.networks, source: { chainId: 1, name: "Ethereum" } } }, operator, relayer),
    /network constants/,
  );
  assert.throws(
    () => validateInfrastructureState({ ...state, contracts: { ...state.contracts, unexpected: relayer } }, operator, relayer),
    /contract set/,
  );
});

test("network check uses raw eth_chainId instead of static provider metadata", async () => {
  let method = "";
  const provider = {
    async send(value) {
      method = value;
      return "0xaa36a7";
    },
    async getNetwork() {
      throw new Error("static network metadata must not be used");
    },
  };
  await assertNetwork(provider, 11155111, "Sepolia");
  assert.equal(method, "eth_chainId");
  await assert.rejects(() => assertNetwork(provider, 1, "Ethereum"), /returned chain 11155111/);
});

test("artifact linker fills every declared external-library placeholder", () => {
  const artifact = {
    bytecode: {
      object: `0x6000${"_".repeat(40)}6000`,
      linkReferences: {
        "contracts/EvmV1Decoder.sol": {
          EvmV1Decoder: [{ start: 2, length: 20 }],
        },
      },
    },
  };
  assert.equal(
    linkArtifactBytecode(artifact, { EvmV1Decoder: addresses.evmV1Decoder }),
    `0x6000${addresses.evmV1Decoder.slice(2)}6000`,
  );
  assert.throws(() => linkArtifactBytecode(artifact, {}), /missing deployed library/);
});

test("library runtime binding replaces only Solidity's self-address guard", () => {
  const compiled = `0x73${"0".repeat(40)}30146080`;
  assert.equal(
    bindLibrarySelfAddress(compiled, addresses.evmV1Decoder),
    `0x73${addresses.evmV1Decoder.slice(2)}30146080`,
  );
  assert.throws(() => bindLibrarySelfAddress("0x60006000", addresses.evmV1Decoder), /self-address guard/);
});

test("release recovery accepts only one CreditReleased event from the configured pool", () => {
  const iface = new Interface([
    "event CreditReleased(uint256 indexed serviceCreditNumber,bytes32 indexed policyId,address indexed beneficiary,uint256 creditAmount,bytes32 failureQueryId,bytes32 successQueryId,bytes32 pairId,address prover)",
  ]);
  const encoded = iface.encodeEventLog(iface.getEvent("CreditReleased"), [
    1,
    transactionHash("9"),
    operator,
    parseEther("0.1"),
    transactionHash("c"),
    transactionHash("d"),
    transactionHash("e"),
    relayer,
  ]);
  const pool = { interface: iface };
  const realLog = { address: addresses.pool, ...encoded };
  const spoofedLog = { address: addresses.verifier, ...encoded };

  const event = parseCreditReleasedEvent(pool, { logs: [spoofedLog, realLog] }, addresses.pool);
  assert.equal(event.serviceCreditNumber, 1n);
  assert.equal(event.prover, relayer);
  assert.throws(
    () => parseCreditReleasedEvent(pool, { logs: [spoofedLog] }, addresses.pool),
    /exactly one CreditReleased/,
  );
  assert.throws(
    () => parseCreditReleasedEvent(pool, { logs: [realLog, realLog] }, addresses.pool),
    /exactly one CreditReleased/,
  );
});

test("draft and activation parsers require one exact Pool event", () => {
  const iface = new Interface([
    "event ServiceCreditDraftCreated(uint256 indexed serviceCreditNumber,address indexed sponsor,address indexed beneficiary,uint256 creditAmount,uint64 refundAfter,uint256 creationBlock,bytes32 termsHash)",
    "event ServiceCreditActivated(uint256 indexed serviceCreditNumber,bytes32 indexed policyId,bytes32 creationBlockHash)",
  ]);
  const terms = {
    attemptSigner: operator,
    beneficiary: operator,
    target: addresses.checkout,
    settlementAsset: addresses.testSettlementToken,
    settlementRecipient: merchant,
    policyId: ZeroHash,
    actionId: transactionHash("a"),
    minimumSettledValue: parseEther("1"),
    startBlock: 100,
    endBlock: 180,
    maxBlockGap: 10,
    minimumAttemptGasLimit: 250000,
    maxFailureGasUsed: 200000,
  };
  const draftLog = iface.encodeEventLog(iface.getEvent("ServiceCreditDraftCreated"), [
    7,
    operator,
    operator,
    parseEther("0.1"),
    4_102_444_800,
    500,
    transactionHash("8"),
  ]);
  const pool = { interface: iface };
  const draft = parseServiceCreditDraft(
    pool,
    { blockNumber: 500, logs: [draftLog] },
    terms,
    4_102_444_800,
    operator,
  );
  assert.deepEqual(draft, {
    serviceCreditNumber: 7n,
    creationBlock: 500,
    termsHash: transactionHash("8"),
  });

  const activationLog = iface.encodeEventLog(iface.getEvent("ServiceCreditActivated"), [
    7,
    transactionHash("9"),
    transactionHash("c"),
  ]);
  assert.doesNotThrow(() => verifyServiceCreditActivation(
    pool,
    { logs: [activationLog] },
    7,
    transactionHash("9"),
  ));
  assert.throws(
    () => verifyServiceCreditActivation(pool, { logs: [activationLog] }, 8, transactionHash("9")),
    /does not match/,
  );
});

test("stored draft verification recomputes the exact funded terms hash", async () => {
  const ruleTuple = "tuple(address attemptSigner,address beneficiary,address target,address settlementAsset,address settlementRecipient,bytes32 policyId,bytes32 actionId,uint256 minimumSettledValue,uint64 startBlock,uint64 endBlock,uint32 maxBlockGap,uint64 minimumAttemptGasLimit,uint64 maxFailureGasUsed)";
  const terms = {
    attemptSigner: operator,
    beneficiary: operator,
    target: addresses.checkout,
    settlementAsset: addresses.testSettlementToken,
    settlementRecipient: merchant,
    policyId: ZeroHash,
    actionId: transactionHash("a"),
    minimumSettledValue: parseEther("1"),
    startBlock: 100,
    endBlock: 180,
    maxBlockGap: 10,
    minimumAttemptGasLimit: 250000,
    maxFailureGasUsed: 200000,
  };
  const refundAfter = 4_102_444_800;
  const termsHash = keccak256(AbiCoder.defaultAbiCoder().encode(
    ["uint64", "uint64", ruleTuple, "uint64", "uint256"],
    [1, 11155111, terms, refundAfter, parseEther("0.1")],
  ));
  const pool = {
    async getServiceCredit() {
      return {
        sponsor: operator,
        creditAmount: parseEther("0.1"),
        refundAfter,
        creationBlock: 500,
        termsHash,
        released: false,
        refunded: false,
      };
    },
    async getRule() {
      return terms;
    },
    async sourceChainKey() {
      return 1;
    },
    async sourceChainId() {
      return 11155111;
    },
  };
  await assert.doesNotReject(() => verifyStoredDraft(
    pool,
    7,
    terms,
    { creationBlock: 500, termsHash },
    refundAfter,
    500,
  ));
  await assert.rejects(() => verifyStoredDraft(
    pool,
    7,
    { ...terms, maxBlockGap: 11 },
    { creationBlock: 500, termsHash },
    refundAfter,
    500,
  ), /stored service credit draft/);
});

test("source receipt validator fails closed on window, gas, identity, and nonce drift", () => {
  const state = activeState();
  const failedHash = transactionHash("d");
  const successHash = transactionHash("e");
  const failureReceipt = { hash: failedHash, blockNumber: 110, status: 0, gasUsed: 150000n };
  const successReceipt = { hash: successHash, blockNumber: 111, status: 1, gasUsed: 170000n };
  const failureTransaction = {
    hash: failedHash,
    from: operator,
    to: addresses.checkout,
    value: 0n,
    gasLimit: 300000n,
    blockNumber: 110,
    nonce: 30,
  };
  const successTransaction = {
    hash: successHash,
    from: operator,
    to: addresses.checkout,
    value: 0n,
    gasLimit: 300000n,
    blockNumber: 111,
    nonce: 31,
  };
  assert.doesNotThrow(() => validateIncludedSourceReceipts(
    state,
    failureReceipt,
    successReceipt,
    failureTransaction,
    successTransaction,
  ));
  assert.throws(
    () => validateIncludedSourceReceipts(
      state,
      { ...failureReceipt, gasUsed: 200001n },
      successReceipt,
      failureTransaction,
      successTransaction,
    ),
    /gas-used ceiling/,
  );
  assert.throws(
    () => validateIncludedSourceReceipts(
      state,
      failureReceipt,
      successReceipt,
      failureTransaction,
      { ...successTransaction, nonce: 30 },
    ),
    /nonce did not increase/,
  );
});

test("rule comparison rejects any changed funded term", () => {
  const state = activeState();
  const expected = {
    attemptSigner: operator,
    beneficiary: operator,
    target: addresses.checkout,
    settlementAsset: addresses.testSettlementToken,
    settlementRecipient: merchant,
    policyId: state.credit.policyId,
    actionId: state.credit.actionId,
    minimumSettledValue: state.credit.minimumSettledValue,
    startBlock: state.credit.startBlock,
    endBlock: state.credit.endBlock,
    maxBlockGap: state.credit.maxBlockGap,
    minimumAttemptGasLimit: state.credit.minimumAttemptGasLimit,
    maxFailureGasUsed: state.credit.maxFailureGasUsed,
  };
  assert.doesNotThrow(() => assertRuleMatchesTerms(expected, expected));
  assert.throws(
    () => assertRuleMatchesTerms({ ...expected, maxBlockGap: 11 }, expected),
    /maxBlockGap drifted/,
  );
});

test("mutation outputs are restricted to the private CTC control directory", () => {
  const previousState = process.env.SPIKE_STATE_OUTPUT;
  const previousJournal = process.env.SPIKE_JOURNAL_PATH;
  try {
    process.env.SPIKE_STATE_OUTPUT = "/Users/qdee/Documents/Codex/competition-controls/buidl-ctc-2026-fall/retrycredit-test.json";
    process.env.SPIKE_JOURNAL_PATH = "/Users/qdee/Documents/Codex/competition-controls/buidl-ctc-2026-fall/retrycredit-test.jsonl";
    assert.deepEqual(getMutationOutputPaths(true), {
      statePath: process.env.SPIKE_STATE_OUTPUT,
      journalPath: process.env.SPIKE_JOURNAL_PATH,
    });
    process.env.SPIKE_STATE_OUTPUT = "/tmp/retrycredit-test.json";
    assert.throws(() => getMutationOutputPaths(true), /private CTC competition-control directory/);
  } finally {
    if (previousState === undefined) delete process.env.SPIKE_STATE_OUTPUT;
    else process.env.SPIKE_STATE_OUTPUT = previousState;
    if (previousJournal === undefined) delete process.env.SPIKE_JOURNAL_PATH;
    else process.env.SPIKE_JOURNAL_PATH = previousJournal;
  }
});
