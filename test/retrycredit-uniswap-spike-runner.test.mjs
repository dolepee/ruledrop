import assert from "node:assert/strict";
import test from "node:test";
import {
  AbiCoder,
  Interface,
  Wallet,
  getAddress,
  keccak256,
  verifyTypedData,
  zeroPadValue,
} from "ethers";
import { RETRY_CREDIT_UNISWAP_SEPOLIA } from "../src/proof-worker.mjs";
import {
  deriveKey,
  linkBytecode,
  requireEvent,
  serializeRule,
  signedRoute,
} from "../scripts/retrycredit-uniswap-spike-runner.mjs";

const abiCoder = AbiCoder.defaultAbiCoder();
const poolAddress = "0x1111111111111111111111111111111111111111";
const eventInterface = new Interface([
  "event CreditReleased(uint256 indexed serviceCreditNumber,bytes32 indexed policyId,address indexed trader,uint256 creditAmount,bytes32 failureQueryId,bytes32 successQueryId,bytes32 pairId,address prover)",
]);
const routerInterface = new Interface([
  "function executeSigned(bytes commands,bytes[] inputs,bytes32 intent,bytes32 data,bool verifySender,bytes32 nonce,bytes signature,uint256 deadline)",
]);
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

test("derives separate deterministic role keys without exposing the operator key", () => {
  const privateKey = `0x${"11".repeat(32)}`;
  const routeKey = deriveKey(privateKey, "RETRYCREDIT_UNISWAP_ROUTE_SIGNER_V1");
  const relayerKey = deriveKey(privateKey, "RETRYCREDIT_UNISWAP_CC3_RELAYER_V1");
  assert.match(routeKey, /^0x[0-9a-f]{64}$/);
  assert.notEqual(routeKey, privateKey);
  assert.notEqual(routeKey, relayerKey);
});

test("links every declared Solidity library slot and rejects missing libraries", () => {
  const placeholder = `0x${"00".repeat(40)}`;
  const references = { "contracts/Decoder.sol": { EvmV1Decoder: [{ start: 3, length: 20 }] } };
  const address = "0x2222222222222222222222222222222222222222";
  const linked = linkBytecode(placeholder, references, { EvmV1Decoder: address });
  assert.equal(linked.slice(2 + 3 * 2, 2 + 3 * 2 + 40), address.slice(2));
  assert.throws(() => linkBytecode(placeholder, references, {}), /missing deployed library/);
});

test("accepts exactly one release event from the configured pool emitter", () => {
  const values = [
    1n,
    `0x${"22".repeat(32)}`,
    "0x3333333333333333333333333333333333333333",
    100n,
    `0x${"44".repeat(32)}`,
    `0x${"55".repeat(32)}`,
    `0x${"66".repeat(32)}`,
    "0x7777777777777777777777777777777777777777",
  ];
  const encoded = eventInterface.encodeEventLog(eventInterface.getEvent("CreditReleased"), values);
  const realLog = { address: poolAddress, topics: encoded.topics, data: encoded.data };
  const spoof = { ...realLog, address: "0x8888888888888888888888888888888888888888" };
  const parsed = requireEvent(eventInterface, { logs: [spoof, realLog] }, "CreditReleased", poolAddress);
  assert.equal(parsed.serviceCreditNumber, 1n);
  assert.throws(
    () => requireEvent(eventInterface, { logs: [spoof] }, "CreditReleased", poolAddress),
    /exactly one CreditReleased/,
  );
});

test("serializes the funded direct-Uniswap rule without losing integer precision", () => {
  const serialized = serializeRule({
    routeSigner: "0x2222222222222222222222222222222222222222",
    trader: "0x3333333333333333333333333333333333333333",
    router: RETRY_CREDIT_UNISWAP_SEPOLIA.router,
    weth: RETRY_CREDIT_UNISWAP_SEPOLIA.weth,
    usdc: RETRY_CREDIT_UNISWAP_SEPOLIA.usdc,
    pool: RETRY_CREDIT_UNISWAP_SEPOLIA.pool,
    policyId: `0x${"44".repeat(32)}`,
    actionId: `0x${"55".repeat(32)}`,
    amountIn: 100_000_000_000_000n,
    minimumSuccessfulOut: 1_000_000n,
    startBlock: 11_000_000n,
    endBlock: 11_000_080n,
    maxBlockGap: 10n,
    minimumAttemptGasLimit: 450_000n,
    maxFailureGasUsed: 300_000n,
  });
  assert.equal(serialized.amountIn, "100000000000000");
  assert.equal(serialized.minimumAttemptGasLimit, "450000");
  assert.equal(serialized.startBlock, 11_000_000);
});

test("builds an exact signed official Universal Router route", async () => {
  const routeSigner = new Wallet(`0x${"21".repeat(32)}`);
  const trader = getAddress("0x3333333333333333333333333333333333333333");
  const intent = `0x${"44".repeat(32)}`;
  const data = zeroPadValue("0x01", 32);
  const nonce = `0x${"55".repeat(32)}`;
  const deadline = 4_102_444_800;
  const result = await signedRoute({
    state: { operator: trader, credit: { actionId: `0x${"66".repeat(32)}` } },
    routeSigner,
    intent,
    data,
    nonce,
    deadline,
    amountOutMinimum: 2_000_000n,
  });
  const decoded = routerInterface.decodeFunctionData("executeSigned", result.calldata);
  assert.equal(decoded.commands, "0x0b00");
  assert.equal(decoded.verifySender, true);
  assert.equal(decoded.inputs.length, 2);
  const [wrapRecipient, amountIn] = abiCoder.decode(["address", "uint256"], decoded.inputs[0]);
  assert.equal(wrapRecipient, "0x0000000000000000000000000000000000000002");
  assert.equal(amountIn, 100_000_000_000_000n);
  const recovered = verifyTypedData({
    name: "UniversalRouter",
    version: "2",
    chainId: RETRY_CREDIT_UNISWAP_SEPOLIA.sourceChainId,
    verifyingContract: RETRY_CREDIT_UNISWAP_SEPOLIA.router,
  }, routeTypes, {
    commands: decoded.commands,
    inputs: Array.from(decoded.inputs),
    intent: decoded.intent,
    data: decoded.data,
    sender: trader,
    nonce: decoded.nonce,
    deadline: decoded.deadline,
  }, decoded.signature);
  assert.equal(recovered, routeSigner.address);
  assert.equal(keccak256(result.calldata).length, 66);
});
