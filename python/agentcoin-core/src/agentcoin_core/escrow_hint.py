"""Seller-side x402 v2 extension advertising escrow via AgentCoin (Base Sepolia only).

A seller attaches it to ITS OWN 402 PaymentRequired body: ``body = with_escrow_hint(body, provider="0x...")``.
``accepts`` is never changed and the input dict is never mutated. The AgentCoin router does not inject this
into proxied or third-party responses. Mirrors x402-escrow-hint/index.mjs; values from
deployments/base-sepolia.json and src/JobEscrow.sol.
"""
from __future__ import annotations

import copy
import re
from typing import Any, Mapping, Optional

from .constants import agentcoin_url

EXTENSION_KEY = "agentcoin-escrow"
HINT_VERSION = "agentcoin-escrow-hint/v1"

BASE_SEPOLIA_ESCROW: Mapping[str, Any] = {
    "network": "eip155:84532",
    "chainId": 84532,
    "routerUrl": agentcoin_url(),
    "escrowContract": "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D",
    "evaluatorRegistry": "0x30576DE005df028D1947C56dEcc85a2a5612036a",
    "token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "evalWindowSeconds": 3600,
    "challengeWindowSeconds": 600,
    "evaluatorMinStake": "2000000",
}

_ADDR = re.compile(r"^0x[0-9a-fA-F]{40}$")
_SVC = re.compile(r"^svc_[0-9a-f]{16}$")
_B32 = re.compile(r"^0x[0-9a-fA-F]{64}$")


def _refunds(c: Mapping[str, Any]) -> list:
    return [
        {"condition": "job Funded, deadline reached, no deliverable submitted", "call": "claimRefund(jobId) or cancel(jobId)", "caller": "anyone (claimRefund); client (cancel)", "refund": "amount (100%)"},
        {"condition": "job Funded, provider has not accepted or submitted", "call": "cancel(jobId)", "caller": "client", "refund": "amount (100%)"},
        {"condition": f"job Submitted, no verdict within evalWindowSeconds ({c['evalWindowSeconds']})", "call": "timeoutRelease(jobId)", "caller": "anyone", "refund": "amount (100%); evaluator stake slashed"},
        {"condition": f"verdict Reject (payoutBps 0) or Partial, challengeWindowSeconds ({c['challengeWindowSeconds']}) elapsed", "call": "finalize(jobId)", "caller": "anyone", "refund": "amount * (10000 - payoutBps) / 10000"},
    ]


def escrow_hint(provider: str, service_id: Optional[str] = None, evaluator: Optional[str] = None, spec_hash: Optional[str] = None,
                deadline_seconds: Optional[int] = None, deployment: Optional[Mapping[str, Any]] = None) -> dict:
    """Extension value {info, schema}; same JSON as the JS helper."""
    c = {**BASE_SEPOLIA_ESCROW, **(deployment or {})}
    if c["chainId"] != 84532 or c["network"] != "eip155:84532":
        raise ValueError("agentcoin escrow hint: Base Sepolia (eip155:84532) only")
    if not _ADDR.match(str(provider or "")):
        raise ValueError("agentcoin escrow hint: provider must be an EVM address")
    if evaluator is not None and not _ADDR.match(str(evaluator)):
        raise ValueError("agentcoin escrow hint: evaluator must be an EVM address")
    if service_id is not None and not _SVC.match(str(service_id)):
        raise ValueError("agentcoin escrow hint: serviceId must be svc_<16 hex>")
    if spec_hash is not None and not _B32.match(str(spec_hash)):
        raise ValueError("agentcoin escrow hint: specHash must be bytes32 hex")
    router = str(c["routerUrl"]).rstrip("/")
    r: dict = {"url": router, "orders": f"{router}/v1/orders", "llmsTxt": f"{router}/llms.txt"}
    if service_id:
        r.update({"serviceId": service_id, "listing": f"{router}/v1/services/{service_id}", "reputation": f"{router}/v1/reputation/{service_id}"})
    r["orderBody"] = {"serviceId": service_id, "mode": "escrow", "buyer": "<client address>"}
    esc: dict = {"contract": c["escrowContract"], "token": c["token"], "provider": provider}
    if evaluator:
        esc["evaluator"] = evaluator
    else:
        esc["evaluatorSource"] = "assigned in the POST /v1/orders escrow response"
    if spec_hash:
        esc["specHash"] = spec_hash
    if deadline_seconds:
        esc["deadlineSeconds"] = int(deadline_seconds)
    esc.update({
        "funding": "JobEscrow.createAndFundFor(client, provider, evaluator, amount, deadline, specHash) after USDC.approve(contract, amount)",
        "x402Scheme": "agentcoin-escrow",
        "evaluatorModel": {
            "registry": c["evaluatorRegistry"],
            "minStake": c["evaluatorMinStake"],
            "verdict": "evaluator calls verdict(jobId, Complete|Reject|Partial, payoutBps, reasonHash) on a Submitted job",
            "evalWindowSeconds": c["evalWindowSeconds"],
            "challenge": f"client or provider may challenge a verdict within challengeWindowSeconds ({c['challengeWindowSeconds']}) with a bond plus arbitration fee; testnet arbitrator is MockArbitrator",
            "challengeWindowSeconds": c["challengeWindowSeconds"],
        },
        "payout": "after challengeWindowSeconds, finalize(jobId) pays provider amount * payoutBps / 10000 minus protocol and evaluator fees",
        "refunds": _refunds(c),
        "instantRelease": "if amount <= instantThreshold and the provider bond covers amount * instantBondCoverBps, submit releases payment without a verdict; then only the client may challenge",
    })
    info = {"v": HINT_VERSION, "escrowAvailable": True, "network": c["network"], "chainId": c["chainId"], "testnet": True, "realValue": False, "router": r, "escrow": esc}
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["v", "escrowAvailable", "network", "chainId", "router", "escrow"],
        "properties": {"v": {"const": HINT_VERSION}, "escrowAvailable": {"type": "boolean"}, "network": {"const": "eip155:84532"}, "chainId": {"const": 84532},
                       "router": {"type": "object", "required": ["url", "orders"]}, "escrow": {"type": "object", "required": ["contract", "token", "provider", "refunds"]}},
    }
    return {"info": info, "schema": schema}


def with_escrow_hint(payment_required: Mapping[str, Any], **opts: Any) -> dict:
    """Return a NEW PaymentRequired dict with extensions["agentcoin-escrow"]; accepts and other fields unchanged."""
    if not isinstance(payment_required, Mapping) or not isinstance(payment_required.get("accepts"), list):
        raise ValueError("with_escrow_hint: expected an x402 PaymentRequired object with accepts[]")
    out = copy.deepcopy(dict(payment_required))
    ext = out.get("extensions") if isinstance(out.get("extensions"), dict) else {}
    out["extensions"] = {**ext, EXTENSION_KEY: escrow_hint(**opts)}
    return out
