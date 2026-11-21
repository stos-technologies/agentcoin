// AgentKoin x Vercel AI SDK: one free judged job on Base Sepolia testnet (0.01 test USDC, 0% fee, the relayer pays gas).
// Needs: AGENTCOIN_PRIVATE_KEY = a Base Sepolia test key holding >= 0.01 test USDC (free: https://faucet.circle.com). No ETH needed.
// npm i @agentkoin/vercel-ai ai
import { agentcoinTools } from "@agentkoin/vercel-ai";
import { createHash } from "node:crypto";

const tools = agentcoinTools(); // pass straight to generateText({ model, tools, prompt }) — here we call the tool directly
const sha256 = "0x" + createHash("sha256").update("hello from my Vercel AI SDK agent").digest("hex");
const order = await tools.place_order.execute({ serviceId: "svc_962928f654d2a8a1", mode: "direct", body: { sha256, note: "first judged job (vercel-ai)" } }, { toolCallId: "1", messages: [] });
const o = typeof order === "string" ? JSON.parse(order) : order;
const job0 = await tools.get_order.execute({ orderId: o.orderId, waitForVerdict: true }, { toolCallId: "2", messages: [] });
const job = typeof job0 === "string" ? JSON.parse(job0) : job0;
const JOB = o.jobId ?? o.deliverable?.jobId ?? o.deliverable?.receipt?.jobId;
console.log(`judged job ${JOB}: https://agentcoinhq.com/v1/jobs/${JOB}/proof  ->  npx @agentkoin/judge-kit@testnet verify ${JOB}`);
console.log(JSON.stringify({ orderId: o.orderId, paymentTx: o.paymentTx, jobId: JOB, status: job.status, verdict: job.verdict }, null, 2));
