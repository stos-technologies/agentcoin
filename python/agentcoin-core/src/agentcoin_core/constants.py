"""Deployment constants for the AgentCoin v0.5 router on Base Sepolia (chainId 84532)."""

import os as _os
from typing import Mapping as _Mapping, Optional as _Optional

#: Default AgentCoin service URL (Base Sepolia testnet router). The only place the URL is defined in Python; override with AGENTCOIN_URL.
DEFAULT_AGENTCOIN_URL = "https://agentcoin.143-244-167-51.sslip.io"


def agentcoin_url(env: _Optional[_Mapping[str, str]] = None) -> str:
    """Service URL: AGENTCOIN_URL, else legacy AGENTCOIN_BASE_URL, else DEFAULT_AGENTCOIN_URL. Trailing slashes removed."""
    e = _os.environ if env is None else env
    return (e.get("AGENTCOIN_URL") or e.get("AGENTCOIN_BASE_URL") or DEFAULT_AGENTCOIN_URL).rstrip("/")


BASE_SEPOLIA = {
    "chain_id": 84532,
    "caip2": "eip155:84532",
    "x402_network_v1": "base-sepolia",
    "rpc_url": "https://sepolia.base.org",
    "explorer": "https://sepolia.basescan.org",
    "router_url": DEFAULT_AGENTCOIN_URL,
    "usdc": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "usdc_eip712": {"name": "USDC", "version": "2"},
    "escrow": "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D",
    "operator_signer": "0xf1b27b5Bd659D9Bfb4835777E64B8F8e5C3eCf68",
}

#: Chain ids treated as mainnet. Refused unless allow_mainnet is set; mainnet is unsupported in v0.1.
MAINNET_CHAIN_IDS = frozenset({1, 8453, 10, 137, 42161, 43114, 56, 324, 59144, 534352, 7777777, 81457, 100, 250, 1101, 5000, 130, 480, 146, 2741})

#: Default per-order payment ceiling: 50000 base units = 0.05 test USDC.
DEFAULT_MAX_PAYMENT = 50_000

ESCROW_STATES = ["None", "Open", "Funded", "Submitted", "Completed", "Rejected", "Partial", "Disputed", "Settled", "Expired", "Cancelled"]

GET_JOB_OUTPUT = "(address,address,address,uint32,uint8,uint8,bool,bool,uint16,uint64,uint64,uint64,uint64,uint256,uint256,uint256,bytes32,bytes32,bytes32)"
GET_JOB_FIELDS = ["client", "provider", "evaluator", "configVersion", "state", "outcome", "accepted", "instant", "payoutBps", "deadline", "submittedAt", "verdictAt", "disputedAt", "amount", "providerBond", "slashBase", "specHash", "deliverableHash", "reasonHash"]
