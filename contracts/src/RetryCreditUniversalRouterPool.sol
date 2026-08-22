// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AttestcoinRetryCreditUniversalRouterVerifier} from "./AttestcoinRetryCreditUniversalRouterVerifier.sol";
import {RetryCreditUniversalRouterPredicateV1} from "./RetryCreditUniversalRouterPredicateV1.sol";
import {IChainInfo} from "./interfaces/IChainInfo.sol";

/// @notice Holds one pre-funded service credit until Attestcoin proves a failed then settled signed Uniswap route.
contract RetryCreditUniversalRouterPool is ReentrancyGuard {
    address public constant CHAIN_INFO = 0x0000000000000000000000000000000000000fD3;
    uint256 public constant ACTIVATION_WINDOW_BLOCKS = 256;

    struct ServiceCredit {
        address sponsor;
        uint256 creditAmount;
        uint64 refundAfter;
        uint256 creationBlock;
        bytes32 termsHash;
        bool released;
        bool refunded;
    }

    AttestcoinRetryCreditUniversalRouterVerifier public immutable retryVerifier;
    RetryCreditUniversalRouterPredicateV1 public immutable predicate;
    IChainInfo public immutable chainInfo;
    uint64 public immutable sourceChainKey;
    uint64 public immutable sourceChainId;
    uint256 public serviceCreditCount;

    mapping(uint256 serviceCreditNumber => ServiceCredit) private serviceCredits;
    mapping(uint256 serviceCreditNumber => RetryCreditUniversalRouterPredicateV1.Rule) private rules;
    mapping(bytes32 queryId => bool) public consumedQueries;
    mapping(bytes32 pairId => bool) public consumedPairs;
    mapping(bytes32 actionKey => bool) public consumedActions;

    event ServiceCreditDraftCreated(
        uint256 indexed serviceCreditNumber,
        address indexed sponsor,
        address indexed trader,
        uint256 creditAmount,
        uint64 refundAfter,
        uint256 creationBlock,
        bytes32 termsHash
    );
    event ServiceCreditActivated(
        uint256 indexed serviceCreditNumber, bytes32 indexed policyId, bytes32 creationBlockHash
    );
    event CreditReleased(
        uint256 indexed serviceCreditNumber,
        bytes32 indexed policyId,
        address indexed trader,
        uint256 creditAmount,
        bytes32 failureQueryId,
        bytes32 successQueryId,
        bytes32 pairId,
        address prover
    );
    event ServiceCreditRefunded(uint256 indexed serviceCreditNumber, address indexed sponsor, uint256 creditAmount);

    error ActivationClosed();
    error ActivationExpired();
    error ActivationNotReady();
    error AlreadyActivated();
    error AlreadyResolved();
    error InvalidServiceCredit();
    error InvalidSourceChain();
    error NotActivated();
    error NotSponsor();
    error RefundClosed();
    error ReleaseClosed();
    error Replay();
    error SourceWindowNotAttested();
    error TransferFailed();

    constructor(AttestcoinRetryCreditUniversalRouterVerifier retryVerifier_, address chainInfoOverride) {
        if (address(retryVerifier_) == address(0)) revert InvalidServiceCredit();
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

    function createServiceCredit(RetryCreditUniversalRouterPredicateV1.Rule calldata terms, uint64 refundAfter)
        external
        payable
        returns (uint256 serviceCreditNumber)
    {
        if (msg.value == 0 || refundAfter <= block.timestamp || terms.policyId != bytes32(0)) {
            revert InvalidServiceCredit();
        }
        predicate.validateTerms(terms);

        IChainInfo.HeightHashResult memory latest = chainInfo.get_latest_attestation_height_and_hash(sourceChainKey);
        if (!latest.exists || !latest.isAttestation || terms.startBlock <= latest.height) {
            revert SourceWindowNotAttested();
        }

        serviceCreditNumber = ++serviceCreditCount;
        bytes32 termsHash = keccak256(abi.encode(sourceChainKey, sourceChainId, terms, refundAfter, msg.value));
        serviceCredits[serviceCreditNumber] = ServiceCredit({
            sponsor: msg.sender,
            creditAmount: msg.value,
            refundAfter: refundAfter,
            creationBlock: block.number,
            termsHash: termsHash,
            released: false,
            refunded: false
        });
        rules[serviceCreditNumber] = terms;

        emit ServiceCreditDraftCreated(
            serviceCreditNumber, msg.sender, terms.trader, msg.value, refundAfter, block.number, termsHash
        );
    }

    /// @notice Derives a stable policy identifier from the mined draft block before source attempts can begin.
    function activateServiceCredit(uint256 serviceCreditNumber) external returns (bytes32 policyId) {
        ServiceCredit storage credit = _serviceCredit(serviceCreditNumber);
        if (msg.sender != credit.sponsor) revert NotSponsor();
        if (credit.released || credit.refunded) revert AlreadyResolved();
        if (rules[serviceCreditNumber].policyId != bytes32(0)) revert AlreadyActivated();
        if (block.timestamp >= credit.refundAfter) revert ActivationClosed();
        if (block.number <= credit.creationBlock) revert ActivationNotReady();
        if (block.number > credit.creationBlock + ACTIVATION_WINDOW_BLOCKS) revert ActivationExpired();

        bytes32 creationBlockHash = blockhash(credit.creationBlock);
        if (creationBlockHash == bytes32(0)) revert ActivationExpired();
        policyId = keccak256(
            abi.encode(
                "RETRYCREDIT_UNISWAP_SERVICE_CREDIT_V1",
                block.chainid,
                address(this),
                serviceCreditNumber,
                credit.sponsor,
                credit.creditAmount,
                credit.refundAfter,
                credit.termsHash,
                creationBlockHash
            )
        );
        rules[serviceCreditNumber].policyId = policyId;
        emit ServiceCreditActivated(serviceCreditNumber, policyId, creationBlockHash);
    }

    function releaseCredit(
        uint256 serviceCreditNumber,
        AttestcoinRetryCreditUniversalRouterVerifier.BatchProof calldata proof
    ) external nonReentrant {
        ServiceCredit storage credit = _serviceCredit(serviceCreditNumber);
        if (credit.released || credit.refunded) revert AlreadyResolved();
        if (rules[serviceCreditNumber].policyId == bytes32(0)) revert NotActivated();
        if (block.timestamp > credit.refundAfter) revert ReleaseClosed();

        (address trader, bytes32 failureQueryId, bytes32 successQueryId, bytes32 pairId) =
            retryVerifier.verifyRelease(proof, rules[serviceCreditNumber]);
        bytes32 actionKey = _actionKey(rules[serviceCreditNumber]);
        if (
            consumedActions[actionKey] || consumedPairs[pairId] || consumedQueries[failureQueryId]
                || consumedQueries[successQueryId]
        ) revert Replay();

        credit.released = true;
        consumedActions[actionKey] = true;
        consumedPairs[pairId] = true;
        consumedQueries[failureQueryId] = true;
        consumedQueries[successQueryId] = true;

        uint256 creditAmount = credit.creditAmount;
        _send(trader, creditAmount);
        emit CreditReleased(
            serviceCreditNumber,
            rules[serviceCreditNumber].policyId,
            trader,
            creditAmount,
            failureQueryId,
            successQueryId,
            pairId,
            msg.sender
        );
    }

    function refundServiceCredit(uint256 serviceCreditNumber) external nonReentrant {
        ServiceCredit storage credit = _serviceCredit(serviceCreditNumber);
        if (msg.sender != credit.sponsor) revert NotSponsor();
        if (credit.released || credit.refunded) revert AlreadyResolved();

        bool inactiveDraftExpired = rules[serviceCreditNumber].policyId == bytes32(0)
            && (block.number > credit.creationBlock + ACTIVATION_WINDOW_BLOCKS || block.timestamp >= credit.refundAfter);
        if (!inactiveDraftExpired) {
            if (block.timestamp <= credit.refundAfter) revert RefundClosed();
            IChainInfo.HeightHashResult memory latest = chainInfo.get_latest_attestation_height_and_hash(sourceChainKey);
            if (!latest.exists || !latest.isAttestation || latest.height < rules[serviceCreditNumber].endBlock) {
                revert SourceWindowNotAttested();
            }
        }

        credit.refunded = true;
        uint256 creditAmount = credit.creditAmount;
        _send(credit.sponsor, creditAmount);
        emit ServiceCreditRefunded(serviceCreditNumber, credit.sponsor, creditAmount);
    }

    function getServiceCredit(uint256 serviceCreditNumber) external view returns (ServiceCredit memory) {
        return _serviceCredit(serviceCreditNumber);
    }

    function getRule(uint256 serviceCreditNumber)
        external
        view
        returns (RetryCreditUniversalRouterPredicateV1.Rule memory)
    {
        _serviceCredit(serviceCreditNumber);
        return rules[serviceCreditNumber];
    }

    function _serviceCredit(uint256 serviceCreditNumber) private view returns (ServiceCredit storage credit) {
        credit = serviceCredits[serviceCreditNumber];
        if (credit.sponsor == address(0)) revert InvalidServiceCredit();
    }

    function _actionKey(RetryCreditUniversalRouterPredicateV1.Rule storage rule) private view returns (bytes32) {
        return keccak256(abi.encode(sourceChainKey, sourceChainId, rule.router, rule.trader, rule.actionId));
    }

    function _send(address recipient, uint256 amount) private {
        (bool success,) = payable(recipient).call{value: amount}("");
        if (!success) revert TransferFailed();
    }
}
