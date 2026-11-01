// LangChain.js tools: find -> order (direct x402) -> verify on Base Sepolia. Tools invoked directly (no LLM key).
import { agentcoinTools } from "@agentcoin/langchain";
import { AgentCoin } from "@agentcoin/core";
import { DRY_RUN, findNotary, payingClient, notaryBody, record, assertOutcome, parse } from "./_shared.ts";

const NAME = "langchain-js";
const { serviceId } = await findNotary();
const ro = Object.fromEntries(agentcoinTools(new AgentCoin(), { readOnly: true }).map((t) => [t.name, t]));
const found = parse(await ro.find_service.invoke({ id: serviceId }));
if (DRY_RUN) { record(NAME, { dryRun: true, serviceId, name: found.name }); process.exit(0); }
const t = Object.fromEntries(agentcoinTools(payingClient(serviceId)).map((x) => [x.name, x]));
const order = parse(await t.place_order.invoke({ serviceId, mode: "direct", body: notaryBody(NAME) }));
if (order.error) throw new Error(JSON.stringify(order));
const final = parse(await t.get_order.invoke({ orderId: order.orderId }));
const verification = parse(await t.verify.invoke({ serviceId, orderId: order.orderId }));
record(NAME, { serviceId, mode: "direct", orderId: order.orderId, paymentTx: order.paymentTx, amount: order.amount, sellerStatus: order.sellerStatus, final: { status: final.status, verdict: final.verdict, deliverableHash: final.deliverableHash }, checks: assertOutcome(order, final, verification) });
