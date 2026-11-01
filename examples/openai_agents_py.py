"""OpenAI Agents SDK (Python) tools: find -> order (direct x402) -> verify on Base Sepolia. FunctionTools invoked directly (no LLM key)."""
import asyncio
import json
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _shared import DRY_RUN, find_notary, notary_body, outcome, paying_client, record
from agentcoin_core import AgentCoin
from agentcoin_openai_agents import agentcoin_tools

NAME = "openai-agents-py"
call = lambda tool, args: json.loads(asyncio.run(tool.on_invoke_tool(None, json.dumps(args))))
sid, _ = find_notary()
ro = {t.name: t for t in agentcoin_tools(AgentCoin(), read_only=True)}
found = call(ro["find_service"], {"id": sid})
if DRY_RUN:
    record(NAME, {"dryRun": True, "serviceId": sid, "name": found["name"]}); sys.exit(0)
t = {x.name: x for x in agentcoin_tools(paying_client(sid))}
order = call(t["place_order"], {"serviceId": sid, "mode": "direct", "body": notary_body(NAME)})
if order.get("error"):
    raise SystemExit(json.dumps(order))
final = call(t["get_order"], {"orderId": order["orderId"]})
verification = call(t["verify"], {"serviceId": sid, "orderId": order["orderId"]})
record(NAME, {"serviceId": sid, "mode": "direct", "orderId": order["orderId"], "paymentTx": order["paymentTx"], "amount": order["amount"], "sellerStatus": order["sellerStatus"],
              "final": {"status": final.get("status"), "verdict": final.get("verdict"), "deliverableHash": final.get("deliverableHash")}, "checks": outcome(order, final, verification)})
