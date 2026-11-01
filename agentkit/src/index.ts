// AgentCoin action provider for Coinbase AgentKit (TypeScript).
// Uses the AgentKit EVM wallet provider as the signer. Refuses networks other than Base Sepolia (84532).
import { ActionProvider, WalletProvider, type Action, type EvmWalletProvider, type Network } from "@coinbase/agentkit";
import { z } from "zod";
import { toAccount } from "viem/accounts";
import { encodeFunctionData, type Hex } from "viem";
import { AgentCoin, AgentCoinError, assertChainAllowed, runTool, toolSpecs, toZodObject, type AgentCoinOptions } from "@agentcoin/core";

export type AgentCoinActionOptions = Omit<AgentCoinOptions, "account" | "walletClient" | "publicClient" | "chainId"> & {
  /** Action-name prefix. Default "AgentCoinActionProvider_". */
  prefix?: string;
  /** Subset of tools. Default: all seven. */
  tools?: string[];
};

/** AgentCoin client bound to an AgentKit EVM wallet provider. */
export function clientFromWalletProvider(wp: EvmWalletProvider, o: AgentCoinActionOptions = {}): AgentCoin {
  const net = wp.getNetwork();
  const chainId = Number(net.chainId);
  assertChainAllowed(chainId, o.allowMainnet ?? false);
  if (chainId !== 84532) throw new AgentCoinError("wrong_network", `wallet provider network ${net.networkId ?? net.chainId} is not base-sepolia (84532)`);
  const address = wp.getAddress() as Hex;
  const account = toAccount({
    address,
    signMessage: async ({ message }) => wp.signMessage(typeof message === "string" ? message : (message as any).raw),
    signTypedData: async (td) => wp.signTypedData(td),
    signTransaction: async (tx) => wp.signTransaction(tx as any),
  });
  const walletClient = {
    sendTransaction: async (tx: any) => wp.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n }),
    writeContract: async (tx: any) => wp.sendTransaction({ to: tx.address, data: encodeFunctionData({ abi: tx.abi, functionName: tx.functionName, args: tx.args }), value: 0n }),
  };
  const pc = wp.getPublicClient();
  return new AgentCoin({ ...o, chainId, account, walletClient: walletClient as any, publicClient: pc as any });
}

/**
 * AgentKit ActionProvider exposing find_service, route_task, place_order, get_order, claim_listing, verify, refund.
 * Action names follow the AgentKit convention <ProviderClass>_<action>, e.g. AgentCoinActionProvider_place_order.
 * supportsNetwork: Base Sepolia (chainId 84532) only.
 */
export class AgentCoinActionProvider extends ActionProvider<EvmWalletProvider> {
  private readonly o: AgentCoinActionOptions;
  constructor(o: AgentCoinActionOptions = {}) {
    super("agentcoin", []);
    this.o = o;
  }
  supportsNetwork(network: Network): boolean {
    return network.protocolFamily === "evm" && String(network.chainId) === "84532";
  }
  getActions(wp: EvmWalletProvider): Action[] {
    const prefix = this.o.prefix ?? "AgentCoinActionProvider_";
    return toolSpecs.filter((t) => !this.o.tools || this.o.tools.includes(t.name)).map((t) => {
      const schema = toZodObject(z, t.parameters);
      return {
        name: prefix + t.name,
        description: t.description,
        schema,
        invoke: async (args: any) => {
          try {
            const parsed = schema.parse(args ?? {});
            return JSON.stringify(await runTool(clientFromWalletProvider(wp, this.o), t.name, parsed), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
          } catch (e: any) {
            return JSON.stringify({ error: e?.code ?? (e?.name === "ZodError" ? "invalid_args" : "error"), message: String(e?.message ?? e) });
          }
        },
      };
    });
  }
}

export const agentcoinActionProvider = (o: AgentCoinActionOptions = {}) => new AgentCoinActionProvider(o);

/**
 * AgentKit's WalletProvider constructor posts an "agent_initialization" analytics event (wallet address, network)
 * to https://cca-lite.coinbase.com/amp. This replaces that method with a no-op for every wallet provider constructed
 * afterwards in this process. Call it before constructing the wallet provider.
 */
export function disableAgentKitAnalytics(): void {
  (WalletProvider.prototype as any).trackInitialization = function () {};
}
