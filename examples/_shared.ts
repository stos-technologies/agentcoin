// Shared example steps: find the AgentCoin-operated notary, build the order body, record results (no secrets).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { AgentCoin, fromEnv } from "@agentcoin/core";

export const DRY_RUN = process.env.AGENTCOIN_DRY_RUN === "1" || !process.env.AGENTCOIN_PRIVATE_KEY;

/** Finds the AgentCoin-operated notary on eip155:84532 with a read-only client. Refuses anything not operatedBy AgentCoin. */
export async function findNotary(): Promise<{ serviceId: string; listing: any }> {
  const ro = new AgentCoin();
  const r = await ro.findService({ q: "agentcoin notary", network: "eip155:84532", limit: 10 });
  const hit = (r.results ?? []).find((x: any) => x.operatedBy === "AgentCoin" && /notary/i.test(x.name ?? ""));
  if (!hit) throw new Error("AgentCoin notary not found in the index");
  const listing = await ro.findService({ id: hit.id });
  if (listing.operatedBy !== "AgentCoin") throw new Error("refusing: listing is not operatedBy AgentCoin");
  return { serviceId: hit.id, listing };
}

/** Paying client restricted to one service id, orders marked origin "agentcoin" (excluded from seller scores). */
export function payingClient(serviceId: string): AgentCoin {
  return fromEnv({ allowedServiceIds: [serviceId], origin: "agentcoin", maxPayment: 10_000n, pollIntervalMs: 15_000, verdictTimeoutMs: 15 * 60_000 });
}

export function notaryBody(name: string) {
  const text = `agentcoin integrations e2e ${name} ${new Date().toISOString()}`;
  return { sha256: "0x" + createHash("sha256").update(text).digest("hex"), note: `integrations e2e: ${name}` };
}

export function record(name: string, data: unknown) {
  mkdirSync(new URL("../out/", import.meta.url), { recursive: true });
  const file = new URL(`../out/${name}${DRY_RUN ? ".dry.local" : ""}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify({ example: name, at: new Date().toISOString(), network: "eip155:84532", testnet: true, ...(data as object) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  console.log(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log("recorded", file.pathname);
}

export const parse = (s: unknown) => (typeof s === "string" ? JSON.parse(s) : s) as any;

/** Checks the final state of a run and throws on anything not delivered/verified. */
export function assertOutcome(order: any, final: any, verification: any) {
  if (order.error) throw new Error(`place_order failed: ${order.error}: ${order.message}`);
  const ok = final.verdict === "delivered" || final.verdict === "complete" || final.verdict === "pass";
  const rec = verification.order?.deliveryRecord;
  return { verdictOk: ok, deliveryRecordValid: rec?.valid ?? null, deliveryRecordSignerIsOperator: rec?.signerIsOperator ?? null, scoreSignatureValid: verification.service?.checks?.signatureValid ?? null, scoreSignerIsOperator: verification.service?.checks?.signerIsOperator ?? null };
}
