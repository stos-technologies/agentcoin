"""AgentCoin router client (Python). Same flow and guards as @agentcoin/core:
find_service / route_task -> place_order -> pay (direct x402 exact, or escrow) -> get_order / wait_for_verdict -> verify."""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from urllib.parse import quote

import httpx
from eth_abi import decode as abi_decode, encode as abi_encode
from eth_account import Account
from eth_utils import keccak, to_checksum_address

from .canonical import keccak_jcs, verify_eip191_document
from .chain import Chain, Web3Chain
from .constants import agentcoin_url, BASE_SEPOLIA, DEFAULT_MAX_PAYMENT, ESCROW_STATES, GET_JOB_FIELDS, GET_JOB_OUTPUT, MAINNET_CHAIN_IDS
from .errors import AgentCoinError
from .x402 import escrow_payment_header, parse402, read_payment_response, sign_exact_payment


def _sel(sig: str) -> str:
    return keccak(text=sig)[:4].hex()


SEL_APPROVE = _sel("approve(address,uint256)")
SEL_CREATE_AND_FUND_FOR = _sel("createAndFundFor(address,address,address,uint256,uint64,bytes32)")
SEL = {n: _sel(f"{n}(uint256)") for n in ("cancel", "claimRefund", "timeoutRelease", "finalize", "getJob")}
TOPIC_JOB_CREATED = "0x" + keccak(text="JobCreated(uint256,address,address,address,uint256,uint64,bytes32,uint32)").hex()
_HEX64 = re.compile(r"^0x[0-9a-fA-F]{64}$")


def assert_chain_allowed(chain_id: int, allow_mainnet: bool = False) -> None:
    if not isinstance(chain_id, int) or chain_id <= 0:
        raise AgentCoinError("bad_chain", f"invalid chainId {chain_id}")
    if chain_id in MAINNET_CHAIN_IDS and not allow_mainnet:
        raise AgentCoinError("mainnet_refused", f"chainId {chain_id} is a mainnet; AgentCoin v0.1 plugins run on Base Sepolia (84532) only. allow_mainnet is unsupported.")


def _decode_body(b: bytes):
    try:
        return json.loads(b)
    except ValueError:
        return b.decode("utf-8", "replace")


def _cs(a) -> str:
    return to_checksum_address(a)


@dataclass
class PayResult:
    order_id: str
    mode: str
    service_id: str
    amount: str
    payment_tx: str | None
    job_id: str | None
    deliverable: object
    seller_status: int | None
    order: dict
    transactions: list = field(default_factory=list)
    response: dict | None = None

    def summary(self) -> dict:
        return {"orderId": self.order_id, "mode": self.mode, "serviceId": self.service_id, "amount": self.amount, "paymentTx": self.payment_tx, "jobId": self.job_id,
                "deliverable": self.deliverable, "sellerStatus": self.seller_status, "transactions": self.transactions or None}


