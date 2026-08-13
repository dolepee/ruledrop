// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {INativeQueryVerifier} from "./interfaces/INativeQueryVerifier.sol";
import {USDCTransferPredicateV1} from "./USDCTransferPredicateV1.sol";

contract AttestcoinClaimVerifier {
    uint64 public constant ETHEREUM_MAINNET_CHAIN_KEY = 3;
    address public constant NATIVE_VERIFIER = 0x0000000000000000000000000000000000000FD2;

    struct Proof {
        uint64 sourceBlock;
        bytes encodedTransaction;
        bytes32 merkleRoot;
        INativeQueryVerifier.MerkleProofEntry[] siblings;
        bytes32 lowerEndpointDigest;
        bytes32[] continuityRoots;
    }

    INativeQueryVerifier public immutable verifier;
    USDCTransferPredicateV1 public immutable predicate;

    error InvalidConfiguration();
    error ProofVerificationFailed();

    constructor(USDCTransferPredicateV1 predicate_, address verifierOverride) {
        if (address(predicate_) == address(0)) revert InvalidConfiguration();
        predicate = predicate_;
        verifier = INativeQueryVerifier(verifierOverride == address(0) ? NATIVE_VERIFIER : verifierOverride);
    }

    function verifyClaim(Proof calldata proof, USDCTransferPredicateV1.Rule calldata rule)
        external
        returns (address claimant, bytes32 queryId, uint256 amount)
    {
        INativeQueryVerifier.MerkleProof memory merkleProof =
            INativeQueryVerifier.MerkleProof({root: proof.merkleRoot, siblings: proof.siblings});
        INativeQueryVerifier.ContinuityProof memory continuityProof = INativeQueryVerifier.ContinuityProof({
            lowerEndpointDigest: proof.lowerEndpointDigest, roots: proof.continuityRoots
        });

        bool verified = verifier.verifyAndEmit(
            ETHEREUM_MAINNET_CHAIN_KEY, proof.sourceBlock, proof.encodedTransaction, merkleProof, continuityProof
        );
        if (!verified) revert ProofVerificationFailed();

        uint64 txIndex = verifier.calculateTxIndex(merkleProof);
        queryId = keccak256(abi.encode(ETHEREUM_MAINNET_CHAIN_KEY, proof.sourceBlock, txIndex));
        (claimant, amount) = predicate.validate(proof.encodedTransaction, proof.sourceBlock, rule);
    }
}

