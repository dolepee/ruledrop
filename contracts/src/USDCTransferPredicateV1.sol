// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

contract USDCTransferPredicateV1 {
    address public constant ETHEREUM_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    bytes4 public constant TRANSFER_SELECTOR = 0xa9059cbb;
    bytes32 public constant TRANSFER_EVENT_SIGNATURE = keccak256("Transfer(address,address,uint256)");

    struct Rule {
        address recipient;
        uint256 minimumAmount;
        uint64 startBlock;
        uint64 endBlock;
    }

    error AmbiguousTransferEvent();
    error InvalidCalldata();
    error InvalidReceipt();
    error InvalidSourceBlock();
    error InvalidSourceTransaction();
    error TransferMismatch();

    function validate(bytes calldata encodedTransaction, uint64 sourceBlock, Rule calldata rule)
        external
        pure
        returns (address claimant, uint256 amount)
    {
        if (sourceBlock < rule.startBlock || sourceBlock > rule.endBlock) revert InvalidSourceBlock();
        if (rule.recipient == address(0) || rule.minimumAmount == 0 || rule.startBlock > rule.endBlock) {
            revert TransferMismatch();
        }

        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        if (!EvmV1Decoder.isValidTransactionType(txType)) revert InvalidSourceTransaction();

        EvmV1Decoder.CommonTxFields memory transaction = EvmV1Decoder.decodeCommonTxFields(encodedTransaction);
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);

        if (receipt.receiptStatus != 1) revert InvalidReceipt();
        if (transaction.toIsNull || transaction.to != ETHEREUM_USDC || transaction.value != 0) {
            revert InvalidSourceTransaction();
        }
        if (transaction.data.length != 68) revert InvalidCalldata();

        bytes4 selector;
        address calldataRecipient;
        uint256 calldataAmount;
        bytes memory data = transaction.data;
        assembly {
            selector := mload(add(data, 32))
            calldataRecipient := and(mload(add(data, 36)), 0xffffffffffffffffffffffffffffffffffffffff)
            calldataAmount := mload(add(data, 68))
        }
        if (selector != TRANSFER_SELECTOR) revert InvalidCalldata();
        if (calldataRecipient != rule.recipient || calldataAmount < rule.minimumAmount) revert TransferMismatch();

        EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, TRANSFER_EVENT_SIGNATURE);
        uint256 matchingLogs = _matchingTransfers(logs, transaction.from, rule.recipient, calldataAmount);
        if (matchingLogs != 1) revert AmbiguousTransferEvent();

        return (transaction.from, calldataAmount);
    }

    function _topicAddress(bytes32 topic) private pure returns (address) {
        return address(uint160(uint256(topic)));
    }

    function _matchingTransfers(EvmV1Decoder.LogEntry[] memory logs, address sender, address recipient, uint256 amount)
        private
        pure
        returns (uint256 matches)
    {
        for (uint256 i; i < logs.length; ++i) {
            EvmV1Decoder.LogEntry memory log = logs[i];
            if (log.address_ != ETHEREUM_USDC || log.topics.length != 3 || log.data.length != 32) continue;
            if (
                _topicAddress(log.topics[1]) == sender && _topicAddress(log.topics[2]) == recipient
                    && abi.decode(log.data, (uint256)) == amount
            ) ++matches;
        }
    }
}
