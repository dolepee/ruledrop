// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Validates signed checkout attempts and their included failed-to-settled receipt sequence.
/// @dev Inclusion and strict source-block ordering are verified separately by AttestcoinRetryCreditVerifier.
contract RetryCreditPredicateV2 {
    uint32 public constant MAX_ATTESTCOIN_BATCH_BLOCK_GAP = 1_000;

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant ATTEMPT_TYPEHASH = keccak256(
        "Attempt(uint256 sourceChainId,address target,address beneficiary,address settlementAsset,address settlementRecipient,bytes32 policyId,bytes32 actionId,uint64 quoteVersion,uint256 settledValue,bytes32 payloadHash,uint64 validUntil)"
    );
    bytes32 public constant DOMAIN_NAME_HASH = keccak256("RetryCredit Checkout");
    bytes32 public constant DOMAIN_VERSION_HASH = keccak256("1");

    bytes4 public constant CHECKOUT_SELECTOR = bytes4(
        keccak256(
            "checkout((uint256,address,address,address,address,bytes32,bytes32,uint64,uint256,bytes32,uint64),bytes,bytes)"
        )
    );
    bytes32 public constant CHECKOUT_SETTLED_EVENT =
        keccak256("CheckoutSettled(bytes32,bytes32,address,address,address,uint256,bytes32,uint64)");
    bytes32 public constant ERC20_TRANSFER_EVENT = keccak256("Transfer(address,address,uint256)");

    struct Attempt {
        uint256 sourceChainId;
        address target;
        address beneficiary;
        address settlementAsset;
        address settlementRecipient;
        bytes32 policyId;
        bytes32 actionId;
        uint64 quoteVersion;
        uint256 settledValue;
        bytes32 payloadHash;
        uint64 validUntil;
    }

    struct Rule {
        address attemptSigner;
        address beneficiary;
        address target;
        address settlementAsset;
        address settlementRecipient;
        bytes32 policyId;
        bytes32 actionId;
        uint256 minimumSettledValue;
        uint64 startBlock;
        uint64 endBlock;
        uint32 maxBlockGap;
        uint64 minimumAttemptGasLimit;
        uint64 maxFailureGasUsed;
    }

    struct CheckoutEnvelope {
        Attempt attempt;
        bytes payload;
        bytes attemptSignature;
    }

    struct AttemptSummary {
        uint64 nonce;
        uint64 quoteVersion;
        bytes32 sku;
    }

    error AttemptExpired();
    error AttemptGasLimitTooLow();
    error CheckoutActionMismatch();
    error DuplicateSettlementTransfer();
    error FailureGasExceeded();
    error InvalidAction();
    error InvalidAttempt();
    error InvalidAttemptSignature();
    error InvalidBlockGap();
    error InvalidCalldata();
    error InvalidCheckoutPayload();
    error InvalidNonceOrder();
    error InvalidParticipant();
    error InvalidQuoteVersion();
    error InvalidReceiptSequence();
    error InvalidRule();
    error InvalidSettlementAsset();
    error InvalidSettledValue();
    error InvalidSourceBlock();
    error InvalidSourceChain();
    error InvalidSourceTransaction();
    error InvalidTarget();
    error InvalidTransactionValue();
    error RequiredSettlementEventMissing();
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
        if (failureBlock < rule.startBlock || successBlock > rule.endBlock || successBlock <= failureBlock) {
            revert InvalidSourceBlock();
        }
        if (uint256(successBlock) - uint256(failureBlock) > rule.maxBlockGap) revert InvalidBlockGap();

        AttemptSummary memory failed =
            _validateFailedAttempt(failedEncodedTransaction, failureBlock, expectedSourceChainId, rule);
        AttemptSummary memory succeeded =
            _validateSuccessfulAttempt(successfulEncodedTransaction, successBlock, expectedSourceChainId, rule);

        if (succeeded.nonce <= failed.nonce) revert InvalidNonceOrder();
        if (succeeded.quoteVersion <= failed.quoteVersion) revert InvalidQuoteVersion();
        if (succeeded.sku != failed.sku) revert CheckoutActionMismatch();
        return rule.beneficiary;
    }

    function attemptDigest(Attempt calldata attempt) external pure returns (bytes32) {
        return _attemptDigest(attempt);
    }

    function domainSeparator(uint256 sourceChainId, address target) external pure returns (bytes32) {
        return _domainSeparator(sourceChainId, target);
    }

    function _validateRule(Rule calldata rule, bool requirePolicyId) private pure {
        if (
            rule.attemptSigner == address(0) || rule.beneficiary == address(0) || rule.target == address(0)
                || rule.settlementAsset == address(0) || rule.settlementRecipient == address(0)
                || rule.settlementRecipient == rule.beneficiary || (requirePolicyId && rule.policyId == bytes32(0))
                || (!requirePolicyId && rule.policyId != bytes32(0)) || rule.actionId == bytes32(0)
                || rule.minimumSettledValue == 0 || rule.startBlock >= rule.endBlock || rule.maxBlockGap == 0
                || rule.maxBlockGap > MAX_ATTESTCOIN_BATCH_BLOCK_GAP || rule.minimumAttemptGasLimit == 0
                || rule.maxFailureGasUsed == 0
        ) revert InvalidRule();
    }

    function _validateAttempt(
        CheckoutEnvelope memory checkout,
        uint64 sourceBlock,
        uint64 expectedSourceChainId,
        Rule calldata rule
    ) private pure {
        Attempt memory attempt = checkout.attempt;
        if (attempt.sourceChainId != expectedSourceChainId) revert InvalidSourceChain();
        if (attempt.target != rule.target) revert InvalidTarget();
        if (attempt.beneficiary != rule.beneficiary) revert InvalidParticipant();
        if (attempt.settlementAsset != rule.settlementAsset) revert InvalidSettlementAsset();
        if (attempt.settlementRecipient != rule.settlementRecipient) revert InvalidParticipant();
        if (attempt.policyId != rule.policyId || attempt.actionId != rule.actionId) revert InvalidAction();
        if (attempt.quoteVersion == 0 || attempt.payloadHash != keccak256(checkout.payload)) revert InvalidAttempt();
        if (attempt.settledValue == 0) revert InvalidSettledValue();
        if (sourceBlock > attempt.validUntil) revert AttemptExpired();

        (address recovered, ECDSA.RecoverError error,) =
            ECDSA.tryRecover(_attemptDigest(attempt), checkout.attemptSignature);
        if (error != ECDSA.RecoverError.NoError || recovered != rule.attemptSigner) {
            revert InvalidAttemptSignature();
        }
    }

    function _validateFailedAttempt(
        bytes calldata encodedTransaction,
        uint64 sourceBlock,
        uint64 expectedSourceChainId,
        Rule calldata rule
    ) private pure returns (AttemptSummary memory summary) {
        _requireValidTransactionType(encodedTransaction);
        EvmV1Decoder.CommonTxFields memory transaction = EvmV1Decoder.decodeCommonTxFields(encodedTransaction);
        _validateTransactionEnvelope(transaction, rule);

        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 0) revert InvalidReceiptSequence();
        if (receipt.receiptGasUsed > rule.maxFailureGasUsed) revert FailureGasExceeded();

        CheckoutEnvelope memory checkout = _decodeCheckout(transaction.data);
        _validateAttempt(checkout, sourceBlock, expectedSourceChainId, rule);
        summary = AttemptSummary({
            nonce: transaction.nonce,
            quoteVersion: checkout.attempt.quoteVersion,
            sku: _validateCheckoutPayload(checkout)
        });
    }

    function _validateSuccessfulAttempt(
        bytes calldata encodedTransaction,
        uint64 sourceBlock,
        uint64 expectedSourceChainId,
        Rule calldata rule
    ) private pure returns (AttemptSummary memory summary) {
        _requireValidTransactionType(encodedTransaction);
        EvmV1Decoder.CommonTxFields memory transaction = EvmV1Decoder.decodeCommonTxFields(encodedTransaction);
        _validateTransactionEnvelope(transaction, rule);

        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert InvalidReceiptSequence();

        CheckoutEnvelope memory checkout = _decodeCheckout(transaction.data);
        _validateAttempt(checkout, sourceBlock, expectedSourceChainId, rule);
        bytes32 sku = _validateCheckoutPayload(checkout);
        if (checkout.attempt.settledValue < rule.minimumSettledValue) revert SettledValueTooLow();
        _requireSettlementEvent(receipt, checkout.attempt, rule.target);
        _requireSettlementTransfer(receipt, checkout.attempt);
        summary = AttemptSummary({nonce: transaction.nonce, quoteVersion: checkout.attempt.quoteVersion, sku: sku});
    }

    function _requireValidTransactionType(bytes calldata encodedTransaction) private pure {
        if (!EvmV1Decoder.isValidTransactionType(EvmV1Decoder.getTransactionType(encodedTransaction))) {
            revert InvalidSourceTransaction();
        }
    }

    function _validateTransactionEnvelope(EvmV1Decoder.CommonTxFields memory transaction, Rule calldata rule)
        private
        pure
    {
        if (transaction.from != rule.beneficiary) revert InvalidParticipant();
        if (transaction.toIsNull || transaction.to != rule.target) revert InvalidTarget();
        if (transaction.value != 0) revert InvalidTransactionValue();
        if (transaction.gasLimit < rule.minimumAttemptGasLimit) revert AttemptGasLimitTooLow();
    }

    function _decodeCheckout(bytes memory data) private pure returns (CheckoutEnvelope memory checkout) {
        if (data.length < 4) revert InvalidCalldata();
        bytes4 selector;
        assembly ("memory-safe") {
            selector := mload(add(data, 0x20))
        }
        if (selector != CHECKOUT_SELECTOR) revert InvalidCalldata();

        bytes memory arguments = new bytes(data.length - 4);
        for (uint256 i; i < arguments.length; ++i) {
            arguments[i] = data[i + 4];
        }
        (checkout.attempt, checkout.payload, checkout.attemptSignature) = abi.decode(arguments, (Attempt, bytes, bytes));
    }

    function _validateCheckoutPayload(CheckoutEnvelope memory checkout) private pure returns (bytes32 sku) {
        if (checkout.payload.length != 96) revert InvalidCheckoutPayload();
        (address merchant, bytes32 decodedSku, uint64 inventoryVersion) =
            abi.decode(checkout.payload, (address, bytes32, uint64));
        if (
            merchant != checkout.attempt.settlementRecipient || decodedSku == bytes32(0)
                || inventoryVersion != checkout.attempt.quoteVersion
        ) revert InvalidCheckoutPayload();
        return decodedSku;
    }

    function _attemptDigest(Attempt memory attempt) private pure returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTEMPT_TYPEHASH,
                attempt.sourceChainId,
                attempt.target,
                attempt.beneficiary,
                attempt.settlementAsset,
                attempt.settlementRecipient,
                attempt.policyId,
                attempt.actionId,
                attempt.quoteVersion,
                attempt.settledValue,
                attempt.payloadHash,
                attempt.validUntil
            )
        );
        return
            keccak256(abi.encodePacked("\x19\x01", _domainSeparator(attempt.sourceChainId, attempt.target), structHash));
    }

    function _domainSeparator(uint256 sourceChainId, address target) private pure returns (bytes32) {
        return
            keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, sourceChainId, target));
    }

    function _requireSettlementEvent(
        EvmV1Decoder.ReceiptFields memory receipt,
        Attempt memory successfulAttempt,
        address expectedEmitter
    ) private pure {
        EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, CHECKOUT_SETTLED_EVENT);
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].address_ != expectedEmitter || logs[i].topics.length != 4 || logs[i].data.length != 160
                    || logs[i].topics[1] != successfulAttempt.policyId
                    || logs[i].topics[2] != successfulAttempt.actionId
                    || logs[i].topics[3] != bytes32(uint256(uint160(successfulAttempt.beneficiary)))
            ) continue;

            (
                address settlementAsset,
                address settlementRecipient,
                uint256 settledValue,
                bytes32 payloadHash,
                uint64 quoteVersion
            ) = abi.decode(logs[i].data, (address, address, uint256, bytes32, uint64));
            if (
                settlementAsset == successfulAttempt.settlementAsset
                    && settlementRecipient == successfulAttempt.settlementRecipient
                    && settledValue == successfulAttempt.settledValue && payloadHash == successfulAttempt.payloadHash
                    && quoteVersion == successfulAttempt.quoteVersion
            ) return;
        }
        revert RequiredSettlementEventMissing();
    }

    function _requireSettlementTransfer(EvmV1Decoder.ReceiptFields memory receipt, Attempt memory successfulAttempt)
        private
        pure
    {
        EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, ERC20_TRANSFER_EVENT);
        uint256 matchingTransfers;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].address_ != successfulAttempt.settlementAsset || logs[i].topics.length != 3
                    || logs[i].data.length != 32
                    || logs[i].topics[1] != bytes32(uint256(uint160(successfulAttempt.beneficiary)))
                    || logs[i].topics[2] != bytes32(uint256(uint160(successfulAttempt.settlementRecipient)))
                    || abi.decode(logs[i].data, (uint256)) != successfulAttempt.settledValue
            ) continue;
            ++matchingTransfers;
        }
        if (matchingTransfers == 0) revert RequiredSettlementTransferMissing();
        if (matchingTransfers != 1) revert DuplicateSettlementTransfer();
    }
}
