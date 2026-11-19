# SDK

Typed client bindings for the Handsoff API.

## Wallet connector capability negotiation

Wallet connectors advertise what they can do through a stable capability
contract so applications can discover signer capabilities (supported network,
transaction format, and cancellation) before presenting an action.

```ts
import { negotiateCapabilities, type ConnectorCapabilities } from "@handsoff/sdk";

const capabilities: ConnectorCapabilities = {
  network: "testnet",
  transactionFormat: "stellar-xdr",
  cancellation: true,
};

const result = negotiateCapabilities(capabilities, {
  network: "testnet",
  transactionFormat: "stellar-xdr",
  cancellation: true,
});

if (!result.ok) {
  // Human-readable mismatch messaging, e.g.
  // "Connector does not support cancellation."
  console.warn(result.message);
}
```

### Contract

| Field               | Type                          | Notes                                                        |
| ------------------- | ----------------------------- | ------------------------------------------------------------ |
| `network`           | `string`                      | Network the connector signs for (e.g. `testnet`, `mainnet`).  |
| `transactionFormat` | `string`                      | Transaction format the connector accepts.                    |
| `cancellation`      | `boolean`                     | Whether in-flight signing can be cancelled.                  |

### Backward compatibility

Connectors that do not report capabilities are treated as `unknown` rather
than failing. Unknown values are preserved and never silently coerced into a
supported value, so negotiation against an unknown capability reports a
mismatch instead of assuming support. Existing connector interfaces remain
compatible; capability reporting is additive.

### Mismatch messaging

`negotiateCapabilities` returns `{ ok: true }` when every requested capability
is supported, or `{ ok: false, message }` describing the first unsupported
capability. Unknown connector values produce a message that names the
capability and the unknown value so callers can surface actionable guidance.
