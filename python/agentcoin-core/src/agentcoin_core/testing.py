"""Mocked AgentCoin router + seller + chain for unit tests (no network). Used by the plugin test suites."""
from __future__ import annotations

import json
from urllib.parse import urlparse, parse_qs

import httpx
from eth_abi import encode as abi_encode
from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak, to_checksum_address

from .canonical import keccak_jcs
from .client import SEL_APPROVE, SEL_CREATE_AND_FUND_FOR, TOPIC_JOB_CREATED, AgentCoin
from .constants import BASE_SEPOLIA, GET_JOB_OUTPUT
from .x402 import AUTH_TYPES, b64, unb64

BASE = "https://router.test"
SELLER = "https://seller.test/v1/notarize"
SERVICE_ID = "svc_test0000000001"
PAY_TO = "0x6A32bC3Bb5eA1dc814f14E29e6f026535129A84f"
PROVIDER = "0x745528C4E0CBdA5759175A660da06d0aaA72db7F"
EVALUATOR = "0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a"
SETTLE_TX = "0x" + "11" * 32


class FakeChain:
    def __init__(self, mock):
        self.m = mock
        self.sent: list[dict] = []
        self.job = {"state": 2, "accepted": False, "deadline": 1893456000}

    def block_timestamp(self):
        return 1793500000

    def call(self, to, data, sender=None):
        if data[2:10] == keccak(text="getJob(uint256)")[:4].hex():
            tup = (self.m.buyer, PROVIDER, EVALUATOR, 1, self.job["state"], 0, self.job["accepted"], False, 0, self.job["deadline"], 0, 0, 0, int(self.m.amount), 0, 0, b"\x6b" * 32, b"\x00" * 32, b"\x00" * 32)
            return abi_encode([GET_JOB_OUTPUT], [tup])
        if self.m.revert_simulation:
            raise RuntimeError("execution reverted")
        return b""

    def send_transaction(self, account, to, data):
        self.sent.append({"to": to, "data": data})
        return "0x" + keccak(text=f"tx{len(self.sent)}").hex()

    def wait_receipt(self, tx_hash):
        logs = []
        if len(self.sent) == 2 and self.sent[1]["data"][2:10] == SEL_CREATE_AND_FUND_FOR:
            pad = lambda a: "0x" + "00" * 12 + a[2:].lower()
            logs = [{"address": BASE_SEPOLIA["escrow"], "topics": [TOPIC_JOB_CREATED, "0x" + (42).to_bytes(32, "big").hex(), pad(self.m.buyer), pad(PROVIDER)], "data": "0x"}]
        return {"status": 1, "logs": logs}


