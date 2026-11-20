// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PayoutScheduleLib
/// @notice Pure helpers for JobEscrow v0.6 payout schedules (AD-014 and its #2887 amendments).
///         required_pass counts only required criteria whose result is exactly pass;
///         fail, not-evaluated, and error never count.
library PayoutScheduleLib {
    uint16 internal constant BPS = 10_000;
    uint8 internal constant MIN_REQUIRED = 1;
    uint8 internal constant MAX_REQUIRED = 15;

    /// @dev Mirrors the acceptance-record result enum, plus the amendment's `error`.
    enum CriterionResult {
        Pass,
        Fail,
        NotEvaluated,
        Error
    }

    function packTable(uint16[] memory entries) internal pure returns (uint256 table) {
        require(entries.length <= 16, "table too long");
        for (uint256 i = 0; i < entries.length; i++) {
            table |= uint256(entries[i]) << (16 * i);
        }
    }

    function entryAt(uint256 table, uint8 k) internal pure returns (uint16) {
        return uint16(table >> (16 * uint256(k)));
    }

    function popcount(uint16 mask) internal pure returns (uint8 n) {
        uint16 x = mask;
        while (x != 0) {
            unchecked {
                n++;
            }
            x &= x - 1;
        }
    }

    /// @notice Bits 0..requiredTotal-1. requiredTotal is 1..15.
    function requiredBits(uint8 requiredTotal) internal pure returns (uint16) {
        return uint16((uint256(1) << requiredTotal) - 1);
    }

    /// @notice required_pass = popcount(passMask restricted to required criteria).
    function requiredPassFromMask(uint16 passMask, uint8 requiredTotal) internal pure returns (uint8) {
        return popcount(passMask & requiredBits(requiredTotal));
    }

    /// @notice Walk a criteria-document-order result list. Only `required == true` rows
    ///         occupy mask bits, in that order. Only `Pass` sets a bit / increments required_pass.
    function requiredCounts(bool[] memory required, CriterionResult[] memory results)
        internal
        pure
        returns (uint8 requiredPass, uint8 requiredTotal, uint16 passMask)
    {
        require(required.length == results.length, "length");
        uint8 bit;
        for (uint256 i = 0; i < required.length; i++) {
            if (!required[i]) continue;
            require(bit < MAX_REQUIRED, "too many required");
            requiredTotal++;
            if (results[i] == CriterionResult.Pass) {
                requiredPass++;
                passMask |= uint16(uint256(1) << bit);
            }
            bit++;
        }
    }

    function scheduleValid(bytes32 docHash, uint8 requiredTotal, uint256 bpsTable) internal pure returns (bool) {
        if (docHash == bytes32(0)) return false;
        if (requiredTotal < MIN_REQUIRED || requiredTotal > MAX_REQUIRED) return false;
        uint16 prev = 0;
        for (uint8 k = 0; k <= requiredTotal; k++) {
            uint16 bps = entryAt(bpsTable, k);
            if (bps > BPS) return false;
            if (k > 0 && bps < prev) return false;
            prev = bps;
        }
        if (requiredTotal < MAX_REQUIRED) {
            uint256 hi = bpsTable >> (16 * (uint256(requiredTotal) + 1));
            if (hi != 0) return false;
        }
        return true;
    }

    function tableContains(uint256 bpsTable, uint8 requiredTotal, uint16 payoutBps) internal pure returns (bool) {
        for (uint8 k = 0; k <= requiredTotal; k++) {
            if (entryAt(bpsTable, k) == payoutBps) return true;
        }
        return false;
    }
}
