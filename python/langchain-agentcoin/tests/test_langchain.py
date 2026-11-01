import json

from agentcoin_core.testing import SERVICE_ID, mock_client
from langchain_agentcoin import agentcoin_tools
from langchain_core.messages import AIMessage

BODY = {"sha256": "0x" + "ab" * 32}


def test_tools_and_schemas():
    _, c = mock_client()
    tools = agentcoin_tools(c)
    assert [t.name for t in tools] == ["find_service", "route_task", "place_order", "get_order", "claim_listing", "verify", "refund"]
    po = next(t for t in tools if t.name == "place_order")
    assert po.args_schema["required"] == ["serviceId"] and "mode" in po.args
    assert [t.name for t in agentcoin_tools(c, read_only=True)] == ["find_service", "route_task", "get_order", "verify"]


def test_invoke_find_order_verify():
    m, c = mock_client(origin="agentcoin", allowed_service_ids=[SERVICE_ID])
    t = {x.name: x for x in agentcoin_tools(c)}
    f = json.loads(t["find_service"].invoke({"q": "notary"}))
    assert any(r["id"] == SERVICE_ID for r in f["results"])
    o = json.loads(t["place_order"].invoke({"serviceId": SERVICE_ID, "body": BODY}))
    assert o["orderId"].startswith("ord_") and o["testnet"] is True
    v = json.loads(t["verify"].invoke({"serviceId": SERVICE_ID, "orderId": o["orderId"]}))
    assert v["service"]["checks"]["signatureValid"] and v["order"]["verdict"] == "delivered"


def test_langgraph_toolnode_executes_tool_calls():
    from langgraph.graph import END, START, MessagesState, StateGraph
    from langgraph.prebuilt import ToolNode

    _, c = mock_client({"escrow_offer": True})
    g = StateGraph(MessagesState)
    g.add_node("tools", ToolNode(agentcoin_tools(c)))
    g.add_edge(START, "tools")
    g.add_edge("tools", END)
    node = g.compile()
    msg = AIMessage(content="", tool_calls=[{"id": "c1", "name": "place_order", "args": {"serviceId": SERVICE_ID, "mode": "escrow", "body": BODY}},
                                            {"id": "c2", "name": "find_service", "args": {"id": SERVICE_ID}}])
    out = node.invoke({"messages": [msg]})["messages"][1:]
    assert json.loads(out[0].content)["jobId"] == "42"
    assert json.loads(out[1].content)["id"] == SERVICE_ID


def test_async_and_errors():
    import asyncio

    _, c = mock_client(allowed_service_ids=["svc_only"])
    po = next(t for t in agentcoin_tools(c) if t.name == "place_order")
    assert json.loads(asyncio.run(po.ainvoke({"serviceId": SERVICE_ID})))["error"] == "service_not_allowed"
