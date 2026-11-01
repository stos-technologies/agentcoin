import asyncio
import json

from agentcoin_core.testing import SERVICE_ID, mock_client
from agentcoin_openai_agents import agentcoin_tools

BODY = {"sha256": "0x" + "ab" * 32}
call = lambda t, a: asyncio.run(t.on_invoke_tool(None, json.dumps(a)))


def test_function_tools():
    _, c = mock_client()
    tools = agentcoin_tools(c)
    assert len(tools) == 7 and all(t.strict_json_schema is False for t in tools)
    assert tools[2].params_json_schema["required"] == ["serviceId"]


def test_invoke_route_order_verify():
    m, c = mock_client(allowed_service_ids=[SERVICE_ID], origin="agentcoin")
    t = {x.name: x for x in agentcoin_tools(c)}
    r = json.loads(call(t["route_task"], {"task": "notarize a sha256", "budget": "20000"}))
    assert [x["serviceId"] for x in r["candidates"]] == ["svc_outside000001", SERVICE_ID]
    assert json.loads(call(t["place_order"], {"serviceId": "svc_outside000001"}))["error"] == "service_not_allowed"
    o = json.loads(call(t["place_order"], {"serviceId": SERVICE_ID, "body": BODY}))
    assert o["paymentTx"].startswith("0x")
    v = json.loads(call(t["verify"], {"orderId": o["orderId"]}))
    assert v["order"]["status"] == "settled"


def test_bad_json_args():
    _, c = mock_client()
    t = agentcoin_tools(c)[0]
    assert json.loads(asyncio.run(t.on_invoke_tool(None, "{not json")))["error"] == "bad_args"
