"""CrewAI tools: find -> order (escrow) -> verify on Base Sepolia. Tools invoked directly via BaseTool.run (no LLM key)."""
import json
import sys, os
os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")  # CrewAI sends OpenTelemetry spans to telemetry.crewai.com unless disabled
os.environ.setdefault("OTEL_SDK_DISABLED", "true")
sys.path.insert(0, os.path.dirname(__file__))
from _shared import DRY_RUN, find_notary, notary_body, outcome, paying_client, record
from agentcoin_core import AgentCoin
from crewai_agentcoin import agentcoin_tools

NAME = "crewai"
sid, _ = find_notary()
ro = {t.name: t for t in agentcoin_tools(AgentCoin(), read_only=True)}
found = json.loads(ro["find_service"].run(id=sid))
if DRY_RUN:
    record(NAME, {"dryRun": True, "serviceId": sid, "name": found["name"]}); sys.exit(0)
t = {x.name: x for x in agentcoin_tools(paying_client(sid))}
resume = os.environ.get("AGENTCOIN_RESUME_ORDER")  # finish get_order/verify for an order this example already placed (no new payment)
if resume:
    prev = json.load(open(os.path.join(os.path.dirname(__file__), "..", "out", f"{NAME}.json")))
    assert prev["orderId"] == resume, "resume order id does not match the recorded order"
    order = {k: prev[k] for k in ("orderId", "jobId", "amount", "transactions", "sellerStatus")}
else:
    order = json.loads(t["place_order"].run(serviceId=sid, mode="escrow", body=notary_body(NAME)))
if order.get("error"):
    raise SystemExit(json.dumps(order))
final = json.loads(t["get_order"].run(orderId=order["orderId"], waitForVerdict=True))
verification = json.loads(t["verify"].run(serviceId=sid, orderId=order["orderId"]))
job = final.get("job") or {}
record(NAME, {"serviceId": sid, "mode": "escrow", "orderId": order["orderId"], "jobId": order["jobId"], "amount": order["amount"], "transactions": order["transactions"], "sellerStatus": order["sellerStatus"],
              "final": {"status": final.get("status"), "verdict": final.get("verdict"), "deliverableHash": final.get("deliverableHash"), "jobState": job.get("stateName") or job.get("state")},
              "checks": outcome(order, final, verification), **({"resumedAfterReadTimeout": True} if resume else {})})
