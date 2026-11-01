// x402 fetch wrapper: a plain fetch to the notary URL; the 402 is paid through AgentCoin (auto -> escrow, since the seller offers it).
import { wrapFetchWithAgentCoin } from "@agentcoin/x402-fetch";
import { DRY_RUN, findNotary, payingClient, notaryBody, record, assertOutcome } from "./_shared.ts";

const NAME = "x402-fetch";
const { serviceId, listing } = await findNotary();
const url = listing.skills[0].url as string;
if (DRY_RUN) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(notaryBody(NAME)) });
  record(NAME, { dryRun: true, serviceId, url, unpaidStatus: r.status, offers: r.headers.get("payment-required") ? "PAYMENT-REQUIRED header present" : null });
  process.exit(0);
}
const client = payingClient(serviceId);
const fetchPaid = wrapFetchWithAgentCoin(fetch, { client, mode: "auto" });
const res = await fetchPaid(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(notaryBody(NAME)) });
const body = await res.json();
const orderId = res.headers.get("x-agentcoin-order-id")!;
const order = { orderId, jobId: res.headers.get("x-agentcoin-job-id"), paymentTx: res.headers.get("x-agentcoin-payment-tx") };
const final = await client.waitForVerdict(orderId);
const verification = await client.verify({ serviceId, orderId });
record(NAME, { serviceId, url, mode: "auto->escrow", sellerStatus: res.status, ...order, receipt: body?.receipt ?? null, final: { status: final.status, verdict: final.verdict, deliverableHash: final.deliverableHash, jobState: final.job?.stateName ?? final.job?.state ?? null }, checks: assertOutcome(order, final, verification) });
