# Security Policy

This is the canonical security policy for FlowFi. It defines how vulnerabilities are reported, which versions are supported, and the responsible disclosure process. For contributors and administrators setting up repository security features, see [SECURITY_IMPLEMENTATION_SUMMARY.md](SECURITY_IMPLEMENTATION_SUMMARY.md). For the GitHub setup checklist, see [.github/SECURITY_SETUP_CHECKLIST.md](.github/SECURITY_SETUP_CHECKLIST.md).

## Supported Versions

We actively support the following versions of FlowFi with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take the security of FlowFi seriously. If you discover a security vulnerability, we appreciate your help in disclosing it to us in a responsible manner.

### How to Report

**Please do not report security vulnerabilities through public GitHub issues.**

The preferred and fastest way to report a vulnerability is **GitHub Security Advisories**:

1. Go to the [Security tab](https://github.com/LabsCrypt/flowfi/security) of this repository.
2. Click **"Report a vulnerability"** (or use the direct link: [Report a vulnerability](https://github.com/LabsCrypt/flowfi/security/advisories/new)).
3. Fill in the private advisory form with as much detail as possible (see "What to Include" below).

This opens a private channel between you and the maintainers — nothing is visible publicly until we agree on a disclosure timeline.

If you cannot use GitHub Security Advisories for any reason, you may instead reach out to the maintainers directly through the [community Telegram](https://t.me/+DOylgFv1jyJlNzM0) and request a private contact, or send a message via GitHub Discussions asking to be contacted privately (do not include vulnerability details in the public message).

### What to Include

Please include the following information in your report:

- **Description**: A clear description of the vulnerability
- **Impact**: The potential impact and severity of the issue
- **Reproduction**: Step-by-step instructions to reproduce the vulnerability
- **Environment**: Affected versions, operating systems, or configurations
- **Proof of Concept**: If applicable, include a minimal proof of concept
- **Suggested Fix**: If you have ideas about how to fix the issue

### Response Timeline

We are committed to responding to security reports promptly:

- **Initial Response**: Within 48 hours of receiving your report
- **Status Update**: Within 7 days with our assessment and planned timeline
- **Resolution**: We aim to resolve critical vulnerabilities within 30 days

These targets apply to every reporting channel — private GitHub Security Advisories and non-sensitive public reports filed with the [security issue template](.github/ISSUE_TEMPLATE/security.md), which restates the same timeline. If you update one, update the other so they do not drift.

If you have not heard from us within 48 hours, please reach out through our [community Telegram](https://t.me/+DOylgFv1jyJlNzM0).

### Disclosure Policy

- We follow responsible disclosure practices
- We will work with you to understand and resolve the issue before any public disclosure
- We will credit you in our security advisory (unless you prefer to remain anonymous)
- We ask that you do not publicly disclose the vulnerability until we have had a chance to address it

## Key Lifecycle Decision Matrix

This section documents who owns each key, who is responsible for signing, and how keys are rotated, revoked, and handled during incidents. It distinguishes **non-custodial** user wallet flows (FlowFi never holds user key material) from **explicitly custodial** flows (FlowFi holds key material on the user's behalf). It intentionally describes *controls and responsibilities only* — never operational secrets, key material, or environment-specific values.

### Ownership and Signer Responsibilities

| Flow | Key owner | Signer | FlowFi custody | FlowFi responsibilities |
| ---- | --------- | ------ | -------------- | ----------------------- |
| **Non-custodial user wallet** (default) | The user | The user's wallet (browser extension / hardware device) | None — FlowFi never receives private keys or seed phrases | Build unsigned transactions, validate chain/network and amounts, request a signature, verify the returned signature before submission |
| **Explicitly custodial flow** (only where a product surface states it) | FlowFi service identity, on behalf of the user | FlowFi backend signer | Yes — key material lives in the deployment secret store | Isolate signer keys per environment, restrict access to the API service identity, log `kid`/identity only, and disclose custody in the product UI |
| **Operator / service identity** (API, CI, deploy) | FlowFi maintainers | The service process or CI runner | N/A | Scope credentials to the minimum role, keep them in the secret store, rotate on schedule and on any suspected compromise |

Rules that apply to every row:

- Private keys and seed phrases are never committed to the repository, baked into images, or written to logs, error messages, or diagnostics.
- Non-custodial flows must never be silently upgraded to custodial: a custodial flow requires an explicit product decision and user-facing disclosure.
- Wallet authorization, chain/network validation, and financial accounting invariants are enforced regardless of which signer is used.

### Rotation

| Key type | Rotation trigger | Procedure |
| -------- | ---------------- | --------- |
| Non-custodial user wallet | User-initiated (suspected compromise, device loss) | The user rotates keys in their own wallet; FlowFi takes no action and holds nothing to rotate. |
| Custodial signer key | Scheduled interval and on any suspected compromise | Overlap-and-retire: add the new key to the secret store, make it active for signing, keep the previous key available for verification until all artifacts it signed have expired, then retire it. |
| JWT signing key | Scheduled interval and on any suspected compromise | Follow the [JWT Signing-Key Rotation](#jwt-signing-key-rotation) runbook above (`JWT_KEYS` / `JWT_ACTIVE_KID`). |
| Operator / service identity | Scheduled interval and on role change or offboarding | Issue a new credential, roll it out, confirm the old credential is unused, then revoke it. |

### Revocation

- **Non-custodial user wallet:** revocation is the user's responsibility; FlowFi can only refuse to build or submit transactions for a wallet the user has flagged.
- **Custodial signer key:** remove the key from the secret store and roll out; confirm no in-flight operation still depends on it before deletion.
- **JWT signing key:** remove the `kid` from `JWT_KEYS` and roll out; tokens signed with it are rejected immediately (see [Externally Observable Behavior](#externally-observable-behavior)).
- **Operator / service identity:** revoke the credential at the identity provider and audit recent activity for the affected identity.

### Incident Response

1. **Contain.** Revoke the affected credential (custodial signer key, JWT `kid`, or operator identity) using the revocation steps above. For non-custodial wallets, notify the user to rotate in their own wallet.
2. **Assess.** Determine which flows used the credential and whether wallet authorization, chain/network validation, or accounting invariants were affected. Do not weaken those controls to restore service.
3. **Rotate.** Issue replacement keys following the rotation procedures above and roll them out through the secret store.
4. **Report.** File a private GitHub Security Advisory per [Reporting a Vulnerability](#reporting-a-vulnerability); never include key material in the advisory.
5. **Review.** Update this matrix if the incident revealed a missing control, and confirm the [.github/SECURITY_SETUP_CHECKLIST.md](.github/SECURITY_SETUP_CHECKLIST.md) items still hold.

Related controls: [SECURITY_IMPLEMENTATION_SUMMARY.md](SECURITY_IMPLEMENTATION_SUMMARY.md), [.github/SECURITY_SETUP_CHECKLIST.md](.github/SECURITY_SETUP_CHECKLIST.md), and the backend authentication documentation (`backend/docs/AUTHENTICATION.md`).

## Security Considerations

### Smart Contract Security

FlowFi uses Soroban smart contracts on the Stellar network. Key security considerations include:

- **Audit Status**: Our smart contracts are currently under development and have not been formally audited
- **Testing**: All contracts undergo extensive testing before deployment
- **Upgrades**: Contract upgrade mechanisms follow secure patterns

### Backend Security

Our backend API implements several security measures:

- **Rate Limiting**: API endpoints are protected against abuse
- **Input Validation**: All inputs are validated using Zod schemas
- **CORS**: Cross-origin requests are properly configured
- **Environment Variables**: Sensitive configuration is stored securely
- **JWT Signing-Key Rotation**: Tokens are signed with a key identified by a `kid` header and verified against a set of keys, so keys can be rotated without logging users out (see below)

### JWT Signing-Key Rotation

FlowFi supports rotating JWT signing keys without invalidating existing sessions. Each issued token carries a `kid` (key identifier) header, and the verifier accepts any key in the current verification set. Rotation is performed by overlapping keys: a new key is added and made active for signing, while the previous key remains in the verification set until every token it signed has expired.

#### Configuration

| Variable | Description |
| -------- | ----------- |
| `JWT_KEYS` | JSON object mapping `kid` to key material, e.g. `{"2024-01":"<secret>","2024-07":"<secret>"}`. Every key listed here is accepted for verification. |
| `JWT_ACTIVE_KID` | The `kid` used to sign newly issued tokens. Must be present in `JWT_KEYS`. |

Startup fails fast if `JWT_ACTIVE_KID` is missing from `JWT_KEYS`, if `JWT_KEYS` is empty or malformed, or if any key material is empty. Tokens whose `kid` is absent from `JWT_KEYS` (unknown or retired keys) are rejected.

#### Secret-Loading Rules

- Key material is supplied only through the environment (or the deployment secret store that populates it); never commit keys to the repository or bake them into images.
- Diagnostics, logs, and error messages must never include key material. Log `kid` values only.
- Use a distinct, high-entropy secret per `kid`; do not reuse a secret under a new `kid`.
- Restrict read access to the secret store to the API service identity.

#### Rotation Runbook

1. **Add the new key.** Generate a new high-entropy secret, add it to `JWT_KEYS` under a new `kid`, and roll out the configuration. New tokens are still signed with the old active key; the new key is only accepted for verification.
2. **Switch the active key.** Set `JWT_ACTIVE_KID` to the new `kid` and roll out. Newly issued tokens are now signed with the new key.
3. **Wait the overlap window.** Keep the old key in `JWT_KEYS` for at least the maximum token lifetime (plus clock-skew allowance) so tokens signed with it remain valid.
4. **Retire the old key.** Remove the old `kid` from `JWT_KEYS` and roll out. Tokens signed with the retired key are now rejected.

#### Externally Observable Behavior

- During steps 1–3, tokens signed by either the old or the new key are accepted; users are not logged out by a rotation.
- After step 4, only tokens signed by keys still in `JWT_KEYS` are accepted; tokens signed by retired or unknown keys are rejected.
- Rotation requires no client-side changes and no versioned API change; the `kid` header is additive and ignored by clients.
- No key material appears in responses, logs, or error diagnostics.

### Frontend Security

The frontend application follows security best practices:

- **Content Security Policy**: Implemented to prevent XSS attacks
- **Secure Dependencies**: Regular dependency updates and vulnerability scanning
- **Wallet Integration**: Secure handling of wallet connections and transactions

## Security Best Practices for Users

When using FlowFi, please follow these security guidelines:

1. **Wallet Security**: Never share your private keys or seed phrases
2. **Transaction Verification**: Always verify transaction details before signing
3. **Network Security**: Use secure, trusted networks when accessing FlowFi
4. **Software Updates**: Keep your wallet software and browser up to date
5. **Phishing Protection**: Always verify you're on the official FlowFi domain

## Bug Bounty Program

Currently, FlowFi does not have a formal bug bounty program. However, we greatly appreciate security researchers who help improve our security posture and will acknowledge their contributions in our security advisories.
