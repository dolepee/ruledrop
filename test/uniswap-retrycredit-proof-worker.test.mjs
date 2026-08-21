import assert from "node:assert/strict";
import test from "node:test";
import {
  AbiCoder,
  Interface,
  Signature,
  SigningKey,
  TypedDataEncoder,
  concat,
  computeAddress,
  id,
  keccak256,
  verifyTypedData,
  zeroPadValue,
} from "ethers";
import {
  RETRY_CREDIT_UNISWAP_SEPOLIA,
  RuleDropWorker,
  WorkerError,
  computeUniswapRetryCreditIntent,
  decodeUniswapRetryCreditRoute,
  normalizeUniswapRetryCreditBatchProof,
} from "../src/proof-worker.mjs";

const abiCoder = AbiCoder.defaultAbiCoder();
const ROUTER_INTERFACE = new Interface([
  "function executeSigned(bytes commands,bytes[] inputs,bytes32 intent,bytes32 data,bool verifySender,bytes32 nonce,bytes signature,uint256 deadline)",
]);
const ROUTE_TYPES = {
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

// Deterministic test-only fixture keys. No runtime signing material is loaded or returned.
const TEST_ONLY_ROUTE_SIGNER_KEY = `0x${"31".repeat(32)}`;
const TEST_ONLY_OTHER_SIGNER_KEY = `0x${"32".repeat(32)}`;
const TEST_ONLY_TRADER_KEY = `0x${"33".repeat(32)}`;
const ROUTE_SIGNER = computeAddress(new SigningKey(TEST_ONLY_ROUTE_SIGNER_KEY).publicKey);
const TRADER = computeAddress(new SigningKey(TEST_ONLY_TRADER_KEY).publicKey);
const POLICY_ID = keccak256(Buffer.from("retrycredit-uniswap-policy"));
const ACTION_ID = keccak256(Buffer.from("retrycredit-uniswap-action"));
const FAILED_HASH = `0x${"a1".repeat(32)}`;
const SUCCESS_HASH = `0x${"b2".repeat(32)}`;
const POOL_ADDRESS = "0x4444444444444444444444444444444444444444";
const AMOUNT_IN = 1_000_000_000_000_000n;
const FAILED_MINIMUM_OUT = 3_000_000n;
const SUCCESS_MINIMUM_OUT = 2_000_000n;
const ACTUAL_AMOUNT_OUT = 2_500_000n;
const SWAP_EVENT = id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const TRANSFER_EVENT = id("Transfer(address,address,uint256)");
const EXPECTED_PATH = `0x${RETRY_CREDIT_UNISWAP_SEPOLIA.weth.slice(2).toLowerCase()}0001f4${RETRY_CREDIT_UNISWAP_SEPOLIA.usdc.slice(2).toLowerCase()}`;

test("decodes only normalized facts from an official signed Uniswap 2.1.1 route", () => {
  const fixture = uniswapBatchFixture();
  const encoded = fixture.merkleProofs.get(10_000_000).get(3).txBytes;
  const decoded = decodeUniswapRetryCreditRoute(encoded);

  assert.equal(decoded.target, RETRY_CREDIT_UNISWAP_SEPOLIA.router);
  assert.equal(decoded.value, AMOUNT_IN.toString());
  assert.equal(decoded.uniswapRetryCredit.routeSigner, ROUTE_SIGNER);
  assert.equal(decoded.uniswapRetryCredit.trader, TRADER);
  assert.equal(decoded.uniswapRetryCredit.commands, "0x0b00");
  assert.equal(decoded.uniswapRetryCredit.path, EXPECTED_PATH);
  assert.equal(decoded.uniswapRetryCredit.amountIn, AMOUNT_IN.toString());
  assert.equal("signature" in decoded.uniswapRetryCredit, false);
  assert.equal("inputs" in decoded.uniswapRetryCredit, false);
  assert.equal("calldata" in decoded, false);
  assert.equal(Object.isFrozen(decoded), true);
});

test("normalizes, validates, freezes, and caches a direct-Uniswap Attestcoin batch", async () => {
  let builderCalls = 0;
  const proof = uniswapBatchFixture();
  const rule = uniswapRuleFixture();
  const worker = new RuleDropWorker({
    poolAddress: POOL_ADDRESS,
    poolAbi: ["function campaignCount() view returns (uint256)"],
    poolContract: {},
    creditcoinProvider: {},
    sourceChainKey: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainKey,
    sourceChainId: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId,
    proofBuilder: {
      async getBatchProof(hashes) {
        builderCalls += 1;
        assert.deepEqual(hashes, [FAILED_HASH, SUCCESS_HASH]);
        return { success: true, data: proof };
      },
    },
  });

  const first = await worker.getUniswapRetryCreditBatchProof({
    failedTransactionHash: FAILED_HASH,
    successfulTransactionHash: SUCCESS_HASH,
    rule,
  });
  const second = await worker.getUniswapRetryCreditBatchProof({
    failedTransactionHash: FAILED_HASH,
    successfulTransactionHash: SUCCESS_HASH,
    rule,
  });

  assert.equal(first, second);
  assert.equal(builderCalls, 1);
  assert.equal(first.summary.failed.receiptStatus, 0);
  assert.equal(first.summary.successful.receiptStatus, 1);
  assert.equal(first.summary.failed.uniswapRetryCredit.data, zeroPadValue("0x01", 32));
  assert.equal(first.summary.successful.uniswapRetryCredit.data, zeroPadValue("0x02", 32));
  assert.equal(first.summary.successful.uniswapRetryCredit.amountOut, ACTUAL_AMOUNT_OUT.toString());
  assert.equal(first.summary.successful.uniswapRetryCredit.routeSigner, ROUTE_SIGNER);
  assert.equal(first.summary.successful.uniswapRetryCredit.trader, TRADER);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.entries), true);
  assert.equal("signature" in first.summary.successful.uniswapRetryCredit, false);
});

