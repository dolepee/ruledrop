// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Validates one failed and one later successful signed Uniswap Universal Router retry on Sepolia.
/// @dev Inclusion and source-block ordering are verified separately by the Attestcoin batch verifier.
contract RetryCreditUniversalRouterPredicateV1 {
    uint64 public constant SEPOLIA_CHAIN_ID = 11_155_111;
    uint32 public constant MAX_ATTESTCOIN_BATCH_BLOCK_GAP = 1_000;

    address public constant SEPOLIA_UNIVERSAL_ROUTER = 0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468;
    address public constant SEPOLIA_WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address public constant SEPOLIA_CIRCLE_TEST_USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address public constant SEPOLIA_WETH_USDC_500_POOL = 0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1;

    address public constant UNIVERSAL_ROUTER_MSG_SENDER = address(1);
    address public constant UNIVERSAL_ROUTER_ADDRESS_THIS = address(2);
    uint24 public constant V3_FEE = 500;
    bytes2 public constant COMMANDS = hex"0b00"; // WRAP_ETH, V3_SWAP_EXACT_IN
    bytes32 public constant FAILURE_ROUTE_DATA = bytes32(uint256(1));
    bytes32 public constant SUCCESS_ROUTE_DATA = bytes32(uint256(2));
    bytes32 public constant NONCE_REPLAY_BYPASS = bytes32(type(uint256).max);

    bytes4 public constant EXECUTE_SIGNED_SELECTOR =
        bytes4(keccak256("executeSigned(bytes,bytes[],bytes32,bytes32,bool,bytes32,bytes,uint256)"));
    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant EXECUTE_SIGNED_TYPEHASH = keccak256(
        "ExecuteSigned(bytes commands,bytes[] inputs,bytes32 intent,bytes32 data,address sender,bytes32 nonce,uint256 deadline)"
    );
    bytes32 public constant DOMAIN_NAME_HASH = keccak256("UniversalRouter");
    bytes32 public constant DOMAIN_VERSION_HASH = keccak256("2");
    bytes32 public constant SWAP_EVENT = keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)");
    bytes32 public constant ERC20_TRANSFER_EVENT = keccak256("Transfer(address,address,uint256)");

    struct Rule {
        address routeSigner;
        address trader;
        address router;
        address weth;
        address usdc;
        address pool;
        bytes32 policyId;
        bytes32 actionId;
        uint256 amountIn;
        uint256 minimumSuccessfulOut;
        uint64 startBlock;
        uint64 endBlock;
        uint32 maxBlockGap;
        uint64 minimumAttemptGasLimit;
        uint64 maxFailureGasUsed;
    }

    struct ExecuteSignedEnvelope {
        bytes commands;
        bytes[] inputs;
        bytes32 intent;
        bytes32 data;
        bool verifySender;
        bytes32 nonce;
        bytes signature;
        uint256 deadline;
    }

    struct AttemptSummary {
        uint64 transactionNonce;
        bytes32 routeNonce;
        uint256 deadline;
        uint256 amountOutMinimum;
        uint256 settledOut;
        bytes32 digest;
    }

    error AttemptGasLimitTooLow();
    error DuplicatePoolSwap();
    error DuplicateSettlementTransfer();
    error FailureGasExceeded();
    error InvalidBlockGap();
    error InvalidCalldata();
    error InvalidCommands();
    error InvalidDeadlineRefresh();
    error InvalidIntent();
    error InvalidParticipant();
    error InvalidReceiptSequence();
    error InvalidRouteData();
    error InvalidRouteInput();
    error InvalidRouteNonce();
    error InvalidRouteRefresh();
    error InvalidRouteSignature();
    error InvalidRule();
    error InvalidSourceBlock();
    error InvalidSourceChain();
    error InvalidSourceTransaction();
    error InvalidTarget();
    error InvalidTransactionValue();
    error RequiredPoolSwapMissing();
    error RequiredSettlementTransferMissing();
    error SettledValueTooLow();

    function validateTerms(Rule calldata rule) external pure {
        _validateRule(rule, false);
    }

    function validateRule(Rule calldata rule) external pure {
        _validateRule(rule, true);
    }

    function validate(
        bytes calldata failedEncodedTransaction,
        uint64 failureBlock,
        bytes calldata successfulEncodedTransaction,
        uint64 successBlock,
        uint64 expectedSourceChainId,
        Rule calldata rule
    ) external pure returns (address beneficiary) {
        _validateRule(rule, true);
        if (expectedSourceChainId != SEPOLIA_CHAIN_ID) revert InvalidSourceChain();
        if (failureBlock < rule.startBlock || successBlock > rule.endBlock || successBlock <= failureBlock) {
            revert InvalidSourceBlock();
        }
        if (uint256(successBlock) - uint256(failureBlock) > rule.maxBlockGap) revert InvalidBlockGap();

        AttemptSummary memory failed = _validateAttempt(failedEncodedTransaction, rule, false, FAILURE_ROUTE_DATA);
        AttemptSummary memory succeeded = _validateAttempt(successfulEncodedTransaction, rule, true, SUCCESS_ROUTE_DATA);

        if (succeeded.transactionNonce <= failed.transactionNonce) revert InvalidRouteRefresh();
        if (succeeded.routeNonce == failed.routeNonce) revert InvalidRouteNonce();
        if (succeeded.deadline < failed.deadline) revert InvalidDeadlineRefresh();
        if (succeeded.amountOutMinimum >= failed.amountOutMinimum) revert InvalidRouteRefresh();
        if (failed.amountOutMinimum <= succeeded.settledOut) revert InvalidRouteRefresh();
        if (succeeded.digest == failed.digest) revert InvalidRouteRefresh();
        return rule.trader;
    }

    function routeIntent(Rule calldata rule) external pure returns (bytes32) {
        return _routeIntent(rule);
    }

    function routeDigest(
        bytes calldata commands,
        bytes[] calldata inputs,
        bytes32 intent,
        bytes32 data,
        address sender,
        bytes32 nonce,
        uint256 deadline,
        uint256 sourceChainId,
        address router
    ) external pure returns (bytes32) {
        bytes[] memory copiedInputs = inputs;
        return _routeDigest(commands, copiedInputs, intent, data, sender, nonce, deadline, sourceChainId, router);
    }

    function domainSeparator(uint256 sourceChainId, address router) external pure returns (bytes32) {
        return _domainSeparator(sourceChainId, router);
    }

    function _validateRule(Rule calldata rule, bool requirePolicyId) private pure {
        if (
            rule.routeSigner == address(0) || rule.trader == address(0) || rule.routeSigner == rule.trader
                || rule.router != SEPOLIA_UNIVERSAL_ROUTER || rule.weth != SEPOLIA_WETH
                || rule.usdc != SEPOLIA_CIRCLE_TEST_USDC || rule.pool != SEPOLIA_WETH_USDC_500_POOL
                || (requirePolicyId && rule.policyId == bytes32(0)) || (!requirePolicyId && rule.policyId != bytes32(0))
                || rule.actionId == bytes32(0) || rule.amountIn == 0 || rule.minimumSuccessfulOut == 0
                || rule.startBlock >= rule.endBlock || rule.maxBlockGap == 0
                || rule.maxBlockGap > MAX_ATTESTCOIN_BATCH_BLOCK_GAP || rule.minimumAttemptGasLimit == 0
                || rule.maxFailureGasUsed == 0 || rule.maxFailureGasUsed >= rule.minimumAttemptGasLimit
        ) revert InvalidRule();
    }

    function _validateAttempt(
        bytes calldata encodedTransaction,
        Rule calldata rule,
        bool successful,
        bytes32 expectedRouteData
    ) private pure returns (AttemptSummary memory summary) {
        if (!EvmV1Decoder.isValidTransactionType(EvmV1Decoder.getTransactionType(encodedTransaction))) {
            revert InvalidSourceTransaction();
        }

        EvmV1Decoder.CommonTxFields memory transaction = EvmV1Decoder.decodeCommonTxFields(encodedTransaction);
        if (transaction.from != rule.trader) revert InvalidParticipant();
        if (transaction.toIsNull || transaction.to != rule.router) revert InvalidTarget();
        if (transaction.value != rule.amountIn) revert InvalidTransactionValue();
        if (transaction.gasLimit < rule.minimumAttemptGasLimit) revert AttemptGasLimitTooLow();

        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != (successful ? 1 : 0)) revert InvalidReceiptSequence();
        if (!successful) {
            if (receipt.receiptLogs.length != 0) revert InvalidReceiptSequence();
            if (receipt.receiptGasUsed > rule.maxFailureGasUsed) revert FailureGasExceeded();
        }

        ExecuteSignedEnvelope memory route = _decodeExecuteSigned(transaction.data);
        _validateSignedRoute(route, rule, expectedRouteData);
        uint256 amountOutMinimum = _validateRouteInputs(route.inputs, rule);
        bytes32 digest = _routeDigestForRule(route, rule);
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, route.signature);
        if (error != ECDSA.RecoverError.NoError || recovered != rule.routeSigner) revert InvalidRouteSignature();

        uint256 settledOut;
        if (successful) {
            if (amountOutMinimum < rule.minimumSuccessfulOut) revert SettledValueTooLow();
            settledOut = _requirePoolSwap(receipt, rule);
            if (settledOut < amountOutMinimum || settledOut < rule.minimumSuccessfulOut) revert SettledValueTooLow();
            _requireSettlementTransfer(receipt, rule, settledOut);
        }

        summary = AttemptSummary({
            transactionNonce: transaction.nonce,
            routeNonce: route.nonce,
            deadline: route.deadline,
            amountOutMinimum: amountOutMinimum,
            settledOut: settledOut,
            digest: digest
        });
    }

    function _decodeExecuteSigned(bytes memory data) private pure returns (ExecuteSignedEnvelope memory route) {
        if (data.length < 4) revert InvalidCalldata();
        bytes4 selector;
        assembly ("memory-safe") {
            selector := mload(add(data, 0x20))
        }
        if (selector != EXECUTE_SIGNED_SELECTOR) revert InvalidCalldata();

        bytes memory arguments = new bytes(data.length - 4);
        for (uint256 i; i < arguments.length; ++i) {
            arguments[i] = data[i + 4];
        }
        if (arguments.length < 256) revert InvalidCalldata();

        uint256 commandsOffset = _word(arguments, 0);
        uint256 inputsOffset = _word(arguments, 32);
        uint256 signatureOffset = _word(arguments, 192);
        if (commandsOffset != 256) revert InvalidCalldata();

        uint256 commandsEnd;
        (route.commands, commandsEnd) = _readCanonicalBytes(arguments, commandsOffset);
        if (inputsOffset != commandsEnd) revert InvalidCalldata();
        uint256 inputsEnd;
        (route.inputs, inputsEnd) = _readCanonicalTwoBytes(arguments, inputsOffset);
        if (signatureOffset != inputsEnd) revert InvalidCalldata();
        route.intent = bytes32(_word(arguments, 64));
        route.data = bytes32(_word(arguments, 96));
        uint256 verifySender = _word(arguments, 128);
        if (verifySender > 1) revert InvalidCalldata();
        route.verifySender = verifySender == 1;
        route.nonce = bytes32(_word(arguments, 160));
        uint256 signatureEnd;
        (route.signature, signatureEnd) = _readCanonicalBytes(arguments, signatureOffset);
        if (signatureEnd != arguments.length) revert InvalidCalldata();
        route.deadline = _word(arguments, 224);
    }

    function _word(bytes memory data, uint256 offset) private pure returns (uint256 value) {
        if (offset > data.length || data.length - offset < 32) revert InvalidCalldata();
        assembly ("memory-safe") {
            value := mload(add(add(data, 0x20), offset))
        }
    }

    function _readCanonicalBytes(bytes memory data, uint256 offset)
        private
        pure
        returns (bytes memory value, uint256 paddedEnd)
    {
        if (offset % 32 != 0) revert InvalidCalldata();
        uint256 length = _word(data, offset);
        uint256 contentOffset = offset + 32;
        if (contentOffset > data.length || length > data.length - contentOffset) revert InvalidCalldata();
        value = new bytes(length);
        for (uint256 i; i < length; ++i) {
            value[i] = data[contentOffset + i];
        }
        uint256 paddedLength = (length + 31) / 32 * 32;
        paddedEnd = contentOffset + paddedLength;
        if (paddedEnd > data.length) revert InvalidCalldata();
        for (uint256 i = contentOffset + length; i < paddedEnd; ++i) {
            if (data[i] != 0) revert InvalidCalldata();
        }
    }

    function _readCanonicalTwoBytes(bytes memory data, uint256 offset)
        private
        pure
        returns (bytes[] memory values, uint256 arrayEnd)
    {
        if (_word(data, offset) != 2) revert InvalidRouteInput();
        uint256 elementsBase = offset + 32;
        uint256 firstOffset = _word(data, elementsBase);
        uint256 secondOffset = _word(data, elementsBase + 32);
        if (firstOffset != 64) revert InvalidCalldata();
        values = new bytes[](2);
        uint256 firstEnd;
        (values[0], firstEnd) = _readCanonicalBytes(data, elementsBase + firstOffset);
        if (secondOffset != firstEnd - elementsBase) revert InvalidCalldata();
        (values[1], arrayEnd) = _readCanonicalBytes(data, elementsBase + secondOffset);
    }

    function _validateSignedRoute(ExecuteSignedEnvelope memory route, Rule calldata rule, bytes32 expectedRouteData)
        private
        pure
    {
        if (keccak256(route.commands) != keccak256(abi.encodePacked(COMMANDS))) revert InvalidCommands();
        if (route.inputs.length != 2) revert InvalidRouteInput();
        if (route.intent != _routeIntent(rule)) revert InvalidIntent();
        if (route.data != expectedRouteData) revert InvalidRouteData();
        if (!route.verifySender) revert InvalidParticipant();
        if (route.nonce == NONCE_REPLAY_BYPASS) revert InvalidRouteNonce();
        if (route.signature.length != 65 || route.deadline == 0) revert InvalidRouteSignature();
    }

    function _validateRouteInputs(bytes[] memory inputs, Rule calldata rule)
        private
        pure
        returns (uint256 amountOutMinimum)
    {
        (address wrapRecipient, uint256 wrapAmount) = abi.decode(inputs[0], (address, uint256));
        if (
            keccak256(inputs[0]) != keccak256(abi.encode(wrapRecipient, wrapAmount))
                || wrapRecipient != UNIVERSAL_ROUTER_ADDRESS_THIS || wrapAmount != rule.amountIn
        ) revert InvalidRouteInput();

        address recipient;
        uint256 amountIn;
        bytes memory path;
        bool payerIsUser;
        uint256[] memory minHopPriceX36;
        (recipient, amountIn, amountOutMinimum, path, payerIsUser, minHopPriceX36) =
            abi.decode(inputs[1], (address, uint256, uint256, bytes, bool, uint256[]));

        if (
            keccak256(inputs[1])
                    != keccak256(abi.encode(recipient, amountIn, amountOutMinimum, path, payerIsUser, minHopPriceX36))
                || recipient != UNIVERSAL_ROUTER_MSG_SENDER || amountIn != rule.amountIn || amountOutMinimum == 0
                || payerIsUser || minHopPriceX36.length != 0
                || keccak256(path) != keccak256(abi.encodePacked(rule.weth, bytes3(V3_FEE), rule.usdc))
        ) revert InvalidRouteInput();
    }

    function _routeIntent(Rule calldata rule) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                "RETRYCREDIT_UNISWAP_V1",
                rule.policyId,
                rule.actionId,
                rule.trader,
                rule.weth,
                rule.usdc,
                rule.pool,
                rule.amountIn
            )
        );
    }

    function _routeDigest(
        bytes memory commands,
        bytes[] memory inputs,
        bytes32 intent,
        bytes32 data,
        address sender,
        bytes32 nonce,
        uint256 deadline,
        uint256 sourceChainId,
        address router
    ) private pure returns (bytes32) {
        bytes32[] memory inputHashes = new bytes32[](inputs.length);
        for (uint256 i; i < inputs.length; ++i) {
            inputHashes[i] = keccak256(inputs[i]);
        }
        bytes32 structHash = keccak256(
            abi.encode(
                EXECUTE_SIGNED_TYPEHASH,
                keccak256(commands),
                keccak256(abi.encodePacked(inputHashes)),
                intent,
                data,
                sender,
                nonce,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(sourceChainId, router), structHash));
    }

    function _routeDigestForRule(ExecuteSignedEnvelope memory route, Rule calldata rule)
        private
        pure
        returns (bytes32)
    {
        return _routeDigest(
            route.commands,
            route.inputs,
            route.intent,
            route.data,
            rule.trader,
            route.nonce,
            route.deadline,
            SEPOLIA_CHAIN_ID,
            rule.router
        );
    }

    function _domainSeparator(uint256 sourceChainId, address router) private pure returns (bytes32) {
        return
            keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, sourceChainId, router));
    }

    function _requirePoolSwap(EvmV1Decoder.ReceiptFields memory receipt, Rule calldata rule)
        private
        pure
        returns (uint256 settledOut)
    {
        EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, SWAP_EVENT);
        uint256 poolSwapCount;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].address_ != rule.pool) continue;
            ++poolSwapCount;
            if (
                logs[i].topics.length != 3 || logs[i].data.length != 160
                    || logs[i].topics[1] != bytes32(uint256(uint160(rule.router)))
                    || logs[i].topics[2] != bytes32(uint256(uint160(rule.trader)))
            ) revert RequiredPoolSwapMissing();

            (int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity,) =
                abi.decode(logs[i].data, (int256, int256, uint160, uint128, int24));
            if (amount0 >= 0 || amount1 <= 0 || sqrtPriceX96 == 0 || liquidity == 0) {
                revert RequiredPoolSwapMissing();
            }
            // The positive-sign guard above makes this conversion lossless.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 actualAmountIn = uint256(amount1);
            if (actualAmountIn != rule.amountIn) revert RequiredPoolSwapMissing();
            settledOut = uint256(-(amount0 + 1)) + 1;
        }
        if (poolSwapCount == 0) revert RequiredPoolSwapMissing();
        if (poolSwapCount != 1) revert DuplicatePoolSwap();
    }

    function _requireSettlementTransfer(
        EvmV1Decoder.ReceiptFields memory receipt,
        Rule calldata rule,
        uint256 settledOut
    ) private pure {
        EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, ERC20_TRANSFER_EVENT);
        uint256 poolTransfers;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].address_ != rule.usdc || logs[i].topics.length != 3 || logs[i].data.length != 32
                    || logs[i].topics[1] != bytes32(uint256(uint160(rule.pool)))
            ) continue;
            ++poolTransfers;
            if (
                logs[i].topics[2] != bytes32(uint256(uint160(rule.trader)))
                    || abi.decode(logs[i].data, (uint256)) != settledOut
            ) revert RequiredSettlementTransferMissing();
        }
        if (poolTransfers == 0) revert RequiredSettlementTransferMissing();
        if (poolTransfers != 1) revert DuplicateSettlementTransfer();
    }
}
