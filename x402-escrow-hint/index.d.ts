export declare const EXTENSION_KEY: "agentcoin-escrow";
export declare const HINT_VERSION: "agentcoin-escrow-hint/v1";
export declare const DEFAULT_AGENTCOIN_URL: string;
export declare const BASE_SEPOLIA_ESCROW: Readonly<{ network: "eip155:84532"; chainId: 84532; routerUrl: string; escrowContract: `0x${string}`; evaluatorRegistry: `0x${string}`; token: `0x${string}`; evalWindowSeconds: number; challengeWindowSeconds: number; evaluatorMinStake: string }>;
export interface EscrowHintOptions { provider: string; serviceId?: string; evaluator?: string; specHash?: string; deadlineSeconds?: number; deployment?: Partial<typeof BASE_SEPOLIA_ESCROW> }
export interface EscrowHint { info: Record<string, unknown> & { v: "agentcoin-escrow-hint/v1"; escrowAvailable: true; network: "eip155:84532"; chainId: 84532 }; schema: Record<string, unknown> }
export declare function escrowHint(o: EscrowHintOptions): EscrowHint;
export declare function withEscrowHint<T extends { accepts: unknown[]; extensions?: Record<string, unknown> }>(paymentRequired: T, opts: EscrowHintOptions): T & { extensions: Record<string, unknown> & { "agentcoin-escrow": EscrowHint } };
export declare function escrowHintMiddleware(opts: EscrowHintOptions): (req: unknown, res: { statusCode: number; json?: (b: unknown) => unknown }, next: () => void) => void;