test("derives the exact funded intent instead of trusting caller-provided route labels", () => {
  const rule = uniswapRuleFixture();
  const expected = keccak256(abiCoder.encode(
    ["string", "bytes32", "bytes32", "address", "address", "address", "address", "uint256"],
    [
      "RETRYCREDIT_UNISWAP_V1",
      POLICY_ID,
      ACTION_ID,
      TRADER,
      RETRY_CREDIT_UNISWAP_SEPOLIA.weth,
      RETRY_CREDIT_UNISWAP_SEPOLIA.usdc,
      RETRY_CREDIT_UNISWAP_SEPOLIA.pool,
      AMOUNT_IN,
    ],
  ));
  assert.equal(computeUniswapRetryCreditIntent(rule), expected);
});

test("matches the pinned read-only Sepolia Universal Router signature fixture", () => {
  const caller = "0x813C4BF413BeeA09a7f61450Bd9a9Fa321ED25Db";
  const amountIn = 100_000_000_000_000n;
  const inputs = [
    abiCoder.encode(
      ["address", "uint256"],
      [RETRY_CREDIT_UNISWAP_SEPOLIA.router, amountIn],
    ),
    abiCoder.encode(
      ["address", "uint256", "uint256", "bytes", "bool", "uint256[]"],
      [caller, amountIn, 2_151_595n, EXPECTED_PATH, false, []],
    ),
  ];
  const value = {
    commands: "0x0b00",
    inputs,
    intent: "0x1c25896f1f199c6d02046f6b02813dee2374ae7cbea3c8ea1cfa96121736552d",
    data: "0xa786b0379ab3ad1104054d27f1eb503a78dde3a7b1e5b20d2fba2d9d8c0b58ec",
    sender: caller,
    nonce: "0x22ec8bdc44db8c86ecb72cc508fcbf5e98022ab0b5ab41a43088996f24c0a573",
    deadline: 1_787_299_080n,
  };
  const signature = "0xc63b5894240b2522997a8469b1123a21dafb368e905feedcc20eb83eeb21d0de54731557ff4da564e6eb757b109fbb061adec1085f5a4aa75a8a3368f37423e61b";
  const domain = {
    name: "UniversalRouter",
    version: "2",
    chainId: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId,
    verifyingContract: RETRY_CREDIT_UNISWAP_SEPOLIA.router,
  };

  assert.deepEqual(inputs.map(keccak256), [
    "0x4819026230b4954d09cd3c81b694327fd69bf0d8efdbd58f50d15126b369c97f",
    "0x483b81cecd3e2c2eec39cc4571656ef75b74a8a91e5f8b586ee2678e999974d7",
  ]);
  assert.equal(
    keccak256(concat(inputs.map(keccak256))),
    "0x5e0e5d945c1d713c6df8dc5f083b01c1a0c3367d1b54e47515d18f1794ce0818",
  );
  assert.equal(
    TypedDataEncoder.hash(domain, ROUTE_TYPES, value),
    "0x9c58d1d171740dcdd1e52502677141f42f9f4331bdcc9afe58b718cb182dcda1",
  );
  assert.equal(
    verifyTypedData(domain, ROUTE_TYPES, value, signature),
    "0x5E0Da66Ec2B6e838142284b8dBC49b43D22957F3",
  );
  assert.equal(
    keccak256(ROUTER_INTERFACE.encodeFunctionData("executeSigned", [
      value.commands,
      value.inputs,
      value.intent,
      value.data,
      true,
      value.nonce,
      signature,
      value.deadline,
    ])),
    "0xba2f217313f8cb3d8def149bea6850f5bb8e0185eff351f481dfacd160c720e4",
  );
});

