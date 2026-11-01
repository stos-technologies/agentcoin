"""Framework-neutral tools. Definitions come from tool_specs.json, generated from @agentcoin/core (one source for TS and Python)."""
from __future__ import annotations

import json
from importlib import resources

from .errors import AgentCoinError

TOOL_SPECS: list[dict] = json.loads(resources.files(__package__).joinpath("tool_specs.json").read_text())
TOOL_NAMES = [t["name"] for t in TOOL_SPECS]


def _trim(o: dict) -> dict:
    if isinstance(o, dict) and isinstance(o.get("service"), dict) and "evidence" in o["service"]:
        o = {**o, "service": {k: v for k, v in o["service"].items() if k != "evidence"}}
    return o


def run_tool(client, name: str, args: dict | None = None) -> dict:
    a = dict(args or {})
    if name == "find_service":
        sid = a.pop("id", None)
        return client.find_service(id=sid, **a)
    if name == "route_task":
        task = a.pop("task")
        budget = a.pop("budget", None)
        return client.route_task(task, budget, a)
    if name == "place_order":
        order = client.place_order(a["serviceId"], a.get("skillId"), a.get("mode") or "direct")
        if not client.account:
            return {"unsigned": True, "order": order}
        paid = client.pay_escrow(order, a.get("body")) if order.get("mode") == "escrow" else client.pay_direct(order, a.get("body"))
        return {**paid.summary(), "status": (paid.order or {}).get("status"), "verdict": (paid.order or {}).get("verdict"), "testnet": True}
    if name == "get_order":
        return client.wait_for_verdict(a["orderId"]) if a.get("waitForVerdict") else client.get_order(a["orderId"])
    if name == "claim_listing":
        sid, submitted = a.get("serviceId"), None
        if not sid and a.get("url"):
            submitted = client.submit_listing(a["url"])
            sid = (submitted.get("listing") or {}).get("id")
        if not sid:
            raise AgentCoinError("bad_args", "serviceId or url required")
        if submitted and not a.get("sign") and a.get("method") != "well-known":
            return {"submitted": submitted, "challenge": client.claim_listing(sid)}
        r = client.claim_listing(sid, sign=bool(a.get("sign")), method=a.get("method"))
        return {"submitted": submitted, "claim": r} if submitted else r
    if name == "verify":
        return _trim(client.verify(service_id=a.get("serviceId"), order_id=a.get("orderId"), document=a.get("document"), expected_signer=a.get("expectedSigner"), evaluator=a.get("evaluator")))
    if name == "refund":
        jid = a.get("jobId")
        if not jid and a.get("orderId"):
            jid = client.get_order(a["orderId"]).get("jobId")
        if not jid:
            raise AgentCoinError("bad_args", "jobId, or orderId of an escrow order, required")
        return client.refund(jid)
    raise AgentCoinError("unknown_tool", f"unknown tool {name}")


def _default(v):
    if isinstance(v, (bytes, bytearray)):
        return "0x" + bytes(v).hex()
    return str(v)


def run_tool_json(client, name: str, args: dict | None = None) -> str:
    """Runs a tool; returns a JSON string. Errors become {"error": code, "message": ...}."""
    try:
        return json.dumps(run_tool(client, name, args), default=_default)
    except AgentCoinError as e:
        return json.dumps({"error": e.code, "message": str(e)})
    except Exception as e:  # network errors etc. reported as tool output
        return json.dumps({"error": "error", "message": str(e)})
