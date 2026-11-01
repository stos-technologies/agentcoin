// @agentcoin/x402-escrow-hint: seller-side x402 v2 extension advertising escrow via AgentCoin (Base Sepolia only).
// A seller attaches it to ITS OWN 402 body. It never changes `accepts` and never mutates the input object.
// The AgentCoin router does not inject this into proxied or third-party responses.
// Values below are from deployments/base-sepolia.json and src/JobEscrow.sol in the AgentCoin repo.

export const EXTENSION_KEY = "agentcoin-escrow";
export const HINT_VERSION = "agentcoin-escrow-hint/v1";

/** Default service URL; must equal DEFAULT_AGENTCOIN_URL in @agentcoin/core (kept local: zero dependencies). Override with AGENTCOIN_URL. */
export const DEFAULT_AGENTCOIN_URL = "https://agentcoin.143-244-167-51.sslip.io";
const env = globalThis.process?.env ?? {};

export const BASE_SEPOLIA_ESCROW = Object.freeze({
  network: "eip155:84532",
  chainId: 84532,
  routerUrl: (env.AGENTCOIN_URL || env.AGENTCOIN_BASE_URL || DEFAULT_AGENTCOIN_URL).replace(/\/+$/, ""),
  escrowContract: "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D",
  evaluatorRegistry: "0x30576DE005df028D1947C56dEcc85a2a5612036a",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  evalWindowSeconds: 3600,
  challengeWindowSeconds: 600,
  evaluatorMinStake: "2000000",
});

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const SVC = /^svc_[0-9a-f]{16}$/;

/** Refund paths as enforced by JobEscrow (amounts in token base units). */
function refundTerms(c) {
  return [
    { condition: "job Funded, deadline reached, no deliverable submitted", call: "claimRefund(jobId) or cancel(jobId)", caller: "anyone (claimRefund); client (cancel)", refund: "amount (100%)" },
    { condition: "job Funded, provider has not accepted or submitted", call: "cancel(jobId)", caller: "client", refund: "amount (100%)" },
    { condition: `job Submitted, no verdict within evalWindowSeconds (${c.evalWindowSeconds})`, call: "timeoutRelease(jobId)", caller: "anyone", refund: "amount (100%); evaluator stake slashed" },
    { condition: `verdict Reject (payoutBps 0) or Partial, challengeWindowSeconds (${c.challengeWindowSeconds}) elapsed`, call: "finalize(jobId)", caller: "anyone", refund: "amount * (10000 - payoutBps) / 10000" },
  ];
}

/**
 * Build the extension value { info, schema }.
 * @param {object} o
 * @param {string} o.provider   seller address that calls JobEscrow.submit (required)
 * @param {string} [o.serviceId] seller's AgentCoin index listing id (svc_<16 hex>), if listed
 * @param {string} [o.evaluator] evaluator address, if fixed by the seller
 * @param {string} [o.specHash]  bytes32 spec hash, if fixed by the seller
 * @param {number} [o.deadlineSeconds]
 * @param {object} [o.deployment] override BASE_SEPOLIA_ESCROW fields (tests)
 */
