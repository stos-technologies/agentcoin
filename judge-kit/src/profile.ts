#!/usr/bin/env node
// AgentKoin judge kit: sign an evaluator profile (agentkoin-evaluator-profile/v1) and POST it to /v1/evaluators/profile.
// Signature: EIP-191 personal_sign over the 32 raw bytes of keccak256(JCS(profile without "signature")).
// --dry-run prints the signed payload and sends nothing. Output: one JSON object on stdout. The key is never printed.
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { keccak256, toBytes, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { jcs, j } from "./lib.ts";

export const PROFILE_TYPE = "agentkoin-evaluator-profile/v1";
export const DEFAULT_REGISTRY = "0x30576DE005df028D1947C56dEcc85a2a5612036a";
export const DEFAULT_SERVICE = "https://agentcoinhq.com";

export type Profile = {
  type: string; chainId: number; registry: string; address: string; name: string; issuedAt: number;
  url?: string; contact?: string; verdictEndpoint?: string; criteriaKinds?: string[]; signature?: Hex;
};

export const profileDigest = (p: Profile): Hex => {
  const { signature: _s, ...unsigned } = p;
  return keccak256(toBytes(jcs(unsigned)));
};

export async function signProfile(key: Hex, f: Omit<Profile, "type" | "address" | "signature" | "issuedAt"> & { issuedAt?: number }): Promise<Profile> {
  const acct = privateKeyToAccount(key);
  const p: Profile = { type: PROFILE_TYPE, chainId: f.chainId, registry: getAddress(f.registry), address: acct.address, name: f.name, issuedAt: f.issuedAt ?? Math.floor(Date.now() / 1000) };
  for (const k of ["url", "contact", "verdictEndpoint", "criteriaKinds"] as const) if (f[k] !== undefined) (p as Record<string, unknown>)[k] = f[k];
  const digest = profileDigest(p);
  return { ...p, signature: await acct.signMessage({ message: { raw: digest } }) };
}

export async function main(): Promise<number> {
  const { values: a } = parseArgs({
    args: process.argv.slice(2).filter((x, i) => !(i === 0 && x === "profile")),
    options: {
      key: { type: "string" }, "key-file": { type: "string" },
      name: { type: "string" }, url: { type: "string" }, contact: { type: "string" },
      "verdict-endpoint": { type: "string" }, "criteria-kinds": { type: "string" },
      registry: { type: "string", default: process.env.JUDGE_REGISTRY ?? DEFAULT_REGISTRY },
      "chain-id": { type: "string", default: "84532" },
      service: { type: "string", default: process.env.JUDGE_SERVICE_URL ?? DEFAULT_SERVICE },
      "issued-at": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (a.help) { console.log("usage: node src/profile.ts --key <file> --name <name> [--url https://..] [--contact text] [--verdict-endpoint https://..] [--criteria-kinds a,b] [--service url] [--dry-run]"); return 0; }
  const keyFile = a.key ?? a["key-file"];
  const raw = keyFile ? (await readFile(keyFile, "utf8")).trim() : process.env.JUDGE_PRIVATE_KEY?.trim();
  if (!raw) { console.error("need --key <file> or JUDGE_PRIVATE_KEY"); return 2; }
  if (!a.name) { console.error("need --name"); return 2; }
  const profile = await signProfile((raw.startsWith("0x") ? raw : "0x" + raw) as Hex, {
    chainId: Number(a["chain-id"]), registry: a.registry!, name: a.name,
    ...(a.url ? { url: a.url } : {}), ...(a.contact ? { contact: a.contact } : {}),
    ...(a["verdict-endpoint"] ? { verdictEndpoint: a["verdict-endpoint"] } : {}),
    ...(a["criteria-kinds"] ? { criteriaKinds: a["criteria-kinds"].split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    ...(a["issued-at"] ? { issuedAt: Number(a["issued-at"]) } : {}),
  });
  const endpoint = new URL("/v1/evaluators/profile", a.service).toString();
  if (a["dry-run"]) { console.log(j({ event: "profile", action: "dry-run", endpoint, digest: profileDigest(profile), payload: profile })); return 0; }
  const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(profile) });
  const text = await r.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch {}
  console.log(j({ event: "profile", action: "sent", endpoint, httpStatus: r.status, digest: profileDigest(profile), response: body }));
  return r.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
