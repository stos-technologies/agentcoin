// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IEvaluatorRegistry} from "../interfaces/IEvaluatorRegistry.sol";
import {IArbitrator, IArbitrable} from "../interfaces/IArbitrator.sol";
import {PayoutScheduleLib} from "../PayoutScheduleLib.sol";
import {IAuthCaptureEscrow} from "./IAuthCaptureEscrow.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title AgentKoinAuthCaptureArbiterV03 (PROTOTYPE, unaudited, local only; not deployed)
/// @notice Immutable x402 `auth-capture` operator of type "custom" for Base Commerce Payments
///         `AuthCaptureEscrow` v1.1. Funds stay in the escrow; this contract is `PaymentInfo.operator` and is
///         the only address that can capture/void them. It does so only after AgentKoin's lifecycle:
///         authorize -> bindTerms (salt-committed terms, evaluator accepts) -> submit -> verdictScheduled
///         (AD-014 pass count -> bps table) -> challenge window (optional arbitrator) -> finalize
///         (capture bps share, void remainder). Missed verdict => full void + slash.
///         No owner, no admin setters, no proxy. Spec: research/adoption-week1/arbiter-spec.md;
///         compliance table: docs/AUTH-CAPTURE-ARBITER.md.
///         v0.2 (source only; the Base Sepolia deployment 0x8b4B...453A is v0.1): the submitting party commits a
///         `resultDigest` (sha256 of the canonical result bytes) at submit; every verdict must name the same
///         digest (`ResultDigestMismatch` otherwise). Verdicts can be relayed as EIP-712 `OutsideVerdict`
///         signatures. An optional, separate `BuyerAcceptance` record (payer-signed, own typehash and storage)
///         never affects settlement, and a verdict-only settlement reports `BuyerDecision.None`.
///         v0.3 (side-by-side copy of v0.2; v0.2 is unchanged): optional `Terms.submitter`. When nonzero, only
///         that address may `submit`; when zero, `info.receiver` submits exactly as in v0.2. `submitter` is part
///         of TERMS_TYPEHASH, so the buyer-signed salt and every digest that names termsHash commit to it.
///         Capture still pays `info.receiver` (e.g. a keyless Stripe deposit address). EIP-712 version "0.3".
contract AgentKoinAuthCaptureArbiterV03 is IArbitrable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;
    uint8 public constant SLASH_MISSED_VERDICT = 1;
    uint8 public constant SLASH_OVERTURNED_VERDICT = 2;
    uint8 public constant BINDING_MODE_COMMITTED = 1;

    uint8 public constant VOID_UNBOUND = 1;
    uint8 public constant VOID_NO_SUBMIT = 2;
    uint8 public constant VOID_MISSED_VERDICT = 3;
    uint8 public constant VOID_AUTH_EXPIRED = 4; // settlement attempted at/after authorizationExpiry

    /// @notice Commerce Payments v1.0 escrow (uint16 feeBps capture ABI). Rejected.
    address public constant ESCROW_V1_0 = 0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff;

    bytes32 public constant TERMS_TYPEHASH = keccak256(
        "AgentKoinTerms(address evaluator,bytes32 criteriaHash,bytes32 scheduleHash,uint8 requiredTotal,uint256 bpsTable,uint48 submitBy,uint32 evalWindow,address submitter)"
    );
    bytes32 public constant AGK_SALT_TYPEHASH = keccak256("AgentKoinTermsSalt(bytes32 termsHash,uint256 saltNonce)");

    string public constant VERSION = "0.3";
    /// @notice EIP-712 domain: {name: "x402 outside-verdict", version: "0.3", chainId, verifyingContract: this}.
    string public constant EIP712_NAME = "x402 outside-verdict";
    string public constant EIP712_VERSION = "0.3";
    bytes32 public constant OUTSIDE_VERDICT_TYPEHASH = keccak256(
        "OutsideVerdict(bytes32 paymentInfoHash,bytes32 termsHash,bytes32 deliverableHash,bytes32 resultDigest,uint16 passMask,uint16 payoutBps,bytes32 reasonHash)"
    );
    bytes32 public constant BUYER_ACCEPTANCE_TYPEHASH = keccak256(
        "BuyerAcceptance(bytes32 paymentInfoHash,bytes32 termsHash,bytes32 resultDigest,uint8 decision,bytes32 noteHash)"
    );

    /// @notice Evaluator verdict attestation (x402 outside-verdict, plus resultDigest).
    struct OutsideVerdict {
        bytes32 paymentInfoHash; // escrow getHash(paymentInfo) == payment key
        bytes32 termsHash;
        bytes32 deliverableHash; // as submitted by the effective submitter
        bytes32 resultDigest; // sha256 of the canonical result bytes the evaluator judged
        uint16 passMask;
        uint16 payoutBps; // must equal bpsTable[popcount(passMask)]
        bytes32 reasonHash;
    }

    /// @notice Payer's own statement about the delivered result. Separate from the verdict; never moves funds.
    struct BuyerAcceptance {
        bytes32 paymentInfoHash;
        bytes32 termsHash;
        bytes32 resultDigest; // must equal the submitted resultDigest
        uint8 decision; // 1 = Accepted, 2 = Rejected (BuyerDecision)
        bytes32 noteHash; // optional pointer to the buyer's note; may be zero
    }

    enum BuyerDecision {
        None,
        Accepted,
        Rejected
    }

    /// @notice Stored buyer acceptance. decision == None means no record exists.
    struct AcceptanceRecord {
        BuyerDecision decision;
        uint48 recordedAt;
        bytes32 resultDigest;
        bytes32 noteHash;
    }

    /// @notice Machine-readable outcome. `settledOn` is always the verdict (or ruling) path; `buyerDecision`
    ///         is reported separately and is None unless the payer recorded one.
    struct Outcome {
        State state;
        bool verdictRecorded;
        uint16 payoutBps;
        bytes32 resultDigest;
        BuyerDecision buyerDecision;
        bool buyerAccepted;
    }

    /// @notice Judging terms. Committed by the buyer through PaymentInfo.salt (binding mode 1).
    struct Terms {
        address evaluator; // staked evaluator; must be REGISTRY.isActive at bind
        bytes32 criteriaHash; // sha256 of criteria.json (as JobEscrow v0.6 docHash)
        bytes32 scheduleHash; // sha256 of schedule.json
        uint8 requiredTotal; // 1..15
        uint256 bpsTable; // JobEscrow v0.6 packing: entry k = bps when k required pass, 16 bits at [16k, 16k+16)
        uint48 submitBy; // absolute; the effective submitter must submit by this time
        uint32 evalWindow; // seconds after submit; >= CONFIG evalWindow floor
        address submitter; // v0.3: who may call submit; zero = info.receiver (v0.2 behaviour)
    }

    /// @notice Immutable configuration (constructor only).
    struct Config {
        uint32 evalWindow; // floor for Terms.evalWindow
        uint32 challengeWindow; // seconds after verdict
        uint32 rulingWindow; // seconds after challenge for the arbitrator to rule
        uint32 minMarginSeconds; // safety gap before authorizationExpiry (> 0)
        uint16 missedVerdictSlashBps; // of registry minStake pinned at bind
        uint16 wrongVerdictSlashBps; // of registry minStake pinned at bind
        uint16 materialDiffBps; // |ruling - verdict| > this => overturned (JobEscrow v0.6 rule)
        uint256 minChallengeBond; // token units
    }

    enum State {
        None,
        Authorized,
        Bound,
        Submitted,
        Verdict,
        Challenged,
        Finalized,
        Voided
    }

    struct Payment {
        State state;
        uint8 bindingMode;
        uint8 requiredTotal;
        uint16 passMask;
        uint16 payoutBps;
        uint48 submitBy;
        uint32 evalWindow;
        uint48 submittedAt;
        uint48 verdictAt;
        uint48 disputedAt;
        address evaluator;
        address submitter; // v0.3: effective submitter, fixed at bind
        uint256 amount;
        uint256 bpsTable;
        uint256 slashBase;
        bytes32 termsHash;
        bytes32 deliverableHash;
        bytes32 resultDigest; // committed at submit; every verdict must name it
        bytes32 reasonHash;
    }

    struct Dispute {
        address challenger;
        uint256 bond;
        uint256 arbFee;
        uint256 disputeId;
    }

    IAuthCaptureEscrow public immutable ESCROW;
    IEvaluatorRegistry public immutable REGISTRY;
    IArbitrator public immutable ARBITRATOR; // zero => challenges disabled
    IERC20 public immutable TOKEN;
    uint256 public immutable MAX_AMOUNT_PER_PAYMENT;

    uint32 internal immutable _evalWindow;
    uint32 internal immutable _challengeWindow;
    uint32 internal immutable _rulingWindow;
    uint32 internal immutable _minMargin;
    uint16 internal immutable _missedBps;
    uint16 internal immutable _wrongBps;
    uint16 internal immutable _materialDiffBps;
    uint256 internal immutable _minChallengeBond;

    mapping(bytes32 key => Payment) internal _payments;
    mapping(bytes32 key => IAuthCaptureEscrow.PaymentInfo) internal _infos;
    mapping(bytes32 key => Dispute) internal _disputes;
    mapping(bytes32 key => AcceptanceRecord) internal _acceptances;

    event PaymentAuthorized(bytes32 indexed key, address indexed payer, address indexed receiver, uint256 amount);
    event TermsBound(
        bytes32 indexed key, bytes32 termsHash, uint8 bindingMode, address indexed evaluator, address submitter
    );
    event Submitted(bytes32 indexed key, address indexed submitter, bytes32 deliverableHash, bytes32 resultDigest);
    event Verdict(
        bytes32 indexed key,
        address indexed evaluator,
        uint16 passMask,
        uint16 payoutBps,
        bytes32 resultDigest,
        bytes32 reasonHash
    );
    event BuyerAcceptanceRecorded(
        bytes32 indexed key, address indexed payer, BuyerDecision decision, bytes32 resultDigest, bytes32 noteHash
    );
    event Challenged(
        bytes32 indexed key,
        address indexed challenger,
        uint256 bond,
        uint256 arbFee,
        uint256 disputeId,
        bytes32 reasonHash
    );
    event Ruled(bytes32 indexed key, uint16 verdictBps, uint16 rulingBps, bool overturned);
    event DisputeTimedOut(bytes32 indexed key);
    event Slashed(bytes32 indexed key, address indexed evaluator, uint8 reason, uint256 amount);
    /// @dev buyerDecision is the acceptance record at settlement time (None = the buyer recorded nothing).
    event Finalized(bytes32 indexed key, uint256 toReceiver, uint256 toPayer, BuyerDecision buyerDecision);
    event TimedOut(bytes32 indexed key, uint256 slashed);
    event Voided(bytes32 indexed key, uint8 reason, uint256 amount);

    error ZeroAddress();
    error InvalidConfig();
    error UnsupportedEscrow();
    error WrongOperator();
    error ChargeNotSupported();
    error TokenNotAllowed();
    error FeeNotZero();
    error RefundExpiryMismatch();
    error AmountTooHigh();
    error DeadlineTooShort();
    error SaltMismatch();
    error InvalidTerms();
    error EvaluatorInactive();
    error EvaluatorConflict();
    error SubmitterIsPayer();
    error WrongState(State current);
    error Unauthorized();
    error SubmitWindowClosed();
    error SubmitWindowOpen();
    error EvalWindowClosed();
    error EvalWindowOpen();
    error ChallengeWindowClosed();
    error ChallengeWindowOpen();
    error RulingWindowClosed();
    error RulingWindowOpen();
    error NoArbitrator();
    error RequiredTotalMismatch();
    error InvalidPassMask();
    error RequiredPassMismatch();
    error InvalidPayout();
    error ZeroHash();
    error ResultDigestMismatch(bytes32 committed, bytes32 given);
    error VerdictFieldMismatch();
    error BadSignature();
    error InvalidDecision();
    error AcceptanceAlreadyRecorded();

    constructor(
        IAuthCaptureEscrow escrow_,
        IEvaluatorRegistry registry_,
        IArbitrator arbitrator_,
        IERC20 token_,
        uint256 maxAmountPerPayment_,
        Config memory c
    ) EIP712(EIP712_NAME, EIP712_VERSION) {
        if (address(escrow_) == address(0) || address(registry_) == address(0) || address(token_) == address(0)) {
            revert ZeroAddress();
        }
        if (address(escrow_) == ESCROW_V1_0) revert UnsupportedEscrow();
        if (
            maxAmountPerPayment_ == 0 || c.evalWindow == 0 || c.challengeWindow == 0 || c.rulingWindow == 0
                || c.minMarginSeconds == 0 || c.missedVerdictSlashBps > BPS || c.wrongVerdictSlashBps > BPS
                || c.materialDiffBps > BPS
        ) revert InvalidConfig();
        ESCROW = escrow_;
        REGISTRY = registry_;
        ARBITRATOR = arbitrator_;
        TOKEN = token_;
        MAX_AMOUNT_PER_PAYMENT = maxAmountPerPayment_;
        _evalWindow = c.evalWindow;
        _challengeWindow = c.challengeWindow;
        _rulingWindow = c.rulingWindow;
        _minMargin = c.minMarginSeconds;
        _missedBps = c.missedVerdictSlashBps;
        _wrongBps = c.wrongVerdictSlashBps;
        _materialDiffBps = c.materialDiffBps;
        _minChallengeBond = c.minChallengeBond;
    }

    // =====================================================================
    // x402 "custom" collect wrappers
    // =====================================================================

    /// @notice Permissionless (x402 "custom"). Checks, forwards to the escrow unchanged, records the payment.
    function authorize(
        IAuthCaptureEscrow.PaymentInfo calldata info,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData
    ) external nonReentrant {
        if (info.operator != address(this)) revert WrongOperator();
        if (info.token != address(TOKEN)) revert TokenNotAllowed();
        if (amount > MAX_AMOUNT_PER_PAYMENT) revert AmountTooHigh();
        if (info.minFeeBps != 0 || info.maxFeeBps != 0 || info.feeReceiver != address(0)) revert FeeNotZero();
        if (info.refundExpiry != info.authorizationExpiry) revert RefundExpiryMismatch();
        // Earliest possible fit: bind at now with the floor evalWindow. bindTerms re-checks with the real terms.
        if (uint256(block.timestamp) + _lifecycleSpan(_evalWindow) > info.authorizationExpiry) {
            revert DeadlineTooShort();
        }

        ESCROW.authorize(info, amount, tokenCollector, collectorData);

        bytes32 key = ESCROW.getHash(info);
        Payment storage p = _payments[key];
        p.state = State.Authorized;
        p.amount = amount;
        _infos[key] = info;
        emit PaymentAuthorized(key, info.payer, info.receiver, amount);
    }

    /// @notice Exposed as x402 "custom" requires; always reverts (AgentKoin needs a hold).
    function charge(IAuthCaptureEscrow.PaymentInfo calldata, uint256, address, bytes calldata, uint256, address)
        external
        pure
    {
        revert ChargeNotSupported();
    }

    // =====================================================================
    // binding and lifecycle
    // =====================================================================

    /// @notice Binding mode 1. Called by the named evaluator (its acceptance). Recomputes the salt from
    ///         (termsHash, saltNonce); the buyer's ERC-3009/Permit2 signature commits to that salt.
    function bindTerms(IAuthCaptureEscrow.PaymentInfo calldata info, Terms calldata terms, uint256 saltNonce)
        external
        nonReentrant
    {
        (bytes32 key, Payment storage p) = _load(info, State.Authorized);
        bytes32 th = termsHash(terms);
        if (info.salt != termsSalt(th, saltNonce)) revert SaltMismatch();
        if (msg.sender != terms.evaluator) revert Unauthorized();
        address sub = effectiveSubmitter(info, terms);
        if (terms.evaluator == info.payer || terms.evaluator == info.receiver || terms.evaluator == sub) {
            revert EvaluatorConflict();
        }
        // The buyer cannot be its own submitter (it would collect both the void refund and a missed-verdict slash).
        if (sub == info.payer) revert SubmitterIsPayer();
        if (!REGISTRY.isActive(terms.evaluator)) revert EvaluatorInactive();
        if (
            terms.evalWindow < _evalWindow || terms.scheduleHash == bytes32(0)
                || !PayoutScheduleLib.scheduleValid(terms.criteriaHash, terms.requiredTotal, terms.bpsTable)
        ) revert InvalidTerms();
        if (block.timestamp > terms.submitBy) revert SubmitWindowClosed();
        if (uint256(terms.submitBy) + _lifecycleSpan(terms.evalWindow) > info.authorizationExpiry) {
            revert DeadlineTooShort();
        }

        p.state = State.Bound;
        p.bindingMode = BINDING_MODE_COMMITTED;
        p.termsHash = th;
        p.evaluator = terms.evaluator;
        p.submitter = sub;
        p.requiredTotal = terms.requiredTotal;
        p.bpsTable = terms.bpsTable;
        p.submitBy = terms.submitBy;
        p.evalWindow = terms.evalWindow;
        p.slashBase = REGISTRY.minStake();
        REGISTRY.lockExposure(terms.evaluator, uint256(key), p.amount);
        emit TermsBound(key, th, BINDING_MODE_COMMITTED, terms.evaluator, sub);
    }

    /// @notice Effective submitter (terms.submitter, or info.receiver when zero), by submitBy. `resultDigest` =
    ///         sha256 of the canonical bytes of the result being delivered (raw bytes, or RFC 8785 JSON). It is
    ///         fixed here, so any later swap of the artifact is detectable: a verdict naming a different digest
    ///         reverts with ResultDigestMismatch.
    function submit(IAuthCaptureEscrow.PaymentInfo calldata info, bytes32 deliverableHash, bytes32 resultDigest)
        external
        nonReentrant
    {
        (bytes32 key, Payment storage p) = _load(info, State.Bound);
        if (msg.sender != p.submitter) revert Unauthorized();
        if (block.timestamp > p.submitBy) revert SubmitWindowClosed();
        if (deliverableHash == bytes32(0) || resultDigest == bytes32(0)) revert ZeroHash();
        p.state = State.Submitted;
        p.submittedAt = uint48(block.timestamp);
        p.deliverableHash = deliverableHash;
        p.resultDigest = resultDigest;
        emit Submitted(key, msg.sender, deliverableHash, resultDigest);
    }

    /// @notice Evaluator call. Same checks as JobEscrow v0.6 `verdictScheduled` (AD-014 + #2887 amendments),
    ///         plus `resultDigest` must equal the digest committed at submit.
    function verdictScheduled(
        IAuthCaptureEscrow.PaymentInfo calldata info,
        uint16 passMask,
        uint8 requiredTotal,
        uint8 requiredPass,
        bytes32 resultDigest,
        bytes32 reasonHash
    ) external nonReentrant {
        (bytes32 key, Payment storage p) = _load(info, State.Submitted);
        if (msg.sender != p.evaluator) revert Unauthorized();
        if (requiredTotal != p.requiredTotal) revert RequiredTotalMismatch();
        uint8 passCount = _checkVerdict(p, passMask, resultDigest, reasonHash);
        if (requiredPass != passCount) revert RequiredPassMismatch();
        _recordVerdict(key, p, passMask, passCount, resultDigest, reasonHash);
    }

    /// @notice Anyone may relay the evaluator's EIP-712 `OutsideVerdict` signature (EOA or ERC-1271).
    ///         Every field must match this payment's stored state; payoutBps must equal the table entry.
    function verdictBySig(IAuthCaptureEscrow.PaymentInfo calldata info, OutsideVerdict calldata v, bytes calldata sig)
        external
        nonReentrant
    {
        (bytes32 key, Payment storage p) = _load(info, State.Submitted);
        if (v.paymentInfoHash != key || v.termsHash != p.termsHash || v.deliverableHash != p.deliverableHash) {
            revert VerdictFieldMismatch();
        }
        if (!SignatureChecker.isValidSignatureNow(p.evaluator, verdictDigest(v), sig)) revert BadSignature();
        uint8 passCount = _checkVerdict(p, v.passMask, v.resultDigest, v.reasonHash);
        if (v.payoutBps != PayoutScheduleLib.entryAt(p.bpsTable, passCount)) revert InvalidPayout();
        _recordVerdict(key, p, v.passMask, passCount, v.resultDigest, v.reasonHash);
    }

    /// @notice Optional buyer statement, kept apart from the verdict. The payer calls it directly (empty
    ///         `sig`) or anyone relays the payer's EIP-712 `BuyerAcceptance` signature. First record wins and
    ///         is final. It does not change capture or void: a verdict settles the hold with or without it.
    function recordBuyerAcceptance(
        IAuthCaptureEscrow.PaymentInfo calldata info,
        BuyerAcceptance calldata a,
        bytes calldata sig
    ) external nonReentrant {
        bytes32 key = ESCROW.getHash(info);
        Payment storage p = _payments[key];
        State st = p.state;
        if (st != State.Submitted && st != State.Verdict && st != State.Challenged && st != State.Finalized) {
            revert WrongState(st);
        }
        if (a.paymentInfoHash != key || a.termsHash != p.termsHash) revert VerdictFieldMismatch();
        if (a.resultDigest != p.resultDigest) revert ResultDigestMismatch(p.resultDigest, a.resultDigest);
        if (a.decision != uint8(BuyerDecision.Accepted) && a.decision != uint8(BuyerDecision.Rejected)) {
            revert InvalidDecision();
        }
        if (_acceptances[key].decision != BuyerDecision.None) revert AcceptanceAlreadyRecorded();
        if (msg.sender != info.payer) {
            if (!SignatureChecker.isValidSignatureNow(info.payer, buyerAcceptanceDigest(a), sig)) {
                revert BadSignature();
            }
        }
        _acceptances[key] =
            AcceptanceRecord(BuyerDecision(a.decision), uint48(block.timestamp), a.resultDigest, a.noteHash);
        emit BuyerAcceptanceRecorded(key, info.payer, BuyerDecision(a.decision), a.resultDigest, a.noteHash);
    }

    /// @notice Payer, receiver or effective submitter, within challengeWindow, when an arbitrator is configured.
    ///         An overturn pays bond + fee reimbursement + the slash harmed share to the challenger. Pulls
    ///         minChallengeBond + the arbitrator's quoted cost from the challenger (held here until ruling).
    function challenge(IAuthCaptureEscrow.PaymentInfo calldata info, bytes32 reasonHash) external nonReentrant {
        (bytes32 key, Payment storage p) = _load(info, State.Verdict);
        if (address(ARBITRATOR) == address(0)) revert NoArbitrator();
        if (msg.sender != info.payer && msg.sender != info.receiver && msg.sender != p.submitter) {
            revert Unauthorized();
        }
        if (block.timestamp > uint256(p.verdictAt) + _challengeWindow) revert ChallengeWindowClosed();
        uint256 fee = ARBITRATOR.arbitrationCost(uint256(key), p.amount);
        p.state = State.Challenged;
        p.disputedAt = uint48(block.timestamp);
        Dispute storage d = _disputes[key];
        d.challenger = msg.sender;
        d.bond = _minChallengeBond;
        d.arbFee = fee;
        TOKEN.safeTransferFrom(msg.sender, address(this), _minChallengeBond + fee);
        d.disputeId = ARBITRATOR.requestRuling(uint256(key), msg.sender, p.payoutBps, reasonHash);
        emit Challenged(key, msg.sender, _minChallengeBond, fee, d.disputeId, reasonHash);
    }

    /// @inheritdoc IArbitrable
    /// @dev `jobId` is the paymentKey (uint256 of the escrow paymentInfoHash). Ruling must be a table entry.
    function rule(uint256 jobId, uint16 payoutBps) external nonReentrant {
        bytes32 key = bytes32(jobId);
        Payment storage p = _payments[key];
        if (p.state != State.Challenged) revert WrongState(p.state);
        if (msg.sender != address(ARBITRATOR)) revert Unauthorized();
        if (block.timestamp > uint256(p.disputedAt) + _rulingWindow) revert RulingWindowClosed();
        if (!PayoutScheduleLib.tableContains(p.bpsTable, p.requiredTotal, payoutBps)) revert InvalidPayout();

        p.state = State.Finalized; // effects before any external call (set again in _settle)
        Dispute storage d = _disputes[key];
        uint16 verdictBps = p.payoutBps;
        uint256 diff = payoutBps > verdictBps ? payoutBps - verdictBps : verdictBps - payoutBps;
        bool overturned = diff > _materialDiffBps;
        p.payoutBps = payoutBps;
        emit Ruled(key, verdictBps, payoutBps, overturned);

        if (overturned) {
            // JobEscrow v0.6: loser (evaluator) reimburses the arbitration cost from stake; slash 2; bond back.
            if (d.arbFee > 0) REGISTRY.reimburse(p.evaluator, jobId, d.arbFee, d.challenger);
            uint256 slashed = REGISTRY.slash(
                p.evaluator, jobId, (p.slashBase * _wrongBps) / BPS, d.challenger, SLASH_OVERTURNED_VERDICT
            );
            emit Slashed(key, p.evaluator, SLASH_OVERTURNED_VERDICT, slashed);
            TOKEN.safeTransfer(d.challenger, d.bond);
        } else {
            // Failed challenge: the bond compensates the evaluator (no treasury exists in this contract).
            TOKEN.safeTransfer(p.evaluator, d.bond);
        }
        if (d.arbFee > 0) TOKEN.safeTransfer(address(ARBITRATOR), d.arbFee);
        _settle(key, p);
    }

    /// @notice Anyone, if the arbitrator did not rule within rulingWindow: settle per the verdict and
    ///         return bond + held arbitration cost to the challenger.
    function resolveStaleDispute(IAuthCaptureEscrow.PaymentInfo calldata info) external nonReentrant {
        (bytes32 key, Payment storage p) = _load(info, State.Challenged);
        if (block.timestamp <= uint256(p.disputedAt) + _rulingWindow) revert RulingWindowOpen();
        p.state = State.Finalized; // effects before any external call (set again in _settle)
        Dispute storage d = _disputes[key];
        emit DisputeTimedOut(key);
        TOKEN.safeTransfer(d.challenger, d.bond + d.arbFee);
        _settle(key, p);
    }

    /// @notice Anyone, after challengeWindow with no challenge: capture the bps share, void the rest.
    function finalize(IAuthCaptureEscrow.PaymentInfo calldata info) external nonReentrant {
        (bytes32 key, Payment storage p) = _load(info, State.Verdict);
        if (block.timestamp <= uint256(p.verdictAt) + _challengeWindow) revert ChallengeWindowOpen();
        _settle(key, p);
    }

    /// @notice Anyone, when no verdict arrived within evalWindow: slash (reason 1, harmed = the effective
    ///         submitter, which equals info.receiver when terms.submitter is zero, as v0.2) and void the full hold
    ///         to the payer. Routing to the submitter keeps slash payouts off keyless receivers (deposit addresses).
    function timeoutRelease(IAuthCaptureEscrow.PaymentInfo calldata info) external nonReentrant {
        (bytes32 key, Payment storage p) = _load(info, State.Submitted);
        if (block.timestamp <= uint256(p.submittedAt) + p.evalWindow) revert EvalWindowOpen();
        p.state = State.Voided;
        uint256 slashed = REGISTRY.slash(
            p.evaluator, uint256(key), (p.slashBase * _missedBps) / BPS, p.submitter, SLASH_MISSED_VERDICT
        );
        emit Slashed(key, p.evaluator, SLASH_MISSED_VERDICT, slashed);
        emit TimedOut(key, slashed);
        REGISTRY.releaseExposure(p.evaluator, uint256(key), p.amount);
        _voidHeld(key, info, VOID_MISSED_VERDICT);
    }

    /// @notice Anyone, after terms.submitBy when the evaluator never bound the terms. Terms + saltNonce
    ///         must reproduce the salt (so submitBy is the buyer-signed one). No slash.
    function voidUnbound(IAuthCaptureEscrow.PaymentInfo calldata info, Terms calldata terms, uint256 saltNonce)
        external
        nonReentrant
    {
        (bytes32 key, Payment storage p) = _load(info, State.Authorized);
        if (info.salt != termsSalt(termsHash(terms), saltNonce)) revert SaltMismatch();
        if (block.timestamp <= terms.submitBy) revert SubmitWindowOpen();
        p.state = State.Voided;
        _voidHeld(key, info, VOID_UNBOUND);
    }

    /// @notice Anyone, after submitBy when bound but the effective submitter never submitted. No slash.
    function voidNoSubmit(IAuthCaptureEscrow.PaymentInfo calldata info) external nonReentrant {
        (bytes32 key, Payment storage p) = _load(info, State.Bound);
        if (block.timestamp <= p.submitBy) revert SubmitWindowOpen();
        p.state = State.Voided;
        REGISTRY.releaseExposure(p.evaluator, uint256(key), p.amount);
        _voidHeld(key, info, VOID_NO_SUBMIT);
    }

    // =====================================================================
    // views
    // =====================================================================

    function termsHash(Terms calldata t) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TERMS_TYPEHASH,
                t.evaluator,
                t.criteriaHash,
                t.scheduleHash,
                t.requiredTotal,
                t.bpsTable,
                t.submitBy,
                t.evalWindow,
                t.submitter
            )
        );
    }

    /// @notice Alias of termsHash.
    function hashTerms(Terms calldata t) external pure returns (bytes32) {
        return termsHash(t);
    }

    /// @notice terms.submitter, or info.receiver when it is zero.
    function effectiveSubmitter(IAuthCaptureEscrow.PaymentInfo calldata info, Terms calldata terms)
        public
        pure
        returns (address)
    {
        return terms.submitter == address(0) ? info.receiver : terms.submitter;
    }

    function termsSalt(bytes32 termsHash_, uint256 saltNonce) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(AGK_SALT_TYPEHASH, termsHash_, saltNonce)));
    }

    function config() external view returns (Config memory) {
        return Config(
            _evalWindow,
            _challengeWindow,
            _rulingWindow,
            _minMargin,
            _missedBps,
            _wrongBps,
            _materialDiffBps,
            _minChallengeBond
        );
    }

    /// @notice Seconds that must fit between submitBy and authorizationExpiry for a given evalWindow.
    function lifecycleSpan(uint32 evalWindow) external view returns (uint256) {
        return _lifecycleSpan(evalWindow);
    }

    function getPayment(bytes32 key) external view returns (Payment memory) {
        return _payments[key];
    }

    function getPaymentInfo(bytes32 key) external view returns (IAuthCaptureEscrow.PaymentInfo memory) {
        return _infos[key];
    }

    function getDispute(bytes32 key) external view returns (Dispute memory) {
        return _disputes[key];
    }

    /// @notice decision == None means no buyer acceptance record exists for this payment.
    function getBuyerAcceptance(bytes32 key) external view returns (AcceptanceRecord memory) {
        return _acceptances[key];
    }

    function outcome(bytes32 key) external view returns (Outcome memory o) {
        Payment storage p = _payments[key];
        o.state = p.state;
        o.verdictRecorded = p.verdictAt != 0;
        o.payoutBps = p.payoutBps;
        o.resultDigest = p.resultDigest;
        o.buyerDecision = _acceptances[key].decision;
        o.buyerAccepted = o.buyerDecision == BuyerDecision.Accepted;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function verdictDigest(OutsideVerdict calldata v) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    OUTSIDE_VERDICT_TYPEHASH,
                    v.paymentInfoHash,
                    v.termsHash,
                    v.deliverableHash,
                    v.resultDigest,
                    v.passMask,
                    v.payoutBps,
                    v.reasonHash
                )
            )
        );
    }

    function buyerAcceptanceDigest(BuyerAcceptance calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    BUYER_ACCEPTANCE_TYPEHASH, a.paymentInfoHash, a.termsHash, a.resultDigest, a.decision, a.noteHash
                )
            )
        );
    }

    // =====================================================================
    // internal
    // =====================================================================

    function _lifecycleSpan(uint32 evalWindow) internal view returns (uint256) {
        return uint256(evalWindow) + _challengeWindow + _rulingWindow + _minMargin;
    }

    function _checkVerdict(Payment storage p, uint16 passMask, bytes32 resultDigest, bytes32 reasonHash)
        internal
        view
        returns (uint8 passCount)
    {
        if (block.timestamp > uint256(p.submittedAt) + p.evalWindow) revert EvalWindowClosed();
        if (reasonHash == bytes32(0)) revert ZeroHash();
        if (resultDigest != p.resultDigest) revert ResultDigestMismatch(p.resultDigest, resultDigest);
        if (uint256(passMask) >> p.requiredTotal != 0) revert InvalidPassMask();
        passCount = PayoutScheduleLib.requiredPassFromMask(passMask, p.requiredTotal);
    }

    function _recordVerdict(
        bytes32 key,
        Payment storage p,
        uint16 passMask,
        uint8 passCount,
        bytes32 resultDigest,
        bytes32 reasonHash
    ) internal {
        uint16 bps = PayoutScheduleLib.entryAt(p.bpsTable, passCount);
        p.state = State.Verdict;
        p.passMask = passMask;
        p.payoutBps = bps;
        p.reasonHash = reasonHash;
        p.verdictAt = uint48(block.timestamp);
        emit Verdict(key, p.evaluator, passMask, bps, resultDigest, reasonHash);
    }

    function _load(IAuthCaptureEscrow.PaymentInfo calldata info, State expected)
        internal
        view
        returns (bytes32 key, Payment storage p)
    {
        key = ESCROW.getHash(info);
        p = _payments[key];
        if (p.state != expected) revert WrongState(p.state);
    }

    /// @dev Final settlement from the stored PaymentInfo. Before authorizationExpiry: capture
    ///      held * payoutBps / 10000 (fee 0, feeReceiver 0) then void the remainder. At/after expiry the
    ///      escrow refuses capture, so everything still held is voided to the payer (same result as reclaim)
    ///      and exposure is released, so the evaluator and any challenger are never stuck.
    function _settle(bytes32 key, Payment storage p) internal {
        p.state = State.Finalized;
        REGISTRY.releaseExposure(p.evaluator, uint256(key), p.amount);
        IAuthCaptureEscrow.PaymentInfo memory info = _infos[key];
        (, uint120 held,) = ESCROW.paymentState(key);
        uint256 toReceiver = 0;
        if (block.timestamp < info.authorizationExpiry) {
            toReceiver = (uint256(held) * p.payoutBps) / BPS;
            if (toReceiver > 0) ESCROW.capture(info, toReceiver, 0, address(0));
        } else if (held > 0) {
            emit Voided(key, VOID_AUTH_EXPIRED, held);
        }
        uint256 toPayer = uint256(held) - toReceiver;
        if (toPayer > 0) ESCROW.void(info);
        emit Finalized(key, toReceiver, toPayer, _acceptances[key].decision);
    }

    function _voidHeld(bytes32 key, IAuthCaptureEscrow.PaymentInfo calldata info, uint8 reason) internal {
        (, uint120 held,) = ESCROW.paymentState(key);
        if (held > 0) ESCROW.void(info); // 0 if the payer already reclaimed after authorizationExpiry
        emit Voided(key, reason, held);
    }
}
