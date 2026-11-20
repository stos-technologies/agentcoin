#!/usr/bin/env node
// agentkoin-judge-kit CLI: dispatches to judge | watch | profile | verify. Base Sepolia (84532) testnet only.
const USAGE = [
  "usage: agentkoin-judge-kit <command> [options]",
  "commands:",
  "  judge    evaluate Submitted jobs and simulate/send verdictScheduled (default dry-run)",
  "  watch    read-only evalWindow watcher and evaluator health",
  "  verify   <jobId> re-check a job (escrow, payment path, criteria, receipt, verdict, settlement) against a Base Sepolia RPC; read-only",
  "  profile  sign an agentkoin-evaluator-profile/v1 and POST it (--dry-run prints it, sends nothing)",
  "  <command> --help for options",
  "network: Base Sepolia (eip155:84532), testnet only",
].join("\n");

const cmd = process.argv[2];
if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(USAGE);
  process.exit(0);
}
if (!["judge", "watch", "profile", "verify"].includes(cmd)) {
  console.error(`unknown command: ${cmd}\n${USAGE}`);
  process.exit(2);
}
process.argv.splice(2, 1);
if (cmd === "verify") {
  const { main } = await import("./verify/cli.mjs");
  process.exit(await main(process.argv.slice(2)));
} else if (cmd === "profile") {
  const { main } = await import("./profile.ts");
  process.exit(await main());
} else if (cmd === "judge") {
  await import("./judge.ts");
} else {
  await import("./watch.ts");
}
