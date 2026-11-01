"""LangChain (Python) tools: find -> order (direct x402) -> verify on Base Sepolia. Tools invoked directly (no LLM key)."""
import json
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _shared import DRY_RUN, find_notary, notary_body, outcome, paying_client, record
from agentcoin_core import AgentCoin
from langchain_agentcoin import agentcoin_tools

NAME = "langchain-py"
sid, _ = find_notary()
ro = {t.name: t for t in agentcoin_tools(AgentCoin(), read_only=True)}
found = json.loads(ro["find_service"].invoke({"id": sid}))
if DRY_RUN:
    record(NAME, {"dryRun": True, "serviceId": sid, "name": found["name"]}); sys.exit(0)
t = {x.name: x for x in agentcoin_tools(paying_client(sid))}
order = json.loads(t["place_order"].invoke({"serviceId": sid, "mode": "direct", "body": notary_body(NAME)}))
if order.get("error"):
    raise SystemExit(json.dumps(order))
final = json.loads(t["get_order"].invoke({"orderId": order["orderId"]}))
verification = json.loads(t["verify"].invoke({"serviceId": sid, "orderId": order["orderId"]}))
record(NAME, {"serviceId": sid, "mode": "direct", "orderId": order["orderId"], "paymentTx": order["paymentTx"], "amount": order["amount"], "sellerStatus": order["sellerStatus"],
              "final": {"status": final.get("status"), "verdict": final.get("verdict"), "deliverableHash": final.get("deliverableHash")}, "checks": outcome(order, final, verification)})
