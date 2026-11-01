import { test } from "node:test";
import assert from "node:assert/strict";
import { generateText, isStepCount } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { agentcoinTools } from "../src/index.ts";
import { mockClient } from "../../core-ts/test/setup.ts";
import { SERVICE_ID } from "../../core-ts/test/mock.ts";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

test("exposes 7 tools with JSON schemas; readOnly filter", () => {
  const { client } = mockClient();
  assert.deepEqual(Object.keys(agentcoinTools(client)).sort(), ["claim_listing", "find_service", "get_order", "place_order", "refund", "route_task", "verify"]);
  assert.deepEqual(Object.keys(agentcoinTools(client, { readOnly: true })).sort(), ["find_service", "get_order", "route_task", "verify"]);
});

test("execute: find_service and place_order (direct, escrow) against the mocked router", async () => {
  const { m, client } = mockClient({ escrowOffer: true });
  const t: any = agentcoinTools(client);
  const f = await t.find_service.execute({ q: "notary" }, { toolCallId: "1", messages: [] });
  assert.ok(f.results.some((r: any) => r.id === SERVICE_ID));
  const d = await t.place_order.execute({ serviceId: SERVICE_ID, body: { sha256: "0x" + "ab".repeat(32) } }, { toolCallId: "2", messages: [] });
  assert.match(d.orderId, /^ord_/); assert.equal(d.testnet, true);
  const e = await t.place_order.execute({ serviceId: SERVICE_ID, mode: "escrow", body: { sha256: "0x" + "ab".repeat(32) } }, { toolCallId: "3", messages: [] });
  assert.equal(e.jobId, "42"); assert.equal(m.sent.length, 2);
});

test("errors are returned as tool output, not thrown", async () => {
  const { client } = mockClient({}, { allowedServiceIds: ["svc_only"] });
  const r = await (agentcoinTools(client) as any).place_order.execute({ serviceId: SERVICE_ID }, { toolCallId: "1", messages: [] });
  assert.equal(r.error, "service_not_allowed");
});

test("generateText loop with a mock model calls find_service then answers", async () => {
  const { client } = mockClient();
  let step = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => (step++ === 0
      ? { content: [{ type: "tool-call", toolCallId: "c1", toolName: "find_service", input: JSON.stringify({ q: "notary" }) }], finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [] }
      : { content: [{ type: "text", text: "found" }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }) as any,
  });
  const r = await generateText({ model, tools: agentcoinTools(client), prompt: "find a notary", stopWhen: isStepCount(3) });
  assert.equal(r.text, "found");
  const tr: any = r.steps[0].toolResults[0];
  assert.ok(tr.output.results.some((x: any) => x.id === SERVICE_ID));
});
