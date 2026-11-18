# Contributing

This repository holds AgentKoin (formerly AgentCoin) client libraries and framework plugins, published to npm (`@agentkoin/*`) and PyPI (`agentkoin-core` and the framework packages) with Base Sepolia testnet defaults. The workspace root package stays private and is not published.

## Build and test

```
npm install && npm run build && npm test
cd python && VIRTUAL_ENV=.venv uv pip install pytest && .venv/bin/pytest
```

Tests use a mocked router and mocked chain clients: no network and no keys. Live examples under `examples/` are opt-in and talk to the Base Sepolia testnet service at https://agentcoinhq.com; they are not part of `npm test` or `pytest`.

## Changes

- Keep packages MIT-licensed, copyright STOS Technologies LLC, with testnet defaults. Do not publish the workspace root package.
- Do not commit keys, `.env` files, or secret material.
- Do not point defaults at mainnet. `allowMainnet` / `allow_mainnet` stays off and unsupported.
- Do not add persuasive or instruction-shaped text to machine-facing metadata or listings.

## License

By contributing, you agree that your contribution is licensed under the MIT License in `LICENSE` (Copyright (c) 2026 STOS Technologies LLC).
