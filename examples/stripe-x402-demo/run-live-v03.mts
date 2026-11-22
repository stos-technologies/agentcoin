// Live v0.3 zero-hop run on Base Sepolia + Stripe sandbox (test mode only). Refuses any other chain and any
// Stripe key for which Stripe does not report livemode=false. Keys are read from files named by env vars, inside this process; nothing secret is printed.
// Env: PAYER_KEY_FILE EVALUATOR_KEY_FILE SELLER_KEY_FILE RELAYER_KEY_FILE STRIPE_ENV_FILE (a KEY=value file with
// STRIPE_SECRET_KEY) [RPC_URL AMOUNT_ATOMIC PASS_MASK STRIPE_DEPOSIT_ADDRESS OUT]. PASS_MASK 0b1111 = 100%, 0b0011 = 50%.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Address, type Hex } from "viem";
import * as sdk from "../../arbiter-sdk/src/index.ts";
import { runLifecycleV03, isWholeCents } from "./lifecycle-v03.mts";
import { sanitize } from "./probe-stripe-verification.mts";
import { DEFAULT_STRIPE_API_BASE, DEFAULT_STRIPE_VERSION } from "./stripe.mts";

const e = process.env;
const need = (k: string) => { const v = e[k]; if (!v) throw new Error(`missing env ${k}`); return v; };
const key = (k: string) => { let s = readFileSync(need(k), "utf8").trim(); if (!s.startsWith("0x")) s = "0x" + s; return s as Hex; };
const envFile = Object.fromEntries(readFileSync(need("STRIPE_ENV_FILE"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
  .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const secretKey = envFile.STRIPE_SECRET_KEY ?? "";
const stripe = { apiBase: e.STRIPE_API_BASE || DEFAULT_STRIPE_API_BASE, secretKey, version: e.STRIPE_VERSION || DEFAULT_STRIPE_VERSION };
const auth = { Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`, "Stripe-Version": stripe.version };
// Test mode only: Stripe itself must report livemode=false for this key before anything is sent.
const bal: any = await (await fetch(`${stripe.apiBase}/v1/balance`, { headers: auth })).json();
if (bal?.livemode !== false) throw new Error("REFUSED: Stripe did not report livemode=false for this key (test mode only)");
const rpcUrl = e.RPC_URL || "https://sepolia.base.org";
const chainId = await createPublicClient({ transport: http(rpcUrl) }).getChainId();
if (chainId !== 84532) throw new Error(`REFUSED: chain ${chainId} is not Base Sepolia (84532)`);
const amount = BigInt(e.AMOUNT_ATOMIC ?? "10000"), passMask = Number(e.PASS_MASK ?? "15");
if (!isWholeCents(amount)) throw new Error("AMOUNT_ATOMIC must be whole cents");
const keys = { payer: key("PAYER_KEY_FILE"), evaluator: key("EVALUATOR_KEY_FILE"), seller: key("SELLER_KEY_FILE"), relayer: key("RELAYER_KEY_FILE") };
const secrets = [secretKey, ...Object.values(keys)];

const r = await runLifecycleV03({
  rpcUrl, chainId, escrow: sdk.AUTH_CAPTURE_ESCROW_V1_1, collector: sdk.ERC3009_COLLECTOR_V1_1,
  arbiterV03: (e.ARBITER_V03 || "0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5") as Address, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  tokenName: "USDC", tokenVersion: "2", stripe, stripeNetwork: e.STRIPE_NETWORK || "base", stripeDepositAddress: (e.STRIPE_DEPOSIT_ADDRESS || undefined) as Address | undefined,
  keys, amount, passMask, waitForChallengeWindow: true, simulateRetries: 5, pollMs: 4000,
  onStep: (s, h) => console.error(`[${new Date().toISOString()}] ${s} ${h}`),
});
// Follow up: read the PaymentIntent back from the Stripe test API until it leaves "processing" (max ~60 s).
let followUp: any = null;
if (r.stripe.paymentIntentId) {
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${stripe.apiBase}/v1/payment_intents/${r.stripe.paymentIntentId}`, { headers: auth });
    const b: any = await res.json();
    followUp = { httpStatus: res.status, status: b.status, livemode: b.livemode, amount: b.amount, amount_received: b.amount_received, currency: b.currency, latest_charge: b.latest_charge ?? null, readAt: new Date().toISOString() };
    if (b.status !== "processing") break;
    await new Promise((ok) => setTimeout(ok, 5000));
  }
}
const out = sanitize({ ...r, stripeFollowUp: followUp }, secrets);
const text = JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
if (e.OUT) writeFileSync(e.OUT, text, { mode: 0o600 });
console.log(text);
