import json

import pytest
from agentcoin_core import AgentCoinError
from agentcoin_core.testing import SERVICE_ID, mock_client
from crewai_agentcoin import agentcoin_tools

BODY = {"sha256": "0x" + "ab" * 32}


def test_tools_have_pydantic_schemas():
    _, c = mock_client()
    tools = agentcoin_tools(c)
    assert [t.name for t in tools] == ["find_service", "route_task", "place_order", "get_order", "claim_listing", "verify", "refund"]
    po = next(t for t in tools if t.name == "place_order")
    js = po.args_schema.model_json_schema()
    assert js["required"] == ["serviceId"] and js["properties"]["mode"]["anyOf"][0]["enum"] == ["direct", "escrow"]


def test_run_find_order_escrow_get_order():
    m, c = mock_client({"escrow_offer": True})
    t = {x.name: x for x in agentcoin_tools(c)}
    assert any(r["id"] == SERVICE_ID for r in json.loads(t["find_service"].run(q="notary"))["results"])
    o = json.loads(t["place_order"].run(serviceId=SERVICE_ID, mode="escrow", body=BODY))
    assert o["jobId"] == "42" and len(m.chain.sent) == 2
    g = json.loads(t["get_order"].run(orderId=o["orderId"], waitForVerdict=True))
    assert g["verdict"] == "complete"


def test_errors_and_mainnet():
    _, c = mock_client(allowed_service_ids=["svc_only"])
    po = next(t for t in agentcoin_tools(c) if t.name == "place_order")
    assert json.loads(po.run(serviceId=SERVICE_ID))["error"] == "service_not_allowed"
    with pytest.raises(AgentCoinError):
        agentcoin_tools({"chain_id": 8453})
