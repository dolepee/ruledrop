// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {AttestcoinClaimVerifier} from "../src/AttestcoinClaimVerifier.sol";
import {RuleDropPool} from "../src/RuleDropPool.sol";
import {USDCTransferPredicateV1} from "../src/USDCTransferPredicateV1.sol";
import {INativeQueryVerifier} from "../src/interfaces/INativeQueryVerifier.sol";
import {MockChainInfo} from "./mocks/MockChainInfo.sol";
import {MockNativeQueryVerifier} from "./mocks/MockNativeQueryVerifier.sol";

contract RuleDropTest is Test {
    address private constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address private constant SPONSOR = address(0xA11CE);
    address private constant RECIPIENT = address(0xBEEF);
    address private constant CLAIMANT_ONE = address(0xC101);
    address private constant CLAIMANT_TWO = address(0xC102);

    uint64 private constant START_BLOCK = 24_000_000;
    uint64 private constant END_BLOCK = 25_000_000;
    uint64 private constant SOURCE_BLOCK = 24_500_000;
    uint256 private constant MINIMUM_AMOUNT = 100e6;

    USDCTransferPredicateV1 private predicate;
    MockNativeQueryVerifier private nativeVerifier;
    AttestcoinClaimVerifier private claimVerifier;
    MockChainInfo private chainInfo;
    RuleDropPool private pool;

    function setUp() external {
        predicate = new USDCTransferPredicateV1();
        nativeVerifier = new MockNativeQueryVerifier();
        claimVerifier = new AttestcoinClaimVerifier(predicate, address(nativeVerifier));
        chainInfo = new MockChainInfo(25_747_630);
        pool = new RuleDropPool(claimVerifier, address(this), address(chainInfo));
        vm.deal(SPONSOR, 100 ether);
        vm.deal(CLAIMANT_ONE, 1 ether);
        vm.deal(CLAIMANT_TWO, 1 ether);
    }

    function testTwoClaimantsReceiveEqualProRataShares() external {
        uint256 campaignId = _createCampaign(10 ether);

        vm.prank(CLAIMANT_ONE);
        pool.registerClaim(campaignId, _proof(_encodedTransfer(CLAIMANT_ONE, RECIPIENT, 150e6, 1), SOURCE_BLOCK));

        nativeVerifier.setTransactionIndex(8);
        vm.prank(CLAIMANT_TWO);
        pool.registerClaim(campaignId, _proof(_encodedTransfer(CLAIMANT_TWO, RECIPIENT, 200e6, 1), SOURCE_BLOCK));

        vm.warp(block.timestamp + 4 days);
        pool.finalize(campaignId);

        uint256 oneBefore = CLAIMANT_ONE.balance;
        uint256 twoBefore = CLAIMANT_TWO.balance;
        vm.prank(CLAIMANT_ONE);
        pool.withdraw(campaignId);
        vm.prank(CLAIMANT_TWO);
        pool.withdraw(campaignId);

        assertEq(CLAIMANT_ONE.balance - oneBefore, 5 ether);
        assertEq(CLAIMANT_TWO.balance - twoBefore, 5 ether);
        RuleDropPool.Campaign memory campaign = pool.getCampaign(campaignId);
        assertEq(campaign.claimantCount, 2);
        assertEq(campaign.sharePerClaim, 5 ether);
        assertEq(campaign.withdrawnCount, 2);
    }

    function testWrongCreditcoinWalletCannotRegisterSourceWallet() external {
        uint256 campaignId = _createCampaign(1 ether);
        vm.prank(CLAIMANT_TWO);
        vm.expectRevert(RuleDropPool.ClaimantMismatch.selector);
        pool.registerClaim(campaignId, _proof(_encodedTransfer(CLAIMANT_ONE, RECIPIENT, 150e6, 1), SOURCE_BLOCK));
    }

    function testDuplicateWalletAndQueryAreRejected() external {
        uint256 campaignId = _createCampaign(1 ether);
        AttestcoinClaimVerifier.Proof memory proof =
            _proof(_encodedTransfer(CLAIMANT_ONE, RECIPIENT, 150e6, 1), SOURCE_BLOCK);

        vm.prank(CLAIMANT_ONE);
        pool.registerClaim(campaignId, proof);

        vm.prank(CLAIMANT_ONE);
        vm.expectRevert(RuleDropPool.AlreadyRegistered.selector);
        pool.registerClaim(campaignId, proof);

        AttestcoinClaimVerifier claimVerifierTwo = new AttestcoinClaimVerifier(predicate, address(nativeVerifier));
        RuleDropPool poolTwo = new RuleDropPool(claimVerifierTwo, address(this), address(chainInfo));
        vm.prank(SPONSOR);
        uint256 otherCampaign = poolTwo.createCampaign{value: 1 ether}(
            RECIPIENT,
            MINIMUM_AMOUNT,
            START_BLOCK,
            END_BLOCK,
            uint64(block.timestamp + 3 days),
            uint64(block.timestamp + 6 days)
        );
        vm.prank(CLAIMANT_ONE);
        poolTwo.registerClaim(otherCampaign, proof);
        assertTrue(poolTwo.registered(otherCampaign, CLAIMANT_ONE));
    }

    function testRejectedProofCannotRegister() external {
        uint256 campaignId = _createCampaign(1 ether);
        nativeVerifier.setVerificationResult(false);
        vm.prank(CLAIMANT_ONE);
        vm.expectRevert(AttestcoinClaimVerifier.ProofVerificationFailed.selector);
        pool.registerClaim(campaignId, _proof(_encodedTransfer(CLAIMANT_ONE, RECIPIENT, 150e6, 1), SOURCE_BLOCK));
    }

    function testRevertedReceiptCannotRegister() external {
        uint256 campaignId = _createCampaign(1 ether);
        vm.prank(CLAIMANT_ONE);
        vm.expectRevert(USDCTransferPredicateV1.InvalidReceipt.selector);
        pool.registerClaim(campaignId, _proof(_encodedTransfer(CLAIMANT_ONE, RECIPIENT, 150e6, 0), SOURCE_BLOCK));
    }

    function testWrongRecipientAndUnderpaymentCannotRegister() external {
        uint256 campaignId = _createCampaign(1 ether);

        vm.prank(CLAIMANT_ONE);
        vm.expectRevert(USDCTransferPredicateV1.TransferMismatch.selector);
        pool.registerClaim(campaignId, _proof(_encodedTransfer(CLAIMANT_ONE, address(0xBAD), 150e6, 1), SOURCE_BLOCK));

        vm.prank(CLAIMANT_ONE);
        vm.expectRevert(USDCTransferPredicateV1.TransferMismatch.selector);
        pool.registerClaim(campaignId, _proof(_encodedTransfer(CLAIMANT_ONE, RECIPIENT, 99e6, 1), SOURCE_BLOCK));
    }

    function testWrongEventEmitterCannotRegister() external {
        uint256 campaignId = _createCampaign(1 ether);
        bytes memory encoded = _encodedTransferWithEmitter(CLAIMANT_ONE, RECIPIENT, 150e6, 1, address(0xBAD));
        vm.prank(CLAIMANT_ONE);
        vm.expectRevert(USDCTransferPredicateV1.AmbiguousTransferEvent.selector);
        pool.registerClaim(campaignId, _proof(encoded, SOURCE_BLOCK));
    }

    function testUnattestedSnapshotCannotCreateCampaign() external {
        chainInfo.setLatest(END_BLOCK - 1, true);
        vm.prank(SPONSOR);
        vm.expectRevert(RuleDropPool.SourceSnapshotNotAttested.selector);
        pool.createCampaign{value: 1 ether}(
            RECIPIENT,
            MINIMUM_AMOUNT,
            START_BLOCK,
            END_BLOCK,
            uint64(block.timestamp + 3 days),
            uint64(block.timestamp + 6 days)
        );
    }

    function testPauseOnlyBlocksNewCampaigns() external {
        uint256 campaignId = _createCampaign(1 ether);
        pool.pauseNewCampaigns();

        vm.prank(SPONSOR);
        vm.expectRevert();
        pool.createCampaign{value: 1 ether}(
            RECIPIENT,
            MINIMUM_AMOUNT,
            START_BLOCK,
            END_BLOCK,
            uint64(block.timestamp + 3 days),
            uint64(block.timestamp + 6 days)
        );

        vm.prank(CLAIMANT_ONE);
        pool.registerClaim(campaignId, _proof(_encodedTransfer(CLAIMANT_ONE, RECIPIENT, 150e6, 1), SOURCE_BLOCK));
        assertTrue(pool.registered(campaignId, CLAIMANT_ONE));
    }

    function testSponsorRecoversOnlyUnclaimedAmountAfterDeadline() external {
        uint256 campaignId = _createCampaign(10 ether);
        vm.prank(CLAIMANT_ONE);
        pool.registerClaim(campaignId, _proof(_encodedTransfer(CLAIMANT_ONE, RECIPIENT, 150e6, 1), SOURCE_BLOCK));
        nativeVerifier.setTransactionIndex(8);
        vm.prank(CLAIMANT_TWO);
        pool.registerClaim(campaignId, _proof(_encodedTransfer(CLAIMANT_TWO, RECIPIENT, 150e6, 1), SOURCE_BLOCK));

        vm.warp(block.timestamp + 4 days);
        pool.finalize(campaignId);
        vm.prank(CLAIMANT_ONE);
        pool.withdraw(campaignId);
        uint256 sponsorBefore = SPONSOR.balance;

        vm.warp(block.timestamp + 4 days);
        pool.recoverRemainder(campaignId);
        assertEq(SPONSOR.balance - sponsorBefore, 5 ether);
    }

    function _createCampaign(uint256 amount) private returns (uint256 campaignId) {
        vm.prank(SPONSOR);
        campaignId = pool.createCampaign{value: amount}(
            RECIPIENT,
            MINIMUM_AMOUNT,
            START_BLOCK,
            END_BLOCK,
            uint64(block.timestamp + 3 days),
            uint64(block.timestamp + 7 days)
        );
    }

    function _proof(bytes memory encodedTransaction, uint64 sourceBlock)
        private
        pure
        returns (AttestcoinClaimVerifier.Proof memory proof)
    {
        INativeQueryVerifier.MerkleProofEntry[] memory siblings = new INativeQueryVerifier.MerkleProofEntry[](0);
        bytes32[] memory continuityRoots = new bytes32[](0);
        proof = AttestcoinClaimVerifier.Proof({
            sourceBlock: sourceBlock,
            encodedTransaction: encodedTransaction,
            merkleRoot: keccak256(encodedTransaction),
            siblings: siblings,
            lowerEndpointDigest: bytes32(uint256(1)),
            continuityRoots: continuityRoots
        });
    }

    function _encodedTransfer(address sender, address recipient, uint256 amount, uint8 receiptStatus)
        private
        pure
        returns (bytes memory)
    {
        return _encodedTransferWithEmitter(sender, recipient, amount, receiptStatus, USDC);
    }

    function _encodedTransferWithEmitter(
        address sender,
        address recipient,
        uint256 amount,
        uint8 receiptStatus,
        address emitter
    ) private pure returns (bytes memory) {
        bytes memory calldata_ = abi.encodeWithSelector(bytes4(0xa9059cbb), recipient, amount);
        bytes memory common = abi.encode(uint64(1), uint64(100_000), sender, false, USDC, uint256(0), calldata_);

        EvmV1Decoder.AccessListEntry[] memory accessList = new EvmV1Decoder.AccessListEntry[](0);
        bytes memory typeSpecific = abi.encode(
            uint64(1), uint128(1), uint128(2), accessList, uint8(0), bytes32(uint256(1)), bytes32(uint256(2))
        );

        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = keccak256("Transfer(address,address,uint256)");
        topics[1] = bytes32(uint256(uint160(sender)));
        topics[2] = bytes32(uint256(uint160(recipient)));
        logs[0] = EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: abi.encode(amount)});
        bytes memory receipt = abi.encode(receiptStatus, uint64(50_000), logs, new bytes(256));

        bytes[] memory chunks = new bytes[](3);
        chunks[0] = common;
        chunks[1] = typeSpecific;
        chunks[2] = receipt;
        return abi.encode(uint8(2), chunks);
    }
}
