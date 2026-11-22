# stripe-x402-demo

Local/testnet harness. Escrow: AuthCaptureEscrow v1.1. Judge: AgentKoin arbiter v0.2, or v0.3 (`arbiter_v03_direct`). Payout: USDC to a Stripe crypto deposit address. Record: Stripe PaymentIntent `transaction_verification`. Output: one JSON receipt. Base Sepolia (chain 84532) and Stripe sandbox (`livemode: false`) only. Not published to npm. Never run against mainnet or live Stripe.

## Defaults (Base Sepolia, chain 84532; all overridable by env)
| name | value |
|---|---|
| ESCROW | `0xf96815976523E00e65Be8f34cA5e64b4f41EB19c` |
| ARBITER (v0.2) | `0xC0A315b5C4745DecB7db9Ed019C026971500e7a0` (active registry slasher) |
| ARBITER (v0.3) | `0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5` (active registry slasher since 2026-11-21 23:13:16 EST) |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| COLLECTOR | `0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88` |

## Files
- `lifecycle.mts` authorize, bindTerms, submit, verdictBySig, optional recordBuyerAcceptance, finalize, optional forward, Stripe call, receipt.
- `run-demo.mts` env wrapper. `probe-stripe-verification.mts` standalone probe. `stripe.mts` Stripe client. `mock-stripe.mts` local mock (not Stripe).
- `lifecycle-v03.mts` v0.3 zero-hop: authorize, bindTerms, submit by `Terms.submitter`, verdictBySig, settlement (finalize, rule or resolveStaleDispute), Stripe call, receipt.
- `run-live-v03.mts` live v0.3 runner. It works on Base Sepolia only, and refuses to run unless Stripe reports `livemode: false` for the key (`GET /v1/balance`). Keys are read from files named by env vars (`PAYER_KEY_FILE EVALUATOR_KEY_FILE SELLER_KEY_FILE RELAYER_KEY_FILE STRIPE_ENV_FILE`; also `AMOUNT_ATOMIC PASS_MASK OUT`). It waits out `challengeWindow` on the real chain, then reads the PaymentIntent back.
- `probe-result-base-sepolia.json` sanitized result of the live Base Sepolia + Stripe sandbox probe (see Proof).
- `live-v03-base-sepolia.json` sanitized receipts of the two live v0.3 runs (see Proof).
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
| `executeSlasher(v0.3)` tx | `0x19e1cf59026d4b13ad060d22543d55b0a977c6b011bdc2e24cd83eb4a4eaae8c` (block 61994637, 2026-11-21 23:13:16 EST); `isSlasher(v0.3) = true` |

**Live, 2026-11-22 (EST): v0.3 zero-hop, arbiter capture straight to a Stripe deposit address, recorded by Stripe** (`run-live-v03.mts`; `live-v03-base-sepolia.json`)

The receiver is Stripe deposit address `0x3b0b371ae3cB08F272b87319684f6518b3b313a0`, which has no key. `Terms.submitter` is the seller EOA `0x745528C4E0CBdA5759175A660da06d0aaA72db7F`. The payer is `0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e` and the evaluator is `0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a`, which is staked in the registry. There was no forward and no impersonation. Each settlement is one `finalize()` tx, sent after the 600 s challenge window.

| step | 100% (passMask 0b1111) | 50% partial (passMask 0b0011) |
|---|---|---|
| authorized | 10000 atomic (0.01 USDC) | 20000 atomic (0.02 USDC) |
| `authorize` | `0x480e89e622c68c0fa5eabf58182b65abbacf0f859959e676b19b6cfc14d232ca` | `0xd078dbcdeab781bcb26e6aec4234ff8dad225824f36222b0f00653efdc5283ac` |
| `bindTerms` (registry `lockExposure`) | `0x514a400a215b016f0b93060319de5fbb5874df32b0b22eac22d1f35886c431ca` | `0xc2842434cca7333583f0c0f6551dc97d8fe65765107aa169112624abc0d5bba8` |
| `submit` (by `Terms.submitter`) | `0x89fecd4740b0721231b86ad46ed625d0693cb44aa963f3c02d156c67c10a591f` | `0x08dae25000c02aaf6f0c7984ebab92dde777fbed265150f8cf3b917a91b93aa0` |
| `verdictBySig` (v0.3 domain) | `0xefa5d96d11d557282dab8b2e12182cf1f1a06eb047b8cb7b32cb09217a68febe` | `0xc32c56a1f1283de7beff4682edfd63e02f4bdcd2bfb8ddcb6c7dd3155c34052c` |
| `finalize` (settlement) | `0x1a54490b3f3e95f1f30ba7a8246552899afa99312ffdb95a6e00991d22f914aa` (block 62194769) | `0x1a830ff8df6657487bcb3c6c54e7a59f711e42449e116560e9c78a3c85c0601b` (block 62195161) |
| USDC transfers in `finalize` | token store -> deposit address 10000 | token store -> deposit address 10000; token store -> payer 10000 (refund) |
| `outcome` | settledBy verdict, payoutBps 10000 | settledBy verdict, payoutBps 5000 |
| PaymentIntent (`transaction_verification`, `amount=1`, network `base`, that `finalize` tx) | `pi_3UecZ2I5sElyKBwA0y13XlCn`: `processing`, then `succeeded`; `amount_received: 1`; charge `py_3UecZ2I5sElyKBwA0GZDKUTs`; `livemode: false` | `pi_3UecaHI5sElyKBwA1KCvXBSy`: `processing`, then `succeeded`; `amount_received: 1`; charge `py_3UecaHI5sElyKBwA126JuWuE`; `livemode: false` |

All 10 txs have status 1 and call the arbiter. The transfer amounts above were decoded from the receipts. Both PaymentIntents were read back from the Stripe test API and carry the settlement tx hash and `agentkoin_arbiter_version: 0.3` metadata. The evaluator's exposure was released after settlement.

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

Observed in the live v0.3 runs (2026-11-22):
- A v0.3 `finalize()` tx whose capture transfer goes straight to the deposit address was accepted: `succeeded`.
- A partial-capture `finalize()` tx with two USDC transfers was accepted for the deposit-address transfer: `succeeded`, `amount_received: 1`. The two transfers were 10000 to the deposit address and 10000 refunded to the payer.
- `metadata` (`agentkoin_*` keys) was accepted on this mode and returned on read-back.
- The read-back also returns `payment_method_options.crypto.mode` and `transaction_verification_options.{network, transaction_hash}`.

Still unverified:
1. Restricted-key permission names for deposit addresses and this PaymentIntent mode. The docs describe restricted keys in general; no per-resource list was found.

Mock error codes and response extras are invented for tests.
