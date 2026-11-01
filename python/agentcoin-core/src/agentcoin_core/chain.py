"""Minimal EVM access used by the client. Tests inject a fake with the same methods."""
from __future__ import annotations

from typing import Protocol

from eth_utils import to_checksum_address


class Chain(Protocol):
    def block_timestamp(self) -> int: ...
    def call(self, to: str, data: str, sender: str | None = None) -> bytes: ...
    def send_transaction(self, account, to: str, data: str) -> str: ...
    def wait_receipt(self, tx_hash: str) -> dict: ...


class Web3Chain:
    """JSON-RPC chain access via web3.py. Signs locally with the eth_account LocalAccount; never sends keys anywhere."""

    def __init__(self, rpc_url: str, chain_id: int, timeout: float = 120):
        from web3 import Web3

        self.w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 30}))
        self.chain_id = chain_id
        self.timeout = timeout

    def block_timestamp(self) -> int:
        return int(self.w3.eth.get_block("latest")["timestamp"])

    def call(self, to: str, data: str, sender: str | None = None) -> bytes:
        tx = {"to": to_checksum_address(to), "data": data}
        if sender:
            tx["from"] = to_checksum_address(sender)
        return bytes(self.w3.eth.call(tx))

    def send_transaction(self, account, to: str, data: str) -> str:
        w3 = self.w3
        tx = {"from": account.address, "to": to_checksum_address(to), "data": data, "value": 0, "chainId": self.chain_id,
              "nonce": w3.eth.get_transaction_count(account.address, "pending")}
        tx["gas"] = int(w3.eth.estimate_gas(tx) * 12 // 10)
        base = w3.eth.get_block("latest").get("baseFeePerGas", 0)
        prio = w3.eth.max_priority_fee
        tx["maxPriorityFeePerGas"] = prio
        tx["maxFeePerGas"] = base * 2 + prio
        signed = account.sign_transaction(tx)
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        h = w3.eth.send_raw_transaction(raw)
        return "0x" + bytes(h).hex().removeprefix("0x")

    def wait_receipt(self, tx_hash: str) -> dict:
        rc = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=self.timeout)
        hx = lambda b: "0x" + bytes(b).hex().removeprefix("0x")
        return {"status": int(rc["status"]), "logs": [{"address": l["address"], "topics": [hx(t) for t in l["topics"]], "data": hx(l["data"])} for l in rc["logs"]]}
