// Form-encoded POST to Stripe. Endpoint/param names verified against docs.stripe.com/api (2026-11-19):
//   POST /v1/transfers: amount, currency, destination (required), transfer_group, source_transaction, metadata
//   POST /v1/refunds:   payment_intent (or charge), amount, metadata, reason, ...
//   Idempotency-Key request header (standard Stripe behavior).
// Connect transfers and refunds are stable API surfaces: no preview Stripe-Version is required; STRIPE_VERSION is optional.
export type StripeCfg = { apiBase: string; secretKey: string; version?: string };
export const stripeCfgFromEnv = (env = process.env): StripeCfg => ({ apiBase: env.STRIPE_API_BASE || "https://api.stripe.com", secretKey: env.STRIPE_SECRET_KEY || "", version: env.STRIPE_VERSION || undefined });

function enc(params: Record<string, unknown>, prefix = "", out: [string, string][] = []) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") enc(v as Record<string, unknown>, key, out); else out.push([key, String(v)]);
  }
  return out;
}
export async function stripePost(cfg: StripeCfg, path: string, params: Record<string, unknown>, idempotencyKey: string) {
  const headers: Record<string, string> = { Authorization: `Basic ${Buffer.from(`${cfg.secretKey}:`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": idempotencyKey };
  if (cfg.version) headers["Stripe-Version"] = cfg.version;
  const res = await fetch(`${cfg.apiBase}${path}`, { method: "POST", headers, body: new URLSearchParams(enc(params)).toString() });
  const text = await res.text(); let body: any; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, ok: res.ok, body };
}
