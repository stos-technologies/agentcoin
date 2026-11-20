# stripe-x402-demo

Local/testnet harness. Escrow: AuthCaptureEscrow v1.1. Judge: AgentKoin arbiter v0.2, or v0.3 (`arbiter_v03_direct`). Payout: USDC to a Stripe crypto deposit address. Record: Stripe PaymentIntent `transaction_verification`. Output: one JSON receipt. Base Sepolia (chain 84532) and Stripe sandbox (`livemode: false`) only. Not published to npm. Never run against mainnet or live Stripe.

## Defaults (Base Sepolia, chain 84532; all overridable by env)
| name | value |
|---|---|
| ESCROW | `0xf96815976523E00e65Be8f34cA5e64b4f41EB19c` |
| ARBITER (v0.2) | `0xC0A315b5C4745DecB7db9Ed019C026971500e7a0` (registry slasher timelock until 2026-11-21 19:22 EST) |
| ARBITER (v0.3) | `0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5` (registry slasher timelock until 2026-11-21 23:02:25 EST) |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| COLLECTOR | `0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88` |

## Files
- `lifecycle.mts` authorize, bindTerms, submit, verdictBySig, optional recordBuyerAcceptance, finalize, optional forward, Stripe call, receipt.
- `run-demo.mts` env wrapper. `probe-stripe-verification.mts` standalone probe. `stripe.mts` Stripe client. `mock-stripe.mts` local mock (not Stripe).
- `lifecycle-v03.mts` v0.3 zero-hop: authorize, bindTerms, submit by `Terms.submitter`, verdictBySig, settlement (finalize, rule or resolveStaleDispute), Stripe call, receipt.
- `probe-result-base-sepolia.json` sanitized result of the live Base Sepolia + Stripe sandbox probe (see Proof).
- Tests: `npm install`, then:
  - `npm test` runs the offline unit test (`test/unit.test.ts`). No chain, no artifacts.
  - `npm run test:anvil` runs `test/demo.test.ts` and `test/v03-direct.test.ts`. These need `forge build` output in `../../out` (the Foundry workspace that builds the registry, escrow and mocks is not in the public repo) and `anvil` in `~/.foundry/bin`.

## Receiver constraint (found while building)
`AgentKoinAuthCaptureArbiter.submit` requires `msg.sender == info.receiver`. A Stripe deposit address has no signer, so with `receiver = STRIPE_DEPOSIT_ADDRESS` the receiver cannot call `submit`. Modes:
- `receiverMode: "seller_forward"` (`FORWARD_TO_DEPOSIT=1`): receiver is the seller key; after finalize the seller transfers the captured USDC to the deposit address; Stripe records the forward tx. Works on any chain.
- `receiverMode: "deposit_address_direct"` with `IMPERSONATE_RECEIVER=1`: anvil impersonates the deposit address for `submit`. Local anvil only.
Without either, the lifecycle throws `RECEIVER_CANNOT_SUBMIT`. The probe avoids the arbiter (operator = an EOA) so `receiver = deposit address` works.

## `arbiter_v03_direct` (v0.3)
`AgentKoinAuthCaptureArbiterV03` adds an optional `Terms.submitter` (part of the terms hash, so the buyer's salt commits to it). `lifecycle-v03.mts` (`runLifecycleV03`) sets `receiver` to a deposit address from `POST /v1/crypto/deposit_addresses` and `submitter` to the seller EOA. The seller submits, the evaluator signs a v0.3 `OutsideVerdict`, and one settlement tx captures straight to the deposit address, with no forward and no impersonation. That tx is `finalize()`, or, after a challenge, `rule()` (inside the arbitrator's `giveRuling` tx) or `resolveStaleDispute()`. The receipt reports it as `settlementTx` and `settlementStep`. `POST /v1/payment_intents` (`transaction_verification`) is called with that tx hash, and only when the capture is an exact whole number of cents (`atomic >= 10000 && atomic % 10000 == 0`). Amounts are never floored: a non-whole-cent capture is reported as `not_called`/`non_whole_cent_amount`. The mock likewise requires one transfer that exactly matches the requested cents, and otherwise returns `invalid_amount`. `test/v03-direct.test.ts` runs this on anvil with the mock Stripe and includes these negative cases:
- the receiver, payer and relayer cannot submit
- terms naming a different submitter fail `SaltMismatch`
- the mock rejects a tx with no deposit transfer, and rejects a wrong amount
- a 0% verdict refunds the payer, and Stripe is not called
- a non-whole-cent partial capture is never sent to Stripe, and the mock rejects the floored amount

Settlement through `rule()` and through `resolveStaleDispute()` is also covered end to end.

## Proof (Base Sepolia, chain 84532; Stripe sandbox, `livemode: false`)
Every value below is public and can be checked against the chain or Sourcify.

