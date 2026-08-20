// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

/// @notice Validates a failed Ethereum call followed by an exact successful retry.
/// @dev Inclusion and ordering are verified separately by AttestcoinRetryVerifier.
contract RetryCoverPredicateV1 {
    uint32 public constant MAX_ATTESTCOIN_BATCH_BLOCK_GAP = 1_000;

    struct Rule {
        address beneficiary;
        address target;
        bytes4 selector;
        bytes32 policyId;
        uint256 callValue;
        uint64 failureNonce;
        uint64 startBlock;
        uint64 endBlock;
        uint32 maxBlockGap;
        uint64 maxFailureGasUsed;
        address successEventEmitter;
        bytes32 successEventSignature;
        uint8 policyIdTopicIndex;
        uint8 beneficiaryTopicIndex;
    }

    error FailureGasExceeded();
    error InvalidBlockGap();
    error InvalidCalldata();
    error InvalidNonce();
    error InvalidParticipant();
    error InvalidReceiptSequence();
    error InvalidRule();
    error InvalidSourceBlock();
    error InvalidSourceTransaction();
    error InvalidTarget();
    error RequiredSuccessEventMissing();

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
        Rule calldata rule
    ) external pure returns (address beneficiary) {
        _validateRule(rule, true);

        if (failureBlock < rule.startBlock || successBlock > rule.endBlock || successBlock <= failureBlock) {
            revert InvalidSourceBlock();
        }
        if (uint256(successBlock) - uint256(failureBlock) > rule.maxBlockGap) revert InvalidBlockGap();

        uint8 failureType = EvmV1Decoder.getTransactionType(failedEncodedTransaction);
        uint8 successType = EvmV1Decoder.getTransactionType(successfulEncodedTransaction);
        if (!EvmV1Decoder.isValidTransactionType(failureType) || !EvmV1Decoder.isValidTransactionType(successType)) {
            revert InvalidSourceTransaction();
        }

        EvmV1Decoder.CommonTxFields memory failed = EvmV1Decoder.decodeCommonTxFields(failedEncodedTransaction);
        EvmV1Decoder.CommonTxFields memory succeeded = EvmV1Decoder.decodeCommonTxFields(successfulEncodedTransaction);
        EvmV1Decoder.ReceiptFields memory failedReceipt = EvmV1Decoder.decodeReceiptFields(failedEncodedTransaction);
        EvmV1Decoder.ReceiptFields memory successReceipt =
            EvmV1Decoder.decodeReceiptFields(successfulEncodedTransaction);

        if (failed.from != rule.beneficiary || succeeded.from != rule.beneficiary) revert InvalidParticipant();
        if (failed.toIsNull || succeeded.toIsNull || failed.to != rule.target || succeeded.to != rule.target) {
            revert InvalidTarget();
        }
        if (failed.value != rule.callValue || succeeded.value != rule.callValue) revert InvalidTarget();
        if (failed.nonce != rule.failureNonce || succeeded.nonce != rule.failureNonce + 1) revert InvalidNonce();
        if (failedReceipt.receiptStatus != 0 || successReceipt.receiptStatus != 1) {
            revert InvalidReceiptSequence();
        }
        if (failedReceipt.receiptGasUsed > rule.maxFailureGasUsed) revert FailureGasExceeded();

        _validateCalldata(failed.data, rule.selector, rule.policyId);
        _validateCalldata(succeeded.data, rule.selector, rule.policyId);
        if (keccak256(failed.data) != keccak256(succeeded.data)) revert InvalidCalldata();

        _requireSuccessEvent(successReceipt, rule);

        return rule.beneficiary;
    }

    function _validateRule(Rule calldata rule, bool requirePolicyId) private pure {
        if (
            rule.beneficiary == address(0) || rule.target == address(0) || rule.selector == bytes4(0)
                || (requirePolicyId && rule.policyId == bytes32(0)) || (!requirePolicyId && rule.policyId != bytes32(0))
                || rule.failureNonce == type(uint64).max || rule.startBlock > rule.endBlock || rule.maxBlockGap == 0
                || rule.maxBlockGap > MAX_ATTESTCOIN_BATCH_BLOCK_GAP || rule.maxFailureGasUsed == 0
                || rule.successEventEmitter == address(0) || rule.successEventSignature == bytes32(0)
                || rule.policyIdTopicIndex == 0 || rule.policyIdTopicIndex > 3 || rule.beneficiaryTopicIndex == 0
                || rule.beneficiaryTopicIndex > 3 || rule.policyIdTopicIndex == rule.beneficiaryTopicIndex
        ) revert InvalidRule();
    }

    function _validateCalldata(bytes memory data, bytes4 expectedSelector, bytes32 expectedPolicyId) private pure {
        if (data.length < 36) revert InvalidCalldata();
        bytes4 selector;
        bytes32 embeddedPolicyId;
        assembly {
            selector := mload(add(data, 32))
            embeddedPolicyId := mload(add(data, 36))
        }
        if (selector != expectedSelector || embeddedPolicyId != expectedPolicyId) revert InvalidCalldata();
    }

    function _requireSuccessEvent(EvmV1Decoder.ReceiptFields memory receipt, Rule calldata rule) private pure {
        EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, rule.successEventSignature);
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].address_ == rule.successEventEmitter && logs[i].topics.length > rule.policyIdTopicIndex
                    && logs[i].topics.length > rule.beneficiaryTopicIndex
                    && logs[i].topics[rule.policyIdTopicIndex] == rule.policyId
                    && address(uint160(uint256(logs[i].topics[rule.beneficiaryTopicIndex]))) == rule.beneficiary
            ) return;
        }
        revert RequiredSuccessEventMissing();
    }
}