export function escrowHint(o = {}) {
  const c = { ...BASE_SEPOLIA_ESCROW, ...(o.deployment ?? {}) };
  if (c.chainId !== 84532 || c.network !== "eip155:84532") throw new Error("agentcoin escrow hint: Base Sepolia (eip155:84532) only");
  if (!ADDR.test(String(o.provider ?? ""))) throw new Error("agentcoin escrow hint: provider must be an EVM address");
  if (o.evaluator != null && !ADDR.test(String(o.evaluator))) throw new Error("agentcoin escrow hint: evaluator must be an EVM address");
  if (o.serviceId != null && !SVC.test(String(o.serviceId))) throw new Error("agentcoin escrow hint: serviceId must be svc_<16 hex>");
  if (o.specHash != null && !/^0x[0-9a-fA-F]{64}$/.test(String(o.specHash))) throw new Error("agentcoin escrow hint: specHash must be bytes32 hex");
  const router = String(c.routerUrl).replace(/\/+$/, "");
  const info = {
    v: HINT_VERSION,
    escrowAvailable: true,
    network: c.network,
    chainId: c.chainId,
    testnet: true,
    realValue: false,
    router: {
      url: router,
      orders: `${router}/v1/orders`,
      llmsTxt: `${router}/llms.txt`,
      ...(o.serviceId ? { serviceId: o.serviceId, listing: `${router}/v1/services/${o.serviceId}`, reputation: `${router}/v1/reputation/${o.serviceId}` } : {}),
      orderBody: { serviceId: o.serviceId ?? null, mode: "escrow", buyer: "<client address>" },
    },
    escrow: {
      contract: c.escrowContract,
      token: c.token,
      provider: o.provider,
      ...(o.evaluator ? { evaluator: o.evaluator } : { evaluatorSource: "assigned in the POST /v1/orders escrow response" }),
      ...(o.specHash ? { specHash: o.specHash } : {}),
      ...(o.deadlineSeconds ? { deadlineSeconds: Number(o.deadlineSeconds) } : {}),
      funding: "JobEscrow.createAndFundFor(client, provider, evaluator, amount, deadline, specHash) after USDC.approve(contract, amount)",
      x402Scheme: "agentcoin-escrow",
      evaluatorModel: {
        registry: c.evaluatorRegistry,
        minStake: c.evaluatorMinStake,
        verdict: "evaluator calls verdict(jobId, Complete|Reject|Partial, payoutBps, reasonHash) on a Submitted job",
        evalWindowSeconds: c.evalWindowSeconds,
        challenge: `client or provider may challenge a verdict within challengeWindowSeconds (${c.challengeWindowSeconds}) with a bond plus arbitration fee; testnet arbitrator is MockArbitrator`,
        challengeWindowSeconds: c.challengeWindowSeconds,
      },
      payout: "after challengeWindowSeconds, finalize(jobId) pays provider amount * payoutBps / 10000 minus protocol and evaluator fees",
      refunds: refundTerms(c),
      instantRelease: "if amount <= instantThreshold and the provider bond covers amount * instantBondCoverBps, submit releases payment without a verdict; then only the client may challenge",
    },
  };
  return {
    info,
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["v", "escrowAvailable", "network", "chainId", "router", "escrow"],
      properties: { v: { const: HINT_VERSION }, escrowAvailable: { type: "boolean" }, network: { const: "eip155:84532" }, chainId: { const: 84532 }, router: { type: "object", required: ["url", "orders"] }, escrow: { type: "object", required: ["contract", "token", "provider", "refunds"] } },
    },
  };
}

/**
 * One line for a seller: `body = withEscrowHint(body, { provider })`.
 * Returns a NEW PaymentRequired object with extensions["agentcoin-escrow"] set. `accepts` and every other
 * field are left as given (same values, same order). Throws if the input is not an x402 PaymentRequired body.
 */
export function withEscrowHint(paymentRequired, opts) {
  if (!paymentRequired || typeof paymentRequired !== "object" || !Array.isArray(paymentRequired.accepts)) throw new Error("withEscrowHint: expected an x402 PaymentRequired object with accepts[]");
  const ext = paymentRequired.extensions && typeof paymentRequired.extensions === "object" ? paymentRequired.extensions : {};
  return { ...paymentRequired, extensions: { ...ext, [EXTENSION_KEY]: escrowHint(opts) } };
}

/**
 * Express/Connect-style middleware for the seller's own routes: wraps res.json so that a 402 body
 * that is an x402 PaymentRequired object gets the extension. Other statuses and bodies pass through unchanged.
 * A PAYMENT-REQUIRED header already set by the seller is not rewritten.
 */
export function escrowHintMiddleware(opts) {
  escrowHint(opts); // validate once at mount time
  return function agentcoinEscrowHint(_req, res, next) {
    const orig = res.json?.bind(res);
    if (orig) res.json = (body) => orig(res.statusCode === 402 && body && Array.isArray(body.accepts) ? withEscrowHint(body, opts) : body);
    next();
  };
}
