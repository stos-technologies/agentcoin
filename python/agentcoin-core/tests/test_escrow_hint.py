import copy
import json
import pathlib

import pytest
from agentcoin_core.escrow_hint import BASE_SEPOLIA_ESCROW, EXTENSION_KEY, escrow_hint, with_escrow_hint

PROVIDER = "0x" + "12" * 20
PR = {"x402Version": 2, "error": "payment required", "accepts": [{"scheme": "exact", "network": "eip155:84532", "amount": "10000", "asset": BASE_SEPOLIA_ESCROW["token"], "payTo": PROVIDER, "maxTimeoutSeconds": 300, "extra": {"name": "USDC", "version": "2"}}], "extensions": {"bazaar": {"info": {}}}}
ROOT = pathlib.Path(__file__).resolve().parents[3]


def test_shape_and_no_mutation():
    before = copy.deepcopy(PR)
    out = with_escrow_hint(PR, provider=PROVIDER, service_id="svc_" + "a" * 16)
    assert PR == before
    assert out["accepts"] == PR["accepts"] and out["extensions"]["bazaar"] == PR["extensions"]["bazaar"]
    assert [k for k in out if k != "extensions"] == [k for k in PR if k != "extensions"]
    info = out["extensions"][EXTENSION_KEY]["info"]
    assert info["v"] == "agentcoin-escrow-hint/v1" and info["chainId"] == 84532 and info["network"] == "eip155:84532"
    assert info["escrow"]["provider"] == PROVIDER and info["escrow"]["x402Scheme"] == "agentcoin-escrow"
    assert info["router"]["reputation"].endswith("/v1/reputation/svc_" + "a" * 16)
    assert [r["call"].split("(")[0] for r in info["escrow"]["refunds"]] == ["claimRefund", "cancel", "timeoutRelease", "finalize"]
    assert "guarantee" not in json.dumps(out).lower()


def test_validation_and_mainnet_refusal():
    with pytest.raises(ValueError):
        escrow_hint(provider="nope")
    with pytest.raises(ValueError):
        escrow_hint(provider=PROVIDER, deployment={"chainId": 8453, "network": "eip155:8453"})
    with pytest.raises(ValueError):
        with_escrow_hint({"x402Version": 2}, provider=PROVIDER)


def test_matches_deployment_and_js_helper():
    d = json.loads((ROOT / "deployments" / "base-sepolia.json").read_text())
    assert BASE_SEPOLIA_ESCROW["escrowContract"] == d["contracts"]["JobEscrow"]["address"]
    assert BASE_SEPOLIA_ESCROW["evaluatorRegistry"] == d["contracts"]["EvaluatorRegistry"]["address"]
    assert BASE_SEPOLIA_ESCROW["token"] == d["usdc"]["address"]
    assert BASE_SEPOLIA_ESCROW["evalWindowSeconds"] == d["params"]["evalWindow"] and BASE_SEPOLIA_ESCROW["challengeWindowSeconds"] == d["params"]["challengeWindow"]
    assert BASE_SEPOLIA_ESCROW["evaluatorMinStake"] == str(d["params"]["minStake"])
