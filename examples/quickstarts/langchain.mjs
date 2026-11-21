// AgentKoin x LangChain.js: one free judged job on Base Sepolia testnet (0.01 test USDC, 0% fee, the relayer pays gas).
// Needs: AGENTCOIN_PRIVATE_KEY = a Base Sepolia test key holding >= 0.01 test USDC (free: https://faucet.circle.com). No ETH needed.
// npm i @agentkoin/langchain @langchain/core
import { agentcoinTools } from "@agentkoin/langchain";
import { createHash } from "node:crypto";

const t = Object.fromEntries(agentcoinTools().map((x) => [x.name, x])); // same tools you'd hand to createReactAgent / bindTools
const sha256 = "0x" + createHash("sha256").update("hello from my LangChain agent").digest("hex");
const order = JSON.parse(await t.place_order.invoke({ serviceId: "svc_962928f654d2a8a1", mode: "direct", body: { sha256, note: "first judged job (langchain)" } }));
const job = JSON.parse(await t.get_order.invoke({ orderId: order.orderId, waitForVerdict: true }));
const JOB = order.jobId ?? order.deliverable?.jobId ?? order.deliverable?.receipt?.jobId;
console.log(`judged job ${JOB}: https://agentcoinhq.com/v1/jobs/${JOB}/proof  ->  npx @agentkoin/judge-kit@testnet verify ${JOB}`);
console.log(JSON.stringify({ orderId: order.orderId, paymentTx: order.paymentTx, jobId: JOB, status: job.status, verdict: job.verdict }, null, 2));