test("accepts the pinned exact-product recipient-flag fixture without a signing secret", () => {
  const routeSigner = "0xF3F8d9388A6bcDae1b8e6f43CA605D20f1EA83c0";
  const trader = "0x813C4BF413BeeA09a7f61450Bd9a9Fa321ED25Db";
  const amountIn = 100_000_000_000_000n;
  const policyId = "0xe914f7308f5a84c5cbce313bf9718ad6c2b88aa738ae9366f37dda3b1d84a579";
  const actionId = "0xf280180cee4154de7ea9a28dcb5e2ef9d69dd05e66863db418273da6c0218ff2";
  const intent = "0xc6af61bd8ae83fe501713ea15554f13bcf0721be55ff526117e43c57e83b9af2";
  const wrapInput = abiCoder.encode(
    ["address", "uint256"],
    ["0x0000000000000000000000000000000000000002", amountIn],
  );
  const routes = [
    {
      minimumOut: 4_529_674n,
      data: zeroPadValue("0x01", 32),
      nonce: "0x5958a93dd3917629cd92c2e62570ea66c31c6387c7944bfe33b7c0fc2a0becb1",
      signature: "0xb036ef1cb3f90abebad74ef7b3a75f6decde546fca6c8fd0f20dfdce6c1342a57940a8cfb1f86e0749a6c9a59b7452e7487453886ff0280f1aaa6e1703c730141c",
      calldataHash: "0x66065fb9687de7f78da5267034d2b11c9367effae6fb069bd145b8802f3ff24c",
    },
    {
      minimumOut: 2_151_595n,
      data: zeroPadValue("0x02", 32),
      nonce: "0xdbd6f07dbb146d56716e2afbf3193c7c305019a5495fbb5a44ee39cd9a950b20",
      signature: "0x359dfc98819350bb82bba09f89c38446498d41acde6bfc91c49d448dc00580a63ee3437ce1899c7fba3f2b5d0ad209d4bf7639dbf3f41389c842215d166fa6dc1b",
      calldataHash: "0x33153471b0d3052802fe9f1c733f66de5228395c8d48a19125de06fbad2f401c",
    },
  ];

  assert.equal(computeUniswapRetryCreditIntent({
    policyId,
    actionId,
    trader,
    amountIn,
  }), intent);

  for (const route of routes) {
    const swapInput = abiCoder.encode(
      ["address", "uint256", "uint256", "bytes", "bool", "uint256[]"],
      ["0x0000000000000000000000000000000000000001", amountIn, route.minimumOut, EXPECTED_PATH, false, []],
    );
    const calldata = ROUTER_INTERFACE.encodeFunctionData("executeSigned", [
      "0x0b00",
      [wrapInput, swapInput],
      intent,
      route.data,
      true,
      route.nonce,
      route.signature,
      1_787_299_080n,
    ]);
    assert.equal(keccak256(calldata), route.calldataHash);
    const decoded = decodeUniswapRetryCreditRoute(encodedTransactionFixture({
      status: route.data === zeroPadValue("0x01", 32) ? 0 : 1,
      nonce: route.data === zeroPadValue("0x01", 32) ? 7n : 8n,
      sender: trader,
      data: calldata,
      value: amountIn,
    }));
    assert.equal(decoded.uniswapRetryCredit.routeSigner, routeSigner);
    assert.equal(decoded.uniswapRetryCredit.trader, trader);
    assert.equal(decoded.uniswapRetryCredit.intent, intent);
    assert.equal(decoded.uniswapRetryCredit.data, route.data);
    assert.equal(decoded.uniswapRetryCredit.amountOutMinimum, route.minimumOut.toString());
  }
});

