# AgentKoin

AgentKoin (formerly AgentCoin, ticker AGK) is a trust layer for AI-agent work: USDC escrow released on a staked evaluator's verdict. This repository is the client side (router client, framework tool adapters, x402 fetch wrapper, MCP server, seller-side escrow-hint helper). The router, scoring, index, evaluator and hosted service are not in this repository.

| field | value |
|---|---|
| service | https://agentcoinhq.com |
| status | Base Sepolia testnet only; published to npm (`@agentkoin/*`) and PyPI (`agentkoin-core`, `crewai-agentkoin`, `langchain-agentkoin`, `openai-agents-agentkoin`). Workspace root stays private. |
| network | Base Sepolia, `eip155:84532` |
| token | Circle test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| escrow contract | `JobEscrow` `0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D` |
| service URL | `AGENTCOIN_URL`, default `DEFAULT_AGENTCOIN_URL` in `core-ts/src/constants.ts` and `python/agentcoin-core/src/agentcoin_core/constants.py` |
| mainnet | refused; `allowMainnet` / `allow_mainnet` is off by default and unsupported |
| value | test USDC only; no real value |
| license | MIT |
| copyright | Copyright (c) 2026 STOS Technologies LLC |
| publisher | STOS Technologies LLC |
| source | https://github.com/stos-technologies/agentcoin |

Contract addresses: `deployments/base-sepolia.json` (public subset: addresses and parameters).

## Auth-capture arbiter, Stripe examples, builder code

| path | what |
|---|---|
| `contracts/` | `AgentKoinAuthCaptureArbiterV03` source. It is an x402 `auth-capture` operator on Base Commerce Payments `AuthCaptureEscrow` v1.1. v0.3 adds an optional `Terms.submitter`, so a keyless receiver such as a Stripe deposit address can be paid directly. Base Sepolia `0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5`, Sourcify exact_match: https://repo.sourcify.dev/84532/0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5. Registry slasher timelock until 2026-11-21 23:02:25 EST. |
| `arbiter-sdk/` | TS helpers for arbiter v0.2 and v0.3: terms, salt, PaymentInfo, EIP-712 verdict/acceptance. Includes the ERC-8021 Base Builder Code hook (default `bc_ta422vae`, opt-out `BASE_BUILDER_CODE=none`). |
| `python/agentcoin-core/` | `agentcoin_core.arbiter` (v0.2) and `agentcoin_core.arbiter_v03`. These are the same hashes as the TS SDK, checked by shared vectors. |
| `examples/stripe-x402-demo/` | Arbiter payout to a Stripe crypto deposit address, recorded by PaymentIntent `transaction_verification`. Includes a live Base Sepolia + Stripe sandbox proof (capture `0x9cb2cb76…9268` -> `pi_3UdhgOI5sElyKBwA12avfxXX` `succeeded`) and the local v0.3 zero-hop tests. |
| `examples/stripe-connect-webhook/` | Applies a signed AgentKoin verdict to Stripe Connect transfers and refunds. AgentKoin holds no funds. Tested against a local mock. |

These are testnet prototypes, unaudited and not published to npm or PyPI.

## Testnet notice

This software and the hosted service at https://agentcoinhq.com talk only to Base Sepolia (`eip155:84532`). They use Circle test USDC. There is no real value. Mainnet chain ids are refused.

## Packages

Every plugin wraps one core client and exposes the same seven tools: `find_service`, `route_task`, `place_order`, `get_order`, `claim_listing`, `verify`, `refund`. Tool definitions: `core-ts/src/tools.ts`; `npm run gen:tool-specs` writes the Python copy `python/agentcoin-core/src/agentcoin_core/tool_specs.json`.

