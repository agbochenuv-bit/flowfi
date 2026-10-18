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
- **Suggested Fix**: If you have ideas for how to fix the issue

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
=======

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

Currently, FlowFi does not have a formal bug bounty program. However, we greatly appreciate security researchers who help improve our security posture and will acknowledge their contributions appropriately.

## Security Updates

Security updates and advisories will be published:

- In this repository's [Security Advisories](https://github.com/LabsCrypt/flowfi/security/advisories)
- In release notes for affected versions
- Through our official communication channels

## Contact

For security-related questions or concerns that are not vulnerabilities, you can:

- Open a public issue with the `security` label using the [security issue template](.github/ISSUE_TEMPLATE/security.md)
- Reach out to the maintainers through GitHub
- Join our community discussions

## Acknowledgments

We thank the security research community for helping keep FlowFi and our users safe. Contributors who responsibly disclose vulnerabilities will be acknowledged in our security advisories and release notes.

---

*This security policy is subject to change. Please check back regularly for updates.*