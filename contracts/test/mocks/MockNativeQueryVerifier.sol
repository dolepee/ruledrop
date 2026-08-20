// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {INativeQueryVerifier} from "../../src/interfaces/INativeQueryVerifier.sol";

contract MockNativeQueryVerifier is INativeQueryVerifier {
    bool public verificationResult = true;
    uint64 public transactionIndex = 7;
    uint256 public batchCallCount;
    uint256 public lastBatchSize;

    mapping(bytes32 merkleRoot => uint64 transactionIndex) private transactionIndices;
    mapping(bytes32 merkleRoot => bool configured) private configuredTransactionIndices;

    function setVerificationResult(bool result) external {
        verificationResult = result;
    }

    function setTransactionIndex(uint64 index) external {
        transactionIndex = index;
    }

    function setTransactionIndexForRoot(bytes32 merkleRoot, uint64 index) external {
        transactionIndices[merkleRoot] = index;
        configuredTransactionIndices[merkleRoot] = true;
    }

    function verifyAndEmit(uint64, uint64, bytes calldata, MerkleProof calldata, ContinuityProof calldata)
        external
        view
        returns (bool)
    {
        return verificationResult;
    }

    function verifyAndEmit(
        uint64,
        uint64[] calldata heights,
        bytes[] calldata,
        MerkleProof[] calldata,
        ContinuityProof calldata
    ) external returns (bool) {
        ++batchCallCount;
        lastBatchSize = heights.length;
        return verificationResult;
    }

    function calculateTxIndex(MerkleProof calldata merkleProof) external view returns (uint64) {
        if (configuredTransactionIndices[merkleProof.root]) return transactionIndices[merkleProof.root];
        return transactionIndex;
    }
}
