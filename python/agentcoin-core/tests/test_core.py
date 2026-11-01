import json

import pytest
from agentcoin_core import AgentCoin, AgentCoinError, TOOL_NAMES, run_tool, run_tool_json
from agentcoin_core.canonical import keccak_jcs, verify_eip191_document
from agentcoin_core.testing import BASE, PAY_TO, SERVICE_ID, SETTLE_TX, mock_client

BODY = {"sha256": "0x" + "ab" * 32}


def test_defaults_and_mainnet_refusal():
    c = AgentCoin()
    assert c.chain_id == 84532 and c.caip2 == "eip155:84532"
    for cid in (1, 8453, 10, 137, 42161):
        with pytest.raises(AgentCoinError) as e:
            AgentCoin(chain_id=cid)
        assert e.value.code == "mainnet_refused"
    with pytest.raises(AgentCoinError):
        AgentCoin(chain_id=11155111)  # unknown USDC


def test_find_and_route_inject_network():
    m, c = mock_client()
    r = c.find_service(q="notary", claimed=True, limit=5)
    assert r["query"] == {"q": "notary", "claimed": "true", "limit": "5"}
    c.route_task("notarize a hash", "20000")
    assert m.calls[-1]["body"]["constraints"]["network"] == "eip155:84532"


def test_place_order_allowlist_buyer_origin():
    m, c = mock_client(allowed_service_ids=[SERVICE_ID], origin="agentcoin")
    c.place_order(SERVICE_ID)
    b = m.calls[-1]["body"]
    assert b["buyer"] == c.address and b["origin"] == "agentcoin"
    with pytest.raises(AgentCoinError) as e:
        c.place_order("svc_outside000001")
    assert e.value.code == "service_not_allowed"


def test_direct_pay_v2_records_receipt():
    m, c = mock_client()
    o = c.place_order(SERVICE_ID)
    p = c.pay_direct(o, BODY)
    assert p.payment_tx == SETTLE_TX and p.deliverable == {"receipt": {"digest": BODY["sha256"]}}
    rc = [x for x in m.calls if x["url"].endswith("/receipt")][0]["body"]
    assert rc["paymentTx"] == SETTLE_TX and rc["deliverable"] == p.deliverable


def test_direct_pay_v1():
    m, c = mock_client({"v1": True})
    p = c.pay_direct(c.place_order(SERVICE_ID), BODY)
    assert p.payment_tx == SETTLE_TX
    assert any("x-payment" in x["headers"] for x in m.calls)


@pytest.mark.parametrize("opts,code", [({"seller_pay_to": "0x000000000000000000000000000000000000dEaD"}, "payto_mismatch"),
                                       ({"amount": "60000"}, "over_max_payment"),
                                       ({"network": "eip155:8453"}, "wrong_network"),
                                       ({"asset": "0x000000000000000000000000000000000000bEEF"}, "wrong_asset")])
def test_direct_guards(opts, code):
    m, c = mock_client(opts)
    with pytest.raises(AgentCoinError) as e:
        c.pay_direct(c.place_order(SERVICE_ID), BODY)
    assert e.value.code == code
    assert not any("payment-signature" in x["headers"] for x in m.calls)


def test_escrow_pay_and_seller_call():
    m, c = mock_client()
    p = c.pay_escrow(c.place_order(SERVICE_ID, mode="escrow"), BODY)
    assert p.job_id == "42" and len(m.chain.sent) == 2 and p.seller_status == 200
    assert [x["label"] for x in p.transactions] == ["USDC.approve(escrow, amount)", "JobEscrow.createAndFundFor"]


@pytest.mark.parametrize("tamper", ["spender", "client", "contract"])
def test_escrow_tamper_refused_before_sending(tamper):
    m, c = mock_client({"tamper": tamper})
    with pytest.raises(AgentCoinError):
        c.pay_escrow(c.place_order(SERVICE_ID, mode="escrow"), BODY)
    assert m.chain.sent == []


