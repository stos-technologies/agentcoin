"""x402 "exact" (EIP-3009 TransferWithAuthorization) helpers, protocol v1 and v2."""
from __future__ import annotations

import base64
import json
import os
import re
from dataclasses import dataclass, field

from eth_account import Account
from eth_utils import to_checksum_address

from .errors import AgentCoinError

_V1 = {"base-sepolia": "eip155:84532", "base": "eip155:8453", "ethereum": "eip155:1", "ethereum-sepolia": "eip155:11155111", "polygon": "eip155:137",
       "polygon-amoy": "eip155:80002", "avalanche": "eip155:43114", "avalanche-fuji": "eip155:43113", "arbitrum": "eip155:42161", "optimism": "eip155:10"}


def b64(o) -> str:
    return base64.b64encode(json.dumps(o, separators=(",", ":")).encode()).decode()


def unb64(s: str):
    return json.loads(base64.b64decode(s))


def to_caip2(network: str) -> str:
    if re.fullmatch(r"eip155:[0-9]+", network):
        return network
    return _V1.get(network, network)


@dataclass
class PaymentRequirement:
    scheme: str
    network: str
    amount: str
    asset: str
    pay_to: str
    x402_version: int
    raw: dict
    max_timeout_seconds: int | None = None
    extra: dict = field(default_factory=dict)


@dataclass
class Parsed402:
    x402_version: int
    resource: object
    accepts: list


def _norm(a: dict, v: int) -> PaymentRequirement:
    return PaymentRequirement(scheme=a.get("scheme"), network=to_caip2(str(a.get("network"))), amount=str(a.get("amount", a.get("maxAmountRequired"))),
                              asset=a.get("asset"), pay_to=a.get("payTo"), x402_version=v, raw=a, max_timeout_seconds=a.get("maxTimeoutSeconds"), extra=a.get("extra") or {})


def parse402(headers, body: bytes) -> Parsed402:
    h = headers.get("payment-required")
    if h:
        pr = unb64(h)
        return Parsed402(2, pr.get("resource"), [_norm(a, 2) for a in pr.get("accepts", [])])
    try:
        j = json.loads(body or b"null")
    except ValueError:
        j = None
    if isinstance(j, dict) and isinstance(j.get("accepts"), list):
        v = 2 if j.get("x402Version") == 2 else 1
        return Parsed402(v, j.get("resource"), [_norm(a, v) for a in j["accepts"]])
    raise AgentCoinError("x402_unparseable", "402 response without PAYMENT-REQUIRED header or accepts[] body")


AUTH_TYPES = {"TransferWithAuthorization": [
    {"name": "from", "type": "address"}, {"name": "to", "type": "address"}, {"name": "value", "type": "uint256"},
    {"name": "validAfter", "type": "uint256"}, {"name": "validBefore", "type": "uint256"}, {"name": "nonce", "type": "bytes32"}]}


def sign_exact_payment(account, req: PaymentRequirement, parsed: Parsed402, *, chain_id: int, token_name: str, token_version: str, now_seconds: int, nonce: str | None = None) -> tuple[str, str]:
    """Returns (header name, header value) for the paid retry."""
    n = nonce or "0x" + os.urandom(32).hex()
    timeout = int(req.max_timeout_seconds or 300)
    auth = {"from": account.address, "to": to_checksum_address(req.pay_to), "value": str(req.amount), "validAfter": str(now_seconds - 60), "validBefore": str(now_seconds + timeout), "nonce": n}
    domain = {"name": req.extra.get("name", token_name), "version": req.extra.get("version", token_version), "chainId": chain_id, "verifyingContract": to_checksum_address(req.asset)}
    msg = {"from": auth["from"], "to": auth["to"], "value": int(auth["value"]), "validAfter": int(auth["validAfter"]), "validBefore": int(auth["validBefore"]), "nonce": bytes.fromhex(n[2:])}
    sig = account.sign_typed_data(domain_data=domain, message_types=AUTH_TYPES, message_data=msg).signature.hex()
    sig = sig if sig.startswith("0x") else "0x" + sig
    if req.x402_version == 2:
        return "PAYMENT-SIGNATURE", b64({"x402Version": 2, "resource": parsed.resource, "accepted": req.raw, "payload": {"signature": sig, "authorization": auth}})
    return "X-PAYMENT", b64({"x402Version": 1, "scheme": req.scheme, "network": req.raw.get("network"), "payload": {"signature": sig, "authorization": auth}})


def read_payment_response(headers) -> dict | None:
    h = headers.get("payment-response") or headers.get("x-payment-response")
    if not h:
        return None
    try:
        return unb64(h)
    except Exception:
        return None


def escrow_payment_header(chain_id: int, job_id: str, tx_hash: str) -> str:
    return b64({"x402Version": 2, "accepted": {"scheme": "agentcoin-escrow", "network": f"eip155:{chain_id}"}, "payload": {"jobId": job_id, "txHash": tx_hash}})
