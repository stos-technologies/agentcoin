// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IArbitrator
/// @notice Minimal external-arbitrator interface. Stub for future Kleros (ERC-792) or UMA
///         (Optimistic Oracle) adapters (not implemented). The arbitrator MUST later call
///         IArbitrable(caller).rule(jobId, payoutBps) at most once per dispute.
/// @dev Fee model (ASSUMPTIONS E-17, E-17a, E-17b):
///      1. Quote: the arbitrable reads arbitrationCost(jobId, amount) (jobId 0 = prospective job).
///      2. Challenge: the arbitrable pulls challenge bond + quoted cost from the challenger and
///         HOLDS the cost in escrow, then calls requestRuling(). No token moves to the arbitrator.
///      3. Ruling: inside rule(), the arbitrable pays the held cost to the arbitrator (msg.sender).
///         On a material ruling the losing side reimburses the challenger.
///      4. Stale dispute (no ruling within arbitrationTimeout): the held cost is refunded to the
///         challenger and a later rule() reverts.
///      Arbitrators that require prepayment (Kleros createDispute{value: cost}) need an adapter
///      that fronts the cost; see ASSUMPTIONS E-17c.
interface IArbitrator {
    /// @notice Cost in payment-token units of one ruling for a job of `amount` token units.
    /// @param jobId Arbitrable-side job id; 0 for a prospective job (quote).
    /// @param amount Job amount (escrow) or budget (adapter) in token units.
    function arbitrationCost(uint256 jobId, uint256 amount) external view returns (uint256 cost);

    /// @param jobId Caller-side job id.
    /// @param challenger Address that posted the challenge bond.
    /// @param verdictPayoutBps Payout to provider under the challenged verdict (0..10000).
    /// @param reasonHash Hash of off-chain challenge evidence.
    /// @return disputeId Arbitrator-side identifier.
    function requestRuling(uint256 jobId, address challenger, uint16 verdictPayoutBps, bytes32 reasonHash)
        external
        returns (uint256 disputeId);
}

/// @title IArbitrable
/// @notice Callback implemented by the escrow and the ERC-8183 evaluator adapter.
interface IArbitrable {
    /// @param jobId Caller-side job id.
    /// @param payoutBps Final payout to provider in basis points (0 = full refund to client, 10000 = full payment).
    function rule(uint256 jobId, uint16 payoutBps) external;
}
