// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AttestcoinClaimVerifier} from "./AttestcoinClaimVerifier.sol";
import {USDCTransferPredicateV1} from "./USDCTransferPredicateV1.sol";
import {ContractInteractionPredicateV1} from "./ContractInteractionPredicateV1.sol";
import {IChainInfo} from "./interfaces/IChainInfo.sol";

contract RuleDropPool is Ownable, Pausable, ReentrancyGuard {
    uint64 public constant ETHEREUM_MAINNET_CHAIN_KEY = 3;
    address public constant CHAIN_INFO = 0x0000000000000000000000000000000000000fD3;

    enum ClaimTemplate {
        DirectUsdcTransfer,
        ContractInteraction
    }

    enum PayoutPolicy {
        EqualProRata,
        SourceAmountWeighted
    }

    struct Campaign {
        address sponsor;
        address recipient;
        uint256 minimumAmount;
        uint256 maximumWeight;
        uint64 startBlock;
        uint64 endBlock;
        uint64 registrationDeadline;
        uint64 withdrawalDeadline;
        uint256 fundedPool;
        uint256 claimantCount;
        uint256 totalWeight;
        uint256 sharePerClaim;
        uint256 totalPaid;
        uint256 withdrawnCount;
        ClaimTemplate claimTemplate;
        PayoutPolicy payoutPolicy;
        bool finalized;
    }

    AttestcoinClaimVerifier public immutable claimVerifier;
    IChainInfo public immutable chainInfo;
    uint256 public campaignCount;

    mapping(uint256 campaignId => Campaign) private campaigns;
    mapping(uint256 campaignId => mapping(address claimant => bool)) public registered;
    mapping(uint256 campaignId => mapping(address claimant => bool)) public withdrawn;
    mapping(uint256 campaignId => mapping(address claimant => uint256)) public claimWeights;
    mapping(uint256 campaignId => mapping(bytes32 queryId => bool)) public consumedQueries;
    mapping(uint256 campaignId => ContractInteractionPredicateV1.Rule) private interactionRules;

    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed sponsor,
        address indexed recipient,
        uint256 fundedPool,
        uint256 minimumAmount,
        uint64 startBlock,
        uint64 endBlock,
        uint64 registrationDeadline,
        uint64 withdrawalDeadline,
        bytes32 ruleHash
    );
    event ClaimRegistered(
        uint256 indexed campaignId,
        address indexed claimant,
        bytes32 indexed queryId,
        uint64 sourceBlock,
        uint256 sourceAmount
    );
    event CampaignConfigured(
        uint256 indexed campaignId, ClaimTemplate claimTemplate, PayoutPolicy payoutPolicy, uint256 maximumWeight
    );
    event CampaignFinalized(uint256 indexed campaignId, uint256 claimantCount, uint256 sharePerClaim);
    event RewardWithdrawn(uint256 indexed campaignId, address indexed claimant, uint256 amount);
    event RemainderRecovered(uint256 indexed campaignId, address indexed sponsor, uint256 amount);

    error AlreadyFinalized();
    error AlreadyRegistered();
    error AlreadyWithdrawn();
    error CampaignNotFinalized();
    error CampaignNotFound();
    error ClaimantMismatch();
    error ContractClaimantUnsupported();
    error InvalidCampaign();
    error InvalidClaimTemplate();
    error InvalidPayoutPolicy();
    error InvalidSourceChain();
    error NotRegistered();
    error RegistrationClosed();
    error RegistrationOpen();
    error Replay();
    error SourceSnapshotNotAttested();
    error TransferFailed();
    error WithdrawalClosed();
    error WithdrawalOpen();

    constructor(AttestcoinClaimVerifier verifier_, address owner_, address chainInfoOverride) Ownable(owner_) {
        if (address(verifier_) == address(0)) revert InvalidCampaign();
        claimVerifier = verifier_;
        chainInfo = IChainInfo(chainInfoOverride == address(0) ? CHAIN_INFO : chainInfoOverride);
        IChainInfo.ChainInfoResult memory source = chainInfo.get_chain_by_key(ETHEREUM_MAINNET_CHAIN_KEY);
        if (
            !source.exists || source.info.chainKey != ETHEREUM_MAINNET_CHAIN_KEY || source.info.chainId != 1
                || source.info.chainEncoding != 1
        ) revert InvalidSourceChain();
    }

    function createCampaign(
        address recipient,
        uint256 minimumAmount,
        uint64 startBlock,
        uint64 endBlock,
        uint64 registrationDeadline,
        uint64 withdrawalDeadline
    ) external payable whenNotPaused returns (uint256 campaignId) {
        campaignId = _createTransferCampaign(
            recipient,
            minimumAmount,
            0,
            startBlock,
            endBlock,
            registrationDeadline,
            withdrawalDeadline,
            PayoutPolicy.EqualProRata
        );
    }

    function createWeightedTransferCampaign(
        address recipient,
        uint256 minimumAmount,
        uint256 maximumWeight,
        uint64 startBlock,
        uint64 endBlock,
        uint64 registrationDeadline,
        uint64 withdrawalDeadline
    ) external payable whenNotPaused returns (uint256 campaignId) {
        if (maximumWeight < minimumAmount) revert InvalidCampaign();
        campaignId = _createTransferCampaign(
            recipient,
            minimumAmount,
            maximumWeight,
            startBlock,
            endBlock,
            registrationDeadline,
            withdrawalDeadline,
            PayoutPolicy.SourceAmountWeighted
        );
    }

    function createInteractionCampaign(
        address target,
        bytes4 selector,
        address requiredEventEmitter,
        bytes32 requiredEventSignature,
        uint8 claimantTopicIndex,
        uint64 startBlock,
        uint64 endBlock,
        uint64 registrationDeadline,
        uint64 withdrawalDeadline
    ) external payable whenNotPaused returns (uint256 campaignId) {
        if (
            target == address(0) || selector == bytes4(0)
                || ((requiredEventEmitter == address(0)) != (requiredEventSignature == bytes32(0)))
                || (requiredEventSignature == bytes32(0) && claimantTopicIndex != 0) || claimantTopicIndex > 3
        ) revert InvalidCampaign();
        _validateCampaign(msg.value, startBlock, endBlock, registrationDeadline, withdrawalDeadline);

        campaignId = ++campaignCount;
        campaigns[campaignId] = _campaignRecord(
            target,
            0,
            0,
            startBlock,
            endBlock,
            registrationDeadline,
            withdrawalDeadline,
            ClaimTemplate.ContractInteraction,
            PayoutPolicy.EqualProRata
        );
        interactionRules[campaignId] = ContractInteractionPredicateV1.Rule({
            target: target,
            selector: selector,
            requiredEventEmitter: requiredEventEmitter,
            requiredEventSignature: requiredEventSignature,
            claimantTopicIndex: claimantTopicIndex,
            startBlock: startBlock,
            endBlock: endBlock
        });

        bytes32 ruleHash = keccak256(
            abi.encode(
                ETHEREUM_MAINNET_CHAIN_KEY,
                ClaimTemplate.ContractInteraction,
                target,
                selector,
                requiredEventEmitter,
                requiredEventSignature,
                claimantTopicIndex,
                startBlock,
                endBlock
            )
        );
        _emitCampaign(campaignId, target, 0, startBlock, endBlock, registrationDeadline, withdrawalDeadline, ruleHash);
        emit CampaignConfigured(campaignId, ClaimTemplate.ContractInteraction, PayoutPolicy.EqualProRata, 0);
    }

    function registerClaim(uint256 campaignId, AttestcoinClaimVerifier.Proof calldata proof) external {
        Campaign storage campaign = _campaign(campaignId);
        _validateRegistration(campaign);
        if (campaign.claimTemplate != ClaimTemplate.DirectUsdcTransfer) revert InvalidClaimTemplate();

        USDCTransferPredicateV1.Rule memory rule = USDCTransferPredicateV1.Rule({
            recipient: campaign.recipient,
            minimumAmount: campaign.minimumAmount,
            startBlock: campaign.startBlock,
            endBlock: campaign.endBlock
        });
        (address claimant, bytes32 queryId, uint256 amount) = claimVerifier.verifyClaim(proof, rule);
        uint256 weight = campaign.payoutPolicy == PayoutPolicy.EqualProRata ? 1 : _min(amount, campaign.maximumWeight);
        _register(campaignId, campaign, claimant, queryId, weight, proof.sourceBlock, amount);
    }

    function registerInteractionClaim(uint256 campaignId, AttestcoinClaimVerifier.Proof calldata proof) external {
        Campaign storage campaign = _campaign(campaignId);
        _validateRegistration(campaign);
        if (campaign.claimTemplate != ClaimTemplate.ContractInteraction) revert InvalidClaimTemplate();
        if (campaign.payoutPolicy != PayoutPolicy.EqualProRata) revert InvalidPayoutPolicy();

        (address claimant, bytes32 queryId) = claimVerifier.verifyInteractionClaim(proof, interactionRules[campaignId]);
        _register(campaignId, campaign, claimant, queryId, 1, proof.sourceBlock, 0);
    }

    function finalize(uint256 campaignId) external {
        Campaign storage campaign = _campaign(campaignId);
        if (block.timestamp <= campaign.registrationDeadline) revert RegistrationOpen();
        if (campaign.finalized) revert AlreadyFinalized();
        campaign.finalized = true;
        if (campaign.totalWeight != 0) campaign.sharePerClaim = campaign.fundedPool / campaign.totalWeight;
        emit CampaignFinalized(campaignId, campaign.claimantCount, campaign.sharePerClaim);
    }

    function withdraw(uint256 campaignId) external nonReentrant {
        Campaign storage campaign = _campaign(campaignId);
        if (!campaign.finalized) revert CampaignNotFinalized();
        if (block.timestamp > campaign.withdrawalDeadline) revert WithdrawalClosed();
        if (!registered[campaignId][msg.sender]) revert NotRegistered();
        if (withdrawn[campaignId][msg.sender]) revert AlreadyWithdrawn();

        withdrawn[campaignId][msg.sender] = true;
        ++campaign.withdrawnCount;
        uint256 amount = claimWeights[campaignId][msg.sender] * campaign.sharePerClaim;
        campaign.totalPaid += amount;
        _send(msg.sender, amount);
        emit RewardWithdrawn(campaignId, msg.sender, amount);
    }

    function recoverRemainder(uint256 campaignId) external nonReentrant {
        Campaign storage campaign = _campaign(campaignId);
        if (!campaign.finalized) revert CampaignNotFinalized();
        if (block.timestamp <= campaign.withdrawalDeadline) revert WithdrawalOpen();

        uint256 remainder = campaign.fundedPool - campaign.totalPaid;
        campaign.fundedPool = campaign.totalPaid;
        _send(campaign.sponsor, remainder);
        emit RemainderRecovered(campaignId, campaign.sponsor, remainder);
    }

    function pauseNewCampaigns() external onlyOwner {
        _pause();
    }

    function unpauseNewCampaigns() external onlyOwner {
        _unpause();
    }

    function getCampaign(uint256 campaignId) external view returns (Campaign memory) {
        return _campaign(campaignId);
    }

    function getInteractionRule(uint256 campaignId) external view returns (ContractInteractionPredicateV1.Rule memory) {
        Campaign storage campaign = _campaign(campaignId);
        if (campaign.claimTemplate != ClaimTemplate.ContractInteraction) revert InvalidClaimTemplate();
        return interactionRules[campaignId];
    }

    function _createTransferCampaign(
        address recipient,
        uint256 minimumAmount,
        uint256 maximumWeight,
        uint64 startBlock,
        uint64 endBlock,
        uint64 registrationDeadline,
        uint64 withdrawalDeadline,
        PayoutPolicy payoutPolicy
    ) private returns (uint256 campaignId) {
        if (recipient == address(0) || minimumAmount == 0) revert InvalidCampaign();
        _validateCampaign(msg.value, startBlock, endBlock, registrationDeadline, withdrawalDeadline);

        campaignId = ++campaignCount;
        campaigns[campaignId] = _campaignRecord(
            recipient,
            minimumAmount,
            maximumWeight,
            startBlock,
            endBlock,
            registrationDeadline,
            withdrawalDeadline,
            ClaimTemplate.DirectUsdcTransfer,
            payoutPolicy
        );
        bytes32 ruleHash = keccak256(
            abi.encode(
                ETHEREUM_MAINNET_CHAIN_KEY,
                ClaimTemplate.DirectUsdcTransfer,
                payoutPolicy,
                recipient,
                minimumAmount,
                maximumWeight,
                startBlock,
                endBlock
            )
        );
        _emitCampaign(
            campaignId,
            recipient,
            minimumAmount,
            startBlock,
            endBlock,
            registrationDeadline,
            withdrawalDeadline,
            ruleHash
        );
        emit CampaignConfigured(campaignId, ClaimTemplate.DirectUsdcTransfer, payoutPolicy, maximumWeight);
    }

    function _campaignRecord(
        address recipient,
        uint256 minimumAmount,
        uint256 maximumWeight,
        uint64 startBlock,
        uint64 endBlock,
        uint64 registrationDeadline,
        uint64 withdrawalDeadline,
        ClaimTemplate claimTemplate,
        PayoutPolicy payoutPolicy
    ) private view returns (Campaign memory) {
        return Campaign({
            sponsor: msg.sender,
            recipient: recipient,
            minimumAmount: minimumAmount,
            maximumWeight: maximumWeight,
            startBlock: startBlock,
            endBlock: endBlock,
            registrationDeadline: registrationDeadline,
            withdrawalDeadline: withdrawalDeadline,
            fundedPool: msg.value,
            claimantCount: 0,
            totalWeight: 0,
            sharePerClaim: 0,
            totalPaid: 0,
            withdrawnCount: 0,
            claimTemplate: claimTemplate,
            payoutPolicy: payoutPolicy,
            finalized: false
        });
    }

    function _validateCampaign(
        uint256 fundedPool,
        uint64 startBlock,
        uint64 endBlock,
        uint64 registrationDeadline,
        uint64 withdrawalDeadline
    ) private view {
        if (
            startBlock > endBlock || fundedPool == 0 || registrationDeadline <= block.timestamp
                || withdrawalDeadline <= registrationDeadline
        ) revert InvalidCampaign();
        IChainInfo.HeightHashResult memory latest =
            chainInfo.get_latest_attestation_height_and_hash(ETHEREUM_MAINNET_CHAIN_KEY);
        if (!latest.exists || endBlock > latest.height) revert SourceSnapshotNotAttested();
    }

    function _validateRegistration(Campaign storage campaign) private view {
        if (msg.sender.code.length != 0) revert ContractClaimantUnsupported();
        if (block.timestamp > campaign.registrationDeadline) revert RegistrationClosed();
        if (campaign.finalized) revert AlreadyFinalized();
    }

    function _register(
        uint256 campaignId,
        Campaign storage campaign,
        address claimant,
        bytes32 queryId,
        uint256 weight,
        uint64 sourceBlock,
        uint256 sourceAmount
    ) private {
        if (claimant != msg.sender) revert ClaimantMismatch();
        if (registered[campaignId][claimant]) revert AlreadyRegistered();
        if (consumedQueries[campaignId][queryId]) revert Replay();
        if (weight == 0) revert InvalidPayoutPolicy();

        registered[campaignId][claimant] = true;
        consumedQueries[campaignId][queryId] = true;
        claimWeights[campaignId][claimant] = weight;
        ++campaign.claimantCount;
        campaign.totalWeight += weight;
        emit ClaimRegistered(campaignId, claimant, queryId, sourceBlock, sourceAmount);
    }

    function _emitCampaign(
        uint256 campaignId,
        address recipient,
        uint256 minimumAmount,
        uint64 startBlock,
        uint64 endBlock,
        uint64 registrationDeadline,
        uint64 withdrawalDeadline,
        bytes32 ruleHash
    ) private {
        emit CampaignCreated(
            campaignId,
            msg.sender,
            recipient,
            msg.value,
            minimumAmount,
            startBlock,
            endBlock,
            registrationDeadline,
            withdrawalDeadline,
            ruleHash
        );
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _campaign(uint256 campaignId) private view returns (Campaign storage campaign) {
        campaign = campaigns[campaignId];
        if (campaign.sponsor == address(0)) revert CampaignNotFound();
    }

    function _send(address recipient, uint256 amount) private {
        (bool success,) = payable(recipient).call{value: amount}("");
        if (!success) revert TransferFailed();
    }
}
