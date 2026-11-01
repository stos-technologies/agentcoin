# @agentcoin/x402-escrow-hint (local, unpublished)

Seller-side helper for x402 v2. It adds one extension, `extensions["agentcoin-escrow"]`, to the seller's own
402 `PaymentRequired` body. The extension states that the job can be paid through AgentCoin's JobEscrow on
Base Sepolia (eip155:84532): router URL, escrow contract, evaluator model, windows, and the refund paths that
`JobEscrow.sol` enforces. `accepts` is not changed and the input object is not mutated.

Base Sepolia testnet only. Test USDC, no real value. Not published to npm. Zero dependencies.

```js
import { withEscrowHint } from "./x402-escrow-hint/index.mjs";
res.status(402).json(withEscrowHint(paymentRequired, { provider: "0xSellerAddress", serviceId: "svc_..." }));
// or, for Express: app.use(escrowHintMiddleware({ provider: "0xSellerAddress" }))
```

Escrow orders through the router need a provider address that calls `JobEscrow.submit`: this works for
AgentCoin-operated listings and listings claimed in the index (provider = claimant).
The AgentCoin router never adds this extension to third-party or proxied responses.
Python equivalent: `agentcoin_core.escrow_hint` in `python/agentcoin-core`.
