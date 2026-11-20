// Minimal Stripe REST client (form-encoded, fetch). Wire details and their verification status:
//  VERIFIED against docs.stripe.com (2026-11-19):
//    POST /v1/crypto/deposit_addresses  form: network=base            header Stripe-Version: <preview>
//    POST /v1/payment_intents           form: amount, currency, confirm=true, payment_method_data[type]=crypto,
//      allowed_payment_method_types[]=crypto, payment_method_options[crypto][mode]=transaction_verification,
//      payment_method_options[crypto][transaction_verification_options][network]=base,
//      ...[transaction_hash]=<0x..>   header Idempotency-Key: <tx hash> (docs use the tx hash as the key)
//  NOT VERIFIED (not documented verbatim, confirm with a real sandbox key):
//    - Stripe-Version value: x402 page shows 2026-05-27.preview in one section and 2026-07-29.preview in the sandbox section.
//    - `network` value for a Base Sepolia transaction (docs show "base" even in the sandbox section).
//    - whether a transfer produced by AuthCaptureEscrow.capture() is accepted.
//    - full PaymentIntent response shape for this mode (only id/status/amount/currency are read here).
//    - restricted-key permission names for crypto deposit addresses and this PaymentIntent mode.
import type { Hex } from "viem";

export const DEFAULT_STRIPE_API_BASE = "https://api.stripe.com";
export const DEFAULT_STRIPE_VERSION = "2026-07-29.preview"; // UNVERIFIED which of the two documented values is current; override with STRIPE_VERSION

export type StripeConfig = { apiBase: string; secretKey: string; version: string };
export function stripeConfigFromEnv(env = process.env): StripeConfig {
  return { apiBase: env.STRIPE_API_BASE || DEFAULT_STRIPE_API_BASE, secretKey: env.STRIPE_SECRET_KEY || "", version: env.STRIPE_VERSION || DEFAULT_STRIPE_VERSION };
}

export function formEncode(params: Record<string, unknown>, prefix = "", out: [string, string][] = []): [string, string][] {
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => out.push([`${key}[]`, String(x)]));
    else if (typeof v === "object") formEncode(v as Record<string, unknown>, key, out);
    else out.push([key, String(v)]);
  }
  return out;
}

export async function stripePost(cfg: StripeConfig, path: string, params: Record<string, unknown>, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${cfg.secretKey}:`).toString("base64")}`,
    "Stripe-Version": cfg.version, "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${cfg.apiBase}${path}`, { method: "POST", headers, body: new URLSearchParams(formEncode(params)).toString() });
  const text = await res.text();
  let body: any; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, ok: res.ok, body };
}

export const createDepositAddressParams = (network = "base") => ({ network });
export const depositAddressRequest = (cfg: StripeConfig) => ({ method: "POST", url: `${cfg.apiBase}/v1/crypto/deposit_addresses`, headers: { "Stripe-Version": cfg.version }, form: formEncode(createDepositAddressParams()) });

export function verificationParams(a: { amountCents: number; txHash: Hex; network?: string; metadata?: Record<string, string> }) {
  return {
    amount: a.amountCents, currency: "usd", confirm: true,
    payment_method_data: { type: "crypto" }, allowed_payment_method_types: ["crypto"],
    payment_method_options: { crypto: { mode: "transaction_verification", transaction_verification_options: { network: a.network ?? "base", transaction_hash: a.txHash } } },
    ...(a.metadata ? { metadata: a.metadata } : {}), // metadata on this mode: standard PaymentIntent param, UNVERIFIED for crypto transaction_verification
  };
}
export const createDepositAddress = (cfg: StripeConfig) => stripePost(cfg, "/v1/crypto/deposit_addresses", createDepositAddressParams());
export const createVerificationIntent = (cfg: StripeConfig, a: { amountCents: number; txHash: Hex; network?: string; metadata?: Record<string, string> }) =>
  stripePost(cfg, "/v1/payment_intents", verificationParams(a), a.txHash);
/** USDC has 6 decimals; 1 cent = 10_000 atomic units. Rounds down. */
export const usdcToCents = (atomic: bigint) => Number(atomic / 10_000n);
