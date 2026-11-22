# Security Policy

AgentKoin (formerly AgentCoin, ticker AGK) is operated by STOS Technologies LLC.

## Status and scope
- **Testnet only.** Contracts are deployed on Base Sepolia (chain 84532) and use test USDC with no real value. Mainnet is not supported.
- **Not audited.** No third-party audit has been done. See `docs/security/self-scan-2026-11-21.md` for our automated self-scan. It is **not a professional audit**.
- In scope: Solidity in `contracts/src/` and the deployments listed in `deployments/` (the self-scan covered the full contract set, of which this repository publishes the arbiter v0.3 source); the client packages in this repo (`@agentkoin/*`, `agentkoin-core` and framework plugins); the hosted service at https://agentcoinhq.com (testnet).
- Out of scope: third-party contracts (Base AuthCaptureEscrow, Circle test USDC), social engineering, DoS by volume, and anything requiring physical access.

## Reporting a vulnerability
Please report privately; do not open a public issue for an exploitable bug.
- Email: hello@agentcoinhq.com (subject: "SECURITY"). Include the affected package or endpoint, versions or commit, and steps to reproduce. Do not attach private keys.
We aim to acknowledge within 3 business days and to give a fix timeline within 10. There is no paid bounty while we are testnet-only; we will credit reporters (if wanted) in release notes and the /trust page.

## Self-scan summary (2026-11-21)
Slither over 82 contracts: 2 High and 29 Medium labels, all triaged as false positives or accepted rounding; 0 exploitable findings; 3 low-priority hardening items. Aderyn is retired and was not run. Details in the report.

## Before any mainnet use
A professional audit, a capped beta, and the owner's explicit approval are all required.
