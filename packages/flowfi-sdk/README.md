# `@flowfi/sdk`

Typed TypeScript client for FlowFi — REST bindings (generated from the OpenAPI
spec) **plus** a standalone Soroban transaction builder with client-side
signing. Third-party dApps, payroll providers, and bots can talk directly to
the Stellar ledger without routing through the FlowFi backend API.

Works in both **browser** (Freighter) and **Node.js** (secret key / custom
signers).

## Quickstart (3 lines per action)

```ts
import { FlowFiClient, KeypairSigner } from '@flowfi/sdk';

const client = new FlowFiClient({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  contractId: 'C...STREAM_CONTRACT...',
});
const signer = new KeypairSigner(process.env.PAYROLL_SECRET!);

// Create → top-up → withdraw → cancel with the same client + signer.
const { streamId } = await client.createStream(
  { sender, recipient, tokenAddress, amount: 1_000_000n, duration: 3600 },
  signer,
);
await client.topUpStream(streamId, 500_000n, signer);
await client.batchWithdraw([streamId], signer);
await client.cancelStream(streamId, signer);
```

Browser (Freighter):

```ts
import { FlowFiClient, FreighterSigner } from '@flowfi/sdk';

const client = new FlowFiClient({ rpcUrl, networkPassphrase, contractId });
const signer = new FreighterSigner();
await client.createStream({ sender, recipient, tokenAddress, amount: 100n, duration: 60 }, signer);
```

Custom wallet (WalletConnect / hardware):

```ts
import { FlowFiClient, CustomSigner } from '@flowfi/sdk';

const signer = new CustomSigner(publicKey, async (envelopeXdr) => wallet.sign(envelopeXdr));
```

Reads need no signer:

```ts
const stream = await client.getStream(1n); // null when pruned via close_stream
const claimable = await client.getClaimableAmount(1n);
```

## Real-Time Events

`FlowFiEventClient` is an optional, framework-independent SSE client. It parses
the `/v1/events/subscribe` event frames, exposes named events and lifecycle
callbacks, and resumes with `Last-Event-ID` when the server supplies an SSE ID.

```ts
import { FlowFiEventClient } from '@flowfi/sdk';

const events = new FlowFiEventClient('https://api.flowfi.io/v1/events/subscribe', {
  headers: { Authorization: `Bearer ${token}` },
});
events.on('stream.created', ({ data, lastEventId }) => console.log(data, lastEventId));
events.onLifecycle('reconnect', ({ attempt, delayMs }) => console.log(attempt, delayMs));
events.connect();
// events.close();
```

## Cancellation

SDK read and write methods accept a final `{ signal, timeoutMs }` options
argument. The timeout applies to the complete operation; aborting while a
wallet approval is pending rejects the operation and prevents later submission.
The wallet extension may still display its own approval prompt until it is
dismissed.

```ts
const controller = new AbortController();
await client.createStream(params, signer, { signal: controller.signal, timeoutMs: 30_000 });
```

## Testnet Smoke Suite

This suite is separate from the default unit tests and never submits a
transaction. Configure all values for an existing testnet deployment and a
funded source account before running it:

```bash
FLOWFI_TESTNET_RPC_URL=https://soroban-testnet.stellar.org \
FLOWFI_TESTNET_CONTRACT_ID=C... \
FLOWFI_TESTNET_SOURCE_SECRET=S... \
FLOWFI_TESTNET_STREAM_ID=1 \
npm run test:smoke:testnet
```

It builds and simulates a generated contract-call envelope, signs it locally,
then exercises `getStream` and `getClaimableAmount` against that deployment.
Keep the source secret in your local environment or secret manager; it is never
printed by the suite.

## Architecture

| File | Responsibility |
|---|---|
| `src/client.ts` | `FlowFiClient`: `createStream`, `batchWithdraw`, `topUpStream`, `cancelStream`, `closeStream`, `getStream`, `getClaimableAmount` |
| `src/builder.ts` | Unsigned envelope builders + `simulateTransaction` assembly + fee-buffer padding |
| `src/signers/index.ts` | `FreighterSigner` (browser), `KeypairSigner` (Node daemon), `CustomSigner` (WalletConnect/HW) |
| `src/types.ts` | Shared `bigint`-safe DTOs |

### Simulation & fee padding

Every write path runs:

1. Build unsigned envelope (`builder.ts`).
2. `simulateTransaction` on the Soroban RPC → attaches footprint keys + auth entries.
3. `assembleTransaction` merges simulation side-effects.
4. `applyFeeBuffer(minFee, multiplier)` adds a configurable safety margin (default 25%).
5. `signer.signTransaction(assembledXdr)` → `sendTransaction`.

Reads (`getStream`, `getClaimableAmount`) never sign or submit.

## Regenerating (REST bindings)

The REST client is generated from the committed OpenAPI spec and lives
alongside `src/`:

```bash
./scripts/generate-sdk.sh
```

What it does:

1. Reads `backend/swagger/flowfi.openapi.json`.
2. Runs [openapi-generator]'s `typescript-fetch` generator via
   `@openapitools/openapi-generator-cli` (Java required on first run).
3. Writes the typed client into `packages/flowfi-sdk/`.

Keep the spec fresh before regenerating:

```bash
cd backend && npm run codegen:openapi
```

## Using the REST SDK

```ts
import { StreamsApi, Configuration } from '@flowfi/sdk';

const api = new StreamsApi(new Configuration({ basePath: 'https://api.flowfi.io/v1' }));
const { data } = await api.getStream(1);
```

## Testing

```bash
cd packages/flowfi-sdk && npm test
```

`tests/client.test.ts` covers builders, simulation assembly, fee padding, all
three signers, and every `FlowFiClient` method with mocked RPC/signer shims
(no network I/O).

[openapi-generator]: https://openapi-generator.tech/