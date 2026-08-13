// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AttestcoinClaimVerifier} from "./AttestcoinClaimVerifier.sol";
import {USDCTransferPredicateV1} from "./USDCTransferPredicateV1.sol";
import {IChainInfo} from "./interfaces/IChainInfo.sol";

contract RuleDropPool is Ownable, Pausable, ReentrancyGuard {
    uint64 public constant ETHEREUM_MAINNET_CHAIN_KEY = 3;
    address public constant CHAIN_INFO = 0x0000000000000000000000000000000000000fD3;

    struct Campaign {
        address sponsor;
        address recipient;
        uint256 minimumAmount;
        uint64 startBlock;
        uint64 endBlock;
        uint64 registrationDeadline;
        uint64 withdrawalDeadline;
        uint256 fundedPool;
        uint256 claimantCount;
        uint256 sharePerClaim;
        uint256 withdrawnCount;
        bool finalized;
    }

    AttestcoinClaimVerifier public immutable claimVerifier;
    IChainInfo public immutable chainInfo;
    uint256 public campaignCount;

    mapping(uint256 campaignId => Campaign) private campaigns;
    mapping(uint256 campaignId => mapping(address claimant => bool)) public registered;
    mapping(uint256 campaignId => mapping(address claimant => bool)) public withdrawn;
    mapping(uint256 campaignId => mapping(bytes32 queryId => bool)) public consumedQueries;

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
    event CampaignFinalized(uint256 indexed campaignId, uint256 claimantCount, uint256 sharePerClaim);
    event RewardWithdrawn(uint256 indexed campaignId, address indexed claimant, uint256 amount);
    event RemainderRecovered(uint256 indexed campaignId, address indexed sponsor, uint256 amount);

    error AlreadyFinalized();
    error AlreadyRegistered();
    error AlreadyWithdrawn();
    error CampaignNotFinalized();
    error CampaignNotFound();
    error ClaimantMismatch();
    error InvalidCampaign();
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
    }

    function createCampaign(
        address recipient,
        uint256 minimumAmount,
        uint64 startBlock,
        uint64 endBlock,
        uint64 registrationDeadline,
        uint64 withdrawalDeadline
    ) external payable whenNotPaused returns (uint256 campaignId) {
        if (
            recipient == address(0) || minimumAmount == 0 || startBlock > endBlock || msg.value == 0
                || registrationDeadline <= block.timestamp || withdrawalDeadline <= registrationDeadline
        ) revert InvalidCampaign();

        IChainInfo.HeightHashResult memory latest =
            chainInfo.get_latest_attestation_height_and_hash(ETHEREUM_MAINNET_CHAIN_KEY);
        if (!latest.exists || endBlock > latest.height) revert SourceSnapshotNotAttested();

        campaignId = ++campaignCount;
        campaigns[campaignId] = Campaign({
            sponsor: msg.sender,
            recipient: recipient,
            minimumAmount: minimumAmount,
            startBlock: startBlock,
            endBlock: endBlock,
            registrationDeadline: registrationDeadline,
            withdrawalDeadline: withdrawalDeadline,
            fundedPool: msg.value,
            claimantCount: 0,
            sharePerClaim: 0,
            withdrawnCount: 0,
            finalized: false
        });

        bytes32 ruleHash =
            keccak256(abi.encode(ETHEREUM_MAINNET_CHAIN_KEY, recipient, minimumAmount, startBlock, endBlock));
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

    function registerClaim(uint256 campaignId, AttestcoinClaimVerifier.Proof calldata proof) external {
        Campaign storage campaign = _campaign(campaignId);
        if (block.timestamp > campaign.registrationDeadline) revert RegistrationClosed();
        if (campaign.finalized) revert AlreadyFinalized();

        USDCTransferPredicateV1.Rule memory rule = USDCTransferPredicateV1.Rule({
            recipient: campaign.recipient,
            minimumAmount: campaign.minimumAmount,
            startBlock: campaign.startBlock,
            endBlock: campaign.endBlock
        });
        (address claimant, bytes32 queryId, uint256 amount) = claimVerifier.verifyClaim(proof, rule);
        if (claimant != msg.sender) revert ClaimantMismatch();
        if (registered[campaignId][claimant]) revert AlreadyRegistered();
        if (consumedQueries[campaignId][queryId]) revert Replay();

        registered[campaignId][claimant] = true;
        consumedQueries[campaignId][queryId] = true;
        ++campaign.claimantCount;
        emit ClaimRegistered(campaignId, claimant, queryId, proof.sourceBlock, amount);
    }

    function finalize(uint256 campaignId) external {
        Campaign storage campaign = _campaign(campaignId);
        if (block.timestamp <= campaign.registrationDeadline) revert RegistrationOpen();
        if (campaign.finalized) revert AlreadyFinalized();
        campaign.finalized = true;
        if (campaign.claimantCount != 0) campaign.sharePerClaim = campaign.fundedPool / campaign.claimantCount;
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
        _send(msg.sender, campaign.sharePerClaim);
        emit RewardWithdrawn(campaignId, msg.sender, campaign.sharePerClaim);
    }

    function recoverRemainder(uint256 campaignId) external nonReentrant {
        Campaign storage campaign = _campaign(campaignId);
        if (!campaign.finalized) revert CampaignNotFinalized();
        if (block.timestamp <= campaign.withdrawalDeadline) revert WithdrawalOpen();

        uint256 paid = campaign.withdrawnCount * campaign.sharePerClaim;
        uint256 remainder = campaign.fundedPool - paid;
        campaign.fundedPool = paid;
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

    function _campaign(uint256 campaignId) private view returns (Campaign storage campaign) {
        campaign = campaigns[campaignId];
        if (campaign.sponsor == address(0)) revert CampaignNotFound();
    }

    function _send(address recipient, uint256 amount) private {
        (bool success,) = payable(recipient).call{value: amount}("");
        if (!success) revert TransferFailed();
    }
}
