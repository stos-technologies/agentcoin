"""Shared example steps (Python): find the AgentCoin-operated notary, order body, result record (no secrets)."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import pathlib

from agentcoin_core import AgentCoin, from_env

DRY_RUN = os.environ.get("AGENTCOIN_DRY_RUN") == "1" or not os.environ.get("AGENTCOIN_PRIVATE_KEY")
OUT = pathlib.Path(__file__).resolve().parent.parent / "out"


def find_notary() -> tuple[str, dict]:
    ro = AgentCoin()
    r = ro.find_service(q="agentcoin notary", network="eip155:84532", limit=10)
    hit = next((x for x in r.get("results", []) if x.get("operatedBy") == "AgentCoin" and "notary" in (x.get("name") or "").lower()), None)
    if not hit:
        raise SystemExit("AgentCoin notary not found in the index")
    listing = ro.find_service(id=hit["id"])
    if listing.get("operatedBy") != "AgentCoin":
        raise SystemExit("refusing: listing is not operatedBy AgentCoin")
    return hit["id"], listing


def paying_client(service_id: str) -> AgentCoin:
    return from_env(allowed_service_ids=[service_id], origin="agentcoin", max_payment=10_000, poll_interval=15, verdict_timeout=900)


def notary_body(name: str) -> dict:
    text = f"agentcoin integrations e2e {name} {dt.datetime.now(dt.timezone.utc).isoformat()}"
    return {"sha256": "0x" + hashlib.sha256(text.encode()).hexdigest(), "note": f"integrations e2e: {name}"}


def record(name: str, data: dict) -> None:
    OUT.mkdir(exist_ok=True)
    f = OUT / (f"{name}.dry.local.json" if DRY_RUN else f"{name}.json")
    doc = {"example": name, "at": dt.datetime.now(dt.timezone.utc).isoformat(), "network": "eip155:84532", "testnet": True, **data}
    f.write_text(json.dumps(doc, indent=2, default=str) + "\n")
    print(json.dumps(data, indent=2, default=str))
    print("recorded", f)


def outcome(order: dict, final: dict, verification: dict) -> dict:
    if order.get("error"):
        raise SystemExit(f"place_order failed: {order}")
    rec = (verification.get("order") or {}).get("deliveryRecord") or {}
    chk = (verification.get("service") or {}).get("checks") or {}
    return {"verdictOk": final.get("verdict") in ("delivered", "complete", "pass"), "deliveryRecordValid": rec.get("valid"), "deliveryRecordSignerIsOperator": rec.get("signerIsOperator"),
            "scoreSignatureValid": chk.get("signatureValid"), "scoreSignerIsOperator": chk.get("signerIsOperator")}