class MockRouter:
    def __init__(self, buyer: str, *, network="eip155:84532", asset=None, amount="10000", seller_pay_to=None, v1=False, tamper=None, escrow_offer=False, revert_simulation=False):
        self.buyer = to_checksum_address(buyer)
        self.network, self.asset, self.amount = network, asset or BASE_SEPOLIA["usdc"], amount
        self.seller_pay_to, self.v1, self.tamper, self.escrow_offer, self.revert_simulation = seller_pay_to, v1, tamper, escrow_offer, revert_simulation
        self.req = {"scheme": "exact", "network": network, "amount": amount, "asset": self.asset, "payTo": PAY_TO, "maxTimeoutSeconds": 300, "extra": {"name": "USDC", "version": "2"}}
        self.score_key = Account.create()
        self.orders: dict = {}
        self.calls: list[dict] = []
        self.chain = FakeChain(self)

    def _j(self, status, body, headers=None):
        return httpx.Response(status, json=body, headers=headers or {})

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        body = json.loads(request.content) if request.content else None
        h = {k.lower(): v for k, v in request.headers.items()}
        self.calls.append({"method": request.method, "url": url, "body": body, "headers": h})
        if url.startswith(SELLER):
            return self._seller(h, body)
        if not url.startswith(BASE):
            return self._j(599, {"error": "mock: unexpected host " + url})
        u = urlparse(url)
        p = u.path
        if p == "/v1/services" and request.method == "GET":
            return self._j(200, {"total": 2, "results": [{"id": "svc_otherhost0001", "host": "other.test"}, {"id": SERVICE_ID, "name": "Test notary", "host": "seller.test", "status": "claimed", "operatedBy": "AgentCoin"}], "query": {k: v[0] for k, v in parse_qs(u.query).items()}})
        if p == "/v1/services" and request.method == "POST":
            return self._j(200, {"status": "created", "listing": {"id": "svc_new0000000001", "status": "unclaimed"}})
        if p.startswith("/v1/services/") and p.endswith("/claim/verify"):
            return self._j(200, {"status": "claimed", "received": body})
        if p.startswith("/v1/services/") and p.endswith("/claim"):
            return self._j(200, {"eip712": {"typedData": {}}, "wellKnown": {"content": "tok"}})
        if p.startswith("/v1/services/"):
            return self._j(200, {"id": p.split("/")[3], "metadataHash": "0x" + "cd" * 32, "skills": [{"id": "POST /v1/notarize", "method": "POST", "url": SELLER}]})
        if p == "/v1/route":
            return self._j(200, {"candidates": [{"serviceId": "svc_outside000001"}, {"serviceId": SERVICE_ID}], "received": body})
        if p == "/v1/orders" and request.method == "POST":
            return self._order(body)
        parts = p.split("/")
        if len(parts) >= 4 and parts[1] == "v1" and parts[2] == "orders":
            ord_ = self.orders.get(parts[3])
            if not ord_:
                return self._j(404, {"error": "unknown orderId"})
            if len(parts) == 5 and parts[4] == "receipt":
                if ord_["mode"] == "direct":
                    ord_.update(paymentTx=body["paymentTx"], status="settled", verdict="delivered", deliverableHash="0x" + "ee" * 32)
                else:
                    ord_.update(jobId=body["jobId"], paymentTx=body["paymentTx"], status="funded")
                return self._j(200, ord_)
            if ord_["mode"] == "escrow" and ord_.get("jobId"):
                ord_.update(status="verdict", verdict="complete")
            return self._j(200, ord_)
        if p.startswith("/v1/reputation/"):
            evidence = [{"type": "probe", "status": 200}]
            score = {"v": "agentcoin-score/v1", "serviceId": p.split("/")[3], "evidenceRoot": keccak_jcs(evidence), "testnet": True}
            d = keccak_jcs(score)
            sig = Account.sign_message(encode_defunct(primitive=bytes.fromhex(d[2:])), self.score_key.key).signature.hex()
            score["signature"] = {"scheme": "eip191", "canonicalization": "RFC8785", "digest": "keccak256", "signer": self.score_key.address, "signedDigest": d, "value": sig if sig.startswith("0x") else "0x" + sig}
            return self._j(200, {"score": score, "evidence": evidence})
        if p == "/mcp":
            return self._j(200, {"jsonrpc": "2.0", "id": 1, "result": {"structuredContent": {"document": {"valid": True}}, "content": [{"type": "text", "text": "{}"}]}})
        return self._j(404, {"error": f"mock: no route {request.method} {p}"})

    def _seller(self, h, body):
        if "payment-signature" in h:
            pl = unb64(h["payment-signature"])
            if (pl.get("accepted") or {}).get("scheme") == "agentcoin-escrow":
                return self._j(200, {"receipt": {"jobId": pl["payload"]["jobId"]}, "deliverableHash": "0x" + "ab" * 32})
            a = pl["payload"]["authorization"]
            msg = {"from": a["from"], "to": a["to"], "value": int(a["value"]), "validAfter": int(a["validAfter"]), "validBefore": int(a["validBefore"]), "nonce": bytes.fromhex(a["nonce"][2:])}
            from eth_account.messages import encode_typed_data
            signable = encode_typed_data(domain_data={"name": "USDC", "version": "2", "chainId": 84532, "verifyingContract": to_checksum_address(self.asset)}, message_types=AUTH_TYPES, message_data=msg)
            if to_checksum_address(Account.recover_message(signable, signature=pl["payload"]["signature"])) != to_checksum_address(a["from"]):
                return self._j(402, {"error": "bad signature"})
            return self._j(200, {"receipt": {"digest": (body or {}).get("sha256")}}, {"PAYMENT-RESPONSE": b64({"success": True, "transaction": SETTLE_TX, "network": self.network, "payer": a["from"], "jobId": "7"})})
        if "x-payment" in h:
            return self._j(200, {"ok": True}, {"X-PAYMENT-RESPONSE": b64({"success": True, "transaction": SETTLE_TX, "network": "base-sepolia"})})
        pay_to = self.seller_pay_to or PAY_TO
        if self.v1:
            return self._j(402, {"x402Version": 1, "accepts": [{"scheme": "exact", "network": "base-sepolia" if self.network == "eip155:84532" else self.network, "maxAmountRequired": self.amount, "asset": self.asset, "payTo": pay_to, "resource": SELLER, "maxTimeoutSeconds": 60, "extra": {"name": "USDC", "version": "2"}}]})
        accepts = [{**self.req, "payTo": pay_to}]
        if self.escrow_offer:
            accepts.append({"scheme": "agentcoin-escrow", "network": self.network, "amount": self.amount, "asset": self.asset, "payTo": PROVIDER, "maxTimeoutSeconds": 300, "extra": {}})
        return self._j(402, {}, {"PAYMENT-REQUIRED": b64({"x402Version": 2, "resource": {"url": SELLER}, "accepts": accepts})})

    def _order(self, body):
        if body["serviceId"] != SERVICE_ID:
            return self._j(404, {"error": "unknown serviceId"})
        oid = f"ord_{len(self.orders) + 1}"
        if body["mode"] == "escrow":
            client = "0x000000000000000000000000000000000000dEaD" if self.tamper == "client" else body["buyer"]
            spender = "0x000000000000000000000000000000000000bEEF" if self.tamper == "spender" else BASE_SEPOLIA["escrow"]
            approve = "0x" + SEL_APPROVE + abi_encode(["address", "uint256"], [spender, int(self.amount)]).hex()
            fund = "0x" + SEL_CREATE_AND_FUND_FOR + abi_encode(["address", "address", "address", "uint256", "uint64", "bytes32"], [client, PROVIDER, EVALUATOR, int(self.amount), 1893456000, b"\x6b" * 32]).hex()
            order = {"orderId": oid, "mode": "escrow", "serviceId": SERVICE_ID, "origin": body.get("origin", "external"),
                     "escrow": {"chainId": 84532, "contract": "0x000000000000000000000000000000000000c0De" if self.tamper == "contract" else BASE_SEPOLIA["escrow"], "token": self.asset,
                                "client": body["buyer"], "provider": PROVIDER, "evaluator": EVALUATOR, "amount": self.amount, "deadline": "1893456000", "specHash": "0x" + "6b" * 32},
                     "transactions": [{"step": 1, "label": "USDC.approve(escrow, amount)", "chainId": 84532, "to": self.asset, "data": approve, "value": "0"},
                                      {"step": 2, "label": "JobEscrow.createAndFundFor", "chainId": 84532, "to": BASE_SEPOLIA["escrow"], "data": fund, "value": "0"}],
                     "sellerCall": {"method": "POST", "url": SELLER}}
            self.orders[oid] = {**order, "status": "awaiting-escrow"}
            return self._j(201, order)
        order = {"orderId": oid, "mode": "direct", "serviceId": SERVICE_ID, "origin": body.get("origin", "external"), "paymentRequirements": [self.req], "request": {"method": "POST", "url": SELLER}}
        self.orders[oid] = {**order, "status": "awaiting-payment"}
        return self._j(201, order)


def mock_client(mock_opts: dict | None = None, **client_kw):
    """Returns (MockRouter, AgentCoin) with a fresh random buyer key."""
    acct = Account.create()
    m = MockRouter(acct.address, **(mock_opts or {}))
    c = AgentCoin(base_url=BASE, account=acct, http=httpx.Client(transport=httpx.MockTransport(m.handler)), chain=m.chain, poll_interval=0.001, **client_kw)
    return m, c