test("rejects malformed or unauthenticated funded Uniswap rules before proof use", async (context) => {
  const cases = [
    { name: "same route signer and trader", overrides: { routeSigner: TRADER } },
    { name: "wrong official router", overrides: { router: "0x1111111111111111111111111111111111111111" } },
    { name: "wrong official pool", overrides: { pool: "0x1111111111111111111111111111111111111111" } },
    { name: "zero input", overrides: { amountIn: 0n } },
    { name: "zero successful minimum", overrides: { minimumSuccessfulOut: 0n } },
    { name: "empty window", overrides: { endBlock: 10_000_000 } },
    { name: "oversized gap", overrides: { maxBlockGap: 1_001 } },
    {
      name: "failure gas cap permits a minimum-gas out-of-gas attempt",
      overrides: { maxFailureGasUsed: 500_000n },
    },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, () => {
      assert.throws(
        () => normalizeUniswapRetryCreditBatchProof(
          uniswapBatchFixture(),
          [FAILED_HASH, SUCCESS_HASH],
          uniswapRuleFixture(scenario.overrides),
        ),
        (error) => error instanceof WorkerError && error.code === "INVALID_RETRY_CREDIT_RULE",
      );
    });
  }
});

test("rejects signed-route, intent, refresh, ordering, and settlement mutations", async (context) => {
  const cases = [
    { name: "allow-revert command", fixture: { failureRoute: { commands: "0x8b00" } } },
    { name: "sender verification disabled", fixture: { failureRoute: { verifySender: false } } },
    { name: "wrong fee path", fixture: { failureRoute: { fee: 3_000 } } },
    { name: "user-paid swap after wrap", fixture: { failureRoute: { payerIsUser: true } } },
    { name: "wrong swap recipient", fixture: { failureRoute: { recipient: TRADER } } },
    { name: "native value mismatch", fixture: { failureTx: { value: AMOUNT_IN - 1n } } },
    { name: "outer calldata trailing bytes", fixture: { successTx: { appendCalldata: "00" } } },
    { name: "inner WRAP input trailing bytes", fixture: { failureRoute: { appendWrapInput: "00" } } },
    { name: "different recovered signer", fixture: { successRoute: { signerKey: TEST_ONLY_OTHER_SIGNER_KEY } } },
    { name: "nonce replay sentinel", fixture: { failureRoute: { nonce: `0x${"ff".repeat(32)}` } } },
    { name: "same signed nonce", fixture: { successRoute: { nonce: zeroPadValue("0x11", 32) } } },
    { name: "wrong quote progression", fixture: { successRoute: { data: zeroPadValue("0x03", 32) } } },
    { name: "intent not derived from rule", fixture: { successRoute: { intent: `0x${"99".repeat(32)}` } } },
    { name: "deadline regression", fixture: { successRoute: { deadline: 4_102_444_799n } } },
    { name: "retry minimum did not improve", fixture: { successRoute: { amountOutMinimum: FAILED_MINIMUM_OUT } } },
    { name: "stale minimum would also have succeeded", fixture: { failureRoute: { amountOutMinimum: ACTUAL_AMOUNT_OUT } } },
    { name: "successful minimum below funded floor", fixture: { successRoute: { amountOutMinimum: 1_000_000n } } },
    { name: "same source block", fixture: { successBlock: 10_000_000 } },
    { name: "transaction nonce did not increase", fixture: { successTx: { nonce: 7n } } },
    { name: "successful receipt also failed", fixture: { successTx: { status: 0 } } },
    { name: "failed receipt contains logs", fixture: { failureTx: { logs: "valid" } } },
    { name: "missing pool swap", fixture: { successLogs: "missing-swap" } },
    { name: "duplicate pool swap", fixture: { successLogs: "duplicate-swap" } },
    { name: "wrong pool swap recipient", fixture: { successLogs: "wrong-swap-recipient" } },
    { name: "wrong swap input delta", fixture: { successLogs: "wrong-input" } },
    { name: "zero pool state", fixture: { successLogs: "zero-pool-state" } },
    { name: "missing Circle transfer", fixture: { successLogs: "missing-transfer" } },
    { name: "duplicate Circle transfer", fixture: { successLogs: "duplicate-transfer" } },
    { name: "wrong Circle recipient", fixture: { successLogs: "wrong-transfer-recipient" } },
    { name: "mismatched Circle output", fixture: { successLogs: "wrong-transfer-amount" } },
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, () => {
      assert.throws(
        () => normalizeUniswapRetryCreditBatchProof(
          uniswapBatchFixture(scenario.fixture),
          [FAILED_HASH, SUCCESS_HASH],
          uniswapRuleFixture(),
        ),
        (error) => error instanceof WorkerError && error.code === "BATCH_PROOF_INVALID",
      );
    });
  }
});