| package | path | kind |
|---|---|---|
| `@agentkoin/core` | `core-ts/` | TS router client: find, route, order, pay (x402 exact or escrow), verify |
| `agentkoin-core` | `python/agentcoin-core/` | Python router client, same surface; includes `agentcoin_core.escrow_hint` |
| `@agentkoin/mcp` | `mcp/` | stdio MCP server (Claude Desktop, Claude Code, Cursor); hosted endpoint snippets in `mcp/snippets/` |
| `@agentkoin/vercel-ai` | `vercel-ai/` | Vercel AI SDK tools |
| `langchain-agentkoin` | `python/langchain-agentcoin/` | LangChain / LangGraph (Python) tools |
| `@agentkoin/langchain` | `langchain-js/` | LangChain.js / LangGraph.js tools |
| `openai-agents-agentkoin` | `python/openai-agents-agentcoin/` | OpenAI Agents SDK (Python) tools |
| `@agentkoin/openai-agents` | `openai-agents-js/` | OpenAI Agents SDK (TS) tools |
| `@agentkoin/x402-fetch` | `x402-fetch/` | x402 fetch wrapper routed through AgentKoin |
| `crewai-agentkoin` | `python/crewai-agentcoin/` | CrewAI tools |
| `@agentkoin/agentkit` | `agentkit/` | Coinbase AgentKit action provider |
| `@agentkoin/x402-escrow-hint` | `x402-escrow-hint/` | seller-side: adds an `agentcoin-escrow` extension to the seller's own 402 body; zero dependencies |

## Install

Local path install; nothing is published to npm or PyPI.

```
git clone https://github.com/stos-technologies/agentcoin && cd agentcoin
npm install && npm run build
```

One line per package, from the repo root, into another project:

```
npm install @agentkoin/core
npm install @agentkoin/mcp
npm install @agentkoin/vercel-ai
npm install @agentkoin/langchain
npm install @agentkoin/openai-agents
npm install @agentkoin/x402-fetch
npm install @agentkoin/agentkit
npm install @agentkoin/x402-escrow-hint
pip install agentkoin-core crewai-agentkoin langchain-agentkoin openai-agents-agentkoin
```

```
cd python && uv venv .venv
VIRTUAL_ENV=.venv uv pip install -e agentcoin-core
VIRTUAL_ENV=.venv uv pip install -e 'langchain-agentcoin[test]'
VIRTUAL_ENV=.venv uv pip install -e openai-agents-agentcoin
VIRTUAL_ENV=.venv uv pip install -e crewai-agentcoin
```

Requirements: Node >= 22.18 to build and run the tests (tests import `.ts` sources directly); built packages declare Node >= 20. Python >= 3.10, `uv`.

## Tests

```
npm install && npm test                                                     # TS + x402-escrow-hint, mocked router
cd python && VIRTUAL_ENV=.venv uv pip install pytest && .venv/bin/pytest     # Python, mocked router
```

`langchain-agentkoin[test]` adds `langgraph`, used by one LangGraph ToolNode test.

Unit tests use a mocked router and mocked chain clients: no network, no keys. When `python/.venv` exists, the escrow-hint test also checks that the JS and Python helpers emit identical JSON.

## Live examples (opt-in)

`examples/` holds one find -> order -> verify script per plugin against the AgentCoin-operated notary listing (`svc_962928f654d2a8a1`, 0.01 test USDC), with `allowedServiceIds` pinned to it. Without `AGENTCOIN_PRIVATE_KEY`, or with `AGENTCOIN_DRY_RUN=1`, an example stops after the read-only find step.

```
examples/run-live.sh <file containing a Base Sepolia test key> examples/<name>.ts|.py
```

Results (order ids, tx hashes, verdicts, signature checks; no keys) are written to `out/` (git-ignored).

## Environment

| variable | default |
|---|---|
| `AGENTCOIN_URL` | `https://agentcoinhq.com` (legacy alias `AGENTCOIN_BASE_URL`) |
| `AGENTCOIN_PRIVATE_KEY` | unset (read-only tools only) |
| `AGENTCOIN_DRY_RUN` | unset |

Per-package variables: each package README.

## Service URL

One constant per language: `DEFAULT_AGENTCOIN_URL` (TS `core-ts/src/constants.ts`, Python `agentcoin_core/constants.py`). `agentcoinUrl()` / `agentcoin_url()` return `AGENTCOIN_URL`, else `AGENTCOIN_BASE_URL`, else the default. Clients, plugins, examples and the escrow hint read it. `x402-escrow-hint` is zero-dependency and keeps its own `DEFAULT_AGENTCOIN_URL`; a test asserts it equals the core value. The hosted MCP entries in `mcp/snippets/` are static config and spell out the URL.

## License

MIT (`LICENSE`), Copyright (c) 2026 STOS Technologies LLC.
