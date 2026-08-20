// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {AttestcoinRetryVerifier} from "../src/AttestcoinRetryVerifier.sol";
import {RetryCoverPool} from "../src/RetryCoverPool.sol";
import {RetryCoverPredicateV1} from "../src/RetryCoverPredicateV1.sol";
import {INativeQueryVerifier} from "../src/interfaces/INativeQueryVerifier.sol";
import {MockChainInfo} from "./mocks/MockChainInfo.sol";
import {MockNativeQueryVerifier} from "./mocks/MockNativeQueryVerifier.sol";

contract RetryCoverTest is Test {
    address private constant SPONSOR = address(0xA11CE);
    address private constant BENEFICIARY = address(0xB0B);
    address private constant PROVER = address(0xC0DE);
    address private constant TARGET = address(0xD00D);
    address private constant OTHER_TARGET = address(0xBAD);
    bytes4 private constant ACTION_SELECTOR = bytes4(keccak256("perform(bytes32,uint256)"));
    bytes32 private constant SUCCESS_EVENT = keccak256("ActionSucceeded(bytes32,address,uint256)");
    bytes32 private constant CREATION_BLOCK_HASH = keccak256("retry-cover-creation-block");

    uint64 private constant START_BLOCK = 25_900_000;
    uint64 private constant END_BLOCK = START_BLOCK + 100;
    uint64 private constant FAILURE_BLOCK = START_BLOCK + 10;
    uint64 private constant SUCCESS_BLOCK = FAILURE_BLOCK + 1;
    uint64 private constant FAILURE_NONCE = 41;
    uint64 private constant FAILURE_GAS_USED = 55_000;
    uint64 private constant MAX_FAILURE_GAS_USED = 60_000;
    uint256 private constant RECOVERY_CREDIT = 0.25 ether;

    RetryCoverPredicateV1 private predicate;
    MockNativeQueryVerifier private nativeVerifier;
    AttestcoinRetryVerifier private retryVerifier;
    MockChainInfo private chainInfo;
    RetryCoverPool private pool;

    function setUp() external {
        predicate = new RetryCoverPredicateV1();
        nativeVerifier = new MockNativeQueryVerifier();
        retryVerifier = new AttestcoinRetryVerifier(predicate, address(nativeVerifier), 3, 1);
        chainInfo = new MockChainInfo(START_BLOCK - 1);
        pool = new RetryCoverPool(retryVerifier, address(chainInfo));
        vm.deal(SPONSOR, 10 ether);
        vm.deal(BENEFICIARY, 1 ether);
        vm.deal(PROVER, 1 ether);
    }

    function testPaysFixedRecoveryCreditAfterAttestcoinBatchVerifiesExactRetry() external {
        (uint256 policyNumber, bytes32 policyId) = _createAndActivatePolicy();
        AttestcoinRetryVerifier.BatchProof memory proof = _validProof(policyId);

        uint256 beneficiaryBefore = BENEFICIARY.balance;
        vm.prank(PROVER);
        pool.claim(policyNumber, proof);

        assertEq(BENEFICIARY.balance - beneficiaryBefore, RECOVERY_CREDIT);
        assertEq(address(pool).balance, 0);
        assertEq(nativeVerifier.batchCallCount(), 1);
        assertEq(nativeVerifier.lastBatchSize(), 2);
        RetryCoverPool.Policy memory policy = pool.getPolicy(policyNumber);
        assertTrue(policy.paid);
        assertFalse(policy.refunded);

        bytes32 failureQueryId = keccak256(abi.encode(uint64(3), FAILURE_BLOCK, uint64(5)));
        bytes32 successQueryId = keccak256(abi.encode(uint64(3), SUCCESS_BLOCK, uint64(6)));
        assertTrue(pool.consumedQueries(failureQueryId));
        assertTrue(pool.consumedQueries(successQueryId));
        assertTrue(pool.consumedPairs(keccak256(abi.encode(failureQueryId, successQueryId))));
    }

    function testPolicyChallengeComesFromLaterKnownCreationBlockHash() external {
        RetryCoverPredicateV1.Rule memory terms = _terms();
        vm.prank(SPONSOR);
        uint256 policyNumber = pool.createPolicy{value: RECOVERY_CREDIT}(terms, uint64(block.timestamp + 7 days));
        RetryCoverPool.Policy memory draft = pool.getPolicy(policyNumber);

        vm.expectRevert(RetryCoverPool.ActivationNotReady.selector);
        pool.activatePolicy(policyNumber);

        vm.roll(draft.creationBlock + 1);
        vm.setBlockhash(draft.creationBlock, CREATION_BLOCK_HASH);
        bytes32 policyId = pool.activatePolicy(policyNumber);
        RetryCoverPredicateV1.Rule memory activeRule = pool.getRule(policyNumber);

        bytes32 expected = keccak256(
            abi.encode(
                "RETRYCOVER_POLICY_V1",
                block.chainid,
                address(pool),
                policyNumber,
                SPONSOR,
                RECOVERY_CREDIT,
                draft.refundAfter,
                draft.termsHash,
                CREATION_BLOCK_HASH
            )
        );
        assertEq(policyId, expected);
        assertEq(activeRule.policyId, expected);
    }

    function testDifferentPolicyNumbersCannotReusePredictedChallenge() external {
        RetryCoverPredicateV1.Rule memory terms = _terms();
        vm.startPrank(SPONSOR);
        uint256 first = pool.createPolicy{value: RECOVERY_CREDIT}(terms, uint64(block.timestamp + 7 days));
        uint256 second = pool.createPolicy{value: RECOVERY_CREDIT}(terms, uint64(block.timestamp + 7 days));
        vm.stopPrank();

        uint256 creationBlock = pool.getPolicy(first).creationBlock;
        vm.roll(creationBlock + 1);
        vm.setBlockhash(creationBlock, CREATION_BLOCK_HASH);
        bytes32 firstId = pool.activatePolicy(first);
        bytes32 secondId = pool.activatePolicy(second);
        assertNotEq(firstId, secondId);
    }

    function testRejectsBatchThatNativeAttestcoinVerifierRejects() external {
        (uint256 policyNumber, bytes32 policyId) = _createAndActivatePolicy();
        AttestcoinRetryVerifier.BatchProof memory proof = _validProof(policyId);
        nativeVerifier.setVerificationResult(false);
        vm.expectRevert(AttestcoinRetryVerifier.ProofVerificationFailed.selector);
        pool.claim(policyNumber, proof);
    }

    function testRejectsAnyBatchShapeOtherThanFailureAndSuccessPair() external {
        (uint256 policyNumber, bytes32 policyId) = _createAndActivatePolicy();
        AttestcoinRetryVerifier.BatchProof memory proof = _validProof(policyId);
        proof.sourceBlocks = new uint64[](1);
        proof.sourceBlocks[0] = FAILURE_BLOCK;

        vm.expectRevert(AttestcoinRetryVerifier.InvalidBatch.selector);
        pool.claim(policyNumber, proof);
    }

    function testRejectsWrongParticipantTargetAndCallValue() external {
        (uint256 policyNumber, bytes32 policyId) = _createAndActivatePolicy();
        bytes memory data = _actionData(policyId, 42);

        AttestcoinRetryVerifier.BatchProof memory wrongParticipant = _validProof(policyId);
        wrongParticipant.encodedTransactions[1] =
            _encodedAction(address(0xBAD1), TARGET, 0, data, FAILURE_NONCE + 1, 1, 70_000, true, policyId, BENEFICIARY);
        vm.expectRevert(RetryCoverPredicateV1.InvalidParticipant.selector);
        pool.claim(policyNumber, wrongParticipant);

        AttestcoinRetryVerifier.BatchProof memory wrongTarget = _validProof(policyId);
        wrongTarget.encodedTransactions[1] = _encodedAction(
            BENEFICIARY, OTHER_TARGET, 0, data, FAILURE_NONCE + 1, 1, 70_000, true, policyId, BENEFICIARY
        );
        vm.expectRevert(RetryCoverPredicateV1.InvalidTarget.selector);
        pool.claim(policyNumber, wrongTarget);

        AttestcoinRetryVerifier.BatchProof memory wrongValue = _validProof(policyId);
        wrongValue.encodedTransactions[1] =
            _encodedAction(BENEFICIARY, TARGET, 1, data, FAILURE_NONCE + 1, 1, 70_000, true, policyId, BENEFICIARY);
        vm.expectRevert(RetryCoverPredicateV1.InvalidTarget.selector);
        pool.claim(policyNumber, wrongValue);
    }

    function testRejectsChangedRetryCalldataEvenWithSameSelectorAndPolicyId() external {
        (uint256 policyNumber, bytes32 policyId) = _createAndActivatePolicy();
        AttestcoinRetryVerifier.BatchProof memory proof = _validProof(policyId);
        proof.encodedTransactions[1] = _encodedAction(
            BENEFICIARY, TARGET, 0, _actionData(policyId, 43), FAILURE_NONCE + 1, 1, 70_000, true, policyId, BENEFICIARY
        );

        vm.expectRevert(RetryCoverPredicateV1.InvalidCalldata.selector);
        pool.claim(policyNumber, proof);
    }

    function testRejectsForeignPolicyIdAndWrongSelector() external {
        (uint256 policyNumber, bytes32 policyId) = _createAndActivatePolicy();
        bytes32 foreignId = keccak256("foreign-policy");
        AttestcoinRetryVerifier.BatchProof memory wrongId = _validProof(policyId);
        bytes memory foreignData = _actionData(foreignId, 42);
        wrongId.encodedTransactions[0] = _encodedAction(
            BENEFICIARY, TARGET, 0, foreignData, FAILURE_NONCE, 0, FAILURE_GAS_USED, false, foreignId, BENEFICIARY
        );
        wrongId.encodedTransactions[1] = _encodedAction(
            BENEFICIARY, TARGET, 0, foreignData, FAILURE_NONCE + 1, 1, 70_000, true, foreignId, BENEFICIARY
        );
        vm.expectRevert(RetryCoverPredicateV1.InvalidCalldata.selector);
        pool.claim(policyNumber, wrongId);

        AttestcoinRetryVerifier.BatchProof memory wrongSelector = _validProof(policyId);
        bytes memory selectorData = abi.encodeWithSelector(bytes4(keccak256("other(bytes32,uint256)")), policyId, 42);
        wrongSelector.encodedTransactions[0] = _encodedAction(
            BENEFICIARY, TARGET, 0, selectorData, FAILURE_NONCE, 0, FAILURE_GAS_USED, false, policyId, BENEFICIARY
        );
        wrongSelector.encodedTransactions[1] = _encodedAction(
            BENEFICIARY, TARGET, 0, selectorData, FAILURE_NONCE + 1, 1, 70_000, true, policyId, BENEFICIARY
        );
        vm.expectRevert(RetryCoverPredicateV1.InvalidCalldata.selector);
        pool.claim(policyNumber, wrongSelector);
    }

    function testRejectsNonConsecutiveNonceAndWrongReceiptSequence() external {
        (uint256 policyNumber, bytes32 policyId) = _createAndActivatePolicy();
        bytes memory data = _actionData(policyId, 42);
        AttestcoinRetryVerifier.BatchProof memory nonceGap = _validProof(policyId);
        nonceGap.encodedTransactions[1] =
            _encodedAction(BENEFICIARY, TARGET, 0, data, FAILURE_NONCE + 2, 1, 70_000, true, policyId, BENEFICIARY);
        vm.expectRevert(RetryCoverPredicateV1.InvalidNonce.selector);
        pool.claim(policyNumber, nonceGap);

        AttestcoinRetryVerifier.BatchProof memory firstSucceeded = _validProof(policyId);
        firstSucceeded.encodedTransactions[0] = _encodedAction(
            BENEFICIARY, TARGET, 0, data, FAILURE_NONCE, 1, FAILURE_GAS_USED, false, policyId, BENEFICIARY
        );
        vm.expectRevert(RetryCoverPredicateV1.InvalidReceiptSequence.selector);
        pool.claim(policyNumber, firstSucceeded);

        AttestcoinRetryVerifier.BatchProof memory retryFailed = _validProof(policyId);
        retryFailed.encodedTransactions[1] =
            _encodedAction(BENEFICIARY, TARGET, 0, data, FAILURE_NONCE + 1, 0, 70_000, false, policyId, BENEFICIARY);
        vm.expectRevert(RetryCoverPredicateV1.InvalidReceiptSequence.selector);
        pool.claim(policyNumber, retryFailed);
    }

    function testRejectsSameBlockReverseBlockAndExcessiveGap() external {
        (uint256 policyNumber, bytes32 policyId) = _createAndActivatePolicy();
        AttestcoinRetryVerifier.BatchProof memory sameBlock = _validProof(policyId);
        sameBlock.sourceBlocks[1] = sameBlock.sourceBlocks[0];
        vm.expectRevert(AttestcoinRetryVerifier.InvalidProofOrder.selector);
        pool.claim(policyNumber, sameBlock);

        AttestcoinRetryVerifier.BatchProof memory reverse = _validProof(policyId);
        reverse.sourceBlocks[1] = reverse.sourceBlocks[0] - 1;
        vm.expectRevert(AttestcoinRetryVerifier.InvalidProofOrder.selector);
        pool.claim(policyNumber, reverse);

        AttestcoinRetryVerifier.BatchProof memory wide = _validProof(policyId);
        wide.sourceBlocks[1] = FAILURE_BLOCK + 11;
        vm.expectRevert(RetryCoverPredicateV1.InvalidBlockGap.selector);
        pool.claim(policyNumber, wide);
    }

    function testRejectsSourceOutsideWindowAndFailureAboveGasCeiling() external {
        (uint256 policyNumber, bytes32 policyId) = _createAndActivatePolicy();
        AttestcoinRetryVerifier.BatchProof memory beforeWindow = _validProof(policyId);
        beforeWindow.sourceBlocks[0] = START_BLOCK - 1;
        vm.expectRevert(RetryCoverPredicateV1.InvalidSourceBlock.selector);
        pool.claim(policyNumber, beforeWindow);

        AttestcoinRetryVerifier.BatchProof memory excessGas = _validProof(policyId);
        excessGas.encodedTransactions[0] = _encodedAction(
            BENEFICIARY,
            TARGET,
            0,
            _actionData(policyId, 42),
            FAILURE_NONCE,
            0,
            MAX_FAILURE_GAS_USED + 1,
            false,
            policyId,
            BENEFICIARY
        );
        vm.expectRevert(RetryCoverPredicateV1.FailureGasExceeded.selector);
        pool.claim(policyNumber, excessGas);
    }

    function testRejectsMissingOrMisboundSuccessEvent() external {
        (uint256 policyNumber, bytes32 policyId) = _createAndActivatePolicy();
        bytes memory data = _actionData(policyId, 42);
        AttestcoinRetryVerifier.BatchProof memory missing = _validProof(policyId);
        missing.encodedTransactions[1] =
            _encodedAction(BENEFICIARY, TARGET, 0, data, FAILURE_NONCE + 1, 1, 70_000, false, policyId, BENEFICIARY);
        vm.expectRevert(RetryCoverPredicateV1.RequiredSuccessEventMissing.selector);
        pool.claim(policyNumber, missing);

        AttestcoinRetryVerifier.BatchProof memory wrongPolicy = _validProof(policyId);
        wrongPolicy.encodedTransactions[1] = _encodedAction(
            BENEFICIARY,
            TARGET,
            0,
            data,
            FAILURE_NONCE + 1,
            1,
            70_000,
            true,
            keccak256("wrong-event-policy"),
            BENEFICIARY
        );
        vm.expectRevert(RetryCoverPredicateV1.RequiredSuccessEventMissing.selector);
        pool.claim(policyNumber, wrongPolicy);

        AttestcoinRetryVerifier.BatchProof memory wrongBeneficiary = _validProof(policyId);
        wrongBeneficiary.encodedTransactions[1] =
            _encodedAction(BENEFICIARY, TARGET, 0, data, FAILURE_NONCE + 1, 1, 70_000, true, policyId, address(0xBAD2));
        vm.expectRevert(RetryCoverPredicateV1.RequiredSuccessEventMissing.selector);
        pool.claim(policyNumber, wrongBeneficiary);
    }

    function testCannotClaimPolicyTwice() external {
        (uint256 policyNumber, bytes32 policyId) = _createAndActivatePolicy();
        AttestcoinRetryVerifier.BatchProof memory proof = _validProof(policyId);
        pool.claim(policyNumber, proof);

        vm.expectRevert(RetryCoverPool.AlreadyResolved.selector);
        pool.claim(policyNumber, proof);
    }

    function testCannotClaimBeforeActivationOrAfterClaimDeadline() external {
        RetryCoverPredicateV1.Rule memory terms = _terms();
        vm.prank(SPONSOR);
        uint256 policyNumber = pool.createPolicy{value: RECOVERY_CREDIT}(terms, uint64(block.timestamp + 7 days));
        vm.expectRevert(RetryCoverPool.NotActivated.selector);
        pool.claim(policyNumber, _emptyProof());

        bytes32 policyId = _activate(policyNumber);
        RetryCoverPool.Policy memory policy = pool.getPolicy(policyNumber);
        AttestcoinRetryVerifier.BatchProof memory proof = _validProof(policyId);
        vm.warp(uint256(policy.refundAfter) + 1);
        vm.expectRevert(RetryCoverPool.ClaimClosed.selector);
        pool.claim(policyNumber, proof);
    }

    function testRefundWaitsForDeadlineAndAttestedClosedSourceWindow() external {
        (uint256 policyNumber,) = _createAndActivatePolicy();
        vm.prank(SPONSOR);
        vm.expectRevert(RetryCoverPool.RefundClosed.selector);
        pool.refund(policyNumber);

        RetryCoverPool.Policy memory policy = pool.getPolicy(policyNumber);
        vm.warp(uint256(policy.refundAfter) + 1);
        vm.prank(SPONSOR);
        vm.expectRevert(RetryCoverPool.SourceWindowNotAttested.selector);
        pool.refund(policyNumber);

        chainInfo.setLatestAttestation(END_BLOCK, true, true);
        uint256 sponsorBefore = SPONSOR.balance;
        vm.prank(SPONSOR);
        pool.refund(policyNumber);
        assertEq(SPONSOR.balance - sponsorBefore, RECOVERY_CREDIT);
        assertTrue(pool.getPolicy(policyNumber).refunded);
    }

    function testExpiredInactiveDraftCanBeRefundedWithoutPretendingSourceWindowClosed() external {
        RetryCoverPredicateV1.Rule memory terms = _terms();
        vm.prank(SPONSOR);
        uint256 policyNumber = pool.createPolicy{value: RECOVERY_CREDIT}(terms, uint64(block.timestamp + 7 days));
        RetryCoverPool.Policy memory policy = pool.getPolicy(policyNumber);
        vm.roll(policy.creationBlock + pool.ACTIVATION_WINDOW_BLOCKS() + 1);

        uint256 sponsorBefore = SPONSOR.balance;
        vm.prank(SPONSOR);
        pool.refund(policyNumber);
        assertEq(SPONSOR.balance - sponsorBefore, RECOVERY_CREDIT);
        vm.expectRevert(RetryCoverPool.AlreadyResolved.selector);
        pool.activatePolicy(policyNumber);
    }

    function testOnlySponsorCanRefundAndPaidPolicyCannotRefund() external {
        (uint256 policyNumber, bytes32 policyId) = _createAndActivatePolicy();
        vm.prank(PROVER);
        vm.expectRevert(RetryCoverPool.NotSponsor.selector);
        pool.refund(policyNumber);

        pool.claim(policyNumber, _validProof(policyId));
        vm.prank(SPONSOR);
        vm.expectRevert(RetryCoverPool.AlreadyResolved.selector);
        pool.refund(policyNumber);
    }

    function testCreationRejectsUnfundedInvalidOrAlreadyOpenSourceWindow() external {
        RetryCoverPredicateV1.Rule memory terms = _terms();
        vm.prank(SPONSOR);
        vm.expectRevert(RetryCoverPool.InvalidPolicy.selector);
        pool.createPolicy(terms, uint64(block.timestamp + 7 days));

        terms.maxBlockGap = 1_001;
        vm.prank(SPONSOR);
        vm.expectRevert(RetryCoverPredicateV1.InvalidRule.selector);
        pool.createPolicy{value: RECOVERY_CREDIT}(terms, uint64(block.timestamp + 7 days));

        terms = _terms();
        chainInfo.setLatestAttestation(START_BLOCK, true, true);
        vm.prank(SPONSOR);
        vm.expectRevert(RetryCoverPool.SourceWindowNotAttested.selector);
        pool.createPolicy{value: RECOVERY_CREDIT}(terms, uint64(block.timestamp + 7 days));
    }

    function testCreationRejectsNonAttestationSnapshotAndWrongEthereumMapping() external {
        RetryCoverPredicateV1.Rule memory terms = _terms();
        chainInfo.setLatestAttestation(START_BLOCK - 1, false, true);
        vm.prank(SPONSOR);
        vm.expectRevert(RetryCoverPool.SourceWindowNotAttested.selector);
        pool.createPolicy{value: RECOVERY_CREDIT}(terms, uint64(block.timestamp + 7 days));

        MockChainInfo wrongChainInfo = new MockChainInfo(START_BLOCK - 1);
        wrongChainInfo.setSource(3, 11155111, 1, true);
        vm.expectRevert(RetryCoverPool.InvalidSourceChain.selector);
        new RetryCoverPool(retryVerifier, address(wrongChainInfo));
    }

    function testSourceChainConfigurationCanTargetEthereumSepoliaForTheSpike() external {
        MockChainInfo sepoliaChainInfo = new MockChainInfo(START_BLOCK - 1);
        sepoliaChainInfo.setSource(1, 11155111, 1, true);
        AttestcoinRetryVerifier sepoliaVerifier =
            new AttestcoinRetryVerifier(predicate, address(nativeVerifier), 1, 11155111);
        RetryCoverPool sepoliaPool = new RetryCoverPool(sepoliaVerifier, address(sepoliaChainInfo));

        assertEq(sepoliaPool.sourceChainKey(), 1);
        assertEq(sepoliaPool.sourceChainId(), 11155111);
    }

    function testActivationExpiresWhenCreationBlockHashIsNoLongerAvailable() external {
        RetryCoverPredicateV1.Rule memory terms = _terms();
        vm.prank(SPONSOR);
        uint256 policyNumber = pool.createPolicy{value: RECOVERY_CREDIT}(terms, uint64(block.timestamp + 7 days));
        RetryCoverPool.Policy memory policy = pool.getPolicy(policyNumber);
        vm.roll(policy.creationBlock + pool.ACTIVATION_WINDOW_BLOCKS() + 1);
        vm.expectRevert(RetryCoverPool.ActivationExpired.selector);
        pool.activatePolicy(policyNumber);
    }

    function _createAndActivatePolicy() private returns (uint256 policyNumber, bytes32 policyId) {
        RetryCoverPredicateV1.Rule memory terms = _terms();
        vm.prank(SPONSOR);
        policyNumber = pool.createPolicy{value: RECOVERY_CREDIT}(terms, uint64(block.timestamp + 7 days));
        policyId = _activate(policyNumber);
    }

    function _activate(uint256 policyNumber) private returns (bytes32 policyId) {
        RetryCoverPool.Policy memory policy = pool.getPolicy(policyNumber);
        vm.roll(policy.creationBlock + 1);
        vm.setBlockhash(policy.creationBlock, CREATION_BLOCK_HASH);
        policyId = pool.activatePolicy(policyNumber);
    }

    function _terms() private pure returns (RetryCoverPredicateV1.Rule memory terms) {
        terms = RetryCoverPredicateV1.Rule({
            beneficiary: BENEFICIARY,
            target: TARGET,
            selector: ACTION_SELECTOR,
            policyId: bytes32(0),
            callValue: 0,
            failureNonce: FAILURE_NONCE,
            startBlock: START_BLOCK,
            endBlock: END_BLOCK,
            maxBlockGap: 10,
            maxFailureGasUsed: MAX_FAILURE_GAS_USED,
            successEventEmitter: TARGET,
            successEventSignature: SUCCESS_EVENT,
            policyIdTopicIndex: 1,
            beneficiaryTopicIndex: 2
        });
    }

    function _validProof(bytes32 policyId) private returns (AttestcoinRetryVerifier.BatchProof memory proof) {
        bytes memory data = _actionData(policyId, 42);
        bytes memory failed = _encodedAction(
            BENEFICIARY, TARGET, 0, data, FAILURE_NONCE, 0, FAILURE_GAS_USED, false, policyId, BENEFICIARY
        );
        bytes memory succeeded =
            _encodedAction(BENEFICIARY, TARGET, 0, data, FAILURE_NONCE + 1, 1, 70_000, true, policyId, BENEFICIARY);
        proof = _proof(failed, FAILURE_BLOCK, succeeded, SUCCESS_BLOCK);
        nativeVerifier.setTransactionIndexForRoot(proof.merkleProofs[0].root, 5);
        nativeVerifier.setTransactionIndexForRoot(proof.merkleProofs[1].root, 6);
    }

    function _emptyProof() private pure returns (AttestcoinRetryVerifier.BatchProof memory proof) {
        proof.sourceBlocks = new uint64[](0);
        proof.encodedTransactions = new bytes[](0);
        proof.merkleProofs = new INativeQueryVerifier.MerkleProof[](0);
        proof.continuityRoots = new bytes32[](0);
    }

    function _proof(bytes memory failed, uint64 failureBlock, bytes memory succeeded, uint64 successBlock)
        private
        pure
        returns (AttestcoinRetryVerifier.BatchProof memory proof)
    {
        proof.sourceBlocks = new uint64[](2);
        proof.sourceBlocks[0] = failureBlock;
        proof.sourceBlocks[1] = successBlock;
        proof.encodedTransactions = new bytes[](2);
        proof.encodedTransactions[0] = failed;
        proof.encodedTransactions[1] = succeeded;
        proof.merkleProofs = new INativeQueryVerifier.MerkleProof[](2);
        proof.merkleProofs[0] = _merkleProof(keccak256(failed));
        proof.merkleProofs[1] = _merkleProof(keccak256(succeeded));
        proof.lowerEndpointDigest = bytes32(uint256(1));
        proof.continuityRoots = new bytes32[](0);
    }

    function _merkleProof(bytes32 root) private pure returns (INativeQueryVerifier.MerkleProof memory proof) {
        proof.root = root;
        proof.siblings = new INativeQueryVerifier.MerkleProofEntry[](0);
    }

    function _actionData(bytes32 policyId, uint256 amount) private pure returns (bytes memory) {
        return abi.encodeWithSelector(ACTION_SELECTOR, policyId, amount);
    }

    function _encodedAction(
        address sender,
        address target,
        uint256 callValue,
        bytes memory data,
        uint64 nonce,
        uint8 receiptStatus,
        uint64 gasUsed,
        bool includeSuccessLog,
        bytes32 eventPolicyId,
        address eventBeneficiary
    ) private pure returns (bytes memory) {
        bytes memory common = abi.encode(nonce, uint64(150_000), sender, false, target, callValue, data);
        EvmV1Decoder.AccessListEntry[] memory accessList = new EvmV1Decoder.AccessListEntry[](0);
        bytes memory typeSpecific = abi.encode(
            uint64(1), uint128(1), uint128(2), accessList, uint8(0), bytes32(uint256(1)), bytes32(uint256(2))
        );

        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](includeSuccessLog ? 1 : 0);
        if (includeSuccessLog) {
            bytes32[] memory topics = new bytes32[](3);
            topics[0] = SUCCESS_EVENT;
            topics[1] = eventPolicyId;
            topics[2] = bytes32(uint256(uint160(eventBeneficiary)));
            logs[0] = EvmV1Decoder.LogEntryTuple({address_: TARGET, topics: topics, data: abi.encode(uint256(42))});
        }
        bytes memory receipt = abi.encode(receiptStatus, gasUsed, logs, new bytes(256));

        bytes[] memory chunks = new bytes[](3);
        chunks[0] = common;
        chunks[1] = typeSpecific;
        chunks[2] = receipt;
        return abi.encode(uint8(2), chunks);
    }
}
