// Local mock of the Stripe endpoints used here. NOT Stripe: error codes and extra fields are invented for tests only.
// transaction_verification is checked against a local chain: the tx must contain a USDC Transfer to a known deposit address.
import http from "node:http";
import { createPublicClient, http as vhttp, parseAbiItem, parseEventLogs, type Address, type Hex } from "viem";

export type MockStripe = { url: string; requests: { path: string; headers: http.IncomingHttpHeaders; form: Record<string, string> }[]; depositAddresses: string[]; close: () => Promise<void> };
const transferEvt = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export async function startMockStripe(o: { rpcUrl: string; usdc: Address; knownDeposit?: Address; port?: number; failVerification?: boolean }): Promise<MockStripe> {
  const pc = createPublicClient({ transport: vhttp(o.rpcUrl) });
  const requests: MockStripe["requests"] = [];
  const deposits: string[] = o.knownDeposit ? [o.knownDeposit.toLowerCase()] : [];
  const idem = new Map<string, { status: number; body: any }>();
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()).entries());
    const path = req.url ?? ""; requests.push({ path, headers: req.headers, form });
    const send = (status: number, body: any) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (!String(req.headers.authorization ?? "").startsWith("Basic ")) return send(401, { error: { type: "invalid_request_error", message: "no key" } });
    if (path === "/v1/crypto/deposit_addresses" && form.network === "base") {
      const address = `0x${(0xde9051n + BigInt(++n)).toString(16).padStart(40, "0")}`;
      deposits.push(address);
      return send(200, { id: `cda_mock_${n}`, object: "crypto.deposit_address", address, network: "base" });
    }
    if (path === "/v1/payment_intents") {
      const key = String(req.headers["idempotency-key"] ?? "");
      if (key && idem.has(key)) { const r = idem.get(key)!; return send(r.status, r.body); }
      const reply = (status: number, body: any) => { if (key) idem.set(key, { status, body }); send(status, body); };
      const tx = form["payment_method_options[crypto][transaction_verification_options][transaction_hash]"] as Hex;
      const bad = (message: string) => reply(400, { error: { type: "invalid_request_error", code: "mock_verification_failed", message } });
      if (form["payment_method_options[crypto][mode]"] !== "transaction_verification" || !tx) return bad("not transaction_verification");
      if (o.failVerification) return bad("forced failure");
      try {
        const r = await pc.getTransactionReceipt({ hash: tx });
        const logs = parseEventLogs({ abi: [transferEvt], logs: r.logs }).filter((l) => l.address.toLowerCase() === o.usdc.toLowerCase() && deposits.includes(l.args.to.toLowerCase()));
        if (!logs.length) return bad("no USDC transfer to a deposit address in tx");
        // Exact whole-cent match on one transfer: no flooring, no summing (1 cent = 10_000 atomic USDC).
        const invalidAmount = (message: string) => reply(400, { error: { type: "invalid_request_error", code: "invalid_amount", message } });
        if (!/^[1-9][0-9]*$/.test(String(form.amount ?? ""))) return invalidAmount(`amount must be a positive integer of cents, got ${form.amount}`);
        const requested = BigInt(form.amount) * 10_000n;
        const whole = (v: bigint) => v >= 10_000n && v % 10_000n === 0n;
        if (!logs.some((l) => l.args.value === requested)) {
          const odd = logs.find((l) => !whole(l.args.value));
          if (odd) return invalidAmount(`non-whole-cent USDC transfer: ${odd.args.value} atomic`);
          return invalidAmount(`amount mismatch: chain ${logs.map((l) => `${l.args.value / 10_000n}`).join("+")} cents, request ${form.amount}`);
        }
        return reply(200, { id: `pi_mock_${tx.slice(2, 14)}`, object: "payment_intent", status: "succeeded", amount: Number(form.amount), currency: form.currency, metadata: Object.fromEntries(Object.entries(form).filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])) });
      } catch (e: any) { return bad(`tx not found: ${e.shortMessage ?? e.message}`); }
    }
    send(404, { error: { type: "invalid_request_error", message: "unknown mock path" } });
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, requests, depositAddresses: deposits, close: () => new Promise((r) => server.close(() => r())) };
}
