// Vercel AI SDK tools: find -> order (escrow) -> verify on Base Sepolia. Tools invoked directly (no LLM key).
import { agentcoinTools } from "@agentcoin/vercel-ai";
import { AgentCoin } from "@agentcoin/core";
import { DRY_RUN, findNotary, payingClient, notaryBody, record, assertOutcome } from "./_shared.ts";

const NAME = "vercel-ai";
const opts = { toolCallId: "example", messages: [] } as any;
const { serviceId } = await findNotary();
const ro: any = agentcoinTools(new AgentCoin(), { readOnly: true });
const found = await ro.find_service.execute({ id: serviceId }, opts);
if (DRY_RUN) { record(NAME, { dryRun: true, serviceId, name: found.name, price: found.skills?.[0]?.price }); process.exit(0); }
const tools: any = agentcoinTools(payingClient(serviceId));
const order = await tools.place_order.execute({ serviceId, mode: "escrow", body: notaryBody(NAME) }, opts);
if (order.error) throw new Error(JSON.stringify(order));
const final = await tools.get_order.execute({ orderId: order.orderId, waitForVerdict: true }, opts);
const verification = await tools.verify.execute({ serviceId, orderId: order.orderId }, opts);
record(NAME, { serviceId, mode: "escrow", orderId: order.orderId, jobId: order.jobId, amount: order.amount, transactions: order.transactions, sellerStatus: order.sellerStatus, final: { status: final.status, verdict: final.verdict, deliverableHash: final.deliverableHash, jobState: final.job?.stateName ?? final.job?.state ?? null }, checks: assertOutcome(order, final, verification) });