**Live, 2026-11-19 (EST): `AuthCaptureEscrow.capture()` straight to a Stripe deposit address, recorded by Stripe** (`probe-stripe-verification.mts --broadcast --create-deposit-address`, 0.01 test USDC = 10000 atomic; `probe-result-base-sepolia.json`)
| step | value |
|---|---|
| deposit address (`POST /v1/crypto/deposit_addresses`, `network=base`) | `0x3b0b371ae3cB08F272b87319684f6518b3b313a0` |
| `authorize` tx | `0xd23ac1973e248dbe81119c63174be0bacae78ff4da40dbe197a9ab29ccf50336` (block 61101473) |
| `capture` tx (one USDC transfer, escrow token store -> deposit address, 10000) | `0x9cb2cb760d5ebd711760aa12cfd28a55e3678eb36bcc86f2d5a4bfdd38429268` (block 61101476) |
| PaymentIntent (`transaction_verification`, `amount=1`, that capture tx) | `pi_3UdhgOI5sElyKBwA12avfxXX`: `processing`, then `succeeded` within about 10 s; `amount_received: 1`; charge `py_3UdhgOI5sElyKBwA1MdwLAQ5` |

This probe uses an EOA operator, not the arbiter.

**Deployed, 2026-11-19 (EST): `AgentKoinAuthCaptureArbiterV03`**
| field | value |
|---|---|
| address | `0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5` |
| deploy tx | `0x0c057d7c5e70f6349036c1cdf8fd12c057f632b4757d28155164319f2b10a6e0` (block 61127019) |
| Sourcify | exact_match: https://repo.sourcify.dev/84532/0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5 |
| config | same as v0.2: arbitrator `0x0` (challenges disabled), challengeWindow 600 s, maxAmountPerPayment 1000000 |
| `proposeSlasher(v0.3, true)` tx | `0xa0cc4e67ce52e2f8cd8f150c6f88488c54636b404e1b9f3c6ff6405eef9bfb7e` (block 61127383) |
| slasher unlock (`pendingSlasher.eta`) | `1795320145` = 2026-11-21 23:02:25 EST |

Until the registry's 48 h slasher timelock is executed, `bindTerms` on v0.3 reverts. The live v0.3 zero-hop (100%) and 50% partial-capture Base Sepolia runs are scheduled for after the unlock, and are not done yet.

**Local anvil + mock Stripe: v0.3 zero-hop.** `test/v03-direct.test.ts` passes 6/6:
- keyless deposit-address receiver, seller-submitted, with a single capture transfer verified by the mock
- role, salt, amount, non-whole-cent and 0% negatives
- `rule()` and `resolveStaleDispute()` settlement

## Probe
```
node probe-stripe-verification.mts --dry-run [--create-deposit-address]     # plan only, no network
node probe-stripe-verification.mts --broadcast [--create-deposit-address]   # chain txs + Stripe calls
```
Env: `RPC_URL STRIPE_SECRET_KEY STRIPE_API_BASE STRIPE_VERSION STRIPE_DEPOSIT_ADDRESS PAYER_KEY OPERATOR_KEY` (+ `ESCROW COLLECTOR USDC TOKEN_NAME TOKEN_VERSION` off Base Sepolia, `AMOUNT_ATOMIC` default 10000, `STRIPE_NETWORK` default `base`). Result values: `dry-run`, `stripe_accepted_capture_transfer`, `stripe_response_not_succeeded`, `stripe_rejected`, `error`. Without `--broadcast` nothing is sent.

## Stripe wire details
Verified in docs.stripe.com/payments/machine/x402 and /api/crypto/deposit-address (read 2026-11-19):
- `POST /v1/crypto/deposit_addresses`, form `network=base` (enum base|solana|tempo), header `Stripe-Version`.
- `POST /v1/payment_intents`, form `amount` (cents), `currency=usd`, `confirm=true`, `payment_method_data[type]=crypto`, `allowed_payment_method_types[]=crypto`, `payment_method_options[crypto][mode]=transaction_verification`, `payment_method_options[crypto][transaction_verification_options][network]=base`, `...[transaction_hash]=<tx hash>`; docs use the tx hash as `Idempotency-Key`.
- Sandbox: docs say use a Stripe sandbox, Base Sepolia, and facilitator `https://x402.org/facilitator`.

Observed in the live sandbox probe (2026-11-19):
- `Stripe-Version: 2026-07-29.preview` was accepted for both calls.
- `network=base` was accepted for a Base Sepolia deposit address and tx hash.
- A transfer emitted inside `AuthCaptureEscrow.capture()` (token store to deposit address) was accepted: `succeeded`.

Still unverified:
1. Whether Stripe accepts a settlement tx that carries two USDC transfers (a partial capture, which pays the deposit address and refunds the payer in one tx). This will be tested live after the v0.3 unlock.
2. PaymentIntent response fields for this mode beyond `id`/`status`; `metadata` acceptance on this mode.
3. Restricted-key permission names for deposit addresses and this PaymentIntent mode (docs describe restricted keys generally; no per-resource list found).
Mock error codes and response extras are invented for tests.
