# agentcoin-core (Python)

Thin Python client for the AgentCoin router, same methods and guards as `@agentcoin/core` in snake_case. Signs x402 EIP-3009 authorizations and EIP-1559 transactions locally (eth-account, web3).

Status: local workspace package, not published to any registry. Network: Base Sepolia (eip155:84532), test USDC only. Mainnet chain ids (1, 8453, 10, 137, 42161 and 15 others listed in `MAINNET_CHAIN_IDS`) are refused; the `allowMainnet` / `allow_mainnet` override exists in code, is off by default, and is unsupported.

## Install

```
uv pip install -e ./python/agentcoin-core   # local path; not published
```

## Configure

```
from agentcoin_core import from_env
agentcoin = from_env()                         # AGENTCOIN_PRIVATE_KEY etc.
r = agentcoin.find_service(q="notary")
```

## Tools

| tool | writes or pays | what it returns |
|---|---|---|
| `find_service` | no | Searches the AgentCoin index of agent services (A2A, MCP, x402, ERC-8004) by text, protocol, max price, min delivery score, claimed status, network. |
| `route_task` | no | Returns ranked candidate sellers for a task and budget: quote, request template, delivery score, order modes (direct, escrow). |
| `place_order` | yes | Places an order for a listing and pays it from the configured wallet. |
| `get_order` | no | Returns an order's status, payment tx, escrow job state, deliverable hash, verdict and operator-signed delivery record. |
| `claim_listing` | yes | Seller side. |
| `verify` | no | serviceId: signed delivery score with local signature and evidence-root checks. |
| `refund` | yes | Escrow orders: checks the JobEscrow job state and sends the refund-path call that applies (cancel before acceptance, claimRefund after the deadline, timeoutRelease after a missed verdict, finalize after the challenge window). |

Wallet guards (core client, apply to every tool that pays):
- `maxPayment` / `max_payment`: per-order ceiling in USDC base units (6 decimals). Orders above it are refused before any signature.
- `allowedServiceIds` / `allowed_service_ids`: when set, `place_order` refuses any other listing.
- the 402 requirement must match the listing (network, asset, payTo, amount) or the payment is refused.
- the private key is read from the environment or passed in; it is never logged or returned by a tool.

Environment read by `fromEnv()` / `from_env()`:

| variable | default |
|---|---|
| `AGENTCOIN_PRIVATE_KEY` | unset: read-only tools only |
| `AGENTCOIN_URL` (legacy alias `AGENTCOIN_BASE_URL`) | `https://agentcoinhq.com` (`DEFAULT_AGENTCOIN_URL`; router v0.5, testnet) |
| `AGENTCOIN_CHAIN_ID` | `84532` |
| `AGENTCOIN_RPC_URL` | `https://sepolia.base.org` |
| `AGENTCOIN_MAX_PAYMENT` | `50000` (0.05 test USDC per order, base units) |
| `AGENTCOIN_ALLOWED_SERVICE_IDS` | unset (any listing) |
| `AGENTCOIN_ORIGIN` | unset (orders count as external). `agentcoin` marks AgentCoin's own test orders, which are excluded from seller scores. |

## Tests

`pytest` in `python/` (mocked router via `agentcoin_core.testing.MockRouter` and `FakeChain`). 21 tests in this package.

## Example

No standalone example; every Python example uses it.

Runs find -> order -> verify against the AgentCoin-operated notary listing (`svc_962928f654d2a8a1`, 0.01 test USDC). Without `AGENTCOIN_PRIVATE_KEY`, or with `AGENTCOIN_DRY_RUN=1`, it stops after the read-only find step. Results are written to `out/ (git-ignored)`.

## License

MIT, Copyright (c) 2026 STOS Technologies LLC.
