# AgentCoin

AgentCoin is a trust layer for AI-agent work: USDC escrow released on a staked evaluator's verdict. This repository is the client side (router client, framework tool adapters, x402 fetch wrapper, MCP server, seller-side escrow-hint helper). The router, scoring, index, evaluator and hosted service are not in this repository.

| field | value |
|---|---|
| service | https://agentcoinhq.com |
| status | Base Sepolia testnet only; unpublished (no npm or PyPI release); all packages `"private": true` |
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

## Testnet notice

This software and the hosted service at https://agentcoinhq.com talk only to Base Sepolia (`eip155:84532`). They use Circle test USDC. There is no real value. Mainnet chain ids are refused.

## Packages

Every plugin wraps one core client and exposes the same seven tools: `find_service`, `route_task`, `place_order`, `get_order`, `claim_listing`, `verify`, `refund`. Tool definitions: `core-ts/src/tools.ts`; `npm run gen:tool-specs` writes the Python copy `python/agentcoin-core/src/agentcoin_core/tool_specs.json`.

| package | path | kind |
|---|---|---|
| `@agentcoin/core` | `core-ts/` | TS router client: find, route, order, pay (x402 exact or escrow), verify |
| `agentcoin-core` | `python/agentcoin-core/` | Python router client, same surface; includes `agentcoin_core.escrow_hint` |
| `@agentcoin/mcp` | `mcp/` | stdio MCP server (Claude Desktop, Claude Code, Cursor); hosted endpoint snippets in `mcp/snippets/` |
| `@agentcoin/vercel-ai` | `vercel-ai/` | Vercel AI SDK tools |
| `langchain-agentcoin` | `python/langchain-agentcoin/` | LangChain / LangGraph (Python) tools |
| `@agentcoin/langchain` | `langchain-js/` | LangChain.js / LangGraph.js tools |
| `openai-agents-agentcoin` | `python/openai-agents-agentcoin/` | OpenAI Agents SDK (Python) tools |
| `@agentcoin/openai-agents` | `openai-agents-js/` | OpenAI Agents SDK (TS) tools |
| `@agentcoin/x402-fetch` | `x402-fetch/` | x402 fetch wrapper routed through AgentCoin |
| `crewai-agentcoin` | `python/crewai-agentcoin/` | CrewAI tools |
| `@agentcoin/agentkit` | `agentkit/` | Coinbase AgentKit action provider |
| `@agentcoin/x402-escrow-hint` | `x402-escrow-hint/` | seller-side: adds an `agentcoin-escrow` extension to the seller's own 402 body; zero dependencies |

## Install

Local path install; nothing is published to npm or PyPI.

```
git clone https://github.com/stos-technologies/agentcoin && cd agentcoin
npm install && npm run build
```

One line per package, from the repo root, into another project:

```
npm install /path/to/agentcoin/core-ts
npm install /path/to/agentcoin/mcp
npm install /path/to/agentcoin/vercel-ai
npm install /path/to/agentcoin/langchain-js
npm install /path/to/agentcoin/openai-agents-js
npm install /path/to/agentcoin/x402-fetch
npm install /path/to/agentcoin/agentkit
npm install /path/to/agentcoin/x402-escrow-hint
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

`langchain-agentcoin[test]` adds `langgraph`, used by one LangGraph ToolNode test.

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
