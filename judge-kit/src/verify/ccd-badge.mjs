// Verified by Concordium badge check for evaluator accountability (stretch). Read-only HTTP GET against the public Agent Registry REST.
// Endpoint shape: VERIFIED against the published OpenAPI (https://agent-registry-mcp.concordium.com/openapi.json, fetched 2026-11-20)
// and one live read-only call with a mainnet badge: GET /v1/check-badge/{badge} -> {badge_valid, checks{status_active, hash_matches_on_chain,
// card_fetched, ...}, on_chain{owner_account, status, metadata_hash_hex, agent_uri}, token_address, agent_uri, card_sha256, issues[]}.
// `network` query param is an override only (network is resolved from the badge).
// NOT verified: a TESTNET badge response (none exists for us yet) and whether agent cards list EVM evaluator addresses in a fixed field,
// so the evaluator-address binding is a plain case-insensitive search of the card JSON for the address.
export const DEFAULT_REGISTRY = "https://agent-registry-mcp.concordium.com";

export async function checkBadge({ badge, evaluator = null, base = DEFAULT_REGISTRY, network = null, fetchImpl = fetch, timeoutMs = 20000 }) {
  const id = "evaluator-badge";
  const meta = { id, claim: "the evaluator is backed by a Verified by Concordium badge whose Agent Card lists the evaluator address", how: "GET {registry}/v1/check-badge/{badge}: require badge_valid, Active status, card hash == on-chain metadata_hash; fetch the card and require it to contain the evaluator address" };
  const skip = (reason) => ({ ...meta, expected: null, actual: null, status: "skip", reason });
  const fail = (reason, expected = null, actual = null) => ({ ...meta, expected, actual, status: "fail", reason });
  if (!badge) return skip("no Concordium Agent Registry badge for this evaluator");
  let r;
  try {
    const res = await fetchImpl(`${base}/v1/check-badge/${encodeURIComponent(badge)}${network ? `?network=${network}` : ""}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 400) return skip("registry does not recognise this badge (HTTP 400)");
    if (!res.ok) return skip(`registry answered HTTP ${res.status}`);
    r = await res.json();
  } catch (e) { return skip("could not reach the Concordium Agent Registry: " + String(e.message ?? e).slice(0, 100)); }
  if (r?.badge_valid === undefined || !r?.on_chain) return skip("unrecognised registry response shape");
  const active = r.on_chain.status === "Active" && r.checks?.status_active !== false;
  const hashOk = r.checks?.hash_matches_on_chain === true && !!r.card_sha256 && r.card_sha256 === r.on_chain.metadata_hash_hex;
  if (!r.badge_valid || !active || !hashOk) return fail("badge is not valid, not Active, or the served card does not match the on-chain hash", { badge_valid: true, status: "Active", hash_matches_on_chain: true }, { badge_valid: r.badge_valid, status: r.on_chain.status, hash_matches_on_chain: r.checks?.hash_matches_on_chain });
  if (evaluator) {
    let text;
    try {
      const cr = await fetchImpl(r.agent_uri ?? r.on_chain.agent_uri, { signal: AbortSignal.timeout(timeoutMs) });
      text = await cr.text();
    } catch (e) { return skip("badge valid, but the Agent Card could not be fetched to bind the evaluator address: " + String(e.message ?? e).slice(0, 80)); }
    // the registry already hashed these bytes; re-hash here so the binding is to exactly what the chain commits to
    const { createHash } = await import("node:crypto");
    if (createHash("sha256").update(text).digest("hex") !== r.on_chain.metadata_hash_hex) return fail("fetched Agent Card does not hash to the on-chain metadata_hash");
    if (!text.toLowerCase().includes(String(evaluator).toLowerCase())) return fail("the badge's Agent Card does not list this evaluator address", evaluator, null);
  }
  return { ...meta, expected: { badge, evaluator }, actual: { owner: r.on_chain.owner_account, status: r.on_chain.status }, status: "pass" };
}
