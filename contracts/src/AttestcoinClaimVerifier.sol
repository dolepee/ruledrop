// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {INativeQueryVerifier} from "./interfaces/INativeQueryVerifier.sol";
import {USDCTransferPredicateV1} from "./USDCTransferPredicateV1.sol";
import {ContractInteractionPredicateV1} from "./ContractInteractionPredicateV1.sol";

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
    ContractInteractionPredicateV1 public immutable interactionPredicate;

    error InvalidConfiguration();
    error ProofVerificationFailed();

    constructor(USDCTransferPredicateV1 predicate_, address verifierOverride) {
        if (address(predicate_) == address(0)) revert InvalidConfiguration();
        predicate = predicate_;
        interactionPredicate = new ContractInteractionPredicateV1();
        verifier = INativeQueryVerifier(verifierOverride == address(0) ? NATIVE_VERIFIER : verifierOverride);
    }

    function verifyClaim(Proof calldata proof, USDCTransferPredicateV1.Rule calldata rule)
        external
        returns (address claimant, bytes32 queryId, uint256 amount)
    {
        queryId = _verify(proof);
        (claimant, amount) = predicate.validate(proof.encodedTransaction, proof.sourceBlock, rule);
    }

    function verifyInteractionClaim(Proof calldata proof, ContractInteractionPredicateV1.Rule calldata rule)
        external
        returns (address claimant, bytes32 queryId)
    {
        queryId = _verify(proof);
        claimant = interactionPredicate.validate(proof.encodedTransaction, proof.sourceBlock, rule);
    }

    function _verify(Proof calldata proof) private returns (bytes32 queryId) {
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
    }
}
