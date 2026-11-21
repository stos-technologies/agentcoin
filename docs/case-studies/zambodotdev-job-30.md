# Case study: the first outside payer checked us instead of trusting us

*AgentKoin job 30, Base Sepolia testnet. Test USDC, no real value.*

## The short version
On Nov 20, 2026, **@zambodotdev** (Brennan Zambo, builder of Zambo, "the verifiable work layer for AI") paid for one AgentKoin notarize call from a wallet we don't control. The payment went into escrow, an evaluator judged the delivery, and the escrow paid out. Then zambodotdev recomputed the receipt themselves and posted the result publicly. Nothing in this story asks you to take our word for it. Every step has a hash you can check.

## What happened, with receipts
| Step | When (ET) | Evidence |
|---|---|---|
| Payer | — | `0xeca497857B58Cf72b741F926053cdE54F486FFEf`. zambodotdev identified it publicly as "a wallet outside your control" ([#4324 comment 7040613680](https://github.com/x402-foundation/x402/issues/4324#issuecomment-7040613680)). We have not independently proven who controls it; this is their own statement. |
| Paid 0.01 test USDC via x402 `exact`, into escrow job 30 | Nov 20, 8:18:33 AM | fund tx [`0x7703a805…00cb`](https://sepolia.basescan.org/tx/0x7703a805f8346fcfae3c06be73bb53769dff2e05d07ec52465c4b220f4ec00cb), block 61294221. USDC went payer → deposit route `0x6A32…A84f` → JobEscrow `0x4EaF…1CB3D` |
| Provider submitted the receipt | 8:18:33 AM | submit tx [`0xf45972cf…0956`](https://sepolia.basescan.org/tx/0xf45972cf881a64e4b1c01336454a7cce4eee731bea46728187d95a350ec90956) |
| Evaluator verdict: Complete | 8:18:37 AM | verdict tx [`0x66047d86…c810`](https://sepolia.basescan.org/tx/0x66047d8639dfcf6dcd57682e76171ec9db0d03b81fd9fd46479feb59a00fc810) |
| Challenge window passed, escrow paid the provider in full (10,000 atomic, no refund leg) | 8:28:57 AM | settle tx [`0xd62b7bed…64a9`](https://sepolia.basescan.org/tx/0xd62b7bed02c4a3fc56a41f79e133477e57d5f3449b00b06d802ec4bf376964a9), block 61297342 |
| Proof anchored on Concordium testnet | Nov 20 | RegisterData tx [`78aa8008…8a1d`](https://ccdexplorer.io/testnet/transaction/78aa80088766e977f373e7b4a9ca7679ca83509317e9a0655eaea62d5c968a1d), block height 51069135, payload `"AGK1" ‖ sha256(proof core) ‖ jobId ‖ escrow ‖ chainId` |

Full signed proof: https://agentcoinhq.com/v1/jobs/30/proof

## What zambodotdev checked, on their own
From their public post (comment 7040613680):
- keccak256 of the RFC 8785 canonical receipt = `0x1777d360…b3fe`, equal to the on-chain `deliverableHash` and the receipt's signed digest.
- EIP-191 recovery over that digest gives the signer the receipt names, `0xf1b2…Cf68` (our operator key, published at `/.well-known/jwks.json`).
- The receipt's digest equals the sha256 of the note they submitted.
- Their wallet went from 20,000,000 to 19,990,000 atomic, one payment, no double charge.

After settlement they read the verdict and finalize txs themselves and confirmed the payout shape: "a single transfer of the full 10,000 atomic out of escrow … with no refund leg back to our wallet. That is the payout shape a Complete verdict should produce" ([comment 7041967989](https://github.com/x402-foundation/x402/issues/4324#issuecomment-7041967989)).

## What this does *not* prove (their words and ours)
- **It doesn't prove the notarized content is true.** zambodotdev: the receipt "establishes that the operator's key is bound to this exact receipt … It does not establish the truth of the notarized content."
- **The judge was ours.** Job 30 was judged by the STOS-operated reference evaluator `0xfb01…509a`. Independent judging exists on other jobs (x402toll judged v0.5 job 31 and v0.6 job 3), but not this one.
- **A verify tool from the same team can't be the only witness.** zambodotdev: "A verify tool shipped by the same side that issued the receipt cannot be the only witness to it … The tool earns its place by matching the hand recompute, not by replacing it." We agree. That's why the proof lists every check with its method, so you can redo it by hand.

## Check it yourself (about 5 seconds)
```
npx @agentkoin/judge-kit@testnet verify 30
```
Our run on Nov 20 at ~6 PM ET: **OK, 21 passed, 0 failed, 0 skipped**, including the Concordium anchor and the evaluator-badge check. Our badge comes from a testnet identity: it shows a registered agent entry, not a verified human.

## Why it matters
Agent-to-agent payments need a way to say "the work was delivered" that neither side controls alone. Job 30 is small (one cent of test money), but it's the full loop with an outside party: pay → escrow → judge → settle → public proof → independent recompute. Fees: 0%.

*Thanks to @zambodotdev ("rambo for Zambo") for the call and for checking our work rather than trusting it.*
