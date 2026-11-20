// Lightweight Node HTTP server around the handler. Run: STRIPE_SECRET_KEY=... node server.mts   (PORT default 8787)
import http from "node:http";
import { createHandler, type Deps } from "./handler.mts";
import { stripeCfgFromEnv } from "./stripe-client.mts";

export function createServer(deps: Deps) {
  const handle = createHandler(deps);
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method !== "POST" || req.url !== "/agentkoin/verdict") return send(404, { error: "not_found" });
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > 100_000) return send(413, { error: "too_large" }); chunks.push(c as Buffer); }
    let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(400, { error: "malformed_body" }); }
    const r = await handle(body); send(r.status, r.body);
  });
}
if (import.meta.main) createServer({ stripe: stripeCfgFromEnv() }).listen(Number(process.env.PORT || 8787), "127.0.0.1", () => console.log(JSON.stringify({ listening: process.env.PORT || 8787 })));
