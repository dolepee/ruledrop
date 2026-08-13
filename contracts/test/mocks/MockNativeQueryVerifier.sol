// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {INativeQueryVerifier} from "../../src/interfaces/INativeQueryVerifier.sol";

contract MockNativeQueryVerifier is INativeQueryVerifier {
    bool public verificationResult = true;
    uint64 public transactionIndex = 7;

    function setVerificationResult(bool result) external {
        verificationResult = result;
    }

    function setTransactionIndex(uint64 index) external {
        transactionIndex = index;
    }

    function verifyAndEmit(uint64, uint64, bytes calldata, MerkleProof calldata, ContinuityProof calldata)
        external
        view
        returns (bool)
    {
        return verificationResult;
    }

    function calculateTxIndex(MerkleProof calldata) external view returns (uint64) {
        return transactionIndex;
    }
}