class AgentCoin:
    def __init__(self, *, base_url: str | None = None, chain_id: int = BASE_SEPOLIA["chain_id"], private_key: str | None = None, account=None,
                 rpc_url: str | None = None, max_payment: int | str = DEFAULT_MAX_PAYMENT, allowed_service_ids: list[str] | None = None,
                 origin: str | None = None, allow_mainnet: bool = False, usdc: str | None = None, escrow: str | None = None,
                 http: httpx.Client | None = None, chain: Chain | None = None, poll_interval: float = 15.0, verdict_timeout: float = 600.0):
        """allow_mainnet is unsupported in v0.1 (default False); the hosted router serves eip155:84532 only."""
        assert_chain_allowed(chain_id, allow_mainnet)
        if chain_id != BASE_SEPOLIA["chain_id"] and not usdc:
            raise AgentCoinError("bad_chain", f"no USDC address known for chainId {chain_id}; pass usdc")
        self.chain_id = chain_id
        self.caip2 = f"eip155:{chain_id}"
        self.base_url = (base_url or agentcoin_url()).rstrip("/")
        self.account = account or (Account.from_key(private_key) if private_key else None)
        self.max_payment = int(max_payment)
        self.allowed_service_ids = set(allowed_service_ids) if allowed_service_ids else None
        self.origin = origin
        self.usdc = _cs(usdc or BASE_SEPOLIA["usdc"])
        self.escrow = _cs(escrow or BASE_SEPOLIA["escrow"])
        self.http = http or httpx.Client(timeout=httpx.Timeout(300, connect=15), follow_redirects=False)
        self._rpc_url = rpc_url or BASE_SEPOLIA["rpc_url"]
        self._chain = chain
        self.poll_interval = poll_interval
        self.verdict_timeout = verdict_timeout

    @property
    def address(self) -> str | None:
        return self.account.address if self.account else None

    @property
    def chain(self) -> Chain:
        if self._chain is None:
            self._chain = Web3Chain(self._rpc_url, self.chain_id)
        return self._chain

    def _need_account(self, what="payment"):
        if not self.account:
            raise AgentCoinError("no_account", f"{what} needs a signer (private_key)")

    # ---------------------------------------------------------------- REST
    def api(self, method: str, path: str, body=None) -> dict:
        r = self.http.request(method, self.base_url + path, headers={"accept": "application/json"}, **({"json": body} if body is not None else {}))
        try:
            j = r.json()
        except ValueError:
            j = None
        if r.status_code >= 400:
            msg = (j or {}).get("error") if isinstance(j, dict) else None
            raise AgentCoinError(f"http_{r.status_code}", f"{method} {path} -> {r.status_code}: {msg or json.dumps(j)[:300]}", j)
        return j if j is not None else {}

    def find_service(self, id: str | None = None, skills_offset: int | None = None, **q) -> dict:
        if id:
            return self.api("GET", f"/v1/services/{quote(id, safe='')}" + (f"?skillsOffset={skills_offset}" if skills_offset else ""))
        params = {k: (str(v).lower() if isinstance(v, bool) else str(v)) for k, v in q.items() if v is not None}
        qs = str(httpx.QueryParams(params))
        return self.api("GET", "/v1/services" + (f"?{qs}" if qs else ""))

    def route_task(self, task: str, budget: str | None = None, constraints: dict | None = None) -> dict:
        body = {"task": task, "constraints": {"network": self.caip2, **(constraints or {})}}
        if budget:
            body["budget"] = str(budget)
        return self.api("POST", "/v1/route", body)

    def place_order(self, service_id: str, skill_id: str | None = None, mode: str = "direct", deadline_seconds: int | None = None) -> dict:
        self.assert_service_allowed(service_id)
        if mode == "escrow":
            self._need_account("escrow orders")
        body = {"serviceId": service_id, "mode": mode}
        if skill_id:
            body["skillId"] = skill_id
        if self.account:
            body["buyer"] = self.account.address
        if deadline_seconds:
            body["deadlineSeconds"] = deadline_seconds
        if self.origin:
            body["origin"] = self.origin
        return self.api("POST", "/v1/orders", body)

    def get_order(self, order_id: str) -> dict:
        return self.api("GET", f"/v1/orders/{quote(order_id, safe='')}")

    def submit_receipt(self, order_id: str, body: dict) -> dict:
        return self.api("POST", f"/v1/orders/{quote(order_id, safe='')}/receipt", body)

    def submit_listing(self, url: str) -> dict:
        return self.api("POST", "/v1/services", {"url": url})

    def claim_listing(self, service_id: str, sign: bool = False, method: str | None = None, expires_in_seconds: int = 3600) -> dict:
        sid = quote(service_id, safe="")
        if method == "well-known":
            return self.api("POST", f"/v1/services/{sid}/claim/verify", {"method": "well-known", **({"claimant": self.address} if self.account else {})})
        if not sign:
            return self.api("POST", f"/v1/services/{sid}/claim", {"claimant": self.address} if self.account else {})
        self._need_account("signing a claim")
        svc = self.find_service(id=service_id)
        mh = svc.get("metadataHash")
        if not isinstance(mh, str) or not _HEX64.match(mh):
            raise AgentCoinError("no_metadata_hash", "listing has no metadataHash")
        expires_at = int(time.time()) + min(86_400, expires_in_seconds)
        sig = self.account.sign_typed_data(
            domain_data={"name": "AgentCoin Index", "version": "1", "chainId": self.chain_id},
            message_types={"Claim": [{"name": "serviceId", "type": "string"}, {"name": "claimant", "type": "address"}, {"name": "metadataHash", "type": "bytes32"}, {"name": "expiresAt", "type": "uint256"}]},
            message_data={"serviceId": service_id, "claimant": self.account.address, "metadataHash": bytes.fromhex(mh[2:]), "expiresAt": expires_at},
        ).signature.hex()
        sig = sig if sig.startswith("0x") else "0x" + sig
        return self.api("POST", f"/v1/services/{sid}/claim/verify", {"claimant": self.account.address, "expiresAt": str(expires_at), "signature": sig})

    def reputation(self, service_id: str) -> dict:
        rep = self.api("GET", f"/v1/reputation/{quote(service_id, safe='')}")
        score, ev = rep.get("score"), rep.get("evidence")
        sig = verify_eip191_document(score) if score else {"valid": False, "reason": "no score"}
        root_ok = bool(isinstance(ev, list) and score and score.get("evidenceRoot") and keccak_jcs(ev) == score["evidenceRoot"])
        is_op = bool(sig.get("signer")) and _cs(sig["signer"]) == _cs(BASE_SEPOLIA["operator_signer"])
        return {"serviceId": service_id, "score": score, "evidenceCount": len(ev) if isinstance(ev, list) else 0,
                "checks": {"signatureValid": sig["valid"], "signer": sig.get("signer"), "signerIsOperator": is_op, "evidenceRootMatches": root_ok}, "evidence": ev}

    def verify_delivery_record(self, record: dict | None) -> dict:
        if not record:
            return {"valid": False, "reason": "no delivery record"}
        r = verify_eip191_document(record)
        return {**r, "signerIsOperator": bool(r.get("signer")) and _cs(r["signer"]) == _cs(BASE_SEPOLIA["operator_signer"])}

    def mcp_call(self, name: str, args: dict) -> dict:
        r = self.http.post(self.base_url + "/mcp", headers={"accept": "application/json, text/event-stream"}, json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}})
        text = r.text
        if text.startswith("event:") or text.startswith("data:"):
            text = "".join(l[5:] for l in text.split("\n") if l.startswith("data:"))
        j = json.loads(text)
        if j.get("error"):
            raise AgentCoinError("mcp_error", j["error"].get("message", "mcp error"), j["error"])
        res = j.get("result") or {}
        if res.get("isError"):
            raise AgentCoinError("mcp_tool_error", (res.get("content") or [{}])[0].get("text", "tool error"), res)
        return res.get("structuredContent") or json.loads((res.get("content") or [{}])[0].get("text", "{}"))

    def verify(self, service_id: str | None = None, order_id: str | None = None, document=None, expected_signer: str | None = None, evaluator: str | None = None) -> dict:
        out: dict = {}
        if service_id:
            out["service"] = self.reputation(service_id)
        if order_id:
            o = self.get_order(order_id)
            out["order"] = {"orderId": o.get("orderId"), "status": o.get("status"), "verdict": o.get("verdict"), "deliverableHash": o.get("deliverableHash"), "deliveryRecord": self.verify_delivery_record(o.get("deliveryRecord"))}
        if document is not None or evaluator:
            args = {}
            if document is not None:
                args["document"] = document
            if expected_signer:
                args["expectedSigner"] = expected_signer
            if evaluator:
                args["evaluator"] = evaluator
            out.update(self.mcp_call("verify", args))
        if not out:
            raise AgentCoinError("bad_args", "service_id, order_id, document or evaluator required")
        return out

    # ---------------------------------------------------------------- guards
    def assert_service_allowed(self, service_id: str) -> None:
        if self.allowed_service_ids is not None and service_id not in self.allowed_service_ids:
            raise AgentCoinError("service_not_allowed", f"serviceId {service_id} is not in allowed_service_ids")

    def _assert_requirement(self, network: str, asset: str, amount) -> None:
        if network != self.caip2:
            raise AgentCoinError("wrong_network", f"payment network {network} != {self.caip2}")
        if _cs(asset) != self.usdc:
            raise AgentCoinError("wrong_asset", f"payment asset {asset} != USDC {self.usdc}")
        if int(amount) > self.max_payment:
            raise AgentCoinError("over_max_payment", f"amount {amount} > max_payment {self.max_payment}")

    # ---------------------------------------------------------------- payment
    def pay_direct(self, order: dict, body=None, method: str | None = None, url: str | None = None, headers: dict | None = None) -> PayResult:
        self._need_account()
        if order.get("mode") != "direct":
            raise AgentCoinError("bad_order", "pay_direct needs a direct order")
        self.assert_service_allowed(order["serviceId"])
        routed = next((r for r in order.get("paymentRequirements") or [] if r.get("scheme") == "exact" and r.get("network") == self.caip2), None)
        if not routed:
            raise AgentCoinError("wrong_network", f"order has no exact requirement on {self.caip2}")
        self._assert_requirement(routed["network"], routed["asset"], routed["amount"])
        req_info = order.get("request") or {}
        url = url or req_info.get("url")
        if not url:
            raise AgentCoinError("no_url", "order has no seller request url")
        method = (method or req_info.get("method") or ("POST" if body is not None else "GET")).upper()
        content = None if body is None else (body if isinstance(body, str) else json.dumps(body))
        base_h = {**({"content-type": "application/json"} if body is not None else {}), **(headers or {})}
        r1 = self.http.request(method, url, headers=base_h, content=content)
        if r1.status_code != 402:
            raise AgentCoinError("expected_402", f"seller returned {r1.status_code} before payment")
        parsed = parse402(r1.headers, r1.content)
        req = next((x for x in parsed.accepts if x.scheme == "exact" and x.network == self.caip2), None)
        if not req:
            raise AgentCoinError("wrong_network", f"seller offers no exact requirement on {self.caip2}")
        self._assert_requirement(req.network, req.asset, req.amount)
        if _cs(req.pay_to) != _cs(routed["payTo"]):
            raise AgentCoinError("payto_mismatch", f"seller payTo {req.pay_to} != indexed payTo {routed['payTo']}")
        if int(req.amount) != int(routed["amount"]):
            raise AgentCoinError("amount_mismatch", f"seller amount {req.amount} != quoted {routed['amount']}")
        hn, hv = sign_exact_payment(self.account, req, parsed, chain_id=self.chain_id, token_name=BASE_SEPOLIA["usdc_eip712"]["name"],
                                    token_version=BASE_SEPOLIA["usdc_eip712"]["version"], now_seconds=self.chain.block_timestamp())
        t = time.time()
        r2 = self.http.request(method, url, headers={**base_h, hn: hv}, content=content)
        latency_ms = int((time.time() - t) * 1000)
        deliverable = _decode_body(r2.content)
        if r2.status_code != 200:
            raise AgentCoinError("payment_rejected", f"seller returned {r2.status_code} after payment", deliverable)
        pr = read_payment_response(r2.headers) or {}
        ptx = pr.get("transaction") or pr.get("txHash")
        if not (isinstance(ptx, str) and _HEX64.match(ptx)):
            raise AgentCoinError("no_payment_tx", "seller returned no settlement transaction in PAYMENT-RESPONSE", {"paymentResponse": pr, "deliverable": deliverable})
        rec = self.submit_receipt(order["orderId"], {"paymentTx": ptx, "deliverable": deliverable, "latencyMs": latency_ms})
        return PayResult(order["orderId"], "direct", order["serviceId"], req.amount, ptx, pr.get("jobId"), deliverable, r2.status_code, rec,
                         response={"status": r2.status_code, "headers": dict(r2.headers), "body": r2.content})

    def _check_escrow_txs(self, order: dict) -> None:
        e = order.get("escrow") or {}
        if int(e.get("chainId", -1)) != self.chain_id:
            raise AgentCoinError("wrong_network", f"escrow chainId {e.get('chainId')} != {self.chain_id}")
        if _cs(e["contract"]) != self.escrow:
            raise AgentCoinError("wrong_escrow", f"escrow contract {e['contract']} != {self.escrow}")
        self._assert_requirement(self.caip2, e["token"], e["amount"])
        txs = order.get("transactions") or []
        if len(txs) != 2:
            raise AgentCoinError("bad_order", "expected 2 escrow transactions")
        a, f = txs
        if _cs(a["to"]) != self.usdc or int(a["chainId"]) != self.chain_id or int(a.get("value") or 0) != 0:
            raise AgentCoinError("bad_tx", "approve tx target/chain/value mismatch")
        d = a["data"].removeprefix("0x")
        if d[:8] != SEL_APPROVE:
            raise AgentCoinError("bad_tx", "approve must be approve(escrow, amount)")
        spender, amt = abi_decode(["address", "uint256"], bytes.fromhex(d[8:]))
        if _cs(spender) != self.escrow or amt != int(e["amount"]):
            raise AgentCoinError("bad_tx", "approve must be approve(escrow, amount)")
        if _cs(f["to"]) != self.escrow or int(f["chainId"]) != self.chain_id or int(f.get("value") or 0) != 0:
            raise AgentCoinError("bad_tx", "fund tx target/chain/value mismatch")
        d = f["data"].removeprefix("0x")
        if d[:8] != SEL_CREATE_AND_FUND_FOR:
            raise AgentCoinError("bad_tx", "fund tx must be createAndFundFor")
        client, provider, evaluator, amount, _deadline, _spec = abi_decode(["address", "address", "address", "uint256", "uint64", "bytes32"], bytes.fromhex(d[8:]))
        if _cs(client) != _cs(self.account.address):
            raise AgentCoinError("bad_tx", "createAndFundFor client != my address")
        if _cs(provider) != _cs(e["provider"]) or _cs(evaluator) != _cs(e["evaluator"]) or amount != int(e["amount"]):
            raise AgentCoinError("bad_tx", "createAndFundFor args != order escrow terms")

    def pay_escrow(self, order: dict, body=None, headers: dict | None = None, seller_call: dict | None | bool = True) -> PayResult:
        """seller_call: True = use the order's sellerCall; dict {url, method} = override; None/False = skip the seller call."""
        self._need_account()
        if order.get("mode") != "escrow":
            raise AgentCoinError("bad_order", "pay_escrow needs an escrow order")
        self.assert_service_allowed(order["serviceId"])
        self._check_escrow_txs(order)
        sent = []
        job_id = None
        for tx in order["transactions"]:
            h = self.chain.send_transaction(self.account, tx["to"], tx["data"])
            rc = self.chain.wait_receipt(h)
            if int(rc["status"]) != 1:
                raise AgentCoinError("tx_reverted", f"{tx.get('label')} reverted: {h}")
            sent.append({"label": tx.get("label"), "hash": h})
            for lg in rc.get("logs", []):
                if _cs(lg["address"]) == self.escrow and lg["topics"] and lg["topics"][0].lower() == TOPIC_JOB_CREATED:
                    job_id = str(int(lg["topics"][1], 16))
        if job_id is None:
            raise AgentCoinError("no_job", "no JobCreated event in fund tx")
        fund_tx = sent[1]["hash"]
        rec: dict = {}
        for i in range(4):
            try:
                rec = self.submit_receipt(order["orderId"], {"jobId": job_id, "paymentTx": fund_tx})
                break
            except AgentCoinError:
                if i == 3:
                    raise
                time.sleep(3)
        sc = order.get("sellerCall") if seller_call is True else (seller_call or None)
        deliverable, status, response = None, None, None
        if sc and sc.get("url"):
            content = None if body is None else (body if isinstance(body, str) else json.dumps(body))
            r = self.http.request(sc.get("method") or "POST", sc["url"], content=content,
                                  headers={"content-type": "application/json", **(headers or {}), "PAYMENT-SIGNATURE": escrow_payment_header(self.chain_id, job_id, fund_tx)})
            status = r.status_code
            deliverable = _decode_body(r.content)
            response = {"status": r.status_code, "headers": dict(r.headers), "body": r.content}
        return PayResult(order["orderId"], "escrow", order["serviceId"], str(order["escrow"]["amount"]), fund_tx, job_id, deliverable, status, rec, sent, response)

    def wait_for_verdict(self, order_id: str, timeout: float | None = None, interval: float | None = None) -> dict:
        end = time.time() + (self.verdict_timeout if timeout is None else timeout)
        def poll():
            try:
                return self.get_order(order_id)
            except httpx.TransportError:  # slow/failed read of the order: keep polling until the deadline
                if time.time() >= end:
                    raise
                return {}
        o = poll()
        while not o.get("verdict") and time.time() < end:
            time.sleep(self.poll_interval if interval is None else interval)
            o = poll()
        return o

    def get_job(self, job_id) -> dict:
        data = "0x" + SEL["getJob"] + abi_encode(["uint256"], [int(job_id)]).hex()
        (tup,) = abi_decode([GET_JOB_OUTPUT], self.chain.call(self.escrow, data))
        j = dict(zip(GET_JOB_FIELDS, tup))
        j["stateName"] = ESCROW_STATES[int(j["state"])]
        return j

    def refund(self, job_id, send: bool = True) -> dict:
        """Buyer refund path for an escrow job (cancel / claimRefund / timeoutRelease / finalize by state); simulates, then sends."""
        job = self.get_job(job_id)
        now = int(time.time())
        st = job["stateName"]
        jid = str(job_id)
        fn = None
        if st == "Funded" and not job["accepted"]:
            fn = "cancel"
        elif st == "Funded" and now >= int(job["deadline"]):
            fn = "claimRefund"
        elif st == "Submitted":
            fn = "timeoutRelease"
        elif st in ("Rejected", "Partial", "Completed"):
            fn = "finalize"
        if not fn:
            return {"jobId": jid, "state": st, "sent": False, "reason": f"no refund action for state {st}" + (" before the deadline" if st == "Funded" else "")}
        if fn == "cancel" and (not self.account or _cs(job["client"]) != _cs(self.account.address)):
            return {"jobId": jid, "state": st, "sent": False, "reason": "cancel is callable by the job client only"}
        data = "0x" + SEL[fn] + abi_encode(["uint256"], [int(job_id)]).hex()
        if not self.account:
            return {"jobId": jid, "state": st, "action": fn, "sent": False, "reason": "no signer", "data": data, "to": self.escrow}
        try:
            self.chain.call(self.escrow, data, sender=self.account.address)
        except Exception as e:  # revert
            return {"jobId": jid, "state": st, "action": fn, "sent": False, "reason": f"simulation reverted: {e}"}
        if not send:
            return {"jobId": jid, "state": st, "action": fn, "sent": False, "reason": "send=False (simulation ok)"}
        h = self.chain.send_transaction(self.account, self.escrow, data)
        rc = self.chain.wait_receipt(h)
        return {"jobId": jid, "state": st, "action": fn, "sent": True, "tx": h, "status": "success" if int(rc["status"]) == 1 else "reverted"}

    def buy(self, service_id: str | None = None, task: str | None = None, budget: str | None = None, skill_id: str | None = None, mode: str = "direct",
            body=None, wait_for_verdict: bool = True, deadline_seconds: int | None = None) -> dict:
        """(route | service_id) -> place_order -> pay -> (escrow: wait for verdict) -> verify. Candidates filtered by allowed_service_ids."""
        route = None
        if not service_id:
            if not task:
                raise AgentCoinError("bad_args", "service_id or task required")
            route = self.route_task(task, budget or str(self.max_payment))
            cands = route.get("candidates") or []
            c = next((x for x in cands if self.allowed_service_ids is None or (x.get("serviceId") or x.get("id")) in self.allowed_service_ids), None)
            if not c:
                raise AgentCoinError("no_candidate", "no routed candidate within allowed_service_ids and budget", {"candidates": [x.get("serviceId") or x.get("id") for x in cands]})
            service_id = c.get("serviceId") or c.get("id")
        order = self.place_order(service_id, skill_id, mode, deadline_seconds)
        paid = self.pay_escrow(order, body) if mode == "escrow" else self.pay_direct(order, body)
        final = self.wait_for_verdict(order["orderId"]) if mode == "escrow" and wait_for_verdict else self.get_order(order["orderId"])
        verification = self.verify(service_id=service_id, order_id=order["orderId"])
        job = final.get("job") or {}
        return {"serviceId": service_id, "routedFrom": {"candidates": len(route.get("candidates") or [])} if route else None,
                "order": {k: v for k, v in paid.summary().items() if k != "deliverable"}, "deliverable": paid.deliverable,
                "final": {"status": final.get("status"), "verdict": final.get("verdict"), "deliverableHash": final.get("deliverableHash"), "jobState": job.get("stateName") or job.get("state")},
                "verification": verification, "testnet": True}
