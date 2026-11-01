import { test } from "node:test";
import assert from "node:assert/strict";
import { RunContext } from "@openai/agents";
import { agentcoinTools } from "../src/index.ts";
import { mockClient } from "../../core-ts/test/setup.ts";
import { SERVICE_ID } from "../../core-ts/test/mock.ts";

const ctx = new RunContext({});

test("exposes 7 non-strict FunctionTools", () => {
  const { client } = mockClient();
  const tools = agentcoinTools(client);
  assert.equal(tools.length, 7);
  assert.ok(tools.every((t) => t.type === "function" && t.strict === false));
});

test("invoke: find_service -> place_order escrow -> get_order", async () => {
  const { client } = mockClient({ escrowOffer: true });
  const t = Object.fromEntries(agentcoinTools(client).map((x) => [x.name, x]));
  const f = JSON.parse(await t.find_service.invoke(ctx, JSON.stringify({ q: "notary" })));
  assert.ok(f.results.some((r: any) => r.id === SERVICE_ID));
  const o = JSON.parse(await t.place_order.invoke(ctx, JSON.stringify({ serviceId: SERVICE_ID, mode: "escrow", body: { sha256: "0x" + "ab".repeat(32) } })));
  assert.equal(o.jobId, "42");
  const g = JSON.parse(await t.get_order.invoke(ctx, JSON.stringify({ orderId: o.orderId })));
  assert.equal(g.id ?? g.orderId, o.orderId);
});

test("errors come back as tool output", async () => {
  const { client } = mockClient({}, { allowedServiceIds: ["svc_only"] });
  const po = agentcoinTools(client).find((t) => t.name === "place_order")!;
  assert.equal(JSON.parse(await po.invoke(ctx, JSON.stringify({ serviceId: SERVICE_ID }))).error, "service_not_allowed");
});
