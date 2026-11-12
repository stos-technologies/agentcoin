// Deployment constants for the AgentCoin v0.5 router on Base Sepolia (chainId 84532).
// Source: docs/QUICKSTART-AGENTS.md and deployments/base-sepolia.json in the AgentCoin router repo (deployments/base-sepolia.json here is a public subset).
/** Default AgentCoin service URL (Base Sepolia testnet router). The only place the URL is defined in TS; override with AGENTCOIN_URL. */
export const DEFAULT_AGENTCOIN_URL = "https://agentcoinhq.com";

/** Service URL: AGENTCOIN_URL, else legacy AGENTCOIN_BASE_URL, else DEFAULT_AGENTCOIN_URL. Trailing slashes removed. */
export function agentcoinUrl(env: Record<string, string | undefined> | undefined = (globalThis as any).process?.env): string {
  return (env?.AGENTCOIN_URL || env?.AGENTCOIN_BASE_URL || DEFAULT_AGENTCOIN_URL).replace(/\/+$/, "");
}

export const BASE_SEPOLIA = {
  chainId: 84532,
  caip2: "eip155:84532",
  x402NetworkV1: "base-sepolia",
  rpcUrl: "https://sepolia.base.org",
  explorer: "https://sepolia.basescan.org",
  routerUrl: DEFAULT_AGENTCOIN_URL,
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  usdcEip712: { name: "USDC", version: "2" },
  escrow: "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D",
  operatorSigner: "0xf1b27b5Bd659D9Bfb4835777E64B8F8e5C3eCf68",
} as const;

/** Chain ids treated as mainnet (real value). Refused unless allowMainnet is set; mainnet is unsupported in v0.1. */
export const MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([1, 8453, 10, 137, 42161, 43114, 56, 324, 59144, 534352, 7777777, 81457, 100, 250, 1101, 5000, 130, 480, 146, 2741]);

/** Default per-order payment ceiling: 50000 base units = 0.05 test USDC. */
export const DEFAULT_MAX_PAYMENT = 50_000n;

export const ESCROW_STATES = ["None", "Open", "Funded", "Submitted", "Completed", "Rejected", "Partial", "Disputed", "Settled", "Expired", "Cancelled"] as const;
export type EscrowState = (typeof ESCROW_STATES)[number];

export const ESCROW_ABI = [
  { type: "function", name: "createAndFundFor", stateMutability: "nonpayable", inputs: [{ name: "client", type: "address" }, { name: "provider", type: "address" }, { name: "evaluator", type: "address" }, { name: "amount", type: "uint256" }, { name: "deadline", type: "uint64" }, { name: "specHash", type: "bytes32" }], outputs: [{ name: "jobId", type: "uint256" }] },
  { type: "function", name: "claimRefund", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { type: "function", name: "timeoutRelease", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { type: "function", name: "finalize", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  {
    type: "function", name: "getJob", stateMutability: "view", inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: [
      { name: "client", type: "address" }, { name: "provider", type: "address" }, { name: "evaluator", type: "address" }, { name: "configVersion", type: "uint32" },
      { name: "state", type: "uint8" }, { name: "outcome", type: "uint8" }, { name: "accepted", type: "bool" }, { name: "instant", type: "bool" }, { name: "payoutBps", type: "uint16" },
      { name: "deadline", type: "uint64" }, { name: "submittedAt", type: "uint64" }, { name: "verdictAt", type: "uint64" }, { name: "disputedAt", type: "uint64" },
      { name: "amount", type: "uint256" }, { name: "providerBond", type: "uint256" }, { name: "slashBase", type: "uint256" }, { name: "specHash", type: "bytes32" }, { name: "deliverableHash", type: "bytes32" }, { name: "reasonHash", type: "bytes32" },
    ] }],
  },
  { type: "event", name: "JobCreated", anonymous: false, inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "client", type: "address", indexed: true }, { name: "provider", type: "address", indexed: true }, { name: "evaluator", type: "address", indexed: false }, { name: "amount", type: "uint256", indexed: false }, { name: "deadline", type: "uint64", indexed: false }, { name: "specHash", type: "bytes32", indexed: false }, { name: "configVersion", type: "uint32", indexed: false }] },
] as const;
