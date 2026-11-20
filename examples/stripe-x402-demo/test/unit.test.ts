// Offline unit tests: no anvil, no Forge artifacts, no network beyond a loopback mock. The full lifecycle suites
// (demo.test.ts, v03-direct.test.ts) need ../../out from `forge build`: run them with `npm run test:anvil`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formEncode, verificationParams, usdcToCents, stripePost } from "../stripe.mts";
import { startMockStripe } from "../mock-stripe.mts";

const TX = "0x9cb2cb760d5ebd711760aa12cfd28a55e3678eb36bcc86f2d5a4bfdd38429268" as const; // live Base Sepolia capture tx

test("transaction_verification params are form-encoded as Stripe expects", () => {
  const form = Object.fromEntries(formEncode(verificationParams({ amountCents: 1, txHash: TX })));
  assert.equal(form.amount, "1"); assert.equal(form.currency, "usd"); assert.equal(form.confirm, "true");
  assert.equal(form["payment_method_data[type]"], "crypto");
  assert.equal(form["allowed_payment_method_types[]"], "crypto");
  assert.equal(form["payment_method_options[crypto][mode]"], "transaction_verification");
  assert.equal(form["payment_method_options[crypto][transaction_verification_options][network]"], "base");
  assert.equal(form["payment_method_options[crypto][transaction_verification_options][transaction_hash]"], TX);
  assert.equal(usdcToCents(10_000n), 1);
});

test("mock Stripe: auth required, issues deposit addresses, refuses non-verification modes and unknown txs", async () => {
  const mock = await startMockStripe({ rpcUrl: "http://127.0.0.1:1", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" });
  try {
    const cfg = { apiBase: mock.url, secretKey: "sk_mock", version: "2026-07-29.preview" };
    const noAuth = await fetch(`${mock.url}/v1/crypto/deposit_addresses`, { method: "POST", body: "network=base" });
    assert.equal(noAuth.status, 401);
    const d = await stripePost(cfg, "/v1/crypto/deposit_addresses", { network: "base" });
    assert.equal(d.status, 200); assert.match(d.body.address, /^0x[0-9a-f]{40}$/); assert.equal(d.body.network, "base");
    const wrongMode = await stripePost(cfg, "/v1/payment_intents", { amount: 1, currency: "usd" });
    assert.equal(wrongMode.status, 400);
    const unknownTx = await stripePost(cfg, "/v1/payment_intents", verificationParams({ amountCents: 1, txHash: TX }), "k1");
    assert.equal(unknownTx.status, 400); assert.match(unknownTx.body.error.message, /tx not found/);
  } finally { await mock.close(); }
});
