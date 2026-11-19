# Wallet transaction compatibility

| Browser engine | Freighter integration | Mock response profiles |
| --- | --- | --- |
| Chromium (Playwright Desktop Chrome) | `@stellar/freighter-api` 6.0.1 | Legacy unversioned and current versioned |
| Firefox (Playwright Desktop Firefox) | `@stellar/freighter-api` 6.0.1 | Legacy unversioned and current versioned |

The lockfile selects Playwright and its browser revisions. The wallet profiles
exercise the injected Freighter message protocol. Real extension releases,
browser extension installation and interactive prompts are outside this matrix.

The suite loads the production wallet and Soroban browser modules in a test
page. It connects a wallet and cancels a stream with a mocked RPC. It checks
simulation, approval, submission and confirmation. Wallet rejection and
simulation failure must prevent submission. Each browser runs each scenario
with both response profiles. RPC calls are routed to a local fixture.

```bash
npm ci --include=optional
npm exec --workspace=frontend -- playwright install --with-deps chromium firefox
npm run test:e2e:wallet --workspace=frontend
```

The **Testnet E2E** workflow remains separately scheduled and manually
dispatchable. It checks the live Stellar testnet create, withdraw and cancel
paths using a testnet contract and ephemeral credentials.
