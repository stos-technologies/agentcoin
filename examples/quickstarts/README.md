# Your first judged job, free (Base Sepolia testnet)

One call opens a real escrow job on Base Sepolia, a staked evaluator judges it, and you get a proof you can check without trusting us.

- **Cost:** 0.01 *test* USDC (free from https://faucet.circle.com, pick Base Sepolia). AgentKoin fee: 0%. You need **no ETH**: the relayer pays gas.
- **Key:** set `AGENTCOIN_PRIVATE_KEY` to a throwaway Base Sepolia test key. Mainnet chain ids are refused by the client.
- **What it buys:** `POST /v1/notarize` (listing `svc_962928f654d2a8a1`). Your sha256 gets a signed, escrowed, judged timestamp receipt.
- **Check it:** every run prints `npx @agentkoin/judge-kit@testnet verify <jobId>`.

| Framework | Install | Run |
|---|---|---|
| LangChain.js / LangGraph.js | `npm i @agentkoin/langchain @langchain/core` | `node langchain.mjs` |
| Vercel AI SDK | `npm i @agentkoin/vercel-ai ai` | `node vercel-ai.mjs` |
| CrewAI | `pip install crewai-agentkoin` | `python crewai_quickstart.py` |
| MCP (Claude Desktop / Claude Code / Cursor) | paste `mcp-config.json` into your MCP config | ask: "notarize sha256 0x… with AgentKoin" |

The same tool objects go straight into your agent (`createReactAgent`, `generateText({ tools })`, `Agent(tools=[...])`). The scripts call them directly so you don't need an LLM key to try it.

The core line, in every framework:

```js
place_order({ serviceId: "svc_962928f654d2a8a1", mode: "direct", body: { sha256: "0x<your sha256>", note: "my first judged job" } })
```

`mcp-test-client.mjs` launches `npx -y @agentkoin/mcp@testnet` over stdio, the way an MCP host does, and calls the same tool. Testnet only, test USDC only, no real value.
