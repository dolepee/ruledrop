// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

/// @notice Reconstructs the canonical EIP-2718 hash for the bounded type-2 transactions used by RetryCredit.
library Type2TransactionHash {
    error UnsupportedSourceTransaction();

    function hash(bytes memory encodedTransaction) internal pure returns (bytes32) {
        return keccak256(encode(encodedTransaction));
    }

    function encode(bytes memory encodedTransaction) internal pure returns (bytes memory) {
        if (EvmV1Decoder.getTransactionType(encodedTransaction) != 2) revert UnsupportedSourceTransaction();
        EvmV1Decoder.DecodedTransactionType2 memory decoded = EvmV1Decoder.decodeTransactionType2(encodedTransaction);
        if (decoded.commonTx.toIsNull || decoded.type2.accessList.length != 0) revert UnsupportedSourceTransaction();

        bytes[] memory items = new bytes[](12);
        items[0] = _encodeUint(decoded.type2.chainId);
        items[1] = _encodeUint(decoded.commonTx.nonce);
        items[2] = _encodeUint(decoded.type2.maxPriorityFeePerGas);
        items[3] = _encodeUint(decoded.type2.maxFeePerGas);
        items[4] = _encodeUint(decoded.commonTx.gasLimit);
        items[5] = _encodeBytes(abi.encodePacked(decoded.commonTx.to));
        items[6] = _encodeUint(decoded.commonTx.value);
        items[7] = _encodeBytes(decoded.commonTx.data);
        items[8] = hex"c0";
        items[9] = _encodeUint(decoded.type2.yParity);
        items[10] = _encodeUint(uint256(decoded.type2.r));
        items[11] = _encodeUint(uint256(decoded.type2.s));

        bytes memory payload;
        for (uint256 i; i < items.length; i++) {
            payload = bytes.concat(payload, items[i]);
        }
        return bytes.concat(hex"02", _encodeList(payload));
    }

    function _encodeUint(uint256 value) private pure returns (bytes memory) {
        if (value == 0) return hex"80";
        return _encodeBytes(_minimalBytes(value));
    }

    function _encodeBytes(bytes memory value) private pure returns (bytes memory) {
        uint256 length = value.length;
        if (length == 1 && uint8(value[0]) < 0x80) return value;
        // forge-lint: disable-next-line(unsafe-typecast)
        if (length <= 55) return bytes.concat(bytes1(uint8(0x80 + length)), value);
        bytes memory lengthBytes = _minimalBytes(length);
        return bytes.concat(bytes1(uint8(0xb7 + lengthBytes.length)), lengthBytes, value);
    }

    function _encodeList(bytes memory payload) private pure returns (bytes memory) {
        if (payload.length <= 55) return bytes.concat(bytes1(uint8(0xc0 + payload.length)), payload);
        bytes memory lengthBytes = _minimalBytes(payload.length);
        return bytes.concat(bytes1(uint8(0xf7 + lengthBytes.length)), lengthBytes, payload);
    }

    function _minimalBytes(uint256 value) private pure returns (bytes memory output) {
        uint256 length;
        uint256 cursor = value;
        while (cursor != 0) {
            length++;
            cursor >>= 8;
        }
        output = new bytes(length);
        for (uint256 i; i < length; i++) {
            // The low byte is consumed before the value is shifted for the next iteration.
            // forge-lint: disable-next-line(unsafe-typecast)
            output[length - 1 - i] = bytes1(uint8(value));
            value >>= 8;
        }
    }
}