def test_reputation_local_checks_and_tamper():
    m, c = mock_client()
    r = c.reputation(SERVICE_ID)
    assert r["checks"]["signatureValid"] and r["checks"]["evidenceRootMatches"] and not r["checks"]["signerIsOperator"]
    doc = dict(r["score"])
    doc["testnet"] = False
    assert verify_eip191_document(doc)["valid"] is False


def test_jcs_matches_ts_vector():
    # same value as @agentcoin/core keccakJcs([{type:"probe",status:200}])
    assert keccak_jcs([{"type": "probe", "status": 200}]) == "0x7f52b158689f43397bdfc1c20ff8e906c8dc3b15322a3319fc15dee2c46ec43c"


def test_refund_paths():
    m, c = mock_client()
    assert c.refund(42)["action"] == "cancel"
    m.chain.job.update(accepted=True)
    r = c.refund(42)
    assert r["sent"] is False and "before the deadline" in r["reason"]
    m.chain.job.update(state=3)
    assert c.refund(42)["action"] == "timeoutRelease"
    m.revert_simulation = True
    assert c.refund(42)["reason"].startswith("simulation reverted")


def test_buy_end_to_end_with_allowlist():
    m, c = mock_client(allowed_service_ids=[SERVICE_ID], origin="agentcoin")
    r = c.buy(task="notarize a hash", body=BODY)
    assert r["serviceId"] == SERVICE_ID and r["final"]["verdict"] == "delivered"
    r = c.buy(service_id=SERVICE_ID, mode="escrow", body=BODY)
    assert r["final"]["verdict"] == "complete" and r["order"]["jobId"] == "42"


def test_tools_shared_specs_and_errors():
    m, c = mock_client(allowed_service_ids=["svc_only"])
    assert TOOL_NAMES == ["find_service", "route_task", "place_order", "get_order", "claim_listing", "verify", "refund"]
    assert json.loads(run_tool_json(c, "place_order", {"serviceId": SERVICE_ID}))["error"] == "service_not_allowed"
    assert "evidence" not in run_tool(c, "verify", {"serviceId": SERVICE_ID})["service"]


def test_read_only_place_order_returns_unsigned():
    import httpx
    from agentcoin_core.testing import MockRouter
    m = MockRouter("0x" + "12" * 20)
    c = AgentCoin(base_url=BASE, http=httpx.Client(transport=httpx.MockTransport(m.handler)))
    r = run_tool(c, "place_order", {"serviceId": SERVICE_ID})
    assert r["unsigned"] is True and r["order"]["paymentRequirements"][0]["payTo"] == PAY_TO


def test_claim_sign_eip712():
    m, c = mock_client()
    r = c.claim_listing(SERVICE_ID, sign=True)
    rec = r["received"]
    assert rec["claimant"] == c.address and rec["signature"].startswith("0x") and len(rec["signature"]) == 132


def test_wait_for_verdict_survives_a_timed_out_poll():
    import httpx
    from agentcoin_core.testing import mock_client
    m, c = mock_client()
    calls = {"n": 0}
    real = c.get_order
    def flaky(oid):
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ReadTimeout("slow")
        return {"orderId": oid, "verdict": "complete"}
    c.get_order = flaky
    assert c.wait_for_verdict("ord_x", timeout=5, interval=0)["verdict"] == "complete"
    assert calls["n"] == 2


def test_service_url_default_and_env_override():
    from agentcoin_core import BASE_SEPOLIA, DEFAULT_AGENTCOIN_URL, agentcoin_url, from_env
    assert BASE_SEPOLIA["router_url"] == DEFAULT_AGENTCOIN_URL == agentcoin_url({})
    assert agentcoin_url({"AGENTCOIN_URL": "https://svc.example/", "AGENTCOIN_BASE_URL": "https://old.example"}) == "https://svc.example"
    assert agentcoin_url({"AGENTCOIN_BASE_URL": "https://old.example"}) == "https://old.example"
    assert from_env({"AGENTCOIN_URL": "https://svc.example"}).base_url == "https://svc.example"
    assert from_env({}).base_url == DEFAULT_AGENTCOIN_URL
