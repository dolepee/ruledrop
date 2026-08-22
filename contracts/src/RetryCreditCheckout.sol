// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {RetryCreditPredicateV2} from "./RetryCreditPredicateV2.sol";

/// @notice Minimal source checkout whose authorized failed-then-settled attempts can earn a RetryCredit.
contract RetryCreditCheckout {
    using SafeERC20 for IERC20;

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant ATTEMPT_TYPEHASH = keccak256(
        "Attempt(uint256 sourceChainId,address target,address beneficiary,address settlementAsset,address settlementRecipient,bytes32 policyId,bytes32 actionId,uint64 quoteVersion,uint256 settledValue,bytes32 payloadHash,uint64 validUntil)"
    );
    bytes32 public constant DOMAIN_NAME_HASH = keccak256("RetryCredit Checkout");
    bytes32 public constant DOMAIN_VERSION_HASH = keccak256("1");

    address public immutable attemptSigner;
    IERC20 public immutable settlementAsset;

    mapping(bytes32 sku => uint64 version) public inventoryVersions;
    mapping(bytes32 actionId => bool settled) public settledActions;

    event CheckoutSettled(
        bytes32 indexed policyId,
        bytes32 indexed actionId,
        address indexed beneficiary,
        address settlementAsset,
        address settlementRecipient,
        uint256 settledValue,
        bytes32 payloadHash,
        uint64 quoteVersion
    );

    error ActionAlreadySettled();
    error AttemptExpired();
    error InexactSettlement();
    error InvalidAttempt();
    error InvalidAttemptSignature();
    error NotAttemptSigner();
    error StaleQuote();

    constructor(address attemptSigner_, IERC20 settlementAsset_) {
        if (attemptSigner_ == address(0) || address(settlementAsset_) == address(0)) revert InvalidAttempt();
        attemptSigner = attemptSigner_;
        settlementAsset = settlementAsset_;
    }

    function setInventoryVersion(bytes32 sku, uint64 version) external {
        if (msg.sender != attemptSigner) revert NotAttemptSigner();
        if (sku == bytes32(0) || version == 0) revert InvalidAttempt();
        inventoryVersions[sku] = version;
    }

    function checkout(
        RetryCreditPredicateV2.Attempt calldata attempt,
        bytes calldata payload,
        bytes calldata attemptSignature
    ) external {
        if (
            attempt.sourceChainId != block.chainid || attempt.target != address(this)
                || attempt.beneficiary != msg.sender || attempt.settlementAsset != address(settlementAsset)
                || attempt.settlementRecipient == address(0) || attempt.settlementRecipient == attempt.beneficiary
                || attempt.policyId == bytes32(0) || attempt.actionId == bytes32(0) || attempt.settledValue == 0
                || attempt.payloadHash != keccak256(payload)
        ) revert InvalidAttempt();
        if (block.number > attempt.validUntil) revert AttemptExpired();
        if (settledActions[attempt.actionId]) revert ActionAlreadySettled();

        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(_attemptDigest(attempt), attemptSignature);
        if (error != ECDSA.RecoverError.NoError || recovered != attemptSigner) {
            revert InvalidAttemptSignature();
        }

        if (payload.length != 96) revert InvalidAttempt();
        (address merchant, bytes32 sku, uint64 inventoryVersion) = abi.decode(payload, (address, bytes32, uint64));
        if (
            merchant != attempt.settlementRecipient || inventoryVersions[sku] != inventoryVersion
                || attempt.quoteVersion != inventoryVersion
        ) {
            revert StaleQuote();
        }

        settledActions[attempt.actionId] = true;
        _settleExactly(msg.sender, merchant, attempt.settledValue);
        _emitSettlement(attempt);
    }

    function _settleExactly(address payer, address recipient, uint256 amount) private {
        uint256 payerBefore = settlementAsset.balanceOf(payer);
        uint256 recipientBefore = settlementAsset.balanceOf(recipient);
        settlementAsset.safeTransferFrom(payer, recipient, amount);
        uint256 payerAfter = settlementAsset.balanceOf(payer);
        uint256 recipientAfter = settlementAsset.balanceOf(recipient);
        if (
            payerAfter > payerBefore || recipientAfter < recipientBefore || payerBefore - payerAfter != amount
                || recipientAfter - recipientBefore != amount
        ) revert InexactSettlement();
    }

    function _emitSettlement(RetryCreditPredicateV2.Attempt calldata attempt) private {
        emit CheckoutSettled(
            attempt.policyId,
            attempt.actionId,
            attempt.beneficiary,
            address(settlementAsset),
            attempt.settlementRecipient,
            attempt.settledValue,
            attempt.payloadHash,
            attempt.quoteVersion
        );
    }

    function attemptDigest(RetryCreditPredicateV2.Attempt calldata attempt) external pure returns (bytes32) {
        return _attemptDigest(attempt);
    }

    function _attemptDigest(RetryCreditPredicateV2.Attempt calldata attempt) private pure returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTEMPT_TYPEHASH,
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
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, attempt.sourceChainId, attempt.target
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
