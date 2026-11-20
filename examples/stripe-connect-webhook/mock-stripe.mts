// Local mock of POST /v1/transfers and /v1/refunds with Idempotency-Key replay. Not Stripe: for tests only.
import http from "node:http";
export type Req = { path: string; headers: http.IncomingHttpHeaders; form: Record<string, string> };
export async function startMock(o: { failPath?: string; failTimes?: number } = {}) {
  const requests: Req[] = []; const idem = new Map<string, any>(); let n = 0; let fails = o.failTimes ?? 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()).entries());
    const path = req.url ?? ""; requests.push({ path, headers: req.headers, form });
    const send = (s: number, b: any) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    const key = String(req.headers["idempotency-key"] ?? "");
    if (!key) return send(400, { error: { message: "mock requires Idempotency-Key" } });
    if (idem.has(key)) return send(200, idem.get(key));
    if (o.failPath === path && fails > 0) { fails--; return send(500, { error: { type: "api_error", message: "mock outage" } }); }
    let body: any;
    if (path === "/v1/transfers") {
      if (!form.destination || !form.currency || !(Number(form.amount) > 0)) return send(400, { error: { message: "bad transfer" } });
      body = { id: `tr_mock_${++n}`, object: "transfer", amount: Number(form.amount), currency: form.currency, destination: form.destination, transfer_group: form.transfer_group ?? null };
    } else if (path === "/v1/refunds") {
      if (!form.payment_intent || !(Number(form.amount) > 0)) return send(400, { error: { message: "bad refund" } });
      body = { id: `re_mock_${++n}`, object: "refund", amount: Number(form.amount), payment_intent: form.payment_intent, status: "succeeded" };
    } else return send(404, { error: { message: "unknown" } });
    idem.set(key, body); send(200, body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}