test("binds the batch builder cache to the full funded rule", async () => {
  let calls = 0;
  const worker = new RuleDropWorker({
    poolAddress: POOL_ADDRESS,
    poolAbi: ["function campaignCount() view returns (uint256)"],
    poolContract: {},
    creditcoinProvider: {},
    sourceChainKey: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainKey,
    sourceChainId: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId,
    proofBuilder: {
      async getBatchProof() {
        calls += 1;
        return { success: true, data: uniswapBatchFixture() };
      },
    },
  });
  await worker.getUniswapRetryCreditBatchProof({
    failedTransactionHash: FAILED_HASH,
    successfulTransactionHash: SUCCESS_HASH,
    rule: uniswapRuleFixture(),
  });
  await assert.rejects(
    worker.getUniswapRetryCreditBatchProof({
      failedTransactionHash: FAILED_HASH,
      successfulTransactionHash: SUCCESS_HASH,
      rule: uniswapRuleFixture({ actionId: `0x${"88".repeat(32)}` }),
    }),
    (error) => error instanceof WorkerError && error.code === "BATCH_PROOF_INVALID",
  );
  assert.equal(calls, 2);
});

function uniswapRuleFixture(overrides = {}) {
  return {
    routeSigner: ROUTE_SIGNER,
    trader: TRADER,
    router: RETRY_CREDIT_UNISWAP_SEPOLIA.router,
    weth: RETRY_CREDIT_UNISWAP_SEPOLIA.weth,
    usdc: RETRY_CREDIT_UNISWAP_SEPOLIA.usdc,
    pool: RETRY_CREDIT_UNISWAP_SEPOLIA.pool,
    policyId: POLICY_ID,
    actionId: ACTION_ID,
    amountIn: AMOUNT_IN,
    minimumSuccessfulOut: 1_500_000n,
    startBlock: 10_000_000,
    endBlock: 10_000_010,
    maxBlockGap: 10,
    minimumAttemptGasLimit: 500_000n,
    maxFailureGasUsed: 300_000n,
    ...overrides,
  };
}

