# GitHub Security Setup Checklist

This checklist helps repository administrators ensure that GitHub's security features are properly configured for the FlowFi repository. For the canonical security policy (reporting guidelines, supported versions, response timelines), see [SECURITY.md](../SECURITY.md). For the implementation status and next steps, see [SECURITY_IMPLEMENTATION_SUMMARY.md](../SECURITY_IMPLEMENTATION_SUMMARY.md).

## Repository Security Settings

### Required Actions (Repository Admin)

- [ ] **Enable Private Vulnerability Reporting**
  - Go to Settings → Security & analysis
  - Enable "Private vulnerability reporting"
  - This allows security researchers to privately report vulnerabilities

- [ ] **Enable Dependency Graph**
  - Go to Settings → Security & analysis
  - Enable "Dependency graph"
  - This helps track project dependencies

- [ ] **Enable Dependabot Alerts**
  - Go to Settings → Security & analysis
  - Enable "Dependabot alerts"
  - This provides automatic vulnerability alerts for dependencies

- [ ] **Enable Dependabot Security Updates**
  - Go to Settings → Security & analysis
  - Enable "Dependabot security updates"
  - This automatically creates PRs to fix vulnerable dependencies

- [ ] **Enable Code Scanning (CodeQL)**
  - Go to Settings → Security & analysis
  - Enable "Code scanning"
  - The security.yml workflow should handle this automatically

- [ ] **Configure Branch Protection**
  - Go to Settings → Branches
  - Add protection rules for `main` branch
  - Require status checks to pass (including security checks)

### Optional but Recommended

- [ ] **Enable Secret Scanning**
  - Go to Settings → Security & analysis
  - Enable "Secret scanning"
  - This detects accidentally committed secrets

- [ ] **Set up Security Policy Link**
  - Verify that SECURITY.md appears in the repository's Security tab
  - GitHub should automatically detect and link to it

## Verification Steps

### 1. Check Security Tab
- [ ] Navigate to the repository's "Security" tab
- [ ] Verify that "Security policy" section shows a link to SECURITY.md
- [ ] Confirm that "Report a vulnerability" button is available

### 2. Test Private Reporting
- [ ] Click "Report a vulnerability" in the Security tab
- [ ] Verify that it opens the private advisory creation form
- [ ] Cancel without submitting (this is just a test)

### 3. Verify Workflows
- [ ] Check that `.github/workflows/security.yml` is running on PRs
- [ ] Confirm that security checks appear in PR status checks
- [ ] Review any security alerts in the Security tab

## Wallet and Operator Key Lifecycle

Use this decision matrix to determine key ownership, signer responsibilities, and the required lifecycle actions for each key class. It distinguishes non-custodial user wallet flows from explicitly custodial flows. Never record private keys, seed phrases, or operator credentials in this repository or in tickets — reference the secret store location only.

| Key class | Custody model | Owner | Signer responsibility | Rotation trigger | Revocation trigger |
| --- | --- | --- | --- | --- | --- |
| User wallet (self-custody) | Non-custodial — keys never leave the user's device | End user | User signs all transactions locally; FlowFi never holds or transmits the key | User-initiated (e.g. device loss, suspected compromise) | User revokes by moving funds to a new wallet; FlowFi cannot revoke |
| User wallet (custodial / managed) | Explicitly custodial — FlowFi or a designated custodian holds signing material | FlowFi operator (documented in the custody agreement) | Custodian signs on the user's behalf; user authorizes via authenticated session | Scheduled rotation per custody policy, or on suspected compromise | Custodian revokes the key and re-issues after user re-authentication |
| Service / operator identity | Non-custodial to end users — internal service credential | FlowFi engineering owner of the service | Service signs its own requests; least-privilege scopes only | Scheduled rotation and on personnel or role change | Immediate revocation on offboarding, leak, or scope change |

### Rotation procedure

1. Confirm the key class in the matrix above and identify the owning party.
2. Generate the replacement key in the approved secret store (never in the repo).
3. Deploy the new key alongside the old one, verify signing works, then retire the old key.
4. Record the rotation date and owner in the internal key inventory (not in this repository).

### Revocation procedure

1. Disable the key in the secret store / custodian console first, then remove it.
2. For custodial user wallets, notify the affected user and require re-authentication before re-issuing.
3. For service identities, revoke scopes and audit recent usage for anomalies.
4. Update the internal key inventory and note the revocation reason.

### Incident response

1. Contain: revoke the affected key immediately using the procedure above.
2. Assess: determine blast radius (which wallets, services, or scopes were reachable).
3. Report: follow the private reporting process in [SECURITY.md](../SECURITY.md); do not disclose operational secrets in the advisory.
4. Recover: rotate all keys in the affected class, verify signing, and monitor for replay.
5. Review: update this matrix and the checklist if the incident revealed a gap.

Related controls: [SECURITY.md](../SECURITY.md) (policy and reporting), [backend/docs/AUTHENTICATION.md](../backend/docs/AUTHENTICATION.md) (service authentication), and [CONTRIBUTING.md](../CONTRIBUTING.md) (contributor secret-handling rules).

## Maintenance Tasks

### Weekly
- [ ] Review any new Dependabot alerts
- [ ] Check for new security advisories

### Monthly
- [ ] Review and update security policy if needed
- [ ] Audit repository access permissions
- [ ] Review security workflow results
- [ ] Verify the key lifecycle matrix still matches the deployed custody model

### Before Major Releases
- [ ] Run comprehensive security audit
- [ ] Update supported versions in SECURITY.md
- [ ] Review and test incident response procedures
- [ ] Confirm scheduled key rotations are current

## Contact Information

Update the following when repository ownership or contact methods change:

- [ ] Security email in SECURITY.md
- [ ] Repository maintainer list
- [ ] Emergency contact procedures

## Notes

- This checklist should be reviewed whenever repository settings change
- New team members should be familiar with the security policy
- Consider setting up notifications for security alerts

---

*Last updated: [DATE] by [MAINTAINER]*