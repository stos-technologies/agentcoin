import { AgentCoin, type AgentCoinOptions } from "./client.ts";
import { agentcoinUrl } from "./constants.ts";

/**
 * Client from environment variables:
 * AGENTCOIN_PRIVATE_KEY (0x hex, optional; read-only without it), AGENTCOIN_URL (legacy alias AGENTCOIN_BASE_URL), AGENTCOIN_CHAIN_ID (default 84532),
 * AGENTCOIN_RPC_URL, AGENTCOIN_MAX_PAYMENT (USDC base units), AGENTCOIN_ALLOWED_SERVICE_IDS (comma-separated), AGENTCOIN_ORIGIN.
 */
export function fromEnv(overrides: AgentCoinOptions = {}, env: Record<string, string | undefined> = process.env): AgentCoin {
  const pk = env.AGENTCOIN_PRIVATE_KEY;
  return new AgentCoin({
    ...(pk ? { account: pk as `0x${string}` } : {}),
    baseUrl: agentcoinUrl(env),
    ...(env.AGENTCOIN_CHAIN_ID ? { chainId: Number(env.AGENTCOIN_CHAIN_ID) } : {}),
    ...(env.AGENTCOIN_RPC_URL ? { rpcUrl: env.AGENTCOIN_RPC_URL } : {}),
    ...(env.AGENTCOIN_MAX_PAYMENT ? { maxPayment: env.AGENTCOIN_MAX_PAYMENT } : {}),
    ...(env.AGENTCOIN_ALLOWED_SERVICE_IDS ? { allowedServiceIds: env.AGENTCOIN_ALLOWED_SERVICE_IDS.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    ...(env.AGENTCOIN_ORIGIN === "agentcoin" ? { origin: "agentcoin" as const } : {}),
    ...overrides,
  });
}

/** Accepts an AgentCoin client, client options, or nothing (reads AGENTCOIN_* env vars). */
export function asClient(x?: AgentCoin | AgentCoinOptions): AgentCoin {
  if (x instanceof AgentCoin || (x && typeof (x as any).findService === "function" && typeof (x as any).placeOrder === "function")) return x as AgentCoin;
  return fromEnv(x ?? {});
}
