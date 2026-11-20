# stripe-connect-webhook

Prototype. Verifies an AgentKoin EIP-712 `OutsideVerdict` and applies it to a Stripe Connect platform charge using separate charges and transfers. The platform's Stripe account holds the funds; AgentKoin sends none and holds none (`heldByAgentKoin: 0`). Not published to npm; tested against a local mock only.

Run: `STRIPE_SECRET_KEY=... node server.mts` (PORT default 8787, `POST /agentkoin/verdict`). Tests: `npm install && npm test` (offline; local mock Stripe).

## Request
`{ chainId, arbiter, verdict, signature, claimedEvaluator?, buyerAcceptance?: { acceptance, signature?, buyer? }, job: { paymentIntentId, transferGroup, sellerConnectedAccountId, authorizedAmountCents, currency, platformFeeBps?, sourceTransaction? }, expected: { evaluator, termsHash, paymentInfoHash, resultDigest } }`
Domain: `{ name: "x402 outside-verdict", version: "0.2", chainId, verifyingContract: arbiter }`. EOA signatures only (no ERC-1271 path). `job` and `expected` should be loaded from the platform's records via `deps.resolveJob` in production. `payoutBps` is not checked against the terms bps table here; `expected.termsHash` binds the terms.

## Mapping (integer cents)
- `gross = floor(authorized * payoutBps / 10000)`, `platformFeeCents = floor(gross * platformFeeBps / 10000)`, `transfer = max(0, gross - platformFeeCents)`, `refund = authorized - gross`.
- 10000 bps: `POST /v1/transfers` (amount, currency, destination, transfer_group, source_transaction?, metadata). 1..9999: transfer, then `POST /v1/refunds` (payment_intent, amount, metadata). 0: refund only.
- `Idempotency-Key`: `agk-<32 hex of keccak(key+verdictDigest)>-transfer|-refund`. Metadata keys: `agentkoin_payment_info_hash, _verdict_digest, _terms_hash, _result_digest, _payout_bps, _evaluator`.
- Zero-amount calls are skipped. `buyerAcceptance` is verified for binding (and signature when `buyer` + `signature` are given), recorded in the receipt, and never changes amounts.

## Status codes
200 settled or duplicate (`duplicate: true`, same receipt) | 400 malformed, `payoutBps` outside 0..10000, acceptance not bound | 401 bad signature or signer is not the expected evaluator | 403 `claimedEvaluator` differs | 409 different verdict already settled for the payment | 422 paymentInfoHash/termsHash/resultDigest differs from expected | 502 Stripe error (completed steps kept; retry resumes).
Replay state is an in-memory `Map` (injectable `store`); use durable storage in production. Transfers and refunds are stable Stripe APIs; endpoint and parameter names were read from docs.stripe.com/api/transfers/create and /api/refunds/create (2026-11-19). `source_transaction` is optional and is passed only when supplied.
