// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IAuthCaptureEscrow
/// @notice Minimal interface to Base Commerce Payments `AuthCaptureEscrow` v1.1
///         (https://github.com/base/commerce-payments, read at b748fdd, 2026-09-03).
///         v1.1 canonical CREATE2 address (Base and Base Sepolia): 0xf96815976523E00e65Be8f34cA5e64b4f41EB19c.
/// @dev v1.1 `capture`/`charge` take an absolute `feeAmount`. The v1.0 escrow
///      (0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff) takes `uint16 feeBps` instead and is NOT supported here.
///      Field order and types of PaymentInfo must match the escrow exactly (it is hashed with PAYMENT_INFO_TYPEHASH).
interface IAuthCaptureEscrow {
    struct PaymentInfo {
        address operator;
        address payer;
        address receiver;
        address token;
        uint120 maxAmount;
        uint48 preApprovalExpiry;
        uint48 authorizationExpiry;
        uint48 refundExpiry;
        uint16 minFeeBps;
        uint16 maxFeeBps;
        address feeReceiver;
        uint256 salt;
    }

    function authorize(
        PaymentInfo calldata paymentInfo,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData
    ) external;

    function capture(PaymentInfo calldata paymentInfo, uint256 amount, uint256 feeAmount, address feeReceiver) external;

    function void(PaymentInfo calldata paymentInfo) external;

    function getHash(PaymentInfo calldata paymentInfo) external view returns (bytes32);

    function paymentState(bytes32 paymentInfoHash)
        external
        view
        returns (bool hasCollectedPayment, uint120 capturableAmount, uint120 refundableAmount);
}
