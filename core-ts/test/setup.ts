import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AgentCoin } from "../src/index.ts";
import { makeMock, BASE } from "./mock.ts";
export function mockClient(mo: any = {}, co: any = {}) {
  const pk = generatePrivateKey();
  const m = makeMock(privateKeyToAccount(pk).address, mo);
  const client = new AgentCoin({ baseUrl: BASE, account: pk, fetch: m.fetch, publicClient: m.publicClient, walletClient: m.walletClient, pollIntervalMs: 1, ...co });
  return { m, client };
}
