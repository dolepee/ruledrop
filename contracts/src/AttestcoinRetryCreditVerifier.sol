// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {INativeQueryVerifier} from "./interfaces/INativeQueryVerifier.sol";
import {RetryCreditPredicateV2} from "./RetryCreditPredicateV2.sol";

/// @notice Verifies an included failure and later successful retry with one Attestcoin batch proof.
contract AttestcoinRetryCreditVerifier {
    address public constant NATIVE_VERIFIER = 0x0000000000000000000000000000000000000FD2;

    struct BatchProof {
        uint64[] sourceBlocks;
        bytes[] encodedTransactions;
        INativeQueryVerifier.MerkleProof[] merkleProofs;
        bytes32 lowerEndpointDigest;
        bytes32[] continuityRoots;
    }

    INativeQueryVerifier public immutable verifier;
    RetryCreditPredicateV2 public immutable predicate;
    uint64 public immutable sourceChainKey;
    uint64 public immutable sourceChainId;

    error InvalidBatch();
    error InvalidConfiguration();
    error InvalidProofOrder();
    error ProofVerificationFailed();

    constructor(
        RetryCreditPredicateV2 predicate_,
        address verifierOverride,
        uint64 sourceChainKey_,
        uint64 sourceChainId_
    ) {
        if (address(predicate_) == address(0) || sourceChainKey_ == 0 || sourceChainId_ == 0) {
            revert InvalidConfiguration();
        }
        predicate = predicate_;
        verifier = INativeQueryVerifier(verifierOverride == address(0) ? NATIVE_VERIFIER : verifierOverride);
        sourceChainKey = sourceChainKey_;
        sourceChainId = sourceChainId_;
    }

    function verifyRelease(BatchProof calldata proof, RetryCreditPredicateV2.Rule calldata rule)
        external
        returns (address beneficiary, bytes32 failureQueryId, bytes32 successQueryId, bytes32 pairId)
    {
        if (proof.sourceBlocks.length != 2 || proof.encodedTransactions.length != 2 || proof.merkleProofs.length != 2) revert InvalidBatch();
        if (proof.sourceBlocks[1] <= proof.sourceBlocks[0]) revert InvalidProofOrder();

        INativeQueryVerifier.ContinuityProof memory sharedContinuityProof = INativeQueryVerifier.ContinuityProof({
            lowerEndpointDigest: proof.lowerEndpointDigest, roots: proof.continuityRoots
        });
        bool verified = verifier.verifyAndEmit(
            sourceChainKey, proof.sourceBlocks, proof.encodedTransactions, proof.merkleProofs, sharedContinuityProof
        );
        if (!verified) revert ProofVerificationFailed();

        beneficiary = predicate.validate(
            proof.encodedTransactions[0],
            proof.sourceBlocks[0],
            proof.encodedTransactions[1],
            proof.sourceBlocks[1],
            sourceChainId,
            rule
        );

        uint64 failureIndex = verifier.calculateTxIndex(proof.merkleProofs[0]);
        uint64 successIndex = verifier.calculateTxIndex(proof.merkleProofs[1]);
        failureQueryId = _queryId(proof.sourceBlocks[0], failureIndex);
        successQueryId = _queryId(proof.sourceBlocks[1], successIndex);
        pairId = keccak256(abi.encode(rule.policyId, rule.actionId, failureQueryId, successQueryId));
    }

    function _queryId(uint64 sourceBlock, uint64 transactionIndex) private view returns (bytes32) {
        return keccak256(abi.encode(sourceChainKey, sourceBlock, transactionIndex));
    }
}
