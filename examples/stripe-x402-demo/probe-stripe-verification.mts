// Standalone probe for the one unproven step: does Stripe PaymentIntent transaction_verification accept a USDC
// transfer produced by AuthCaptureEscrow.capture() to a Stripe crypto deposit address?
// Default is a plan only (no network). `--broadcast` sends chain txs and calls Stripe at STRIPE_API_BASE.
//   node probe-stripe-verification.mts --dry-run [--create-deposit-address]
//   node probe-stripe-verification.mts --broadcast [--create-deposit-address]
// Env: RPC_URL, STRIPE_SECRET_KEY, STRIPE_API_BASE, STRIPE_VERSION, STRIPE_DEPOSIT_ADDRESS, PAYER_KEY, OPERATOR_KEY,
//      ESCROW, COLLECTOR, USDC, TOKEN_NAME, TOKEN_VERSION, AMOUNT_ATOMIC (default 10000 = 0.01 USDC), STRIPE_NETWORK (default base)
// Chain flow: operator = OPERATOR_KEY address; payer signs ERC-3009 ReceiveWithAuthorization (escrow collector);
// operator.authorize then operator.capture(receiver = deposit address). No arbiter involved: the Transfer log shape
// (token store -> receiver, emitted inside capture) is what Stripe must accept.
import { writeFileSync } from "node:fs";
import { stripePost } from "./stripe.mts";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEventLogs, parseAbiItem, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as sdk from "../../arbiter-sdk/src/index.ts";
import { createDepositAddress, createVerificationIntent, depositAddressRequest, stripeConfigFromEnv, verificationParams, formEncode, usdcToCents } from "./stripe.mts";

const PI = "(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)";
const escrowAbi = parseAbi([`function authorize(${PI} paymentInfo, uint256 amount, address tokenCollector, bytes collectorData)`, `function capture(${PI} paymentInfo, uint256 amount, uint256 feeAmount, address feeReceiver)`]);
const transferEvt = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const BASE_SEPOLIA = { chainId: 84532, escrow: sdk.AUTH_CAPTURE_ESCROW_V1_1, collector: sdk.ERC3009_COLLECTOR_V1_1, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address, tokenName: "USDC", tokenVersion: "2" };

const FALLBACK_VERSIONS = (process.env.STRIPE_VERSION_FALLBACKS ?? "2026-05-27.preview").split(",").filter(Boolean);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isVersionError = (r: { ok: boolean; body: any }) => !r.ok && /version/i.test(JSON.stringify(r.body?.error ?? r.body ?? ""));
/** Redacts Stripe/API secrets from any JSON-able value. */
export function sanitize<T>(v: T, extra: string[] = []): T {
  let t = JSON.stringify(v).replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g, "[REDACTED]").replace(/("client_secret":")[^"]+/g, "$1[REDACTED]");
  for (const e of extra.filter(Boolean)) t = t.split(e).join("[REDACTED]");
  return JSON.parse(t);
}
/** Tries cfg.version, then fallbacks only when Stripe reports a version problem. Every attempt is recorded. */
async function withVersions(cfg: ReturnType<typeof stripeConfigFromEnv>, attempts: any[], label: string, call: (c: typeof cfg) => Promise<{ status: number; ok: boolean; body: any }>) {
  let last: any;
  for (const version of [cfg.version, ...FALLBACK_VERSIONS.filter((v) => v !== cfg.version)]) {
    last = await call({ ...cfg, version });
    attempts.push({ label, stripeVersion: version, httpStatus: last.status, response: last.body });
    if (!isVersionError(last)) { cfg.version = version; return last; }
  }
  return last;
}