function uniswapBatchFixture({
  failureRoute = {},
  successRoute = {},
  failureTx = {},
  successTx = {},
  successLogs = "valid",
  successBlock = 10_000_001,
} = {}) {
  const rule = uniswapRuleFixture();
  const intent = computeUniswapRetryCreditIntent(rule);
  const failedRoute = signedRouteFixture({
    intent,
    data: zeroPadValue("0x01", 32),
    nonce: zeroPadValue("0x11", 32),
    deadline: 4_102_444_800n,
    amountOutMinimum: FAILED_MINIMUM_OUT,
    ...failureRoute,
  });
  const successfulRoute = signedRouteFixture({
    intent,
    data: zeroPadValue("0x02", 32),
    nonce: zeroPadValue("0x12", 32),
    deadline: 4_102_444_801n,
    amountOutMinimum: SUCCESS_MINIMUM_OUT,
    ...successRoute,
  });
  const logs = settlementLogs(successLogs);
  const failedLogs = failureTx.logs === "valid" ? logs : (failureTx.logs ?? []);
  const failedEntry = {
    txHash: FAILED_HASH,
    txBytes: encodedTransactionFixture({
      status: 0,
      nonce: 7n,
      data: failedRoute,
      ...failureTx,
      logs: failedLogs,
    }),
    merkleProof: { root: `0x${"51".repeat(32)}`, siblings: [] },
  };
  const successfulEntry = {
    txHash: SUCCESS_HASH,
    txBytes: encodedTransactionFixture({
      status: 1,
      nonce: 8n,
      data: successfulRoute,
      ...successTx,
      logs,
    }),
    merkleProof: { root: `0x${"52".repeat(32)}`, siblings: [] },
  };
  const merkleProofs = successBlock === 10_000_000
    ? new Map([[10_000_000, new Map([[3, failedEntry], [4, successfulEntry]])]])
    : new Map([
      [10_000_000, new Map([[3, failedEntry]])],
      [successBlock, new Map([[4, successfulEntry]])],
    ]);
  return {
    chainKey: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainKey,
    fromHeader: Math.min(10_000_000, successBlock),
    toHeader: Math.max(10_000_000, successBlock),
    continuityProof: {
      lowerEndpointDigest: `0x${"61".repeat(32)}`,
      roots: [`0x${"62".repeat(32)}`, `0x${"63".repeat(32)}`],
    },
    merkleProofs,
  };
}

function signedRouteFixture({
  intent,
  data,
  nonce,
  deadline,
  amountOutMinimum,
  commands = "0x0b00",
  verifySender = true,
  fee = RETRY_CREDIT_UNISWAP_SEPOLIA.fee,
  recipient = "0x0000000000000000000000000000000000000001",
  payerIsUser = false,
  appendWrapInput = "",
  signerKey = TEST_ONLY_ROUTE_SIGNER_KEY,
}) {
  const path = `0x${RETRY_CREDIT_UNISWAP_SEPOLIA.weth.slice(2)}${Number(fee).toString(16).padStart(6, "0")}${RETRY_CREDIT_UNISWAP_SEPOLIA.usdc.slice(2)}`.toLowerCase();
  let wrapInput = abiCoder.encode(
    ["address", "uint256"],
    ["0x0000000000000000000000000000000000000002", AMOUNT_IN],
  );
  if (appendWrapInput) wrapInput = `${wrapInput}${appendWrapInput}`;
  const swapInput = abiCoder.encode(
    ["address", "uint256", "uint256", "bytes", "bool", "uint256[]"],
    [recipient, AMOUNT_IN, amountOutMinimum, path, payerIsUser, []],
  );
  const inputs = [wrapInput, swapInput];
  const message = {
    commands,
    inputs,
    intent,
    data,
    sender: verifySender ? TRADER : "0x0000000000000000000000000000000000000000",
    nonce,
    deadline,
  };
  const digest = TypedDataEncoder.hash(
    {
      name: "UniversalRouter",
      version: "2",
      chainId: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId,
      verifyingContract: RETRY_CREDIT_UNISWAP_SEPOLIA.router,
    },
    ROUTE_TYPES,
    message,
  );
  const signature = Signature.from(new SigningKey(signerKey).sign(digest)).serialized;
  return ROUTER_INTERFACE.encodeFunctionData("executeSigned", [
    commands,
    inputs,
    intent,
    data,
    verifySender,
    nonce,
    signature,
    deadline,
  ]);
}

