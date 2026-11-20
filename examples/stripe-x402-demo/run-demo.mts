// CLI wrapper: reads env, runs the lifecycle, prints the unified receipt JSON. Broadcasts to RPC_URL: point it at anvil
// unless Base Sepolia use is explicitly approved. Env: RPC_URL, ESCROW, ARBITER, USDC, COLLECTOR, TOKEN_NAME, TOKEN_VERSION,
// STRIPE_DEPOSIT_ADDRESS, STRIPE_SECRET_KEY, STRIPE_API_BASE, STRIPE_VERSION, PAYER_KEY, EVALUATOR_KEY, SELLER_KEY, RELAYER_KEY,
// AMOUNT_ATOMIC, PASS_MASK (default 15 = 100%), BUYER_ACCEPTANCE (accepted|rejected), FORWARD_TO_DEPOSIT=1, IMPERSONATE_RECEIVER=1, TIME_TRAVEL=1
import type { Address, Hex } from "viem";
import * as sdk from "../../arbiter-sdk/src/index.ts";
import { runLifecycle } from "./lifecycle.mts";
import { stripeConfigFromEnv } from "./stripe.mts";

const e = process.env, need = (k: string) => { if (!e[k]) throw new Error(`${k} required`); return e[k]!; };
const receipt = await runLifecycle({
  rpcUrl: need("RPC_URL"), escrow: (e.ESCROW || sdk.AUTH_CAPTURE_ESCROW_V1_1) as Address,
  arbiter: (e.ARBITER || "0xC0A315b5C4745DecB7db9Ed019C026971500e7a0") as Address,
  usdc: (e.USDC || "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as Address, collector: (e.COLLECTOR || sdk.ERC3009_COLLECTOR_V1_1) as Address,
  tokenName: e.TOKEN_NAME || "USDC", tokenVersion: e.TOKEN_VERSION || "2",
  stripeDepositAddress: need("STRIPE_DEPOSIT_ADDRESS") as Address, stripe: e.STRIPE_SECRET_KEY ? stripeConfigFromEnv(e) : null,
  keys: { payer: need("PAYER_KEY") as Hex, evaluator: need("EVALUATOR_KEY") as Hex, seller: need("SELLER_KEY") as Hex, relayer: (e.RELAYER_KEY || need("PAYER_KEY")) as Hex },
  amount: BigInt(e.AMOUNT_ATOMIC || "1000000"), passMask: Number(e.PASS_MASK ?? 15),
  buyerAcceptance: (e.BUYER_ACCEPTANCE as any) || null, forwardToDeposit: e.FORWARD_TO_DEPOSIT === "1",
  impersonateReceiver: e.IMPERSONATE_RECEIVER === "1", timeTravel: e.TIME_TRAVEL === "1",
});
console.log(JSON.stringify(receipt, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