export async function runProbe(argv = process.argv.slice(2), env = process.env) {
  const flags = new Set(argv);
  const broadcast = flags.has("--broadcast") && !flags.has("--dry-run");
  const cfg = stripeConfigFromEnv(env);
  const amount = BigInt(env.AMOUNT_ATOMIC ?? "10000");
  const network = env.STRIPE_NETWORK || "base";
  const out: any = { schema: "agentkoin.stripe-probe/0.1", mode: broadcast ? "broadcast" : "dry-run", stripe: { apiBase: cfg.apiBase, version: cfg.version, versionStatus: "unverified: docs show 2026-05-27.preview and 2026-07-29.preview" }, amountAtomic: amount.toString(), amountCents: usdcToCents(amount), steps: [] };
  const step = (name: string, data: unknown) => out.steps.push({ name, ...(data as object) });

  let deposit = (env.STRIPE_DEPOSIT_ADDRESS || "") as Address;
  if (flags.has("--create-deposit-address")) {
    if (!broadcast) step("stripe.createDepositAddress", { planned: depositAddressRequest(cfg) });
    else {
      const attempts: any[] = [];
      const r = await withVersions(cfg, attempts, "createDepositAddress", (c) => createDepositAddress(c));
      step("stripe.createDepositAddress", { attempts });
      if (!r.ok || !/^0x[0-9a-fA-F]{40}$/.test(r.body?.address ?? "")) return { ...out, result: "stopped_before_any_chain_tx", error: "deposit address creation failed or returned no valid 0x address" };
      deposit = r.body.address;
    }
  }
  if (!broadcast) {
    const txHash = "0x<capture tx hash>" as Hex;
    step("chain.authorize", { planned: "escrow.authorize(paymentInfo{operator, payer, receiver=deposit}, amount, collector, ERC-3009 sig)" });
    step("chain.capture", { planned: "escrow.capture(paymentInfo, amount, 0, 0x0)" });
    step("stripe.createPaymentIntent", { planned: { method: "POST", url: `${cfg.apiBase}/v1/payment_intents`, headers: { "Stripe-Version": cfg.version, "Idempotency-Key": txHash }, form: formEncode(verificationParams({ amountCents: usdcToCents(amount), txHash, network })) } });
    return { ...out, receiver: deposit || null, result: "dry-run" };
  }
  if (!deposit) throw new Error("STRIPE_DEPOSIT_ADDRESS or --create-deposit-address required");
  for (const k of ["RPC_URL", "PAYER_KEY", "OPERATOR_KEY"]) if (!env[k]) throw new Error(`${k} required for --broadcast`);
  const rpc = env.RPC_URL!;
  const chainId = await createPublicClient({ transport: http(rpc) }).getChainId();
  if (env.EXPECT_CHAIN_ID && Number(env.EXPECT_CHAIN_ID) !== chainId) throw new Error(`chainId ${chainId} != EXPECT_CHAIN_ID ${env.EXPECT_CHAIN_ID}`);
  const known = chainId === BASE_SEPOLIA.chainId ? BASE_SEPOLIA : null;
  const escrow = (env.ESCROW || known?.escrow) as Address, collector = (env.COLLECTOR || known?.collector) as Address, usdc = (env.USDC || known?.usdc) as Address;
  if (!escrow || !collector || !usdc) throw new Error("ESCROW, COLLECTOR, USDC required on this chain");
  const tokenName = env.TOKEN_NAME || known?.tokenName || "USDC", tokenVersion = env.TOKEN_VERSION || known?.tokenVersion || "2";
  const chain = defineChain({ id: chainId, name: "probe", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pc = createPublicClient({ chain, transport: http(rpc), pollingInterval: 500 });
  const payer = privateKeyToAccount(env.PAYER_KEY as Hex), operator = privateKeyToAccount(env.OPERATOR_KEY as Hex);
  const opWallet = createWalletClient({ account: operator, chain, transport: http(rpc) });
  const now = Number((await pc.getBlock()).timestamp);
  const p: sdk.PaymentInfo = { operator: operator.address, payer: payer.address, receiver: deposit, token: usdc, maxAmount: amount, preApprovalExpiry: now + 3600, authorizationExpiry: now + 86400, refundExpiry: now + 86400, minFeeBps: 0, maxFeeBps: 0, feeReceiver: sdk.ZERO, salt: BigInt(keccak256(toHex(`probe-${now}-${Math.random()}`))) };
  const sig = await payer.signTypedData(sdk.receiveWithAuthorizationTypedData({ p, chainId, escrow, collector, tokenName, tokenVersion }));
  const authHash = await opWallet.writeContract({ address: escrow, abi: escrowAbi, functionName: "authorize", args: [p, amount, collector, sig] });
  const authRc = await pc.waitForTransactionReceipt({ hash: authHash });
  step("chain.authorize", { txHash: authHash, blockNumber: authRc.blockNumber.toString(), status: authRc.status });
  if (authRc.status !== "success") return { ...out, result: "error", error: "authorize reverted" };
  const capHash = await opWallet.writeContract({ address: escrow, abi: escrowAbi, functionName: "capture", args: [p, amount, 0, sdk.ZERO] });
  const capRc = await pc.waitForTransactionReceipt({ hash: capHash });
  const logs = parseEventLogs({ abi: [transferEvt], logs: capRc.logs }).filter((l) => l.address.toLowerCase() === usdc.toLowerCase() && l.args.to.toLowerCase() === deposit.toLowerCase());
  step("chain.capture", { txHash: capHash, blockNumber: capRc.blockNumber.toString(), status: capRc.status, transferToReceiver: logs.map((l) => ({ from: l.args.from, to: l.args.to, value: l.args.value.toString() })) });
  if (capRc.status !== "success" || !logs.length) return { ...out, result: "error", error: "capture produced no USDC transfer to receiver" };
  await sleep(Number(env.CONFIRM_WAIT_MS ?? 6000)); // let Stripe's node see the confirmed tx
  const attempts: any[] = [];
  const params = { amountCents: usdcToCents(amount), txHash: capHash as Hex, network };
  let r = await withVersions(cfg, attempts, "createPaymentIntent", (c) => createVerificationIntent(c, params));
  if (!r.ok && !isVersionError(r) && /not found|confirm|pending|finali|not yet|could not find/i.test(JSON.stringify(r.body?.error ?? ""))) {
    await sleep(Number(env.RETRY_WAIT_MS ?? 12000));
    // new idempotency key: Stripe replays the cached error for a reused key
    r = await withVersions(cfg, attempts, "createPaymentIntent.retry", (c) => stripePost(c, "/v1/payment_intents", verificationParams(params), `${capHash}-retry1`));
  }
  step("stripe.createPaymentIntent", { attempts });
  return { ...out, chainId, receiver: deposit, captureTxHash: capHash, result: r.ok && r.body.status === "succeeded" ? "stripe_accepted_capture_transfer" : r.ok ? "stripe_response_not_succeeded" : "stripe_rejected" };
}

if (import.meta.main) runProbe().then((o) => { const clean = sanitize(o, [process.env.STRIPE_SECRET_KEY ?? "", process.env.PAYER_KEY ?? "", process.env.OPERATOR_KEY ?? ""]); if (process.env.PROBE_OUT) writeFileSync(process.env.PROBE_OUT, JSON.stringify(clean, null, 2) + "\n", { mode: 0o600 }); console.log(JSON.stringify(clean, null, 2)); process.exit(o.result === "error" || o.result === "stripe_rejected" ? 1 : 0); }, (e) => { console.error(JSON.stringify({ result: "error", error: String(e.message ?? e) })); process.exit(1); });
