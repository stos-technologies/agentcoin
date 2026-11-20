"""AgentKoinAuthCaptureArbiter client helpers (pure, no network).

Mirrors src/arbiter/AgentKoinAuthCaptureArbiter.sol and arbiter-sdk/src/index.ts:
terms hash and salt (deployed v0.1 and source v0.2), resultDigest (sha256 of canonical bytes),
the EIP-712 OutsideVerdict and the separate BuyerAcceptance record (source v0.2 only).
Testnet prototype, unaudited.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

from eth_abi import encode
from eth_account.messages import encode_typed_data
from eth_utils import keccak

from .canonical import jcs

EIP712_NAME = "x402 outside-verdict"
EIP712_VERSION = "0.2"

TERMS_TYPE = (
    "AgentKoinTerms(address evaluator,bytes32 criteriaHash,bytes32 scheduleHash,uint8 requiredTotal,"
    "uint256 bpsTable,uint48 submitBy,uint32 evalWindow)"
)
SALT_TYPE = "AgentKoinTermsSalt(bytes32 termsHash,uint256 saltNonce)"
VERDICT_TYPE = (
    "OutsideVerdict(bytes32 paymentInfoHash,bytes32 termsHash,bytes32 deliverableHash,bytes32 resultDigest,"
    "uint16 passMask,uint16 payoutBps,bytes32 reasonHash)"
)
ACCEPTANCE_TYPE = (
    "BuyerAcceptance(bytes32 paymentInfoHash,bytes32 termsHash,bytes32 resultDigest,uint8 decision,bytes32 noteHash)"
)


def _h(s: str) -> str:
    return "0x" + keccak(text=s).hex()


TERMS_TYPEHASH = _h(TERMS_TYPE)
AGK_SALT_TYPEHASH = _h(SALT_TYPE)
OUTSIDE_VERDICT_TYPEHASH = _h(VERDICT_TYPE)
BUYER_ACCEPTANCE_TYPEHASH = _h(ACCEPTANCE_TYPE)

BUYER_DECISION_NONE = 0  # no record; never inferred from a capture
BUYER_DECISION_ACCEPTED = 1
BUYER_DECISION_REJECTED = 2


def _b32(x: str) -> bytes:
    b = bytes.fromhex(x[2:] if x.startswith("0x") else x)
    if len(b) != 32:
        raise ValueError("expected 32 bytes")
    return b


def result_digest(data: bytes) -> str:
    """sha256 over the exact result bytes."""
    return "0x" + hashlib.sha256(data).hexdigest()


def result_digest_json(value) -> str:
    """sha256(UTF-8(RFC 8785 JCS(value)))."""
    return result_digest(jcs(value))


def matches_committed_digest(data: bytes, committed: str) -> bool:
    return result_digest(data).lower() == committed.lower()


def pack_bps_table(entries: list[int]) -> int:
    if not 2 <= len(entries) <= 16:
        raise ValueError("bps table needs 2..16 entries")
    t = 0
    for k, e in enumerate(entries):
        if not 0 <= e <= 10_000:
            raise ValueError(f"bad bps {e}")
        if k and e < entries[k - 1]:
            raise ValueError("bps table must be non-decreasing")
        t |= e << (16 * k)
    return t


def payout_for_mask(bps_table: int, pass_mask: int, required_total: int) -> int:
    if pass_mask >> required_total:
        raise ValueError("pass mask has bits at or above requiredTotal")
    return (bps_table >> (16 * bin(pass_mask).count("1"))) & 0xFFFF


@dataclass(frozen=True)
class Terms:
    evaluator: str
    criteria_hash: str
    schedule_hash: str
    required_total: int
    bps_table: int
    submit_by: int
    eval_window: int


def terms_hash(t: Terms) -> str:
    enc = encode(
        ["bytes32", "address", "bytes32", "bytes32", "uint8", "uint256", "uint48", "uint32"],
        [_b32(TERMS_TYPEHASH), t.evaluator, _b32(t.criteria_hash), _b32(t.schedule_hash), t.required_total,
         t.bps_table, t.submit_by, t.eval_window],
    )
    return "0x" + keccak(enc).hex()


def terms_salt(th: str, salt_nonce: int) -> int:
    enc = encode(["bytes32", "bytes32", "uint256"], [_b32(AGK_SALT_TYPEHASH), _b32(th), salt_nonce])
    return int.from_bytes(keccak(enc), "big")


def _domain(chain_id: int, arbiter: str) -> dict:
    return {"name": EIP712_NAME, "version": EIP712_VERSION, "chainId": chain_id, "verifyingContract": arbiter}


def build_verdict(payment_info_hash: str, terms: Terms, deliverable_hash: str, result_digest_: str, pass_mask: int,
                  reason_hash: str) -> dict:
    """payoutBps is derived from the committed table, never supplied."""
    return {
        "paymentInfoHash": payment_info_hash,
        "termsHash": terms_hash(terms),
        "deliverableHash": deliverable_hash,
        "resultDigest": result_digest_,
        "passMask": pass_mask,
        "payoutBps": payout_for_mask(terms.bps_table, pass_mask, terms.required_total),
        "reasonHash": reason_hash,
    }


def verdict_typed_data(chain_id: int, arbiter: str, verdict: dict) -> dict:
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"},
            ],
            "OutsideVerdict": [
                {"name": "paymentInfoHash", "type": "bytes32"}, {"name": "termsHash", "type": "bytes32"},
                {"name": "deliverableHash", "type": "bytes32"}, {"name": "resultDigest", "type": "bytes32"},
                {"name": "passMask", "type": "uint16"}, {"name": "payoutBps", "type": "uint16"},
                {"name": "reasonHash", "type": "bytes32"},
            ],
        },
        "primaryType": "OutsideVerdict",
        "domain": _domain(chain_id, arbiter),
        "message": verdict,
    }


def buyer_acceptance_typed_data(chain_id: int, arbiter: str, acceptance: dict) -> dict:
    if acceptance.get("decision") not in (BUYER_DECISION_ACCEPTED, BUYER_DECISION_REJECTED):
        raise ValueError("decision must be 1 (accepted) or 2 (rejected)")
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"},
            ],
            "BuyerAcceptance": [
                {"name": "paymentInfoHash", "type": "bytes32"}, {"name": "termsHash", "type": "bytes32"},
                {"name": "resultDigest", "type": "bytes32"}, {"name": "decision", "type": "uint8"},
                {"name": "noteHash", "type": "bytes32"},
            ],
        },
        "primaryType": "BuyerAcceptance",
        "domain": _domain(chain_id, arbiter),
        "message": acceptance,
    }


def _digest(td: dict) -> str:
    m = encode_typed_data(full_message=td)
    return "0x" + keccak(b"\x19" + m.version + m.header + m.body).hex()


def verdict_digest(chain_id: int, arbiter: str, verdict: dict) -> str:
    return _digest(verdict_typed_data(chain_id, arbiter, verdict))


def buyer_acceptance_digest(chain_id: int, arbiter: str, acceptance: dict) -> str:
    return _digest(buyer_acceptance_typed_data(chain_id, arbiter, acceptance))


def describe_outcome(o: dict) -> dict:
    """Machine-readable summary of arbiter.outcome(key). buyerAccepted is False unless a record says so."""
    names = {0: None, 1: "accepted", 2: "rejected"}
    return {
        "settledBy": "verdict" if o["verdictRecorded"] else "none",
        "payoutBps": o["payoutBps"],
        "resultDigest": o["resultDigest"],
        "buyerAcceptance": names[o["buyerDecision"]],
        "buyerAccepted": bool(o["buyerAccepted"]),
    }
