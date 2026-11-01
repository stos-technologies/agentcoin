from __future__ import annotations

import os

from .client import AgentCoin
from .constants import agentcoin_url


def from_env(env: dict | None = None, **overrides) -> AgentCoin:
    """AGENTCOIN_PRIVATE_KEY (optional; read-only without it), AGENTCOIN_URL (legacy alias AGENTCOIN_BASE_URL), AGENTCOIN_CHAIN_ID (default 84532), AGENTCOIN_RPC_URL,
    AGENTCOIN_MAX_PAYMENT (USDC base units), AGENTCOIN_ALLOWED_SERVICE_IDS (comma-separated), AGENTCOIN_ORIGIN."""
    e = os.environ if env is None else env
    kw: dict = {}
    if e.get("AGENTCOIN_PRIVATE_KEY"):
        kw["private_key"] = e["AGENTCOIN_PRIVATE_KEY"]
    kw["base_url"] = agentcoin_url(e)
    if e.get("AGENTCOIN_CHAIN_ID"):
        kw["chain_id"] = int(e["AGENTCOIN_CHAIN_ID"])
    if e.get("AGENTCOIN_RPC_URL"):
        kw["rpc_url"] = e["AGENTCOIN_RPC_URL"]
    if e.get("AGENTCOIN_MAX_PAYMENT"):
        kw["max_payment"] = int(e["AGENTCOIN_MAX_PAYMENT"])
    if e.get("AGENTCOIN_ALLOWED_SERVICE_IDS"):
        kw["allowed_service_ids"] = [s.strip() for s in e["AGENTCOIN_ALLOWED_SERVICE_IDS"].split(",") if s.strip()]
    if e.get("AGENTCOIN_ORIGIN") == "agentcoin":
        kw["origin"] = "agentcoin"
    kw.update(overrides)
    return AgentCoin(**kw)


def as_client(x=None, **kw) -> AgentCoin:
    """AgentCoin instance, a dict of AgentCoin kwargs, or None (environment variables)."""
    if x is not None and hasattr(x, "find_service") and hasattr(x, "place_order"):
        return x
    if isinstance(x, dict):
        return from_env(**{**x, **kw})
    return from_env(**kw)
