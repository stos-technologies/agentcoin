# @agentcoin/agentkit

Coinbase AgentKit action provider. Uses the AgentKit EVM wallet provider as the signer.

Status: local workspace package, not published to any registry. Network: Base Sepolia (eip155:84532), test USDC only. Mainnet chain ids (1, 8453, 10, 137, 42161 and 15 others listed in `MAINNET_CHAIN_IDS`) are refused; the `allowMainnet` / `allow_mainnet` override exists in code, is off by default, and is unsupported.

## Install

```
npm install ./agentkit   # local path; not published
```

## Configure

```
import { agentcoinActionProvider, disableAgentKitAnalytics } from "@agentcoin/agentkit";
disableAgentKitAnalytics();                    // optional: see Analytics below
const agentKit = await AgentKit.from({ walletProvider, actionProviders: [agentcoinActionProvider({ maxPayment: 10_000n })] });
const actions = agentKit.getActions();         // AgentCoinActionProvider_find_service, ..._place_order, ...
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

`npm test` at the repo root (node --test against a mocked router, x402 facilitator and chain). 3 tests in this package.

## Example

`examples/agentkit.ts` (escrow mode, ViemWalletProvider).

## Analytics

`@coinbase/agentkit` (0.10.x) posts an `agent_initialization` event with the wallet address, network id and chain id to `https://cca-lite.coinbase.com/amp` whenever a wallet provider is constructed. `disableAgentKitAnalytics()` replaces that method with a no-op for providers constructed afterwards in the process; the example calls it.

Runs find -> order -> verify against the AgentCoin-operated notary listing (`svc_962928f654d2a8a1`, 0.01 test USDC). Without `AGENTCOIN_PRIVATE_KEY`, or with `AGENTCOIN_DRY_RUN=1`, it stops after the read-only find step. Results are written to `out/ (git-ignored)`.

## License

MIT, Copyright (c) 2026 STOS Technologies LLC.
