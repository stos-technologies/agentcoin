"""RFC 8785 canonical JSON, keccak256 over it, and AgentCoin EIP-191 document verification."""
from __future__ import annotations

import rfc8785
from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak, to_checksum_address


def jcs(v) -> bytes:
    return rfc8785.dumps(v)


def keccak_jcs(v) -> str:
    return "0x" + keccak(jcs(v)).hex()


def verify_eip191_document(doc: dict) -> dict:
    """personal_sign over keccak256(RFC8785(document without "signature"))."""
    s = (doc or {}).get("signature")
    if not isinstance(s, dict) or s.get("scheme") != "eip191":
        return {"valid": False, "reason": "no eip191 signature"}
    unsigned = {k: v for k, v in doc.items() if k != "signature"}
    digest = keccak_jcs(unsigned)
    if s.get("signedDigest") and s["signedDigest"].lower() != digest.lower():
        return {"valid": False, "digest": digest, "reason": "digest mismatch (document modified)"}
    signer = to_checksum_address(s["signer"])
    try:
        rec = Account.recover_message(encode_defunct(primitive=bytes.fromhex(digest[2:])), signature=s["value"])
    except Exception:
        return {"valid": False, "signer": signer, "digest": digest, "reason": "signature does not match signer"}
    ok = to_checksum_address(rec) == signer
    out = {"valid": ok, "signer": signer, "digest": digest}
    if not ok:
        out["reason"] = "signature does not match signer"
    return out
