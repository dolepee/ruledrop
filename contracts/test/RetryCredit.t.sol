// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {AttestcoinRetryCreditVerifier} from "../src/AttestcoinRetryCreditVerifier.sol";
import {RetryCreditCheckout} from "../src/RetryCreditCheckout.sol";
import {RetryCreditPool} from "../src/RetryCreditPool.sol";
import {RetryCreditPredicateV2} from "../src/RetryCreditPredicateV2.sol";
import {INativeQueryVerifier} from "../src/interfaces/INativeQueryVerifier.sol";
import {MockChainInfo} from "./mocks/MockChainInfo.sol";
import {MockNativeQueryVerifier} from "./mocks/MockNativeQueryVerifier.sol";

contract MockSettlementToken is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract FeeSettlementToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 1) {
            super._update(from, to, value - 1);
            super._update(from, address(0xFEE), 1);
        } else {
            super._update(from, to, value);
        }
    }
}

contract RetryCreditTest is Test {
    uint256 private constant SPONSOR_KEY = 0xA11CE;
    uint256 private constant ATTEMPT_SIGNER_KEY = 0xBEEF;
    uint256 private constant OUTSIDER_KEY = 0xBAD;

    address private constant BENEFICIARY = address(0xB0B);
    address private constant MERCHANT = address(0xCAFE);
    address private constant PROVER = address(0xC0DE);
    bytes32 private constant ACTION_ID = keccak256("sponsor-issued-action-7");
    bytes32 private constant SKU = keccak256("limited-edition-item");
    bytes32 private constant CREATION_BLOCK_HASH = keccak256("retry-credit-creation-block");

    uint64 private constant SOURCE_CHAIN_KEY = 3;
    uint64 private constant SOURCE_CHAIN_ID = 1;
    uint64 private constant START_BLOCK = 25_900_000;
    uint64 private constant END_BLOCK = START_BLOCK + 100;
    uint64 private constant FAILURE_BLOCK = START_BLOCK + 10;
    uint64 private constant SUCCESS_BLOCK = FAILURE_BLOCK + 2;
    uint64 private constant FAILURE_NONCE = 41;
    uint64 private constant SUCCESS_NONCE = FAILURE_NONCE + 3;
    uint64 private constant FAILURE_GAS_USED = 55_000;
    uint64 private constant MINIMUM_ATTEMPT_GAS_LIMIT = 150_000;
    uint64 private constant MAX_FAILURE_GAS_USED = 60_000;
    uint256 private constant MINIMUM_SETTLED_VALUE = 40e6;
    uint256 private constant SUCCESS_SETTLED_VALUE = 42e6;
    uint256 private constant CREDIT_AMOUNT = 0.25 ether;

    address private sponsor;
    address private attemptSigner;

    RetryCreditPredicateV2 private predicate;
    MockNativeQueryVerifier private nativeVerifier;
    AttestcoinRetryCreditVerifier private retryVerifier;
    MockChainInfo private chainInfo;
    RetryCreditPool private pool;
    MockSettlementToken private token;
    RetryCreditCheckout private checkout;

    function setUp() external {
        vm.chainId(SOURCE_CHAIN_ID);
        sponsor = vm.addr(SPONSOR_KEY);
        attemptSigner = vm.addr(ATTEMPT_SIGNER_KEY);

        predicate = new RetryCreditPredicateV2();
        nativeVerifier = new MockNativeQueryVerifier();
        retryVerifier =
            new AttestcoinRetryCreditVerifier(predicate, address(nativeVerifier), SOURCE_CHAIN_KEY, SOURCE_CHAIN_ID);
        chainInfo = new MockChainInfo(START_BLOCK - 1);
        pool = new RetryCreditPool(retryVerifier, address(chainInfo));
        token = new MockSettlementToken();
        checkout = new RetryCreditCheckout(attemptSigner, token);

        vm.deal(sponsor, 10 ether);
        vm.deal(BENEFICIARY, 1 ether);
        vm.deal(PROVER, 1 ether);
    }

    function testSourceCheckoutFailsStaleQuoteThenTransfersBoundAssetAndEmitsSettlement() external {
        (, bytes32 policyId) = _createAndActivateServiceCredit();
        token.mint(BENEFICIARY, 100e6);
        vm.prank(BENEFICIARY);
        token.approve(address(checkout), type(uint256).max);
        vm.prank(attemptSigner);
        checkout.setInventoryVersion(SKU, 2);

        (RetryCreditPredicateV2.Attempt memory failedAttempt, bytes memory failedPayload) = _failureAttempt(policyId);
        bytes memory failedSignature = _sign(ATTEMPT_SIGNER_KEY, failedAttempt);
        vm.expectRevert(RetryCreditCheckout.StaleQuote.selector);
        vm.prank(BENEFICIARY);
        checkout.checkout(failedAttempt, failedPayload, failedSignature);
        assertEq(token.balanceOf(MERCHANT), 0);

        (RetryCreditPredicateV2.Attempt memory successAttempt, bytes memory successPayload) = _successAttempt(policyId);
        bytes memory successSignature = _sign(ATTEMPT_SIGNER_KEY, successAttempt);
        vm.prank(BENEFICIARY);
        checkout.checkout(successAttempt, successPayload, successSignature);

        assertEq(token.balanceOf(MERCHANT), SUCCESS_SETTLED_VALUE);
        assertTrue(checkout.settledActions(ACTION_ID));
    }

    function testSourceCheckoutRejectsFeeOnTransferSettlement() external {
        FeeSettlementToken feeToken = new FeeSettlementToken();
        RetryCreditCheckout feeCheckout = new RetryCreditCheckout(attemptSigner, feeToken);
        feeToken.mint(BENEFICIARY, 100e6);
        vm.prank(BENEFICIARY);
        feeToken.approve(address(feeCheckout), type(uint256).max);
        vm.prank(attemptSigner);
        feeCheckout.setInventoryVersion(SKU, 2);

        bytes memory payload = abi.encode(MERCHANT, SKU, uint64(2));
        RetryCreditPredicateV2.Attempt memory attempt = RetryCreditPredicateV2.Attempt({
            sourceChainId: SOURCE_CHAIN_ID,
            target: address(feeCheckout),
            beneficiary: BENEFICIARY,
            settlementAsset: address(feeToken),
            settlementRecipient: MERCHANT,
            policyId: keccak256("active-policy"),
            actionId: keccak256("fee-token-action"),
            quoteVersion: 2,
            settledValue: SUCCESS_SETTLED_VALUE,
            payloadHash: keccak256(payload),
            validUntil: uint64(block.number + 1)
        });
        bytes memory signature = _sign(ATTEMPT_SIGNER_KEY, attempt);

        vm.expectRevert(RetryCreditCheckout.InexactSettlement.selector);
        vm.prank(BENEFICIARY);
        feeCheckout.checkout(attempt, payload, signature);
        assertEq(feeToken.balanceOf(MERCHANT), 0);
    }

    function testReleasesFixedCreditForSeparatelySignedChangedRetry() external {
        (uint256 creditNumber, bytes32 policyId) = _createAndActivateServiceCredit();
        AttestcoinRetryCreditVerifier.BatchProof memory proof = _validProof(policyId);

        EvmV1Decoder.CommonTxFields memory failed = EvmV1Decoder.decodeCommonTxFields(proof.encodedTransactions[0]);
        EvmV1Decoder.CommonTxFields memory succeeded = EvmV1Decoder.decodeCommonTxFields(proof.encodedTransactions[1]);
        assertNotEq(keccak256(failed.data), keccak256(succeeded.data));
        assertGt(succeeded.nonce, failed.nonce + 1);

        uint256 beneficiaryBefore = BENEFICIARY.balance;
        vm.prank(PROVER);
        pool.releaseCredit(creditNumber, proof);

        assertEq(BENEFICIARY.balance - beneficiaryBefore, CREDIT_AMOUNT);
        assertEq(address(pool).balance, 0);
        assertEq(nativeVerifier.batchCallCount(), 1);
        assertEq(nativeVerifier.lastBatchSize(), 2);

        RetryCreditPool.ServiceCredit memory credit = pool.getServiceCredit(creditNumber);
        assertTrue(credit.released);
        assertFalse(credit.refunded);

        bytes32 failureQueryId = keccak256(abi.encode(SOURCE_CHAIN_KEY, FAILURE_BLOCK, uint64(5)));
        bytes32 successQueryId = keccak256(abi.encode(SOURCE_CHAIN_KEY, SUCCESS_BLOCK, uint64(6)));
        bytes32 pairId = keccak256(abi.encode(policyId, ACTION_ID, failureQueryId, successQueryId));
        bytes32 actionKey =
            keccak256(abi.encode(SOURCE_CHAIN_KEY, SOURCE_CHAIN_ID, address(checkout), BENEFICIARY, ACTION_ID));
        assertTrue(pool.consumedQueries(failureQueryId));
        assertTrue(pool.consumedQueries(successQueryId));
        assertTrue(pool.consumedPairs(pairId));
        assertTrue(pool.consumedActions(actionKey));
    }

    function testCheckoutAbiDomainAndTypedDataAreExactAcrossSourceAndDestination() external view {
        assertEq(predicate.CHECKOUT_SELECTOR(), RetryCreditCheckout.checkout.selector);
        assertEq(
            predicate.CHECKOUT_SETTLED_EVENT(),
            keccak256("CheckoutSettled(bytes32,bytes32,address,address,address,uint256,bytes32,uint64)")
        );

        RetryCreditPredicateV2.Attempt memory attempt =
            _attempt(keccak256("policy"), 7, SUCCESS_SETTLED_VALUE, keccak256("payload"), SUCCESS_BLOCK + 1);
        bytes32 expectedDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("RetryCredit Checkout"),
                keccak256("1"),
                SOURCE_CHAIN_ID,
                address(checkout)
            )
        );
        bytes32 expectedStructHash = keccak256(
            abi.encode(
                keccak256(
                    "Attempt(uint256 sourceChainId,address target,address beneficiary,address settlementAsset,address settlementRecipient,bytes32 policyId,bytes32 actionId,uint64 quoteVersion,uint256 settledValue,bytes32 payloadHash,uint64 validUntil)"
                ),
                attempt.sourceChainId,
                attempt.target,
                attempt.beneficiary,
                attempt.settlementAsset,
                attempt.settlementRecipient,
                attempt.policyId,
                attempt.actionId,
                attempt.quoteVersion,
                attempt.settledValue,
                attempt.payloadHash,
                attempt.validUntil
            )
        );
        bytes32 expectedDigest = keccak256(abi.encodePacked("\x19\x01", expectedDomain, expectedStructHash));
        assertEq(predicate.domainSeparator(SOURCE_CHAIN_ID, address(checkout)), expectedDomain);
        assertEq(predicate.attemptDigest(attempt), expectedDigest);
        assertEq(checkout.attemptDigest(attempt), expectedDigest);
    }

    function testPolicyIdIsStableUnpredictableAndUniquePerDraft() external {
        RetryCreditPredicateV2.Rule memory terms = _terms();
        vm.startPrank(sponsor);
        uint256 first = pool.createServiceCredit{value: CREDIT_AMOUNT}(terms, uint64(block.timestamp + 7 days));
        uint256 second = pool.createServiceCredit{value: CREDIT_AMOUNT}(terms, uint64(block.timestamp + 7 days));
        vm.stopPrank();

        RetryCreditPool.ServiceCredit memory draft = pool.getServiceCredit(first);
        vm.expectRevert(RetryCreditPool.ActivationNotReady.selector);
        vm.prank(sponsor);
        pool.activateServiceCredit(first);

        vm.roll(draft.creationBlock + 1);
        vm.setBlockhash(draft.creationBlock, CREATION_BLOCK_HASH);
        vm.startPrank(sponsor);
        bytes32 firstId = pool.activateServiceCredit(first);
        bytes32 secondId = pool.activateServiceCredit(second);
        vm.stopPrank();
        assertNotEq(firstId, secondId);

        bytes32 expected = keccak256(
            abi.encode(
                "RETRYCREDIT_SERVICE_CREDIT_V2",
                block.chainid,
                address(pool),
                first,
                sponsor,
                CREDIT_AMOUNT,
                draft.refundAfter,
                draft.termsHash,
                CREATION_BLOCK_HASH
            )
        );
        assertEq(firstId, expected);
        assertEq(pool.getRule(first).policyId, expected);
    }

    function testRejectsInvalidAttemptSignatureAndAnySignedFieldMutation() external {
        (uint256 creditNumber, bytes32 policyId) = _createAndActivateServiceCredit();
        (RetryCreditPredicateV2.Attempt memory failedAttempt, bytes memory failedPayload) = _failureAttempt(policyId);
        (RetryCreditPredicateV2.Attempt memory successAttempt, bytes memory successPayload) = _successAttempt(policyId);

        bytes memory wrongSignerData = _checkoutData(failedAttempt, failedPayload, _sign(OUTSIDER_KEY, failedAttempt));
        AttestcoinRetryCreditVerifier.BatchProof memory wrongSigner = _proof(
            _encodedAttempt(wrongSignerData, FAILURE_NONCE, 0, FAILURE_GAS_USED, false, successAttempt),
            FAILURE_BLOCK,
            _encodedAttempt(
                _signedCheckoutData(successAttempt, successPayload), SUCCESS_NONCE, 1, 70_000, true, successAttempt
            ),
            SUCCESS_BLOCK
        );
        vm.expectRevert(RetryCreditPredicateV2.InvalidAttemptSignature.selector);
        pool.releaseCredit(creditNumber, wrongSigner);

        bytes memory originalSignature = _sign(ATTEMPT_SIGNER_KEY, successAttempt);
        successAttempt.settledValue += 1;
        bytes memory tamperedData = _checkoutData(successAttempt, successPayload, originalSignature);
        AttestcoinRetryCreditVerifier.BatchProof memory tampered = _proof(
            _encodedAttempt(
                _signedCheckoutData(failedAttempt, failedPayload),
                FAILURE_NONCE,
                0,
                FAILURE_GAS_USED,
                false,
                successAttempt
            ),
            FAILURE_BLOCK,
            _encodedAttempt(tamperedData, SUCCESS_NONCE, 1, 70_000, true, successAttempt),
            SUCCESS_BLOCK
        );
        vm.expectRevert(RetryCreditPredicateV2.InvalidAttemptSignature.selector);
        pool.releaseCredit(creditNumber, tampered);
    }

    function testRejectsWrongPolicyActionChainAssetTargetAndParticipant() external {
        (uint256 creditNumber, bytes32 policyId) = _createAndActivateServiceCredit();
        (RetryCreditPredicateV2.Attempt memory failedAttempt, bytes memory failedPayload) = _failureAttempt(policyId);
        AttestcoinRetryCreditVerifier.BatchProof memory proof;

        failedAttempt.actionId = keccak256("foreign-action");
        proof = _proofWithFailedAttempt(policyId, failedAttempt, failedPayload);
        vm.expectRevert(RetryCreditPredicateV2.InvalidAction.selector);
        pool.releaseCredit(creditNumber, proof);

        (failedAttempt, failedPayload) = _failureAttempt(policyId);
        failedAttempt.sourceChainId = 11155111;
        proof = _proofWithFailedAttempt(policyId, failedAttempt, failedPayload);
        vm.expectRevert(RetryCreditPredicateV2.InvalidSourceChain.selector);
        pool.releaseCredit(creditNumber, proof);

        (failedAttempt, failedPayload) = _failureAttempt(policyId);
        failedAttempt.settlementAsset = address(0xBAD1);
        proof = _proofWithFailedAttempt(policyId, failedAttempt, failedPayload);
        vm.expectRevert(RetryCreditPredicateV2.InvalidSettlementAsset.selector);
        pool.releaseCredit(creditNumber, proof);

        (failedAttempt, failedPayload) = _failureAttempt(policyId);
        failedAttempt.settlementRecipient = address(0xBAD4);
        proof = _proofWithFailedAttempt(policyId, failedAttempt, failedPayload);
        vm.expectRevert(RetryCreditPredicateV2.InvalidParticipant.selector);
        pool.releaseCredit(creditNumber, proof);

        AttestcoinRetryCreditVerifier.BatchProof memory wrongTarget = _validProof(policyId);
        wrongTarget.encodedTransactions[0] = _replaceSourceIdentity(
            wrongTarget.encodedTransactions[0], BENEFICIARY, address(0xBAD2), FAILURE_NONCE, 0, FAILURE_GAS_USED
        );
        vm.expectRevert(RetryCreditPredicateV2.InvalidTarget.selector);
        pool.releaseCredit(creditNumber, wrongTarget);

        AttestcoinRetryCreditVerifier.BatchProof memory wrongParticipant = _validProof(policyId);
        wrongParticipant.encodedTransactions[0] = _replaceSourceIdentity(
            wrongParticipant.encodedTransactions[0],
            address(0xBAD3),
            address(checkout),
            FAILURE_NONCE,
            0,
            FAILURE_GAS_USED
        );
        vm.expectRevert(RetryCreditPredicateV2.InvalidParticipant.selector);
        pool.releaseCredit(creditNumber, wrongParticipant);
    }

    function testRejectsPayloadMismatchExpiryQuoteRegressionAndTooLittleSettlement() external {
        (uint256 creditNumber, bytes32 policyId) = _createAndActivateServiceCredit();
        (RetryCreditPredicateV2.Attempt memory failedAttempt, bytes memory failedPayload) = _failureAttempt(policyId);
        AttestcoinRetryCreditVerifier.BatchProof memory proof;
        failedAttempt.payloadHash = keccak256("not-the-payload");
        proof = _proofWithFailedAttempt(policyId, failedAttempt, failedPayload);
        vm.expectRevert(RetryCreditPredicateV2.InvalidAttempt.selector);
        pool.releaseCredit(creditNumber, proof);

        (failedAttempt, failedPayload) = _failureAttempt(policyId);
        failedAttempt.validUntil = FAILURE_BLOCK - 1;
        proof = _proofWithFailedAttempt(policyId, failedAttempt, failedPayload);
        vm.expectRevert(RetryCreditPredicateV2.AttemptExpired.selector);
        pool.releaseCredit(creditNumber, proof);

        (RetryCreditPredicateV2.Attempt memory successAttempt, bytes memory successPayload) = _successAttempt(policyId);
        successAttempt.quoteVersion = 1;
        successPayload = abi.encode(MERCHANT, SKU, uint64(1));
        successAttempt.payloadHash = keccak256(successPayload);
        proof = _proofWithSuccessAttempt(policyId, successAttempt, successPayload);
        vm.expectRevert(RetryCreditPredicateV2.InvalidQuoteVersion.selector);
        pool.releaseCredit(creditNumber, proof);

        (successAttempt, successPayload) = _successAttempt(policyId);
        successAttempt.settledValue = MINIMUM_SETTLED_VALUE - 1;
        proof = _proofWithSuccessAttempt(policyId, successAttempt, successPayload);
        vm.expectRevert(RetryCreditPredicateV2.SettledValueTooLow.selector);
        pool.releaseCredit(creditNumber, proof);
    }

    function testAttemptsMustDescribeOneStructurallyValidCheckoutAction() external {
        (uint256 creditNumber, bytes32 policyId) = _createAndActivateServiceCredit();
        (RetryCreditPredicateV2.Attempt memory failedAttempt, bytes memory failedPayload) = _failureAttempt(policyId);
        AttestcoinRetryCreditVerifier.BatchProof memory proof;

        failedAttempt.settledValue = 0;
        proof = _proofWithFailedAttempt(policyId, failedAttempt, failedPayload);
        vm.expectRevert(RetryCreditPredicateV2.InvalidSettledValue.selector);
        pool.releaseCredit(creditNumber, proof);

        (failedAttempt, failedPayload) = _failureAttempt(policyId);
        failedPayload = hex"1234";
        failedAttempt.payloadHash = keccak256(failedPayload);
        proof = _proofWithFailedAttempt(policyId, failedAttempt, failedPayload);
        vm.expectRevert(RetryCreditPredicateV2.InvalidCheckoutPayload.selector);
        pool.releaseCredit(creditNumber, proof);

        (failedAttempt, failedPayload) = _failureAttempt(policyId);
        failedPayload = abi.encode(address(0xBAD1), SKU, uint64(1));
        failedAttempt.payloadHash = keccak256(failedPayload);
        proof = _proofWithFailedAttempt(policyId, failedAttempt, failedPayload);
        vm.expectRevert(RetryCreditPredicateV2.InvalidCheckoutPayload.selector);
        pool.releaseCredit(creditNumber, proof);

        (failedAttempt, failedPayload) = _failureAttempt(policyId);
        failedPayload = abi.encode(MERCHANT, SKU, uint64(2));
        failedAttempt.payloadHash = keccak256(failedPayload);
        proof = _proofWithFailedAttempt(policyId, failedAttempt, failedPayload);
        vm.expectRevert(RetryCreditPredicateV2.InvalidCheckoutPayload.selector);
        pool.releaseCredit(creditNumber, proof);

        (RetryCreditPredicateV2.Attempt memory successAttempt, bytes memory successPayload) = _successAttempt(policyId);
        successPayload = abi.encode(MERCHANT, keccak256("different-sku"), uint64(2));
        successAttempt.payloadHash = keccak256(successPayload);
        proof = _proofWithSuccessAttempt(policyId, successAttempt, successPayload);
        vm.expectRevert(RetryCreditPredicateV2.CheckoutActionMismatch.selector);
        pool.releaseCredit(creditNumber, proof);
    }

    function testRejectsImpossibleWindowAndSelfSettlementTerms() external {
        RetryCreditPredicateV2.Rule memory terms = _terms();
        terms.endBlock = terms.startBlock;
        vm.expectRevert(RetryCreditPredicateV2.InvalidRule.selector);
        vm.prank(sponsor);
        pool.createServiceCredit{value: CREDIT_AMOUNT}(terms, uint64(block.timestamp + 7 days));

        terms = _terms();
        terms.settlementRecipient = terms.beneficiary;
        vm.expectRevert(RetryCreditPredicateV2.InvalidRule.selector);
        vm.prank(sponsor);
        pool.createServiceCredit{value: CREDIT_AMOUNT}(terms, uint64(block.timestamp + 7 days));
    }

    function testSettlementEventBindsAssetValuePayloadAndVersion() external {
        (uint256 creditNumber, bytes32 policyId) = _createAndActivateServiceCredit();
        (RetryCreditPredicateV2.Attempt memory successAttempt,) = _successAttempt(policyId);
        AttestcoinRetryCreditVerifier.BatchProof memory proof;

        RetryCreditPredicateV2.Attempt memory wrongEvent = successAttempt;
        wrongEvent.settlementAsset = address(0xBAD1);
        proof = _proofWithCustomSuccessEvent(policyId, wrongEvent);
        vm.expectRevert(RetryCreditPredicateV2.RequiredSettlementEventMissing.selector);
        pool.releaseCredit(creditNumber, proof);

        wrongEvent = successAttempt;
        wrongEvent.settledValue += 1;
        proof = _proofWithCustomSuccessEvent(policyId, wrongEvent);
        vm.expectRevert(RetryCreditPredicateV2.RequiredSettlementEventMissing.selector);
        pool.releaseCredit(creditNumber, proof);

        wrongEvent = successAttempt;
        wrongEvent.settlementRecipient = address(0xBAD2);
        proof = _proofWithCustomSuccessEvent(policyId, wrongEvent);
        vm.expectRevert(RetryCreditPredicateV2.RequiredSettlementEventMissing.selector);
        pool.releaseCredit(creditNumber, proof);

        wrongEvent = successAttempt;
        wrongEvent.payloadHash = keccak256("wrong-event-payload");
        proof = _proofWithCustomSuccessEvent(policyId, wrongEvent);
        vm.expectRevert(RetryCreditPredicateV2.RequiredSettlementEventMissing.selector);
        pool.releaseCredit(creditNumber, proof);

        wrongEvent = successAttempt;
        wrongEvent.quoteVersion += 1;
        proof = _proofWithCustomSuccessEvent(policyId, wrongEvent);
        vm.expectRevert(RetryCreditPredicateV2.RequiredSettlementEventMissing.selector);
        pool.releaseCredit(creditNumber, proof);
    }

    function testSettlementEventBindsPolicyActionBeneficiaryAndEmitter() external {
        (uint256 creditNumber, bytes32 policyId) = _createAndActivateServiceCredit();
        AttestcoinRetryCreditVerifier.BatchProof memory proof = _validProof(policyId);
        (RetryCreditPredicateV2.Attempt memory successAttempt,) = _successAttempt(policyId);

        proof.encodedTransactions[1] = _encodedAttemptWithEvent(
            EvmV1Decoder.decodeCommonTxFields(proof.encodedTransactions[1]).data,
            SUCCESS_NONCE,
            successAttempt,
            keccak256("wrong-policy"),
            ACTION_ID,
            BENEFICIARY,
            address(checkout)
        );
        vm.expectRevert(RetryCreditPredicateV2.RequiredSettlementEventMissing.selector);
        pool.releaseCredit(creditNumber, proof);

        proof = _validProof(policyId);
        proof.encodedTransactions[1] = _encodedAttemptWithEvent(
            EvmV1Decoder.decodeCommonTxFields(proof.encodedTransactions[1]).data,
            SUCCESS_NONCE,
            successAttempt,
            policyId,
            keccak256("wrong-action"),
            address(0xBAD),
            address(0xBAD)
        );
        vm.expectRevert(RetryCreditPredicateV2.RequiredSettlementEventMissing.selector);
        pool.releaseCredit(creditNumber, proof);
    }

    function testSettlementTransferRequiresExactAssetFromToAmountAndSingleLog() external {
        (uint256 creditNumber, bytes32 policyId) = _createAndActivateServiceCredit();
        (RetryCreditPredicateV2.Attempt memory successAttempt,) = _successAttempt(policyId);

        _expectTransferFailure(
            creditNumber,
            policyId,
            successAttempt,
            address(0xBAD1),
            BENEFICIARY,
            MERCHANT,
            SUCCESS_SETTLED_VALUE,
            1,
            RetryCreditPredicateV2.RequiredSettlementTransferMissing.selector
        );
        _expectTransferFailure(
            creditNumber,
            policyId,
            successAttempt,
            address(token),
            address(0xBAD2),
            MERCHANT,
            SUCCESS_SETTLED_VALUE,
            1,
            RetryCreditPredicateV2.RequiredSettlementTransferMissing.selector
        );
        _expectTransferFailure(
            creditNumber,
            policyId,
            successAttempt,
            address(token),
            BENEFICIARY,
            address(0xBAD3),
            SUCCESS_SETTLED_VALUE,
            1,
            RetryCreditPredicateV2.RequiredSettlementTransferMissing.selector
        );
        _expectTransferFailure(
            creditNumber,
            policyId,
            successAttempt,
            address(token),
            BENEFICIARY,
            MERCHANT,
            SUCCESS_SETTLED_VALUE + 1,
            1,
            RetryCreditPredicateV2.RequiredSettlementTransferMissing.selector
        );
        _expectTransferFailure(
            creditNumber,
            policyId,
            successAttempt,
            address(token),
            BENEFICIARY,
            MERCHANT,
            SUCCESS_SETTLED_VALUE,
            0,
            RetryCreditPredicateV2.RequiredSettlementTransferMissing.selector
        );
        _expectTransferFailure(
            creditNumber,
            policyId,
            successAttempt,
            address(token),
            BENEFICIARY,
            MERCHANT,
            SUCCESS_SETTLED_VALUE,
            2,
            RetryCreditPredicateV2.DuplicateSettlementTransfer.selector
        );
    }

    function testRejectsNonceReceiptBlockGasAndNativeProofViolations() external {
        (uint256 creditNumber, bytes32 policyId) = _createAndActivateServiceCredit();
        AttestcoinRetryCreditVerifier.BatchProof memory proof = _validProof(policyId);
        (RetryCreditPredicateV2.Attempt memory successAttempt,) = _successAttempt(policyId);
        proof.encodedTransactions[1] =
            _replaceNonceStatusAndGas(proof.encodedTransactions[1], FAILURE_NONCE, 1, 70_000, true, successAttempt);
        vm.expectRevert(RetryCreditPredicateV2.InvalidNonceOrder.selector);
        pool.releaseCredit(creditNumber, proof);

        proof = _validProof(policyId);
        proof.encodedTransactions[0] = _replaceNonceStatusAndGas(
            proof.encodedTransactions[0], FAILURE_NONCE, 1, FAILURE_GAS_USED, false, successAttempt
        );
        vm.expectRevert(RetryCreditPredicateV2.InvalidReceiptSequence.selector);
        pool.releaseCredit(creditNumber, proof);

        proof = _validProof(policyId);
        proof.sourceBlocks[1] = proof.sourceBlocks[0];
        vm.expectRevert(AttestcoinRetryCreditVerifier.InvalidProofOrder.selector);
        pool.releaseCredit(creditNumber, proof);

        proof = _validProof(policyId);
        proof.sourceBlocks[1] = FAILURE_BLOCK + 11;
        vm.expectRevert(RetryCreditPredicateV2.InvalidBlockGap.selector);
        pool.releaseCredit(creditNumber, proof);

        proof = _validProof(policyId);
        proof.encodedTransactions[0] = _replaceNonceStatusAndGas(
            proof.encodedTransactions[0], FAILURE_NONCE, 0, MAX_FAILURE_GAS_USED + 1, false, successAttempt
        );
        vm.expectRevert(RetryCreditPredicateV2.FailureGasExceeded.selector);
        pool.releaseCredit(creditNumber, proof);

        proof = _validProof(policyId);
        proof.encodedTransactions[0] =
            _replaceFailureEnvelope(proof.encodedTransactions[0], MINIMUM_ATTEMPT_GAS_LIMIT - 1, 0);
        vm.expectRevert(RetryCreditPredicateV2.AttemptGasLimitTooLow.selector);
        pool.releaseCredit(creditNumber, proof);

        proof = _validProof(policyId);
        proof.encodedTransactions[0] =
            _replaceFailureEnvelope(proof.encodedTransactions[0], MINIMUM_ATTEMPT_GAS_LIMIT, 1);
        vm.expectRevert(RetryCreditPredicateV2.InvalidTransactionValue.selector);
        pool.releaseCredit(creditNumber, proof);

        proof = _validProof(policyId);
        nativeVerifier.setVerificationResult(false);
        vm.expectRevert(AttestcoinRetryCreditVerifier.ProofVerificationFailed.selector);
        pool.releaseCredit(creditNumber, proof);
    }

    function testRejectsMalformedBatchSourceWindowAndReplay() external {
        (uint256 creditNumber, bytes32 policyId) = _createAndActivateServiceCredit();
        AttestcoinRetryCreditVerifier.BatchProof memory malformed = _validProof(policyId);
        malformed.sourceBlocks = new uint64[](1);
        malformed.sourceBlocks[0] = FAILURE_BLOCK;
        vm.expectRevert(AttestcoinRetryCreditVerifier.InvalidBatch.selector);
        pool.releaseCredit(creditNumber, malformed);

        AttestcoinRetryCreditVerifier.BatchProof memory outsideWindow = _validProof(policyId);
        outsideWindow.sourceBlocks[0] = START_BLOCK - 1;
        vm.expectRevert(RetryCreditPredicateV2.InvalidSourceBlock.selector);
        pool.releaseCredit(creditNumber, outsideWindow);

        AttestcoinRetryCreditVerifier.BatchProof memory proof = _validProof(policyId);
        pool.releaseCredit(creditNumber, proof);
        vm.expectRevert(RetryCreditPool.AlreadyResolved.selector);
        pool.releaseCredit(creditNumber, proof);
    }

    function testActionCannotReleaseASecondServiceCreditWithDifferentReceipts() external {
        (uint256 firstNumber, bytes32 firstPolicyId) = _createAndActivateServiceCredit();
        AttestcoinRetryCreditVerifier.BatchProof memory firstProof = _validProof(firstPolicyId);
        pool.releaseCredit(firstNumber, firstProof);

        (uint256 secondNumber, bytes32 secondPolicyId) = _createAndActivateServiceCredit();
        AttestcoinRetryCreditVerifier.BatchProof memory secondProof = _validProof(secondPolicyId);
        secondProof.sourceBlocks[0] += 1;
        secondProof.sourceBlocks[1] += 1;

        vm.expectRevert(RetryCreditPool.Replay.selector);
        pool.releaseCredit(secondNumber, secondProof);
    }

    function testSponsorFundingBindsAttemptSignerAndInvalidTermsFail() external {
        RetryCreditPredicateV2.Rule memory terms = _terms();
        vm.prank(PROVER);
        uint256 creditNumber = pool.createServiceCredit{value: CREDIT_AMOUNT}(terms, uint64(block.timestamp + 7 days));
        RetryCreditPool.ServiceCredit memory credit = pool.getServiceCredit(creditNumber);
        assertEq(credit.sponsor, PROVER);
        assertEq(pool.getRule(creditNumber).attemptSigner, attemptSigner);

        terms.attemptSigner = address(0);
        vm.prank(sponsor);
        vm.expectRevert(RetryCreditPredicateV2.InvalidRule.selector);
        pool.createServiceCredit{value: CREDIT_AMOUNT}(terms, uint64(block.timestamp + 7 days));

        terms = _terms();
        terms.settlementAsset = address(0);
        vm.prank(sponsor);
        vm.expectRevert(RetryCreditPredicateV2.InvalidRule.selector);
        pool.createServiceCredit{value: CREDIT_AMOUNT}(terms, uint64(block.timestamp + 7 days));
    }

    function testReleaseDeadlineAndRefundPreservePrecommitSafety() external {
        RetryCreditPredicateV2.Rule memory terms = _terms();
        vm.prank(sponsor);
        uint256 creditNumber = pool.createServiceCredit{value: CREDIT_AMOUNT}(terms, uint64(block.timestamp + 7 days));
        vm.expectRevert(RetryCreditPool.NotActivated.selector);
        pool.releaseCredit(creditNumber, _emptyProof());

        bytes32 policyId = _activate(creditNumber);
        RetryCreditPool.ServiceCredit memory credit = pool.getServiceCredit(creditNumber);
        vm.warp(uint256(credit.refundAfter) + 1);
        AttestcoinRetryCreditVerifier.BatchProof memory proof = _validProof(policyId);
        vm.expectRevert(RetryCreditPool.ReleaseClosed.selector);
        pool.releaseCredit(creditNumber, proof);

        vm.prank(sponsor);
        vm.expectRevert(RetryCreditPool.SourceWindowNotAttested.selector);
        pool.refundServiceCredit(creditNumber);

        chainInfo.setLatestAttestation(END_BLOCK, true, true);
        uint256 sponsorBefore = sponsor.balance;
        vm.prank(sponsor);
        pool.refundServiceCredit(creditNumber);
        assertEq(sponsor.balance - sponsorBefore, CREDIT_AMOUNT);
        assertTrue(pool.getServiceCredit(creditNumber).refunded);
    }

    function testExpiredDraftRefundAndConfigurableSourceChain() external {
        RetryCreditPredicateV2.Rule memory terms = _terms();
        vm.prank(sponsor);
        uint256 creditNumber = pool.createServiceCredit{value: CREDIT_AMOUNT}(terms, uint64(block.timestamp + 7 days));
        RetryCreditPool.ServiceCredit memory credit = pool.getServiceCredit(creditNumber);
        vm.roll(credit.creationBlock + pool.ACTIVATION_WINDOW_BLOCKS() + 1);
        vm.expectRevert(RetryCreditPool.ActivationExpired.selector);
        vm.prank(sponsor);
        pool.activateServiceCredit(creditNumber);
        vm.prank(sponsor);
        pool.refundServiceCredit(creditNumber);

        MockChainInfo sepoliaChainInfo = new MockChainInfo(START_BLOCK - 1);
        sepoliaChainInfo.setSource(1, 11155111, 1, true);
        AttestcoinRetryCreditVerifier sepoliaVerifier =
            new AttestcoinRetryCreditVerifier(predicate, address(nativeVerifier), 1, 11155111);
        RetryCreditPool sepoliaPool = new RetryCreditPool(sepoliaVerifier, address(sepoliaChainInfo));
        assertEq(sepoliaPool.sourceChainKey(), 1);
        assertEq(sepoliaPool.sourceChainId(), 11155111);
    }

    function testOnlySponsorCanActivateAndNoOneCanActivateAtRefundDeadline() external {
        RetryCreditPredicateV2.Rule memory terms = _terms();
        uint64 refundAfter = uint64(block.timestamp + 1 days);
        vm.prank(sponsor);
        uint256 creditNumber = pool.createServiceCredit{value: CREDIT_AMOUNT}(terms, refundAfter);
        RetryCreditPool.ServiceCredit memory credit = pool.getServiceCredit(creditNumber);
        vm.roll(credit.creationBlock + 1);
        vm.setBlockhash(credit.creationBlock, CREATION_BLOCK_HASH);

        vm.expectRevert(RetryCreditPool.NotSponsor.selector);
        vm.prank(PROVER);
        pool.activateServiceCredit(creditNumber);

        vm.warp(refundAfter);
        vm.expectRevert(RetryCreditPool.ActivationClosed.selector);
        vm.prank(sponsor);
        pool.activateServiceCredit(creditNumber);

        uint256 sponsorBefore = sponsor.balance;
        vm.prank(sponsor);
        pool.refundServiceCredit(creditNumber);
        assertEq(sponsor.balance - sponsorBefore, CREDIT_AMOUNT);
    }

    function _createAndActivateServiceCredit() private returns (uint256 creditNumber, bytes32 policyId) {
        vm.prank(sponsor);
        creditNumber = pool.createServiceCredit{value: CREDIT_AMOUNT}(_terms(), uint64(block.timestamp + 7 days));
        policyId = _activate(creditNumber);
    }

    function _activate(uint256 creditNumber) private returns (bytes32 policyId) {
        RetryCreditPool.ServiceCredit memory credit = pool.getServiceCredit(creditNumber);
        vm.roll(credit.creationBlock + 1);
        vm.setBlockhash(credit.creationBlock, CREATION_BLOCK_HASH);
        vm.prank(credit.sponsor);
        policyId = pool.activateServiceCredit(creditNumber);
    }

    function _terms() private view returns (RetryCreditPredicateV2.Rule memory terms) {
        terms = RetryCreditPredicateV2.Rule({
            attemptSigner: attemptSigner,
            beneficiary: BENEFICIARY,
            target: address(checkout),
            settlementAsset: address(token),
            settlementRecipient: MERCHANT,
            policyId: bytes32(0),
            actionId: ACTION_ID,
            minimumSettledValue: MINIMUM_SETTLED_VALUE,
            startBlock: START_BLOCK,
            endBlock: END_BLOCK,
            maxBlockGap: 10,
            minimumAttemptGasLimit: MINIMUM_ATTEMPT_GAS_LIMIT,
            maxFailureGasUsed: MAX_FAILURE_GAS_USED
        });
    }

    function _validProof(bytes32 policyId) private returns (AttestcoinRetryCreditVerifier.BatchProof memory proof) {
        (RetryCreditPredicateV2.Attempt memory failedAttempt, bytes memory failedPayload) = _failureAttempt(policyId);
        (RetryCreditPredicateV2.Attempt memory successAttempt, bytes memory successPayload) = _successAttempt(policyId);
        proof = _proof(
            _encodedAttempt(
                _signedCheckoutData(failedAttempt, failedPayload),
                FAILURE_NONCE,
                0,
                FAILURE_GAS_USED,
                false,
                successAttempt
            ),
            FAILURE_BLOCK,
            _encodedAttempt(
                _signedCheckoutData(successAttempt, successPayload), SUCCESS_NONCE, 1, 70_000, true, successAttempt
            ),
            SUCCESS_BLOCK
        );
        nativeVerifier.setTransactionIndexForRoot(proof.merkleProofs[0].root, 5);
        nativeVerifier.setTransactionIndexForRoot(proof.merkleProofs[1].root, 6);
    }

    function _proofWithFailedAttempt(
        bytes32 policyId,
        RetryCreditPredicateV2.Attempt memory failedAttempt,
        bytes memory failedPayload
    ) private view returns (AttestcoinRetryCreditVerifier.BatchProof memory proof) {
        (RetryCreditPredicateV2.Attempt memory successAttempt, bytes memory successPayload) = _successAttempt(policyId);
        proof = _proof(
            _encodedAttempt(
                _signedCheckoutData(failedAttempt, failedPayload),
                FAILURE_NONCE,
                0,
                FAILURE_GAS_USED,
                false,
                successAttempt
            ),
            FAILURE_BLOCK,
            _encodedAttempt(
                _signedCheckoutData(successAttempt, successPayload), SUCCESS_NONCE, 1, 70_000, true, successAttempt
            ),
            SUCCESS_BLOCK
        );
    }

    function _proofWithSuccessAttempt(
        bytes32 policyId,
        RetryCreditPredicateV2.Attempt memory successAttempt,
        bytes memory successPayload
    ) private view returns (AttestcoinRetryCreditVerifier.BatchProof memory proof) {
        (RetryCreditPredicateV2.Attempt memory failedAttempt, bytes memory failedPayload) = _failureAttempt(policyId);
        proof = _proof(
            _encodedAttempt(
                _signedCheckoutData(failedAttempt, failedPayload),
                FAILURE_NONCE,
                0,
                FAILURE_GAS_USED,
                false,
                successAttempt
            ),
            FAILURE_BLOCK,
            _encodedAttempt(
                _signedCheckoutData(successAttempt, successPayload), SUCCESS_NONCE, 1, 70_000, true, successAttempt
            ),
            SUCCESS_BLOCK
        );
    }

    function _proofWithCustomSuccessEvent(bytes32 policyId, RetryCreditPredicateV2.Attempt memory eventAttempt)
        private
        returns (AttestcoinRetryCreditVerifier.BatchProof memory proof)
    {
        proof = _validProof(policyId);
        EvmV1Decoder.CommonTxFields memory transaction = EvmV1Decoder.decodeCommonTxFields(proof.encodedTransactions[1]);
        (RetryCreditPredicateV2.Attempt memory signedAttempt,) = _successAttempt(policyId);
        proof.encodedTransactions[1] = _encodedAttemptWithEvent(
            transaction.data,
            SUCCESS_NONCE,
            eventAttempt,
            signedAttempt.policyId,
            signedAttempt.actionId,
            signedAttempt.beneficiary,
            address(checkout)
        );
    }

    function _expectTransferFailure(
        uint256 creditNumber,
        bytes32 policyId,
        RetryCreditPredicateV2.Attempt memory successAttempt,
        address transferEmitter,
        address transferFrom,
        address transferTo,
        uint256 transferAmount,
        uint256 transferCount,
        bytes4 expectedError
    ) private {
        AttestcoinRetryCreditVerifier.BatchProof memory proof = _validProof(policyId);
        EvmV1Decoder.CommonTxFields memory transaction = EvmV1Decoder.decodeCommonTxFields(proof.encodedTransactions[1]);
        proof.encodedTransactions[1] = _encodedAttemptWithTransfers(
            transaction.data,
            SUCCESS_NONCE,
            successAttempt,
            transferEmitter,
            transferFrom,
            transferTo,
            transferAmount,
            transferCount
        );
        vm.expectRevert(expectedError);
        pool.releaseCredit(creditNumber, proof);
    }

    function _failureAttempt(bytes32 policyId)
        private
        view
        returns (RetryCreditPredicateV2.Attempt memory attempt, bytes memory payload)
    {
        payload = abi.encode(MERCHANT, SKU, uint64(1));
        attempt = _attempt(policyId, 1, 45e6, keccak256(payload), FAILURE_BLOCK + 1);
    }

    function _successAttempt(bytes32 policyId)
        private
        view
        returns (RetryCreditPredicateV2.Attempt memory attempt, bytes memory payload)
    {
        payload = abi.encode(MERCHANT, SKU, uint64(2));
        attempt = _attempt(policyId, 2, SUCCESS_SETTLED_VALUE, keccak256(payload), SUCCESS_BLOCK + 1);
    }

    function _attempt(
        bytes32 policyId,
        uint64 quoteVersion,
        uint256 settledValue,
        bytes32 payloadHash,
        uint64 validUntil
    ) private view returns (RetryCreditPredicateV2.Attempt memory attempt) {
        attempt = RetryCreditPredicateV2.Attempt({
            sourceChainId: SOURCE_CHAIN_ID,
            target: address(checkout),
            beneficiary: BENEFICIARY,
            settlementAsset: address(token),
            settlementRecipient: MERCHANT,
            policyId: policyId,
            actionId: ACTION_ID,
            quoteVersion: quoteVersion,
            settledValue: settledValue,
            payloadHash: payloadHash,
            validUntil: validUntil
        });
    }

    function _signedCheckoutData(RetryCreditPredicateV2.Attempt memory attempt, bytes memory payload)
        private
        view
        returns (bytes memory)
    {
        return _checkoutData(attempt, payload, _sign(ATTEMPT_SIGNER_KEY, attempt));
    }

    function _checkoutData(RetryCreditPredicateV2.Attempt memory attempt, bytes memory payload, bytes memory signature)
        private
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(RetryCreditCheckout.checkout.selector, attempt, payload, signature);
    }

    function _sign(uint256 privateKey, RetryCreditPredicateV2.Attempt memory attempt)
        private
        view
        returns (bytes memory signature)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, predicate.attemptDigest(attempt));
        signature = abi.encodePacked(r, s, v);
    }

    function _proof(bytes memory failed, uint64 failureBlock, bytes memory succeeded, uint64 successBlock)
        private
        pure
        returns (AttestcoinRetryCreditVerifier.BatchProof memory proof)
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

    function _emptyProof() private pure returns (AttestcoinRetryCreditVerifier.BatchProof memory proof) {
        proof.sourceBlocks = new uint64[](0);
        proof.encodedTransactions = new bytes[](0);
        proof.merkleProofs = new INativeQueryVerifier.MerkleProof[](0);
        proof.continuityRoots = new bytes32[](0);
    }

    function _merkleProof(bytes32 root) private pure returns (INativeQueryVerifier.MerkleProof memory proof) {
        proof.root = root;
        proof.siblings = new INativeQueryVerifier.MerkleProofEntry[](0);
    }

    function _encodedAttempt(
        bytes memory checkoutData,
        uint64 nonce,
        uint8 receiptStatus,
        uint64 gasUsed,
        bool includeSettlementLog,
        RetryCreditPredicateV2.Attempt memory eventAttempt
    ) private view returns (bytes memory) {
        return _encodedAttemptFor(
            checkoutData,
            BENEFICIARY,
            address(checkout),
            nonce,
            receiptStatus,
            gasUsed,
            includeSettlementLog,
            eventAttempt
        );
    }

    function _encodedAttemptFor(
        bytes memory checkoutData,
        address sender,
        address sourceTarget,
        uint64 nonce,
        uint8 receiptStatus,
        uint64 gasUsed,
        bool includeSettlementLog,
        RetryCreditPredicateV2.Attempt memory eventAttempt
    ) private view returns (bytes memory) {
        bytes memory common = abi.encode(nonce, uint64(180_000), sender, false, sourceTarget, uint256(0), checkoutData);
        bytes memory typeSpecific = _typeSpecific();
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](includeSettlementLog ? 2 : 0);
        if (includeSettlementLog) {
            logs[0] = _transferLog(
                eventAttempt.settlementAsset,
                eventAttempt.beneficiary,
                eventAttempt.settlementRecipient,
                eventAttempt.settledValue
            );
            logs[1] = _settlementLog(
                eventAttempt, eventAttempt.policyId, eventAttempt.actionId, eventAttempt.beneficiary, address(checkout)
            );
        }
        bytes memory receipt = abi.encode(receiptStatus, gasUsed, logs, new bytes(256));
        bytes[] memory chunks = new bytes[](3);
        chunks[0] = common;
        chunks[1] = typeSpecific;
        chunks[2] = receipt;
        return abi.encode(uint8(2), chunks);
    }

    function _replaceSourceIdentity(
        bytes memory encoded,
        address sender,
        address sourceTarget,
        uint64 nonce,
        uint8 status,
        uint64 gasUsed
    ) private view returns (bytes memory) {
        EvmV1Decoder.CommonTxFields memory transaction = EvmV1Decoder.decodeCommonTxFields(encoded);
        RetryCreditPredicateV2.Attempt memory unused;
        return _encodedAttemptFor(transaction.data, sender, sourceTarget, nonce, status, gasUsed, false, unused);
    }

    function _replaceFailureEnvelope(bytes memory encoded, uint64 gasLimit, uint256 callValue)
        private
        view
        returns (bytes memory)
    {
        EvmV1Decoder.CommonTxFields memory transaction = EvmV1Decoder.decodeCommonTxFields(encoded);
        bytes memory common =
            abi.encode(transaction.nonce, gasLimit, BENEFICIARY, false, address(checkout), callValue, transaction.data);
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](0);
        bytes memory receipt = abi.encode(uint8(0), FAILURE_GAS_USED, logs, new bytes(256));
        bytes[] memory chunks = new bytes[](3);
        chunks[0] = common;
        chunks[1] = _typeSpecific();
        chunks[2] = receipt;
        return abi.encode(uint8(2), chunks);
    }

    function _replaceNonceStatusAndGas(
        bytes memory encoded,
        uint64 nonce,
        uint8 status,
        uint64 gasUsed,
        bool includeEvent,
        RetryCreditPredicateV2.Attempt memory eventAttempt
    ) private view returns (bytes memory) {
        EvmV1Decoder.CommonTxFields memory transaction = EvmV1Decoder.decodeCommonTxFields(encoded);
        return _encodedAttemptFor(
            transaction.data, BENEFICIARY, address(checkout), nonce, status, gasUsed, includeEvent, eventAttempt
        );
    }

    function _encodedAttemptWithEvent(
        bytes memory checkoutData,
        uint64 nonce,
        RetryCreditPredicateV2.Attempt memory eventAttempt,
        bytes32 eventPolicyId,
        bytes32 eventActionId,
        address eventBeneficiary,
        address eventEmitter
    ) private view returns (bytes memory) {
        bytes memory common = abi.encode(
            nonce, uint64(180_000), BENEFICIARY, false, address(checkout), uint256(0), checkoutData
        );
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](2);
        logs[0] = _transferLog(
            eventAttempt.settlementAsset,
            eventAttempt.beneficiary,
            eventAttempt.settlementRecipient,
            eventAttempt.settledValue
        );
        logs[1] = _settlementLog(eventAttempt, eventPolicyId, eventActionId, eventBeneficiary, eventEmitter);
        bytes memory receipt = abi.encode(uint8(1), uint64(70_000), logs, new bytes(256));
        bytes[] memory chunks = new bytes[](3);
        chunks[0] = common;
        chunks[1] = _typeSpecific();
        chunks[2] = receipt;
        return abi.encode(uint8(2), chunks);
    }

    function _encodedAttemptWithTransfers(
        bytes memory checkoutData,
        uint64 nonce,
        RetryCreditPredicateV2.Attempt memory eventAttempt,
        address transferEmitter,
        address transferFrom,
        address transferTo,
        uint256 transferAmount,
        uint256 transferCount
    ) private view returns (bytes memory) {
        bytes memory common = abi.encode(
            nonce, uint64(180_000), BENEFICIARY, false, address(checkout), uint256(0), checkoutData
        );
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](transferCount + 1);
        for (uint256 i; i < transferCount; ++i) {
            logs[i] = _transferLog(transferEmitter, transferFrom, transferTo, transferAmount);
        }
        logs[transferCount] = _settlementLog(
            eventAttempt, eventAttempt.policyId, eventAttempt.actionId, eventAttempt.beneficiary, address(checkout)
        );
        bytes memory receipt = abi.encode(uint8(1), uint64(70_000), logs, new bytes(256));
        bytes[] memory chunks = new bytes[](3);
        chunks[0] = common;
        chunks[1] = _typeSpecific();
        chunks[2] = receipt;
        return abi.encode(uint8(2), chunks);
    }

    function _transferLog(address emitter, address from, address to, uint256 amount)
        private
        pure
        returns (EvmV1Decoder.LogEntryTuple memory log)
    {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = keccak256("Transfer(address,address,uint256)");
        topics[1] = bytes32(uint256(uint160(from)));
        topics[2] = bytes32(uint256(uint160(to)));
        log = EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: abi.encode(amount)});
    }

    function _settlementLog(
        RetryCreditPredicateV2.Attempt memory eventAttempt,
        bytes32 eventPolicyId,
        bytes32 eventActionId,
        address eventBeneficiary,
        address eventEmitter
    ) private view returns (EvmV1Decoder.LogEntryTuple memory log) {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = predicate.CHECKOUT_SETTLED_EVENT();
        topics[1] = eventPolicyId;
        topics[2] = eventActionId;
        topics[3] = bytes32(uint256(uint160(eventBeneficiary)));
        log = EvmV1Decoder.LogEntryTuple({
            address_: eventEmitter,
            topics: topics,
            data: abi.encode(
                eventAttempt.settlementAsset,
                eventAttempt.settlementRecipient,
                eventAttempt.settledValue,
                eventAttempt.payloadHash,
                eventAttempt.quoteVersion
            )
        });
    }

    function _typeSpecific() private pure returns (bytes memory) {
        EvmV1Decoder.AccessListEntry[] memory accessList = new EvmV1Decoder.AccessListEntry[](0);
        return
            abi.encode(
                uint64(1), uint128(1), uint128(2), accessList, uint8(0), bytes32(uint256(1)), bytes32(uint256(2))
            );
    }
}
