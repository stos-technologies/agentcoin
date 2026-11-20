"""AgentKoin auth-capture arbiter helpers: cross-checked against the TS SDK vectors (which are checked against
the Solidity contract on anvil) and the sample terms file (JSON Schema + recomputed hashes). No network."""
import json
from pathlib import Path

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data

from agentcoin_core import arbiter as a

REPO = next(p for p in Path(__file__).resolve().parents if (p / "arbiter-sdk").is_dir())  # repo root
VECTORS = json.loads((REPO / "arbiter-sdk/test/vectors.v02.json").read_text())
EX = REPO / "examples/authcapture"


def _terms(d: dict) -> a.Terms:
    return a.Terms(d["evaluator"], d["criteriaHash"], d["scheduleHash"], d["requiredTotal"], int(d["bpsTable"], 16),
                   d["submitBy"], d["evalWindow"])


def test_typehashes_match_ts_and_solidity():
    t = VECTORS["typehashes"]
    assert (a.TERMS_TYPEHASH, a.AGK_SALT_TYPEHASH, a.OUTSIDE_VERDICT_TYPEHASH, a.BUYER_ACCEPTANCE_TYPEHASH) == (
        t["terms"], t["salt"], t["verdict"], t["acceptance"])


def test_result_digest_jcs_and_bytes():
    from agentcoin_core.canonical import jcs
    assert jcs(VECTORS["json"]).decode() == VECTORS["jcs"]
    assert a.result_digest_json(VECTORS["json"]) == VECTORS["resultDigestJson"]
    assert a.result_digest(b"agentkoin sample result bytes v1") == VECTORS["resultDigestBytes"]
    assert a.matches_committed_digest(b"agentkoin sample result bytes v1", VECTORS["resultDigestBytes"])
    assert not a.matches_committed_digest(b"agentkoin sample result bytes v2", VECTORS["resultDigestBytes"])


def test_terms_hash_and_salt():
    t = _terms(VECTORS["terms"])
    assert a.terms_hash(t) == VECTORS["termsHash"]
    assert hex(a.terms_salt(a.terms_hash(t), 42)) == VECTORS["termsSalt42"]


def test_verdict_and_acceptance_digests():
    t = _terms(VECTORS["terms"])
    v = VECTORS["verdict"]
    built = a.build_verdict(v["paymentInfoHash"], t, v["deliverableHash"], v["resultDigest"], v["passMask"], v["reasonHash"])
    assert built == v
    assert built["payoutBps"] == 7500  # 0b1011 -> 3 of 4 pass
    assert a.verdict_digest(VECTORS["chainId"], VECTORS["arbiter"], v) == VECTORS["verdictDigest"]
    assert a.buyer_acceptance_digest(VECTORS["chainId"], VECTORS["arbiter"], VECTORS["acceptance"]) == VECTORS["acceptanceDigest"]
    assert VECTORS["verdictDigest"] != VECTORS["acceptanceDigest"]


def test_signatures_recover_to_signer():
    acct = Account.create()
    td = a.verdict_typed_data(84532, VECTORS["arbiter"], VECTORS["verdict"])
    sig = acct.sign_message(encode_typed_data(full_message=td)).signature
    assert Account.recover_message(encode_typed_data(full_message=td), signature=sig) == acct.address


def test_acceptance_decision_must_be_explicit():
    bad = dict(VECTORS["acceptance"], decision=0)
    with pytest.raises(ValueError):
        a.buyer_acceptance_typed_data(84532, VECTORS["arbiter"], bad)


def test_describe_outcome_absence_is_explicit():
    o = a.describe_outcome({"state": 6, "verdictRecorded": True, "payoutBps": 10000, "resultDigest": "0x" + "ab" * 32,
                            "buyerDecision": 0, "buyerAccepted": False})
    assert o["settledBy"] == "verdict" and o["buyerAcceptance"] is None and o["buyerAccepted"] is False


def test_payout_mask_bounds():
    table = a.pack_bps_table([0, 2500, 5000, 7500, 10000])
    assert table == 0x27101D4C138809C40000
    assert a.payout_for_mask(table, 0xF, 4) == 10000
    with pytest.raises(ValueError):
        a.payout_for_mask(table, 0x1F, 4)


def test_sample_terms_file_schema_and_hashes():
    jsonschema = pytest.importorskip("jsonschema")
    sample = json.loads((EX / "terms.base-sepolia.json").read_text())
    schema = json.loads((EX / "terms.schema.json").read_text())
    jsonschema.Draft202012Validator.check_schema(schema)
    jsonschema.Draft202012Validator(schema).validate(sample)
    at = sample["arbiterTerms"]
    assert a.result_digest((EX / "criteria.json").read_bytes()) == at["criteriaHash"]
    assert a.result_digest((EX / "schedule.json").read_bytes()) == at["scheduleHash"]
    assert a.terms_hash(_terms(at)) == at["termsHash"] == sample["outside-verdict"]["termsHash"]
    assert a.pack_bps_table(sample["outside-verdict"]["terms"]["payoutBps"]) == int(at["bpsTable"], 16)
    d = sample["deployment"]
    assert d["arbitrator"] == "0x" + "00" * 20 and d["challengesEnabled"] is False


def test_acceptance_digest_binds_result_digest():
    assert "bytes32 resultDigest" in a.ACCEPTANCE_TYPE
    acc = VECTORS["acceptance"]
    other = dict(acc, resultDigest="0x" + "ee" * 32)
    assert a.buyer_acceptance_digest(84532, VECTORS["arbiter"], other) != VECTORS["acceptanceDigest"]
