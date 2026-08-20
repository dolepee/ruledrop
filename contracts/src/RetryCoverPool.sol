// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AttestcoinRetryVerifier} from "./AttestcoinRetryVerifier.sol";
import {RetryCoverPredicateV1} from "./RetryCoverPredicateV1.sol";
import {IChainInfo} from "./interfaces/IChainInfo.sol";

/// @notice A one-shot, pre-funded fixed credit for an exact failed-then-successful Ethereum call.
contract RetryCoverPool is ReentrancyGuard {
    address public constant CHAIN_INFO = 0x0000000000000000000000000000000000000fD3;
    uint256 public constant ACTIVATION_WINDOW_BLOCKS = 256;

    struct Policy {
        address sponsor;
        uint256 recoveryCredit;
        uint64 refundAfter;
        uint256 creationBlock;
        bytes32 termsHash;
        bool paid;
        bool refunded;
    }

    AttestcoinRetryVerifier public immutable retryVerifier;
    RetryCoverPredicateV1 public immutable predicate;
    IChainInfo public immutable chainInfo;
    uint64 public immutable sourceChainKey;
    uint64 public immutable sourceChainId;
    uint256 public policyCount;

    mapping(uint256 policyNumber => Policy) private policies;
    mapping(uint256 policyNumber => RetryCoverPredicateV1.Rule) private rules;
    mapping(bytes32 queryId => bool) public consumedQueries;
    mapping(bytes32 pairId => bool) public consumedPairs;

    event PolicyDraftCreated(
        uint256 indexed policyNumber,
        address indexed sponsor,
        address indexed beneficiary,
        uint256 recoveryCredit,
        uint64 refundAfter,
        uint256 creationBlock,
        bytes32 termsHash
    );
    event PolicyActivated(uint256 indexed policyNumber, bytes32 indexed policyId, bytes32 creationBlockHash);
    event RecoveryPaid(
        uint256 indexed policyNumber,
        bytes32 indexed policyId,
        address indexed beneficiary,
        uint256 recoveryCredit,
        bytes32 failureQueryId,
        bytes32 successQueryId,
        bytes32 pairId,
        address prover
    );
    event PolicyRefunded(uint256 indexed policyNumber, address indexed sponsor, uint256 recoveryCredit);

    error ActivationExpired();
    error ActivationNotReady();
    error AlreadyActivated();
    error AlreadyResolved();
    error ClaimClosed();
    error InvalidPolicy();
    error InvalidSourceChain();
    error NotActivated();
    error NotSponsor();
    error RefundClosed();
    error Replay();
    error SourceWindowNotAttested();
    error TransferFailed();

    constructor(AttestcoinRetryVerifier retryVerifier_, address chainInfoOverride) {
        if (address(retryVerifier_) == address(0)) revert InvalidPolicy();
        retryVerifier = retryVerifier_;
        predicate = retryVerifier_.predicate();
        sourceChainKey = retryVerifier_.sourceChainKey();
        sourceChainId = retryVerifier_.sourceChainId();
        chainInfo = IChainInfo(chainInfoOverride == address(0) ? CHAIN_INFO : chainInfoOverride);

        IChainInfo.ChainInfoResult memory source = chainInfo.get_chain_by_key(sourceChainKey);
        if (
            !source.exists || source.info.chainKey != sourceChainKey || source.info.chainId != sourceChainId
                || source.info.chainEncoding != 1
        ) revert InvalidSourceChain();
    }

    function createPolicy(RetryCoverPredicateV1.Rule calldata terms, uint64 refundAfter)
        external
        payable
        returns (uint256 policyNumber)
    {
        if (msg.value == 0 || refundAfter <= block.timestamp || terms.policyId != bytes32(0)) {
            revert InvalidPolicy();
        }
        predicate.validateTerms(terms);

        IChainInfo.HeightHashResult memory latest = chainInfo.get_latest_attestation_height_and_hash(sourceChainKey);
        if (!latest.exists || !latest.isAttestation || terms.startBlock <= latest.height) {
            revert SourceWindowNotAttested();
        }

        policyNumber = ++policyCount;
        bytes32 termsHash = keccak256(abi.encode(sourceChainKey, sourceChainId, terms, refundAfter, msg.value));
        policies[policyNumber] = Policy({
            sponsor: msg.sender,
            recoveryCredit: msg.value,
            refundAfter: refundAfter,
            creationBlock: block.number,
            termsHash: termsHash,
            paid: false,
            refunded: false
        });
        rules[policyNumber] = terms;

        emit PolicyDraftCreated(
            policyNumber, msg.sender, terms.beneficiary, msg.value, refundAfter, block.number, termsHash
        );
    }

    /// @notice Derives an unguessable source-call challenge from the mined draft block.
    /// @dev Must run in a later block and before EVM blockhash history expires.
    function activatePolicy(uint256 policyNumber) external returns (bytes32 policyId) {
        Policy storage policy = _policy(policyNumber);
        if (policy.paid || policy.refunded) revert AlreadyResolved();
        if (rules[policyNumber].policyId != bytes32(0)) revert AlreadyActivated();
        if (block.number <= policy.creationBlock) revert ActivationNotReady();
        if (block.number > policy.creationBlock + ACTIVATION_WINDOW_BLOCKS) revert ActivationExpired();

        bytes32 creationBlockHash = blockhash(policy.creationBlock);
        if (creationBlockHash == bytes32(0)) revert ActivationExpired();
        policyId = keccak256(
            abi.encode(
                "RETRYCOVER_POLICY_V1",
                block.chainid,
                address(this),
                policyNumber,
                policy.sponsor,
                policy.recoveryCredit,
                policy.refundAfter,
                policy.termsHash,
                creationBlockHash
            )
        );
        rules[policyNumber].policyId = policyId;
        emit PolicyActivated(policyNumber, policyId, creationBlockHash);
    }

    function claim(uint256 policyNumber, AttestcoinRetryVerifier.BatchProof calldata proof) external nonReentrant {
        Policy storage policy = _policy(policyNumber);
        if (policy.paid || policy.refunded) revert AlreadyResolved();
        if (rules[policyNumber].policyId == bytes32(0)) revert NotActivated();
        if (block.timestamp > policy.refundAfter) revert ClaimClosed();

        (address beneficiary, bytes32 failureQueryId, bytes32 successQueryId, bytes32 pairId) =
            retryVerifier.verifyRetry(proof, rules[policyNumber]);
        if (consumedPairs[pairId] || consumedQueries[failureQueryId] || consumedQueries[successQueryId]) {
            revert Replay();
        }

        policy.paid = true;
        consumedPairs[pairId] = true;
        consumedQueries[failureQueryId] = true;
        consumedQueries[successQueryId] = true;

        uint256 recoveryCredit = policy.recoveryCredit;
        _send(beneficiary, recoveryCredit);
        emit RecoveryPaid(
            policyNumber,
            rules[policyNumber].policyId,
            beneficiary,
            recoveryCredit,
            failureQueryId,
            successQueryId,
            pairId,
            msg.sender
        );
    }

    function refund(uint256 policyNumber) external nonReentrant {
        Policy storage policy = _policy(policyNumber);
        if (msg.sender != policy.sponsor) revert NotSponsor();
        if (policy.paid || policy.refunded) revert AlreadyResolved();

        bool inactiveDraftExpired = rules[policyNumber].policyId == bytes32(0)
            && block.number > policy.creationBlock + ACTIVATION_WINDOW_BLOCKS;
        if (!inactiveDraftExpired) {
            if (block.timestamp <= policy.refundAfter) revert RefundClosed();
            IChainInfo.HeightHashResult memory latest = chainInfo.get_latest_attestation_height_and_hash(sourceChainKey);
            if (!latest.exists || !latest.isAttestation || latest.height < rules[policyNumber].endBlock) {
                revert SourceWindowNotAttested();
            }
        }

        policy.refunded = true;
        uint256 recoveryCredit = policy.recoveryCredit;
        _send(policy.sponsor, recoveryCredit);
        emit PolicyRefunded(policyNumber, policy.sponsor, recoveryCredit);
    }

    function getPolicy(uint256 policyNumber) external view returns (Policy memory) {
        return _policy(policyNumber);
    }

    function getRule(uint256 policyNumber) external view returns (RetryCoverPredicateV1.Rule memory) {
        _policy(policyNumber);
        return rules[policyNumber];
    }

    function _policy(uint256 policyNumber) private view returns (Policy storage policy) {
        policy = policies[policyNumber];
        if (policy.sponsor == address(0)) revert InvalidPolicy();
    }

    function _send(address recipient, uint256 amount) private {
        (bool success,) = payable(recipient).call{value: amount}("");
        if (!success) revert TransferFailed();
    }
}
