// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IEvaluatorRegistry
/// @notice Interface the escrow and the ERC-8183 adapter use to check, lock and slash evaluator stake.
interface IEvaluatorRegistry {
    function isActive(address evaluator) external view returns (bool);
    function minStake() external view returns (uint256);
    function stakeOf(address evaluator) external view returns (uint256);
    function lockExposure(address evaluator, uint256 jobId, uint256 amount) external;
    function releaseExposure(address evaluator, uint256 jobId, uint256 amount) external;
    /// @return slashed Amount actually removed from stake (capped at current stake).
    function slash(address evaluator, uint256 jobId, uint256 amount, address harmedParty, uint8 reason)
        external
        returns (uint256 slashed);
    /// @notice Moves up to `amount` of stake 100% to `to` (arbitration-fee reimbursement, E-17).
    /// @return paid Amount actually paid (capped at current stake).
    function reimburse(address evaluator, uint256 jobId, uint256 amount, address to) external returns (uint256 paid);
}

/// @title IEvaluatorQuorum (NOT IMPLEMENTED in v0)
/// @notice Placeholder for N-of-M evaluator panels. v0 uses a single evaluator per job.
///         A future quorum contract can be named as the job evaluator and call verdict()
///         after aggregating member votes, so JobEscrow does not need to change.
interface IEvaluatorQuorum {
    function members(uint256 jobId) external view returns (address[] memory);
    function threshold(uint256 jobId) external view returns (uint256);
}
