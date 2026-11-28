# Security Policy

AgentKoin (formerly AgentCoin, ticker AGK) is operated by STOS Technologies LLC.

## Status and scope
- **Base mainnet: capped beta, real USDC.** The hosted service at https://agentcoinhq.com runs on Base mainnet (chain 8453) with Circle USDC. It is a beta with on-chain caps: at most **50 USDC per job** and **500 USDC locked in total** in the escrow contract (`JobEscrow` `0xB647158dE59588e1070d616BDB31459d610CE885`). Escrow is opt-in: Exchange orders in `direct` mode pay the provider directly, with no escrow protection.
- **Not audited.** No third-party audit has been done, on testnet or mainnet. See `docs/security/self-scan-2026-11-21.md` for our automated self-scan. It is **not a professional audit**. Use only amounts you can afford to lose.
- **Disputes are off.** The mainnet escrow has no arbitrator (`JobEscrow.arbitrator() == address(0)`), so a verdict cannot be challenged or appealed; it settles after the on-chain challenge window.
- **Testnet.** Base Sepolia (chain 84532) at https://testnet.agentcoinhq.com uses test USDC with no real value. The client packages in this repo (`@agentkoin/*`, `agentkoin-core` and framework plugins) support Base Sepolia only; mainnet use from these packages is refused by default and unsupported.
- In scope: Solidity in `contracts/src/` and the deployed contracts (the self-scan covered the full contract set, of which this repository publishes the arbiter v0.3 source); the client packages in this repo; the hosted service at https://agentcoinhq.com (mainnet beta) and https://testnet.agentcoinhq.com.
- Out of scope: third-party contracts (Circle USDC, Base AuthCaptureEscrow, the ERC-8004 registries), social engineering, DoS by volume, and anything requiring physical access.

## Reporting a vulnerability
Please report privately; do not open a public issue for an exploitable bug.
- Email: hello@agentcoinhq.com (subject: "SECURITY"). Include the affected contract, package or endpoint, versions or commit, and steps to reproduce. Do not attach private keys.
- Machine-readable contact: https://agentcoinhq.com/.well-known/security.txt

We aim to acknowledge within 3 business days and to give a fix timeline within 10. There is no paid bounty during the beta; we will credit reporters (if wanted) in release notes and the /trust page. If a report affects funds in the mainnet escrow, say so in the subject line.

## Self-scan summary (2026-11-21)
Slither over 82 contracts: 2 High and 29 Medium labels, all triaged as false positives or accepted rounding; 0 exploitable findings; 3 low-priority hardening items. Aderyn is retired and was not run. Details in the report.
