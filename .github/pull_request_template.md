## Description
<!-- Provide a clear and concise description of what this PR does -->

## Type of Change
<!-- Mark the relevant option with an 'x' -->

- [ ] 🐛 Bug fix (non-breaking change which fixes an issue)
- [ ] ✨ New feature (non-breaking change which adds functionality)
- [ ] 💥 Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] 📚 Documentation update
- [ ] 🔧 Refactoring (no functional changes)
- [ ] ⚡ Performance improvement
- [ ] 🧪 Test addition or update

## Related Issues
<!-- Link related issues using keywords like "Closes", "Fixes", "Resolves" -->
<!-- Example: Closes #123, Fixes #456 -->
<!-- REQUIRED: every PR must reference at least one issue. The CI policy check
     (scripts/ci/issue-linked-change-policy.mjs) fails the build when no issue
     link is found. -->

Closes #

## Changes Made
<!-- Describe the specific changes made in this PR -->

## Policy Evidence
<!-- REQUIRED when this PR touches financial behavior, public API contracts,
     or operational controls. The CI policy check inspects the diff and fails
     unless the matching evidence below is present. -->

### Does this PR touch a governed area?
<!-- Mark all that apply. Leave all unchecked if none apply. -->

- [ ] Financial behavior (accounting invariants, balances, payouts, fees)
- [ ] Public API contracts (routes, request/response shapes, versioning)
- [ ] Operational controls (CI, deploy, secrets handling, alerting, runbooks)

### Evidence for governed changes
<!-- Complete the rows that match the boxes checked above. -->

- **Focused tests:** <!-- Link the test file(s) and name the failure/boundary cases covered -->
- **Owning documentation:** <!-- Link the API/contract/operational/contributor doc updated in this PR -->
- **Interface compatibility:** <!-- Confirm existing interfaces stay compatible, or link the versioning change -->

### Exemption
<!-- Maintainers may exempt a governed change only with an explicit, reviewable
     reason. Exemptions are never silent: the CI check requires the marker below
     and a justification. -->

- [ ] This PR is exempt from the policy evidence requirement

**Exemption justification:** <!-- Required if the box above is checked -->

## Testing
<!-- Describe the tests you ran and how to verify your changes -->

### Test Coverage
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing performed

### Test Steps
<!-- If applicable, provide steps to test the changes -->
1. 
2. 
3. 

## Breaking Changes
<!-- If this PR includes breaking changes, describe them here -->
<!-- If none, you can remove this section -->

**Breaking Changes:**
- 

**Migration Guide:**
<!-- If applicable, provide steps for users to migrate -->

## Screenshots/Demo
<!-- If applicable, add screenshots or a link to a demo -->

## Checklist
<!-- Mark completed items with an 'x' -->

- [ ] My code follows the project's style guidelines
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] Updated Postman/Hoppscotch API collections if routes changed
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes
- [ ] Any dependent changes have been merged and published
- [ ] I have checked for breaking changes and documented them if applicable
- [ ] If this change adds or modifies a metric, I have updated the Grafana dashboard and the alert rules in `backend/docs/observability/`

## Additional Notes
<!-- Any additional information that reviewers should know -->
