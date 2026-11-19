# Browser, wallet, and network compatibility

FlowFi integrates with Freighter. The table records the evidence for each combination and the limits of that evidence. Browser and extension versions verified manually should be recorded with the release commit, date, network, and result.

| Browser | Wallet | Network | Evidence and coverage |
| --- | --- | --- | --- |
| Playwright desktop Chromium and Firefox | Freighter API shim | Mock Testnet | Both engines are configured in [Playwright](../frontend/playwright.config.ts). The [connection](../frontend/e2e/wallet-connection.spec.ts), [transaction behavior](../frontend/e2e/wallet-transactions-lifecycle.spec.ts), and [stream lifecycle](../frontend/e2e/stream-lifecycle.spec.ts) specs exercise the app against mocked services. This covers browser behavior without installing the real extension. |
| Desktop browser with Freighter installed | Real Freighter | Stellar Testnet | This is the manual release verification target. The [Testnet E2E workflow](../.github/workflows/testnet-e2e.yml) exercises contract calls and indexer ingestion against live Testnet with programmatically signed transactions. Record a browser and extension smoke result before claiming this full combination is verified. |
| Any browser with a working Freighter installation | Real Freighter | Mainnet or Futurenet | The [network configuration](../frontend/src/lib/stellar-config.ts) defines these networks. Browser plus extension plus live transactions have no automated evidence here. A deployed contract and corresponding app and wallet network are required. |
| Local development browser | Development setup | Local Sandbox | The [sandbox runbook](../backend/docs/SANDBOX_MODE.md) describes the local setup. The mock Testnet suite and live Testnet workflow provide no browser-wallet certification for Sandbox. |
| Safari/WebKit, mobile browsers, and unlisted desktop versions | Any | Any | The configured [browser suite](../frontend/playwright.config.ts) does not cover these environments. Treat them as unverified. |
| Any | Wallets other than Freighter | Any | The [wallet registry and connection guard](../frontend/src/lib/wallet.ts) restrict integration to Freighter. The [wallet tests](../frontend/src/lib/wallet.test.ts) exercise the unsupported-wallet error. |

## What users see

The wallet chooser offers Freighter. If it is absent, the connection error directs the user to install it. A rejected connection prompts the user to try again when ready. A wallet on a different network produces a banner naming the wallet and app networks and offering reconnection. Select the same network in both places, then reconnect. A missing deployment can surface as a contract-not-deployed error. See [troubleshooting](TROUBLESHOOTING.md).

The app provides no browser-version gate. For an unverified browser or device, reproduce the problem on desktop Chromium or Firefox with Freighter and report both version numbers and the network.

## Manual Testnet verification

1. Record the build commit, OS, browser version, Freighter version, Testnet deployment, and UTC time. Use a funded test wallet with no production funds.
2. Connect, reject a signing request, then retry. Switch Freighter to another network and verify the banner. Switch back and reconnect.
3. Create a stream, withdraw from the recipient account, and cancel from the sender account. Confirm each successful transaction on Testnet and verify the indexed status. Save a pass or fail result and non-sensitive evidence for each step.
