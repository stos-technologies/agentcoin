// AgentKit action provider with a ViemWalletProvider: find -> order (escrow) -> verify on Base Sepolia. Actions invoked directly (no LLM key).
import { ViemWalletProvider } from "@coinbase/agentkit";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { agentcoinActionProvider, disableAgentKitAnalytics } from "@agentcoin/agentkit";
import { DRY_RUN, findNotary, notaryBody, record, assertOutcome, parse } from "./_shared.ts";

const NAME = "agentkit";
const { serviceId } = await findNotary();
if (DRY_RUN) { record(NAME, { dryRun: true, serviceId }); process.exit(0); }
const wc = createWalletClient({ account: privateKeyToAccount(process.env.AGENTCOIN_PRIVATE_KEY as `0x${string}`), chain: baseSepolia, transport: http(process.env.AGENTCOIN_RPC_URL ?? "https://sepolia.base.org") });
disableAgentKitAnalytics(); // no wallet-address analytics POST to Coinbase from the AgentKit constructor
const wp = new ViemWalletProvider(wc as any);
const provider = agentcoinActionProvider({ allowedServiceIds: [serviceId], origin: "agentcoin", maxPayment: 10_000n, pollIntervalMs: 15_000, verdictTimeoutMs: 15 * 60_000 });
if (!provider.supportsNetwork(wp.getNetwork())) throw new Error("provider does not support this network");
const a = Object.fromEntries(provider.getActions(wp).map((x) => [x.name.replace("AgentCoinActionProvider_", ""), x]));
const found = parse(await a.find_service.invoke({ id: serviceId }));
if (found.operatedBy !== "AgentCoin") throw new Error("not AgentCoin-operated");
const order = parse(await a.place_order.invoke({ serviceId, mode: "escrow", body: notaryBody(NAME) }));
if (order.error) throw new Error(JSON.stringify(order));
const final = parse(await a.get_order.invoke({ orderId: order.orderId, waitForVerdict: true }));
const verification = parse(await a.verify.invoke({ serviceId, orderId: order.orderId }));
record(NAME, { serviceId, mode: "escrow", orderId: order.orderId, jobId: order.jobId, amount: order.amount, transactions: order.transactions, sellerStatus: order.sellerStatus, final: { status: final.status, verdict: final.verdict, deliverableHash: final.deliverableHash, jobState: final.job?.stateName ?? final.job?.state ?? null }, checks: assertOutcome(order, final, verification) });