function settlementLogs(mode) {
  const swapAmountIn = mode === "wrong-input" ? AMOUNT_IN - 1n : AMOUNT_IN;
  const swapRecipient = mode === "wrong-swap-recipient"
    ? "0x1111111111111111111111111111111111111111"
    : TRADER;
  const sqrtPrice = mode === "zero-pool-state" ? 0n : 79_228_162_514_264_337_593_543_950_336n;
  const swap = {
    address_: RETRY_CREDIT_UNISWAP_SEPOLIA.pool,
    topics: [
      SWAP_EVENT,
      zeroPadValue(RETRY_CREDIT_UNISWAP_SEPOLIA.router, 32),
      zeroPadValue(swapRecipient, 32),
    ],
    data: abiCoder.encode(
      ["int256", "int256", "uint160", "uint128", "int24"],
      [-ACTUAL_AMOUNT_OUT, swapAmountIn, sqrtPrice, 1_000_000n, 0],
    ),
  };
  const transferAmount = mode === "wrong-transfer-amount" ? ACTUAL_AMOUNT_OUT - 1n : ACTUAL_AMOUNT_OUT;
  const transferRecipient = mode === "wrong-transfer-recipient"
    ? "0x1111111111111111111111111111111111111111"
    : TRADER;
  const transfer = {
    address_: RETRY_CREDIT_UNISWAP_SEPOLIA.usdc,
    topics: [
      TRANSFER_EVENT,
      zeroPadValue(RETRY_CREDIT_UNISWAP_SEPOLIA.pool, 32),
      zeroPadValue(transferRecipient, 32),
    ],
    data: abiCoder.encode(["uint256"], [transferAmount]),
  };
  if (mode === "missing-swap") return [transfer];
  if (mode === "duplicate-swap") return [swap, swap, transfer];
  if (mode === "missing-transfer") return [swap];
  if (mode === "duplicate-transfer") return [swap, transfer, transfer];
  return [swap, transfer];
}

function encodedTransactionFixture({
  status,
  nonce,
  data,
  sender = TRADER,
  value = AMOUNT_IN,
  logs = [],
  appendCalldata = "",
}) {
  const calldata = appendCalldata ? `${data}${appendCalldata}` : data;
  const common = abiCoder.encode(
    ["uint64", "uint64", "address", "bool", "address", "uint256", "bytes"],
    [nonce, 500_000n, sender, false, RETRY_CREDIT_UNISWAP_SEPOLIA.router, value, calldata],
  );
  const typeSpecific = abiCoder.encode(
    ["uint64", "uint128", "uint128", "tuple(address account,bytes32[] storageKeys)[]", "uint8", "bytes32", "bytes32"],
    [1n, 1n, 2n, [], 0, `0x${"71".repeat(32)}`, `0x${"72".repeat(32)}`],
  );
  const receipt = abiCoder.encode(
    ["uint8", "uint64", "tuple(address address_,bytes32[] topics,bytes data)[]", "bytes"],
    [status, 250_000n, logs, "0x"],
  );
  return abiCoder.encode(["uint8", "bytes[]"], [2, [common, typeSpecific, receipt]]);
}
