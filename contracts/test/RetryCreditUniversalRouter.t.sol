// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {AttestcoinRetryCreditUniversalRouterVerifier} from "../src/AttestcoinRetryCreditUniversalRouterVerifier.sol";
import {RetryCreditUniversalRouterPool} from "../src/RetryCreditUniversalRouterPool.sol";
import {RetryCreditUniversalRouterPredicateV1} from "../src/RetryCreditUniversalRouterPredicateV1.sol";
import {INativeQueryVerifier} from "../src/interfaces/INativeQueryVerifier.sol";
import {MockChainInfo} from "./mocks/MockChainInfo.sol";
import {MockNativeQueryVerifier} from "./mocks/MockNativeQueryVerifier.sol";

contract RetryCreditUniversalRouterTest is Test {
    uint256 private constant ROUTE_SIGNER_KEY = 0xA11CE;
    uint256 private constant TRADER_KEY = 0xB0B;
    uint256 private constant OUTSIDER_KEY = 0xBAD;
    uint256 private constant SPONSOR_KEY = 0xC0FFEE;

    uint64 private constant SOURCE_CHAIN_KEY = 1;
    uint64 private constant SOURCE_CHAIN_ID = 11_155_111;
    uint64 private constant START_BLOCK = 9_100_000;
    uint64 private constant END_BLOCK = START_BLOCK + 100;
    uint64 private constant FAILURE_BLOCK = START_BLOCK + 10;
    uint64 private constant SUCCESS_BLOCK = FAILURE_BLOCK + 2;
    uint64 private constant FAILURE_TRANSACTION_NONCE = 17;
    uint64 private constant SUCCESS_TRANSACTION_NONCE = 19;
    uint64 private constant MINIMUM_GAS_LIMIT = 250_000;
    uint64 private constant FAILURE_GAS_USED = 125_000;
    uint64 private constant MAX_FAILURE_GAS_USED = 150_000;

    uint256 private constant AMOUNT_IN = 0.0001 ether;
    uint256 private constant FAILURE_MIN_OUT = 4_539_926;
    uint256 private constant SUCCESS_MIN_OUT = 2_156_464;
    uint256 private constant ACTUAL_OUT = 2_269_963;
    uint256 private constant MINIMUM_SUCCESSFUL_OUT = 2_000_000;
    uint256 private constant CREDIT_AMOUNT = 0.1 ether;
    uint256 private constant FAILURE_DEADLINE = 1_800_000_000;
    uint256 private constant SUCCESS_DEADLINE = FAILURE_DEADLINE + 60;

    address private constant ROUTER = 0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468;
    address private constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address private constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address private constant POOL = 0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1;

    bytes32 private constant POLICY_ID = keccak256("prefunded-creditcoin-policy");
    bytes32 private constant ACTION_ID = keccak256("one-weth-usdc-swap-intent");
    bytes32 private constant FAILURE_ROUTE_NONCE = keccak256("failed-route-nonce");
    bytes32 private constant SUCCESS_ROUTE_NONCE = keccak256("refreshed-route-nonce");
    bytes32 private constant CREATION_BLOCK_HASH = keccak256("uniswap-credit-creation-block");

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant EXECUTE_SIGNED_TYPEHASH = keccak256(
        "ExecuteSigned(bytes commands,bytes[] inputs,bytes32 intent,bytes32 data,address sender,bytes32 nonce,uint256 deadline)"
    );

    struct RouteSpec {
        bytes commands;
        address wrapRecipient;
        uint256 wrapAmount;
        address outputRecipient;
        uint256 amountIn;
        uint256 minimumOut;
        bytes path;
        bool payerIsUser;
        uint256[] minHopPriceX36;
        bytes32 intent;
        bytes32 data;
        bool verifySender;
        bytes32 nonce;
        uint256 deadline;
        uint256 signerKey;
    }

    struct ReceiptSpec {
        uint8 status;
        uint64 gasUsed;
        uint8 swapCount;
        address swapEmitter;
        address swapSender;
        address swapRecipient;
        int256 amount0;
        int256 amount1;
        uint8 transferCount;
        address transferEmitter;
        address transferFrom;
        address transferTo;
        uint256 transferAmount;
    }

    address private routeSigner;
    address private trader;
    address private sponsor;
    address private prover;
    RetryCreditUniversalRouterPredicateV1 private predicate;
    MockNativeQueryVerifier private nativeVerifier;
    AttestcoinRetryCreditUniversalRouterVerifier private batchVerifier;
    MockChainInfo private chainInfo;
    RetryCreditUniversalRouterPool private servicePool;

    function setUp() external {
        vm.chainId(SOURCE_CHAIN_ID);
        routeSigner = vm.addr(ROUTE_SIGNER_KEY);
        trader = vm.addr(TRADER_KEY);
        sponsor = vm.addr(SPONSOR_KEY);
        prover = address(0xC0DE);
        predicate = new RetryCreditUniversalRouterPredicateV1();
        nativeVerifier = new MockNativeQueryVerifier();
        batchVerifier = new AttestcoinRetryCreditUniversalRouterVerifier(
            predicate, address(nativeVerifier), SOURCE_CHAIN_KEY, SOURCE_CHAIN_ID
        );
        chainInfo = new MockChainInfo(START_BLOCK - 1);
        chainInfo.setSource(SOURCE_CHAIN_KEY, SOURCE_CHAIN_ID, 1, true);
        servicePool = new RetryCreditUniversalRouterPool(batchVerifier, address(chainInfo));
        vm.deal(sponsor, 10 ether);
        vm.deal(trader, 1 ether);
        vm.deal(prover, 1 ether);
    }

    function testFundedPoolActivatesReleasesOnceAndConsumesBatchIdentity() external {
        (uint256 serviceCreditNumber, bytes32 policyId) = _createAndActivateServiceCredit();
        RetryCreditUniversalRouterPredicateV1.Rule memory activeRule = servicePool.getRule(serviceCreditNumber);
        AttestcoinRetryCreditUniversalRouterVerifier.BatchProof memory proof = _validProofForRule(activeRule);
        nativeVerifier.setTransactionIndexForRoot(proof.merkleProofs[0].root, 7);
        nativeVerifier.setTransactionIndexForRoot(proof.merkleProofs[1].root, 11);

        uint256 traderBefore = trader.balance;
        vm.prank(prover);
        servicePool.releaseCredit(serviceCreditNumber, proof);

        assertEq(trader.balance - traderBefore, CREDIT_AMOUNT);
        assertEq(address(servicePool).balance, 0);
        RetryCreditUniversalRouterPool.ServiceCredit memory credit = servicePool.getServiceCredit(serviceCreditNumber);
        assertTrue(credit.released);
        assertFalse(credit.refunded);

        bytes32 failureQueryId = keccak256(abi.encode(SOURCE_CHAIN_KEY, FAILURE_BLOCK, uint64(7)));
        bytes32 successQueryId = keccak256(abi.encode(SOURCE_CHAIN_KEY, SUCCESS_BLOCK, uint64(11)));
        bytes32 pairId = keccak256(abi.encode(policyId, ACTION_ID, failureQueryId, successQueryId));
        bytes32 actionKey = keccak256(abi.encode(SOURCE_CHAIN_KEY, SOURCE_CHAIN_ID, ROUTER, trader, ACTION_ID));
        assertTrue(servicePool.consumedQueries(failureQueryId));
        assertTrue(servicePool.consumedQueries(successQueryId));
        assertTrue(servicePool.consumedPairs(pairId));
        assertTrue(servicePool.consumedActions(actionKey));

        vm.expectRevert(RetryCreditUniversalRouterPool.AlreadyResolved.selector);
        vm.prank(prover);
        servicePool.releaseCredit(serviceCreditNumber, proof);
    }

    function testFundedPoolPolicyIsDerivedAfterDraftAndBoundIntoRoute() external {
        RetryCreditUniversalRouterPredicateV1.Rule memory terms = _terms();
        vm.prank(sponsor);
        uint256 serviceCreditNumber =
            servicePool.createServiceCredit{value: CREDIT_AMOUNT}(terms, uint64(block.timestamp + 7 days));
        RetryCreditUniversalRouterPool.ServiceCredit memory draft = servicePool.getServiceCredit(serviceCreditNumber);

        vm.expectRevert(RetryCreditUniversalRouterPool.ActivationNotReady.selector);
        vm.prank(sponsor);
        servicePool.activateServiceCredit(serviceCreditNumber);

        vm.roll(draft.creationBlock + 1);
        vm.setBlockhash(draft.creationBlock, CREATION_BLOCK_HASH);
        vm.prank(sponsor);
        bytes32 policyId = servicePool.activateServiceCredit(serviceCreditNumber);

        bytes32 expected = keccak256(
            abi.encode(
                "RETRYCREDIT_UNISWAP_SERVICE_CREDIT_V1",
                block.chainid,
                address(servicePool),
                serviceCreditNumber,
                sponsor,
                CREDIT_AMOUNT,
                draft.refundAfter,
                draft.termsHash,
                CREATION_BLOCK_HASH
            )
        );
        assertEq(policyId, expected);
        assertEq(servicePool.getRule(serviceCreditNumber).policyId, expected);
        assertEq(
            predicate.routeIntent(servicePool.getRule(serviceCreditNumber)),
            predicate.routeIntent(_ruleWithPolicy(expected))
        );
    }

    function testFundedPoolRejectsRetroactiveWindowAndUnsafeRefund() external {
        RetryCreditUniversalRouterPredicateV1.Rule memory terms = _terms();
        chainInfo.setLatest(terms.startBlock, true);
        vm.expectRevert(RetryCreditUniversalRouterPool.SourceWindowNotAttested.selector);
        vm.prank(sponsor);
        servicePool.createServiceCredit{value: CREDIT_AMOUNT}(terms, uint64(block.timestamp + 7 days));

        chainInfo.setLatest(terms.startBlock - 1, true);
        vm.prank(sponsor);
        uint256 serviceCreditNumber =
            servicePool.createServiceCredit{value: CREDIT_AMOUNT}(terms, uint64(block.timestamp + 7 days));
        RetryCreditUniversalRouterPool.ServiceCredit memory draft = servicePool.getServiceCredit(serviceCreditNumber);
        vm.roll(draft.creationBlock + 1);
        vm.setBlockhash(draft.creationBlock, CREATION_BLOCK_HASH);
        vm.prank(sponsor);
        servicePool.activateServiceCredit(serviceCreditNumber);

        vm.warp(draft.refundAfter + 1);
        chainInfo.setLatest(terms.endBlock - 1, true);
        vm.expectRevert(RetryCreditUniversalRouterPool.SourceWindowNotAttested.selector);
        vm.prank(sponsor);
        servicePool.refundServiceCredit(serviceCreditNumber);

        chainInfo.setLatest(terms.endBlock, true);
        uint256 sponsorBefore = sponsor.balance;
        vm.prank(sponsor);
        servicePool.refundServiceCredit(serviceCreditNumber);
        assertEq(sponsor.balance - sponsorBefore, CREDIT_AMOUNT);
        assertTrue(servicePool.getServiceCredit(serviceCreditNumber).refunded);
    }

    function testValidOfficialRouterRetryFitsOneNativeAttestcoinBatch() external {
        AttestcoinRetryCreditUniversalRouterVerifier.BatchProof memory proof = _validProof();
        nativeVerifier.setTransactionIndexForRoot(proof.merkleProofs[0].root, 7);
        nativeVerifier.setTransactionIndexForRoot(proof.merkleProofs[1].root, 11);

        (address beneficiary, bytes32 failureQueryId, bytes32 successQueryId, bytes32 pairId) =
            batchVerifier.verifyRelease(proof, _rule());

        assertEq(beneficiary, trader);
        assertEq(failureQueryId, keccak256(abi.encode(SOURCE_CHAIN_KEY, FAILURE_BLOCK, uint64(7))));
        assertEq(successQueryId, keccak256(abi.encode(SOURCE_CHAIN_KEY, SUCCESS_BLOCK, uint64(11))));
        assertEq(pairId, keccak256(abi.encode(POLICY_ID, ACTION_ID, failureQueryId, successQueryId)));
        assertEq(nativeVerifier.batchCallCount(), 1);
        assertEq(nativeVerifier.lastBatchSize(), 2);

        EvmV1Decoder.CommonTxFields memory failed = EvmV1Decoder.decodeCommonTxFields(proof.encodedTransactions[0]);
        EvmV1Decoder.CommonTxFields memory succeeded = EvmV1Decoder.decodeCommonTxFields(proof.encodedTransactions[1]);
        assertEq(failed.from, trader);
        assertEq(failed.to, ROUTER);
        assertEq(failed.value, AMOUNT_IN);
        assertGt(succeeded.nonce, failed.nonce);
        assertNotEq(keccak256(succeeded.data), keccak256(failed.data));
    }

    function testDomainTypedDataAndStableIntentMatchUniversalRouterV2() external view {
        RouteSpec memory route = _route(false);
        bytes[] memory inputs = _inputs(route);
        bytes32 expectedDomain = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("UniversalRouter"), keccak256("2"), SOURCE_CHAIN_ID, ROUTER)
        );
        bytes32 expectedIntent =
            keccak256(abi.encode("RETRYCREDIT_UNISWAP_V1", POLICY_ID, ACTION_ID, trader, WETH, USDC, POOL, AMOUNT_IN));
        bytes32 expectedDigest = _digest(route, inputs);

        assertEq(predicate.domainSeparator(SOURCE_CHAIN_ID, ROUTER), expectedDomain);
        assertEq(predicate.routeIntent(_rule()), expectedIntent);
        assertEq(
            predicate.routeDigest(
                route.commands,
                inputs,
                route.intent,
                route.data,
                trader,
                route.nonce,
                route.deadline,
                SOURCE_CHAIN_ID,
                ROUTER
            ),
            expectedDigest
        );
    }

    function testTermsRequireExactOfficialSepoliaStackAndDistinctRoles() external {
        RetryCreditUniversalRouterPredicateV1.Rule memory terms = _rule();
        terms.policyId = bytes32(0);
        predicate.validateTerms(terms);

        terms.policyId = POLICY_ID;
        predicate.validateRule(terms);

        terms.routeSigner = trader;
        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.InvalidRule.selector);
        predicate.validateRule(terms);

        terms = _rule();
        terms.router = address(0xBAD1);
        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.InvalidRule.selector);
        predicate.validateRule(terms);

        terms = _rule();
        terms.pool = address(0xBAD2);
        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.InvalidRule.selector);
        predicate.validateRule(terms);

        terms = _rule();
        terms.maxFailureGasUsed = terms.minimumAttemptGasLimit;
        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.InvalidRule.selector);
        predicate.validateRule(terms);
    }

    function testBatchVerifierRejectsAnyNonSepoliaAttestcoinSourceIdentity() external {
        vm.expectRevert(AttestcoinRetryCreditUniversalRouterVerifier.InvalidConfiguration.selector);
        new AttestcoinRetryCreditUniversalRouterVerifier(predicate, address(nativeVerifier), uint64(3), SOURCE_CHAIN_ID);

        vm.expectRevert(AttestcoinRetryCreditUniversalRouterVerifier.InvalidConfiguration.selector);
        new AttestcoinRetryCreditUniversalRouterVerifier(
            predicate, address(nativeVerifier), SOURCE_CHAIN_KEY, uint64(1)
        );
    }

    function testBothRoutesNeedIndependentCorrectSignaturesAndBoundSender() external {
        RouteSpec memory failed = _route(false);
        failed.signerKey = OUTSIDER_KEY;
        _expectFailure(
            failed,
            _route(true),
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.InvalidRouteSignature.selector
        );

        RouteSpec memory succeeded = _route(true);
        succeeded.signerKey = OUTSIDER_KEY;
        _expectFailure(
            _route(false),
            succeeded,
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.InvalidRouteSignature.selector
        );

        failed = _route(false);
        failed.verifySender = false;
        _expectFailure(
            failed,
            _route(true),
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.InvalidParticipant.selector
        );
    }

    function testRejectsWrongIntentRouteDataAndReplayBypassNonce() external {
        RouteSpec memory failed = _route(false);
        failed.intent = keccak256("foreign-intent");
        _expectFailure(
            failed,
            _route(true),
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.InvalidIntent.selector
        );

        failed = _route(false);
        failed.data = bytes32(uint256(2));
        _expectFailure(
            failed,
            _route(true),
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.InvalidRouteData.selector
        );

        failed = _route(false);
        failed.nonce = bytes32(type(uint256).max);
        _expectFailure(
            failed,
            _route(true),
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.InvalidRouteNonce.selector
        );
    }

    function testRejectsWrongCommandsWrapAndNestedV3Route() external {
        RouteSpec memory failed = _route(false);
        failed.commands = hex"0b80";
        _expectFailure(
            failed,
            _route(true),
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.InvalidCommands.selector
        );

        failed = _route(false);
        failed.wrapRecipient = trader;
        _expectFailure(
            failed,
            _route(true),
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.InvalidRouteInput.selector
        );

        failed = _route(false);
        failed.outputRecipient = trader;
        _expectFailure(
            failed,
            _route(true),
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.InvalidRouteInput.selector
        );

        failed = _route(false);
        failed.path = abi.encodePacked(WETH, bytes3(uint24(3_000)), USDC);
        _expectFailure(
            failed,
            _route(true),
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.InvalidRouteInput.selector
        );

        failed = _route(false);
        failed.payerIsUser = true;
        _expectFailure(
            failed,
            _route(true),
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.InvalidRouteInput.selector
        );

        failed = _route(false);
        failed.minHopPriceX36 = new uint256[](1);
        failed.minHopPriceX36[0] = 1;
        _expectFailure(
            failed,
            _route(true),
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.InvalidRouteInput.selector
        );
    }

    function testRejectsNonCanonicalNestedInputEvenWhenDecodedValuesMatch() external {
        RouteSpec memory failed = _route(false);
        bytes[] memory inputs = _inputs(failed);
        inputs[0] = bytes.concat(inputs[0], bytes32(0));
        bytes memory malformed = _signedCalldataWithInputs(failed, inputs);
        bytes memory successful = _signedCalldata(_route(true));

        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.InvalidRouteInput.selector);
        predicate.validate(
            _encodedAttempt(
                malformed, FAILURE_TRANSACTION_NONCE, trader, ROUTER, AMOUNT_IN, MINIMUM_GAS_LIMIT, _failedReceipt()
            ),
            FAILURE_BLOCK,
            _encodedAttempt(
                successful,
                SUCCESS_TRANSACTION_NONCE,
                trader,
                ROUTER,
                AMOUNT_IN,
                MINIMUM_GAS_LIMIT,
                _successfulReceipt()
            ),
            SUCCESS_BLOCK,
            SOURCE_CHAIN_ID,
            _rule()
        );
    }

    function testRetryMustActuallyRefreshNonceDeadlineAndStaleMinimum() external {
        RouteSpec memory succeeded = _route(true);
        succeeded.nonce = FAILURE_ROUTE_NONCE;
        _expectFailure(
            _route(false),
            succeeded,
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.InvalidRouteNonce.selector
        );

        succeeded = _route(true);
        succeeded.deadline = FAILURE_DEADLINE - 1;
        _expectFailure(
            _route(false),
            succeeded,
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.InvalidDeadlineRefresh.selector
        );

        succeeded = _route(true);
        succeeded.minimumOut = FAILURE_MIN_OUT;
        _expectFailure(
            _route(false),
            succeeded,
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.SettledValueTooLow.selector
        );

        RouteSpec memory failed = _route(false);
        failed.minimumOut = ACTUAL_OUT;
        _expectFailure(
            failed,
            _route(true),
            _failedReceipt(),
            _successfulReceipt(),
            RetryCreditUniversalRouterPredicateV1.InvalidRouteRefresh.selector
        );
    }

    function testRejectsNonCanonicalOuterOffsetsTrailingBytesAndFailureLogs() external {
        bytes memory failedData = bytes.concat(_signedCalldata(_route(false)), bytes32(0));
        bytes memory successData = _signedCalldata(_route(true));
        bytes memory failed = _encodedAttempt(
            failedData, FAILURE_TRANSACTION_NONCE, trader, ROUTER, AMOUNT_IN, MINIMUM_GAS_LIMIT, _failedReceipt()
        );
        bytes memory succeeded = _encodedAttempt(
            successData, SUCCESS_TRANSACTION_NONCE, trader, ROUTER, AMOUNT_IN, MINIMUM_GAS_LIMIT, _successfulReceipt()
        );
        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.InvalidCalldata.selector);
        predicate.validate(failed, FAILURE_BLOCK, succeeded, SUCCESS_BLOCK, SOURCE_CHAIN_ID, _rule());

        failedData = _signedCalldata(_route(false));
        assembly ("memory-safe") {
            mstore(add(failedData, 0x24), 0x120)
        }
        failed = _encodedAttempt(
            failedData, FAILURE_TRANSACTION_NONCE, trader, ROUTER, AMOUNT_IN, MINIMUM_GAS_LIMIT, _failedReceipt()
        );
        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.InvalidCalldata.selector);
        predicate.validate(failed, FAILURE_BLOCK, succeeded, SUCCESS_BLOCK, SOURCE_CHAIN_ID, _rule());

        ReceiptSpec memory loggedFailure = _failedReceipt();
        loggedFailure.transferCount = 1;
        loggedFailure.transferEmitter = USDC;
        loggedFailure.transferFrom = POOL;
        loggedFailure.transferTo = trader;
        loggedFailure.transferAmount = 1;
        failed = _encodedAttempt(
            _signedCalldata(_route(false)),
            FAILURE_TRANSACTION_NONCE,
            trader,
            ROUTER,
            AMOUNT_IN,
            MINIMUM_GAS_LIMIT,
            loggedFailure
        );
        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.InvalidReceiptSequence.selector);
        predicate.validate(failed, FAILURE_BLOCK, succeeded, SUCCESS_BLOCK, SOURCE_CHAIN_ID, _rule());
    }

    function testSuccessRequiresExactOfficialPoolSwapAndCircleTransfer() external {
        ReceiptSpec memory success = _successfulReceipt();
        success.swapCount = 0;
        _expectFailure(
            _route(false),
            _route(true),
            _failedReceipt(),
            success,
            RetryCreditUniversalRouterPredicateV1.RequiredPoolSwapMissing.selector
        );

        success = _successfulReceipt();
        success.swapEmitter = address(0xBAD1);
        _expectFailure(
            _route(false),
            _route(true),
            _failedReceipt(),
            success,
            RetryCreditUniversalRouterPredicateV1.RequiredPoolSwapMissing.selector
        );

        success = _successfulReceipt();
        success.swapSender = address(0xBAD2);
        _expectFailure(
            _route(false),
            _route(true),
            _failedReceipt(),
            success,
            RetryCreditUniversalRouterPredicateV1.RequiredPoolSwapMissing.selector
        );

        success = _successfulReceipt();
        // The bounded fixture amount is many orders of magnitude below int256.max.
        // forge-lint: disable-next-line(unsafe-typecast)
        success.amount1 = int256(AMOUNT_IN + 1);
        _expectFailure(
            _route(false),
            _route(true),
            _failedReceipt(),
            success,
            RetryCreditUniversalRouterPredicateV1.RequiredPoolSwapMissing.selector
        );

        success = _successfulReceipt();
        success.transferEmitter = address(0xBAD3);
        _expectFailure(
            _route(false),
            _route(true),
            _failedReceipt(),
            success,
            RetryCreditUniversalRouterPredicateV1.RequiredSettlementTransferMissing.selector
        );

        success = _successfulReceipt();
        success.transferTo = address(0xBAD4);
        _expectFailure(
            _route(false),
            _route(true),
            _failedReceipt(),
            success,
            RetryCreditUniversalRouterPredicateV1.RequiredSettlementTransferMissing.selector
        );

        success = _successfulReceipt();
        success.transferAmount += 1;
        _expectFailure(
            _route(false),
            _route(true),
            _failedReceipt(),
            success,
            RetryCreditUniversalRouterPredicateV1.RequiredSettlementTransferMissing.selector
        );
    }

    function testRejectsDuplicatePoolOrSettlementEvidence() external {
        ReceiptSpec memory success = _successfulReceipt();
        success.swapCount = 2;
        _expectFailure(
            _route(false),
            _route(true),
            _failedReceipt(),
            success,
            RetryCreditUniversalRouterPredicateV1.DuplicatePoolSwap.selector
        );

        success = _successfulReceipt();
        success.transferCount = 2;
        _expectFailure(
            _route(false),
            _route(true),
            _failedReceipt(),
            success,
            RetryCreditUniversalRouterPredicateV1.DuplicateSettlementTransfer.selector
        );
    }

    function testRejectsEnvelopeReceiptWindowAndNativeVerifierFailures() external {
        bytes memory failedData = _signedCalldata(_route(false));
        bytes memory successData = _signedCalldata(_route(true));
        bytes memory failed = _encodedAttempt(
            failedData,
            FAILURE_TRANSACTION_NONCE,
            address(0xBAD1),
            ROUTER,
            AMOUNT_IN,
            MINIMUM_GAS_LIMIT,
            _failedReceipt()
        );
        bytes memory succeeded = _encodedAttempt(
            successData, SUCCESS_TRANSACTION_NONCE, trader, ROUTER, AMOUNT_IN, MINIMUM_GAS_LIMIT, _successfulReceipt()
        );
        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.InvalidParticipant.selector);
        predicate.validate(failed, FAILURE_BLOCK, succeeded, SUCCESS_BLOCK, SOURCE_CHAIN_ID, _rule());

        failed = _encodedAttempt(
            failedData, FAILURE_TRANSACTION_NONCE, trader, ROUTER, AMOUNT_IN + 1, MINIMUM_GAS_LIMIT, _failedReceipt()
        );
        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.InvalidTransactionValue.selector);
        predicate.validate(failed, FAILURE_BLOCK, succeeded, SUCCESS_BLOCK, SOURCE_CHAIN_ID, _rule());

        ReceiptSpec memory failedReceipt = _failedReceipt();
        failedReceipt.gasUsed = MAX_FAILURE_GAS_USED + 1;
        failed = _encodedAttempt(
            failedData, FAILURE_TRANSACTION_NONCE, trader, ROUTER, AMOUNT_IN, MINIMUM_GAS_LIMIT, failedReceipt
        );
        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.FailureGasExceeded.selector);
        predicate.validate(failed, FAILURE_BLOCK, succeeded, SUCCESS_BLOCK, SOURCE_CHAIN_ID, _rule());

        AttestcoinRetryCreditUniversalRouterVerifier.BatchProof memory proof = _validProof();
        nativeVerifier.setVerificationResult(false);
        vm.expectRevert(AttestcoinRetryCreditUniversalRouterVerifier.ProofVerificationFailed.selector);
        batchVerifier.verifyRelease(proof, _rule());
    }

    function testRejectsTargetGasChainStatusBlockGapAndTransactionNonceRegression() external {
        bytes memory failedData = _signedCalldata(_route(false));
        bytes memory successData = _signedCalldata(_route(true));
        bytes memory failed = _encodedAttempt(
            failedData,
            FAILURE_TRANSACTION_NONCE,
            trader,
            address(0xBAD1),
            AMOUNT_IN,
            MINIMUM_GAS_LIMIT,
            _failedReceipt()
        );
        bytes memory succeeded = _encodedAttempt(
            successData, SUCCESS_TRANSACTION_NONCE, trader, ROUTER, AMOUNT_IN, MINIMUM_GAS_LIMIT, _successfulReceipt()
        );
        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.InvalidTarget.selector);
        predicate.validate(failed, FAILURE_BLOCK, succeeded, SUCCESS_BLOCK, SOURCE_CHAIN_ID, _rule());

        failed = _encodedAttempt(
            failedData, FAILURE_TRANSACTION_NONCE, trader, ROUTER, AMOUNT_IN, MINIMUM_GAS_LIMIT - 1, _failedReceipt()
        );
        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.AttemptGasLimitTooLow.selector);
        predicate.validate(failed, FAILURE_BLOCK, succeeded, SUCCESS_BLOCK, SOURCE_CHAIN_ID, _rule());

        failed = _encodedAttempt(
            failedData, FAILURE_TRANSACTION_NONCE, trader, ROUTER, AMOUNT_IN, MINIMUM_GAS_LIMIT, _failedReceipt()
        );
        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.InvalidSourceChain.selector);
        predicate.validate(failed, FAILURE_BLOCK, succeeded, SUCCESS_BLOCK, 1, _rule());

        ReceiptSpec memory wrongFailureStatus = _failedReceipt();
        wrongFailureStatus.status = 1;
        failed = _encodedAttempt(
            failedData, FAILURE_TRANSACTION_NONCE, trader, ROUTER, AMOUNT_IN, MINIMUM_GAS_LIMIT, wrongFailureStatus
        );
        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.InvalidReceiptSequence.selector);
        predicate.validate(failed, FAILURE_BLOCK, succeeded, SUCCESS_BLOCK, SOURCE_CHAIN_ID, _rule());

        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.InvalidBlockGap.selector);
        predicate.validate(failed, FAILURE_BLOCK, succeeded, FAILURE_BLOCK + 11, SOURCE_CHAIN_ID, _rule());

        failed = _encodedAttempt(
            failedData, FAILURE_TRANSACTION_NONCE, trader, ROUTER, AMOUNT_IN, MINIMUM_GAS_LIMIT, _failedReceipt()
        );
        succeeded = _encodedAttempt(
            successData, FAILURE_TRANSACTION_NONCE, trader, ROUTER, AMOUNT_IN, MINIMUM_GAS_LIMIT, _successfulReceipt()
        );
        vm.expectRevert(RetryCreditUniversalRouterPredicateV1.InvalidRouteRefresh.selector);
        predicate.validate(failed, FAILURE_BLOCK, succeeded, SUCCESS_BLOCK, SOURCE_CHAIN_ID, _rule());
    }

    function _expectFailure(
        RouteSpec memory failedRoute,
        RouteSpec memory successfulRoute,
        ReceiptSpec memory failedReceipt,
        ReceiptSpec memory successfulReceipt,
        bytes4 expectedError
    ) private {
        bytes memory failed = _encodedAttempt(
            _signedCalldata(failedRoute),
            FAILURE_TRANSACTION_NONCE,
            trader,
            ROUTER,
            AMOUNT_IN,
            MINIMUM_GAS_LIMIT,
            failedReceipt
        );
        bytes memory succeeded = _encodedAttempt(
            _signedCalldata(successfulRoute),
            SUCCESS_TRANSACTION_NONCE,
            trader,
            ROUTER,
            AMOUNT_IN,
            MINIMUM_GAS_LIMIT,
            successfulReceipt
        );
        vm.expectRevert(expectedError);
        predicate.validate(failed, FAILURE_BLOCK, succeeded, SUCCESS_BLOCK, SOURCE_CHAIN_ID, _rule());
    }

    function _rule() private view returns (RetryCreditUniversalRouterPredicateV1.Rule memory rule) {
        return _ruleWithPolicy(POLICY_ID);
    }

    function _terms() private view returns (RetryCreditUniversalRouterPredicateV1.Rule memory rule) {
        return _ruleWithPolicy(bytes32(0));
    }

    function _ruleWithPolicy(bytes32 policyId)
        private
        view
        returns (RetryCreditUniversalRouterPredicateV1.Rule memory rule)
    {
        rule = RetryCreditUniversalRouterPredicateV1.Rule({
            routeSigner: routeSigner,
            trader: trader,
            router: ROUTER,
            weth: WETH,
            usdc: USDC,
            pool: POOL,
            policyId: policyId,
            actionId: ACTION_ID,
            amountIn: AMOUNT_IN,
            minimumSuccessfulOut: MINIMUM_SUCCESSFUL_OUT,
            startBlock: START_BLOCK,
            endBlock: END_BLOCK,
            maxBlockGap: 10,
            minimumAttemptGasLimit: MINIMUM_GAS_LIMIT,
            maxFailureGasUsed: MAX_FAILURE_GAS_USED
        });
    }

    function _route(bool successful) private view returns (RouteSpec memory route) {
        return _routeForRule(successful, _rule());
    }

    function _routeForRule(bool successful, RetryCreditUniversalRouterPredicateV1.Rule memory rule)
        private
        view
        returns (RouteSpec memory route)
    {
        route.commands = hex"0b00";
        route.wrapRecipient = address(2);
        route.wrapAmount = AMOUNT_IN;
        route.outputRecipient = address(1);
        route.amountIn = AMOUNT_IN;
        route.minimumOut = successful ? SUCCESS_MIN_OUT : FAILURE_MIN_OUT;
        route.path = abi.encodePacked(WETH, bytes3(uint24(500)), USDC);
        route.payerIsUser = false;
        route.minHopPriceX36 = new uint256[](0);
        route.intent = predicate.routeIntent(rule);
        route.data = successful ? bytes32(uint256(2)) : bytes32(uint256(1));
        route.verifySender = true;
        route.nonce = successful ? SUCCESS_ROUTE_NONCE : FAILURE_ROUTE_NONCE;
        route.deadline = successful ? SUCCESS_DEADLINE : FAILURE_DEADLINE;
        route.signerKey = ROUTE_SIGNER_KEY;
    }

    function _inputs(RouteSpec memory route) private pure returns (bytes[] memory inputs) {
        inputs = new bytes[](2);
        inputs[0] = abi.encode(route.wrapRecipient, route.wrapAmount);
        inputs[1] = abi.encode(
            route.outputRecipient, route.amountIn, route.minimumOut, route.path, route.payerIsUser, route.minHopPriceX36
        );
    }

    function _signedCalldata(RouteSpec memory route) private view returns (bytes memory) {
        return _signedCalldataWithInputs(route, _inputs(route));
    }

    function _signedCalldataWithInputs(RouteSpec memory route, bytes[] memory inputs)
        private
        view
        returns (bytes memory)
    {
        bytes32 digest = _digest(route, inputs);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(route.signerKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);
        return abi.encodeWithSelector(
            predicate.EXECUTE_SIGNED_SELECTOR(),
            route.commands,
            inputs,
            route.intent,
            route.data,
            route.verifySender,
            route.nonce,
            signature,
            route.deadline
        );
    }

    function _digest(RouteSpec memory route, bytes[] memory inputs) private view returns (bytes32) {
        bytes32[] memory inputHashes = new bytes32[](inputs.length);
        for (uint256 i; i < inputs.length; ++i) {
            inputHashes[i] = keccak256(inputs[i]);
        }
        address sender = route.verifySender ? trader : address(0);
        bytes32 structHash = keccak256(
            abi.encode(
                EXECUTE_SIGNED_TYPEHASH,
                keccak256(route.commands),
                keccak256(abi.encodePacked(inputHashes)),
                route.intent,
                route.data,
                sender,
                route.nonce,
                route.deadline
            )
        );
        bytes32 domain = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("UniversalRouter"), keccak256("2"), SOURCE_CHAIN_ID, ROUTER)
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _validProof() private view returns (AttestcoinRetryCreditUniversalRouterVerifier.BatchProof memory proof) {
        return _validProofForRule(_rule());
    }

    function _validProofForRule(RetryCreditUniversalRouterPredicateV1.Rule memory rule)
        private
        view
        returns (AttestcoinRetryCreditUniversalRouterVerifier.BatchProof memory proof)
    {
        bytes memory failed = _encodedAttempt(
            _signedCalldata(_routeForRule(false, rule)),
            FAILURE_TRANSACTION_NONCE,
            trader,
            ROUTER,
            AMOUNT_IN,
            MINIMUM_GAS_LIMIT,
            _failedReceipt()
        );
        bytes memory succeeded = _encodedAttempt(
            _signedCalldata(_routeForRule(true, rule)),
            SUCCESS_TRANSACTION_NONCE,
            trader,
            ROUTER,
            AMOUNT_IN,
            MINIMUM_GAS_LIMIT,
            _successfulReceipt()
        );
        proof.sourceBlocks = new uint64[](2);
        proof.sourceBlocks[0] = FAILURE_BLOCK;
        proof.sourceBlocks[1] = SUCCESS_BLOCK;
        proof.encodedTransactions = new bytes[](2);
        proof.encodedTransactions[0] = failed;
        proof.encodedTransactions[1] = succeeded;
        proof.merkleProofs = new INativeQueryVerifier.MerkleProof[](2);
        proof.merkleProofs[0] = _merkleProof(keccak256(failed));
        proof.merkleProofs[1] = _merkleProof(keccak256(succeeded));
        proof.lowerEndpointDigest = bytes32(uint256(1));
        proof.continuityRoots = new bytes32[](0);
    }

    function _createAndActivateServiceCredit() private returns (uint256 serviceCreditNumber, bytes32 policyId) {
        vm.prank(sponsor);
        serviceCreditNumber =
            servicePool.createServiceCredit{value: CREDIT_AMOUNT}(_terms(), uint64(block.timestamp + 7 days));
        RetryCreditUniversalRouterPool.ServiceCredit memory draft = servicePool.getServiceCredit(serviceCreditNumber);
        vm.roll(draft.creationBlock + 1);
        vm.setBlockhash(draft.creationBlock, CREATION_BLOCK_HASH);
        vm.prank(sponsor);
        policyId = servicePool.activateServiceCredit(serviceCreditNumber);
    }

    function _merkleProof(bytes32 root) private pure returns (INativeQueryVerifier.MerkleProof memory proof) {
        proof.root = root;
        proof.siblings = new INativeQueryVerifier.MerkleProofEntry[](0);
    }

    function _failedReceipt() private pure returns (ReceiptSpec memory receipt) {
        receipt.status = 0;
        receipt.gasUsed = FAILURE_GAS_USED;
    }

    function _successfulReceipt() private view returns (ReceiptSpec memory receipt) {
        receipt.status = 1;
        receipt.gasUsed = 180_000;
        receipt.swapCount = 1;
        receipt.swapEmitter = POOL;
        receipt.swapSender = ROUTER;
        receipt.swapRecipient = trader;
        // The bounded fixture amounts are many orders of magnitude below int256.max.
        // forge-lint: disable-next-line(unsafe-typecast)
        receipt.amount0 = -int256(ACTUAL_OUT);
        // forge-lint: disable-next-line(unsafe-typecast)
        receipt.amount1 = int256(AMOUNT_IN);
        receipt.transferCount = 1;
        receipt.transferEmitter = USDC;
        receipt.transferFrom = POOL;
        receipt.transferTo = trader;
        receipt.transferAmount = ACTUAL_OUT;
    }

    function _encodedAttempt(
        bytes memory transactionData,
        uint64 nonce,
        address sender,
        address target,
        uint256 value,
        uint64 gasLimit,
        ReceiptSpec memory receiptSpec
    ) private pure returns (bytes memory) {
        bytes memory common = abi.encode(nonce, gasLimit, sender, false, target, value, transactionData);
        EvmV1Decoder.LogEntryTuple[] memory logs =
            new EvmV1Decoder.LogEntryTuple[](uint256(receiptSpec.swapCount) + uint256(receiptSpec.transferCount));
        uint256 cursor;
        for (uint256 i; i < receiptSpec.swapCount; ++i) {
            logs[cursor++] = _swapLog(receiptSpec);
        }
        for (uint256 i; i < receiptSpec.transferCount; ++i) {
            logs[cursor++] = _transferLog(receiptSpec);
        }
        bytes memory receipt = abi.encode(receiptSpec.status, receiptSpec.gasUsed, logs, new bytes(256));
        bytes[] memory chunks = new bytes[](3);
        chunks[0] = common;
        chunks[1] = _typeSpecific();
        chunks[2] = receipt;
        return abi.encode(uint8(2), chunks);
    }

    function _swapLog(ReceiptSpec memory receiptSpec) private pure returns (EvmV1Decoder.LogEntryTuple memory log) {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)");
        topics[1] = bytes32(uint256(uint160(receiptSpec.swapSender)));
        topics[2] = bytes32(uint256(uint160(receiptSpec.swapRecipient)));
        log = EvmV1Decoder.LogEntryTuple({
            address_: receiptSpec.swapEmitter,
            topics: topics,
            data: abi.encode(
                receiptSpec.amount0,
                receiptSpec.amount1,
                uint160(81_231_334_464_000_000_000_000),
                uint128(9_000_000_000_000),
                int24(-196_350)
            )
        });
    }

    function _transferLog(ReceiptSpec memory receiptSpec) private pure returns (EvmV1Decoder.LogEntryTuple memory log) {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = keccak256("Transfer(address,address,uint256)");
        topics[1] = bytes32(uint256(uint160(receiptSpec.transferFrom)));
        topics[2] = bytes32(uint256(uint160(receiptSpec.transferTo)));
        log = EvmV1Decoder.LogEntryTuple({
            address_: receiptSpec.transferEmitter, topics: topics, data: abi.encode(receiptSpec.transferAmount)
        });
    }

    function _typeSpecific() private pure returns (bytes memory) {
        EvmV1Decoder.AccessListEntry[] memory accessList = new EvmV1Decoder.AccessListEntry[](0);
        return abi.encode(
            uint64(SOURCE_CHAIN_ID),
            uint128(1_000_000_000),
            uint128(2_000_000_000),
            accessList,
            uint8(0),
            bytes32(uint256(1)),
            bytes32(uint256(2))
        );
    }
}
