"""AgentKoin auth-capture arbiter v0.3 helpers (LOCAL PROTOTYPE; no v0.3 deployment exists).

Mirrors src/arbiter/AgentKoinAuthCaptureArbiterV03.sol: Terms gain an optional ``submitter`` (zero = the
receiver submits, as in v0.2), included in TERMS_TYPEHASH; EIP-712 domain ("x402 outside-verdict", "0.3").
The v0.2 module ``agentcoin_core.arbiter`` is unchanged; verdict/acceptance struct types are identical, so this
module reuses them and only swaps the terms hash and the domain version.
"""
from __future__ import annotations

from dataclasses import dataclass

from eth_abi import encode
from eth_utils import keccak

from . import arbiter as _v02
from .arbiter import (  # noqa: F401  (re-exported, version-independent)
    AGK_SALT_TYPEHASH, BUYER_ACCEPTANCE_TYPEHASH, OUTSIDE_VERDICT_TYPEHASH, pack_bps_table, payout_for_mask,
    result_digest, result_digest_json, terms_salt,
)

ZERO_ADDRESS = "0x" + "00" * 20
VERSION = "0.3"
EIP712_NAME = "x402 outside-verdict"
EIP712_VERSION = "0.3"
TERMS_V03_TYPE = (
    "AgentKoinTerms(address evaluator,bytes32 criteriaHash,bytes32 scheduleHash,uint8 requiredTotal,"
    "uint256 bpsTable,uint48 submitBy,uint32 evalWindow,address submitter)"
)
TERMS_V03_TYPEHASH = "0x" + keccak(text=TERMS_V03_TYPE).hex()


@dataclass(frozen=True)
class TermsV03:
    evaluator: str
    criteria_hash: str
    schedule_hash: str
    required_total: int
    bps_table: int
    submit_by: int
    eval_window: int
    submitter: str = ZERO_ADDRESS


def effective_submitter(receiver: str, t: TermsV03) -> str:
    return receiver if int(t.submitter, 16) == 0 else t.submitter


def submitter_is_payer(payer: str, receiver: str, t: TermsV03) -> bool:
    """Mirrors bindTerms' SubmitterIsPayer guard (case-insensitive)."""
    return effective_submitter(receiver, t).lower() == payer.lower()


def validate_bind_v03(payer: str, receiver: str, t: TermsV03) -> list[str]:
    """Role checks bindTerms enforces. Empty list = OK."""
    errs = []
    sub = effective_submitter(receiver, t).lower()
    if t.evaluator.lower() in (payer.lower(), receiver.lower(), sub):
        errs.append("evaluator must differ from payer, receiver and submitter (EvaluatorConflict)")
    if submitter_is_payer(payer, receiver, t):
        errs.append("effective submitter must differ from the payer (SubmitterIsPayer)")
    return errs


def hash_terms_v03(t: TermsV03) -> str:
    enc = encode(
        ["bytes32", "address", "bytes32", "bytes32", "uint8", "uint256", "uint48", "uint32", "address"],
        [bytes.fromhex(TERMS_V03_TYPEHASH[2:]), t.evaluator, bytes.fromhex(t.criteria_hash[2:]),
         bytes.fromhex(t.schedule_hash[2:]), t.required_total, t.bps_table, t.submit_by, t.eval_window, t.submitter],
    )
    return "0x" + keccak(enc).hex()


def build_verdict_v03(payment_info_hash: str, terms: TermsV03, deliverable_hash: str, result_digest_: str,
                      pass_mask: int, reason_hash: str) -> dict:
    return {
        "paymentInfoHash": payment_info_hash,
        "termsHash": hash_terms_v03(terms),
        "deliverableHash": deliverable_hash,
        "resultDigest": result_digest_,
        "passMask": pass_mask,
        "payoutBps": payout_for_mask(terms.bps_table, pass_mask, terms.required_total),
        "reasonHash": reason_hash,
    }


def _v03(td: dict) -> dict:
    td["domain"] = {**td["domain"], "name": EIP712_NAME, "version": EIP712_VERSION}
    return td


def verdict_typed_data_v03(chain_id: int, arbiter: str, verdict: dict) -> dict:
    return _v03(_v02.verdict_typed_data(chain_id, arbiter, verdict))


def buyer_acceptance_typed_data_v03(chain_id: int, arbiter: str, acceptance: dict) -> dict:
    return _v03(_v02.buyer_acceptance_typed_data(chain_id, arbiter, acceptance))


def verdict_digest_v03(chain_id: int, arbiter: str, verdict: dict) -> str:
    return _v02._digest(verdict_typed_data_v03(chain_id, arbiter, verdict))


def buyer_acceptance_digest_v03(chain_id: int, arbiter: str, acceptance: dict) -> str:
    return _v02._digest(buyer_acceptance_typed_data_v03(chain_id, arbiter, acceptance))
