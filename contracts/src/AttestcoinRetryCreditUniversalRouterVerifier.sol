// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {INativeQueryVerifier} from "./interfaces/INativeQueryVerifier.sol";
import {RetryCreditUniversalRouterPredicateV1} from "./RetryCreditUniversalRouterPredicateV1.sol";

/// @notice Verifies one included failed and later successful Universal Router call with one Attestcoin batch.
contract AttestcoinRetryCreditUniversalRouterVerifier {
    address public constant NATIVE_VERIFIER = 0x0000000000000000000000000000000000000FD2;
    uint64 public constant SEPOLIA_SOURCE_CHAIN_KEY = 1;
    uint64 public constant SEPOLIA_CHAIN_ID = 11_155_111;

    struct BatchProof {
        uint64[] sourceBlocks;
        bytes[] encodedTransactions;
        INativeQueryVerifier.MerkleProof[] merkleProofs;
        bytes32 lowerEndpointDigest;
        bytes32[] continuityRoots;
    }

    INativeQueryVerifier public immutable verifier;
    RetryCreditUniversalRouterPredicateV1 public immutable predicate;
    uint64 public immutable sourceChainKey;
    uint64 public immutable sourceChainId;

    error InvalidBatch();
    error InvalidConfiguration();
    error InvalidProofOrder();
    error ProofVerificationFailed();

    constructor(
        RetryCreditUniversalRouterPredicateV1 predicate_,
        address verifierOverride,
        uint64 sourceChainKey_,
        uint64 sourceChainId_
    ) {
        if (
            address(predicate_) == address(0) || sourceChainKey_ != SEPOLIA_SOURCE_CHAIN_KEY
                || sourceChainId_ != SEPOLIA_CHAIN_ID
        ) {
            revert InvalidConfiguration();
        }
        predicate = predicate_;
        verifier = INativeQueryVerifier(verifierOverride == address(0) ? NATIVE_VERIFIER : verifierOverride);
        sourceChainKey = sourceChainKey_;
        sourceChainId = sourceChainId_;
    }

    function verifyRelease(BatchProof calldata proof, RetryCreditUniversalRouterPredicateV1.Rule calldata rule)
        external
        returns (address beneficiary, bytes32 failureQueryId, bytes32 successQueryId, bytes32 pairId)
    {
        if (proof.sourceBlocks.length != 2 || proof.encodedTransactions.length != 2 || proof.merkleProofs.length != 2) revert InvalidBatch();
        if (proof.sourceBlocks[1] <= proof.sourceBlocks[0]) revert InvalidProofOrder();

        INativeQueryVerifier.ContinuityProof memory continuityProof = INativeQueryVerifier.ContinuityProof({
            lowerEndpointDigest: proof.lowerEndpointDigest, roots: proof.continuityRoots
        });
        bool verified = verifier.verifyAndEmit(
            sourceChainKey, proof.sourceBlocks, proof.encodedTransactions, proof.merkleProofs, continuityProof
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

        failureQueryId = _queryId(proof.sourceBlocks[0], verifier.calculateTxIndex(proof.merkleProofs[0]));
        successQueryId = _queryId(proof.sourceBlocks[1], verifier.calculateTxIndex(proof.merkleProofs[1]));
        pairId = keccak256(abi.encode(rule.policyId, rule.actionId, failureQueryId, successQueryId));
    }

    function _queryId(uint64 sourceBlock, uint64 transactionIndex) private view returns (bytes32) {
        return keccak256(abi.encode(sourceChainKey, sourceBlock, transactionIndex));
    }
}
