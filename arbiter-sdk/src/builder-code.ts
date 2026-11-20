// Base Builder Code (ERC-8021, schema 0) dataSuffix helpers. Pure functions; no network.
// Layout verified 2026-11-19 against docs.base.org/specifications/builder-codes (test vector
// "baseapp" -> 0x07626173656170700080218021802180218021802180218021) and ox@0.14 erc8021 Attribution.toDataSuffix:
//   codes (ASCII, comma-joined) || codesLength (1 byte) || schemaId (1 byte, 0x00) || 0x80218021802180218021802180218021 (16 bytes)
// The suffix is appended after the ABI calldata; contracts ignore trailing calldata. Attribution is read off-chain.
import { concatHex, stringToHex, hexToString, encodeFunctionData, type Abi, type Address, type Hex } from "viem";

export const ERC8021_MARKER: Hex = "0x80218021802180218021802180218021";
/** Builder Code issued Nov 17 2026 for deployer 0x78e2...488e (per AgentCoin Research relay, Nov 19). */
export const DEFAULT_BASE_BUILDER_CODE = "bc_ta422vae";
const DISABLED_ENV = new Set(["", "none", "0"]);

function normalizeCodes(codes: string | readonly string[]): string[] {
  const list = typeof codes === "string" ? [codes] : [...codes];
  if (list.length === 0) throw new Error("builder code: at least one code required");
  for (const c of list) {
    if (c.length === 0) throw new Error("builder code: empty code");
    if (!/^[\x21-\x2b\x2d-\x7e]+$/.test(c)) throw new Error(`builder code: invalid character in ${JSON.stringify(c)} (printable ASCII, no space, no comma)`);
  }
  if (list.join(",").length > 255) throw new Error("builder code: codes exceed 255 bytes");
  return list;
}

/** ERC-8021 schema 0 suffix for one code or several. Throws on empty/invalid input. */
export function encodeBuilderCodeSuffix(codes: string | readonly string[]): Hex {
  const joined = normalizeCodes(codes).join(",");
  const codesHex = stringToHex(joined);
  const len = joined.length.toString(16).padStart(2, "0");
  return concatHex([codesHex, `0x${len}`, "0x00", ERC8021_MARKER]);
}

/** Parses a trailing schema 0 suffix from calldata; null when absent or not schema 0. */
export function decodeBuilderCodeSuffix(data: Hex): { codes: string[]; schemaId: 0; suffix: Hex } | null {
  const hex = data.slice(2).toLowerCase();
  const m = ERC8021_MARKER.slice(2);
  if (hex.length < (m.length + 4) || !hex.endsWith(m)) return null;
  const end = hex.length - m.length;
  if (hex.slice(end - 2, end) !== "00") return null;
  const len = parseInt(hex.slice(end - 4, end - 2), 16);
  const start = end - 4 - len * 2;
  if (len === 0 || start < 0) return null;
  const codes = hexToString(`0x${hex.slice(start, end - 4)}`).split(",");
  return { codes, schemaId: 0, suffix: `0x${hex.slice(start)}` };
}

/** Strict no-op (returns calldata unchanged) when code is null, undefined or "". */
export function appendBuilderCodeSuffix(calldata: Hex, code: string | readonly string[] | null | undefined): Hex {
  if (code === null || code === undefined || code === "" || (typeof code !== "string" && code.length === 0)) return calldata;
  return concatHex([calldata, encodeBuilderCodeSuffix(code)]);
}

/**
 * Resolution order: explicit string -> use it; explicit null or "" -> disabled; explicit undefined ->
 * process.env.BASE_BUILDER_CODE (unset -> DEFAULT_BASE_BUILDER_CODE; "", "none", "0" -> disabled; else the value).
 */
export function resolveBuilderCode(explicit?: string | null, env: Record<string, string | undefined> = process.env): string | null {
  if (explicit === null || explicit === "") return null;
  if (explicit !== undefined) return explicit;
  const e = env.BASE_BUILDER_CODE;
  if (e === undefined) return DEFAULT_BASE_BUILDER_CODE;
  return DISABLED_ENV.has(e.trim().toLowerCase()) ? null : e.trim();
}

/** Value for viem's `dataSuffix` option on writeContract/sendTransaction; undefined when disabled. */
export function builderDataSuffix(explicit?: string | null, env?: Record<string, string | undefined>): Hex | undefined {
  const code = resolveBuilderCode(explicit, env);
  return code === null ? undefined : encodeBuilderCodeSuffix(code);
}

/** Calldata builder for any arbiter/escrow call: ABI-encoded call plus the suffix when a code resolves. */
export function buildArbiterTx(a: { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[]; builderCode?: string | null; env?: Record<string, string | undefined> }): { to: Address; data: Hex; builderCode: string | null } {
  const code = resolveBuilderCode(a.builderCode, a.env);
  const data = encodeFunctionData({ abi: a.abi as Abi, functionName: a.functionName, args: a.args as any });
  return { to: a.address, data: appendBuilderCodeSuffix(data, code), builderCode: code };
}
