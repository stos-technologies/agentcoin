# arbiter-sdk

TypeScript helpers for the AgentKoin auth-capture arbiter, an x402 `auth-capture` operator on Base Commerce Payments `AuthCaptureEscrow` v1.1. Pure functions; no network access. Base Sepolia testnet only; unpublished.

| module | covers |
|---|---|
| `src/index.ts` | v0.2: `termsHash`, `termsSalt`, `buildPaymentInfo`, escrow `paymentInfoHash`, ERC-3009 typed data, `resultDigest` (sha256 over RFC 8785 JCS), EIP-712 `OutsideVerdict` and `BuyerAcceptance` (domain `x402 outside-verdict` / `0.2`), `checkBeforeSigning` |
| `src/v03.ts` | v0.3: `TermsV03` with optional `submitter`, `hashTermsV03`, `effectiveSubmitter`, `submitterIsPayer`, `buildPaymentInfoV03`, `checkBeforeSigningV03`, domain `0.3` digests, `ARBITER_V03_ABI`, `buildArbiterV03Tx` |
| `src/builder-code.ts` | ERC-8021 Base Builder Code data suffix. The default code is `bc_ta422vae`. Opt out with `BASE_BUILDER_CODE=none` (or `""` or `0`) or `builderCode: null`. `buildArbiterTx` appends the suffix only when a code resolves. |

Deployments (Base Sepolia, 84532): v0.3 `0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5` (Sourcify exact_match; source in `../contracts`), v0.2 `0xC0A315b5C4745DecB7db9Ed019C026971500e7a0`.

## Tests
```
npm install
npm test            # offline: test/unit.test.ts (vectors, domain separator of the v0.3 deployment, role guards, builder code)
npm run test:anvil  # crosscheck.test.ts, builder-code.test.ts, v03.test.ts: deploy and compare against Solidity on a local anvil
```
`test:anvil` needs Forge artifacts in `../out`, from the Foundry workspace that also builds the registry, escrow and mocks (not in this repository), and `anvil` in `~/.foundry/bin`. `vectors.v02.json` and `vectors.v03.json` are shared with `python/agentcoin-core`.
