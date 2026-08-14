// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

contract ContractInteractionPredicateV1 {
    struct Rule {
        address target;
        bytes4 selector;
        address requiredEventEmitter;
        bytes32 requiredEventSignature;
        uint8 claimantTopicIndex;
        uint64 startBlock;
        uint64 endBlock;
    }

    error InvalidCalldata();
    error InvalidReceipt();
    error InvalidRule();
    error InvalidSourceBlock();
    error InvalidSourceTransaction();
    error RequiredEventMissing();

    function validate(bytes calldata encodedTransaction, uint64 sourceBlock, Rule calldata rule)
        external
        pure
        returns (address claimant)
    {
        if (sourceBlock < rule.startBlock || sourceBlock > rule.endBlock) revert InvalidSourceBlock();
        if (
            rule.target == address(0) || rule.selector == bytes4(0) || rule.startBlock > rule.endBlock
                || ((rule.requiredEventEmitter == address(0)) != (rule.requiredEventSignature == bytes32(0)))
                || (rule.requiredEventSignature == bytes32(0) && rule.claimantTopicIndex != 0)
                || rule.claimantTopicIndex > 3
        ) revert InvalidRule();

        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        if (!EvmV1Decoder.isValidTransactionType(txType)) revert InvalidSourceTransaction();

        EvmV1Decoder.CommonTxFields memory transaction = EvmV1Decoder.decodeCommonTxFields(encodedTransaction);
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);

        if (receipt.receiptStatus != 1) revert InvalidReceipt();
        if (transaction.toIsNull || transaction.to != rule.target) revert InvalidSourceTransaction();
        if (transaction.data.length < 4) revert InvalidCalldata();

        bytes4 selector;
        bytes memory data = transaction.data;
        assembly {
            selector := mload(add(data, 32))
        }
        if (selector != rule.selector) revert InvalidCalldata();

        if (rule.requiredEventSignature != bytes32(0)) {
            EvmV1Decoder.LogEntry[] memory logs =
                EvmV1Decoder.getLogsByEventSignature(receipt, rule.requiredEventSignature);
            bool found;
            for (uint256 i; i < logs.length; ++i) {
                if (
                    logs[i].address_ == rule.requiredEventEmitter
                        && (rule.claimantTopicIndex == 0
                            || (logs[i].topics.length > rule.claimantTopicIndex
                                && address(uint160(uint256(logs[i].topics[rule.claimantTopicIndex])))
                                    == transaction.from))
                ) {
                    found = true;
                    break;
                }
            }
            if (!found) revert RequiredEventMissing();
        }

        return transaction.from;
    }
}
