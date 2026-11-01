// x402 "exact" (EIP-3009 TransferWithAuthorization) helpers, protocol v1 and v2.
// v2: 402 + PAYMENT-REQUIRED header (base64 JSON {x402Version:2, accepts[]}); retry with PAYMENT-SIGNATURE; PAYMENT-RESPONSE.
// v1: 402 + JSON body {x402Version:1, accepts[] with maxAmountRequired}; retry with X-PAYMENT; X-PAYMENT-RESPONSE.
import { getAddress, toHex, type Hex, type LocalAccount } from "viem";
import { AgentCoinError } from "./errors.ts";

export interface PaymentRequirement {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  resource?: string;
  extra?: Record<string, any>;
  x402Version: 1 | 2;
  raw: Record<string, any>;
}

export interface Parsed402 { x402Version: 1 | 2; resource?: unknown; accepts: PaymentRequirement[] }

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

/** caip2 for a network string as used in x402 v1 ("base-sepolia") or v2 ("eip155:84532"). */
export function toCaip2(network: string): string {
  if (/^eip155:[0-9]+$/.test(network)) return network;
  const m: Record<string, string> = { "base-sepolia": "eip155:84532", base: "eip155:8453", ethereum: "eip155:1", "ethereum-sepolia": "eip155:11155111", polygon: "eip155:137", "polygon-amoy": "eip155:80002", avalanche: "eip155:43114", "avalanche-fuji": "eip155:43113", arbitrum: "eip155:42161", optimism: "eip155:10" };
  return m[network] ?? network;
}

export async function parse402(res: Response): Promise<Parsed402> {
  const h = res.headers.get("payment-required");
  if (h) {
    const pr = unb64(h);
    return { x402Version: 2, resource: pr.resource, accepts: (pr.accepts ?? []).map((a: any) => norm(a, 2)) };
  }
  const body: any = await res.clone().json().catch(() => null);
  if (body && Array.isArray(body.accepts)) {
    const v = body.x402Version === 2 ? 2 : 1;
    return { x402Version: v, resource: body.resource, accepts: body.accepts.map((a: any) => norm(a, v)) };
  }
  throw new AgentCoinError("x402_unparseable", "402 response without PAYMENT-REQUIRED header or accepts[] body");
}

function norm(a: any, v: 1 | 2): PaymentRequirement {
  return { scheme: a.scheme, network: toCaip2(String(a.network)), amount: String(a.amount ?? a.maxAmountRequired), asset: a.asset, payTo: a.payTo, maxTimeoutSeconds: a.maxTimeoutSeconds, resource: a.resource, extra: a.extra, x402Version: v, raw: a };
}

const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Signs an EIP-3009 authorization for one "exact" requirement and returns the header name and value for the retry. */
export async function signExactPayment(
  account: LocalAccount, req: PaymentRequirement, parsed: Parsed402,
  { chainId, tokenName, tokenVersion, nowSeconds, nonce }: { chainId: number; tokenName: string; tokenVersion: string; nowSeconds: bigint; nonce?: Hex },
): Promise<{ header: string; value: string; nonce: Hex }> {
  const n = nonce ?? (toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex);
  const timeout = BigInt(req.maxTimeoutSeconds ?? 300);
  const authorization = { from: account.address, to: getAddress(req.payTo), value: req.amount, validAfter: String(nowSeconds - 60n), validBefore: String(nowSeconds + timeout), nonce: n };
  const signature = await account.signTypedData({
    domain: { name: req.extra?.name ?? tokenName, version: req.extra?.version ?? tokenVersion, chainId, verifyingContract: getAddress(req.asset) },
    types: AUTH_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from: authorization.from, to: authorization.to, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce: n },
  });
  if (req.x402Version === 2) {
    return { header: "PAYMENT-SIGNATURE", value: b64({ x402Version: 2, resource: parsed.resource, accepted: req.raw, payload: { signature, authorization } }), nonce: n };
  }
  return { header: "X-PAYMENT", value: b64({ x402Version: 1, scheme: req.scheme, network: req.raw.network, payload: { signature, authorization } }), nonce: n };
}

export function readPaymentResponse(res: Response): Record<string, any> | null {
  const h = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  if (!h) return null;
  try { return unb64(h); } catch { return null; }
}

export function escrowPaymentHeader(chainId: number, jobId: string, txHash: string): string {
  return b64({ x402Version: 2, accepted: { scheme: "agentcoin-escrow", network: `eip155:${chainId}` }, payload: { jobId, txHash } });
}
