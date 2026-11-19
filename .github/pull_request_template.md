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

Closes #

## Task Ownership
<!-- Complete when this PR delivers substantial or multi-part work -->
<!-- See the advanced task ownership and review workflow in CONTRIBUTING.md -->

- [ ] This PR is linked to the issue that owns the work (no untracked scope)
- [ ] Dependent work is split into tracked sub-issues and linked above
- [ ] Scope boundaries are stated in the Description (what is in and out of scope)
- [ ] Design review requested before implementation if the change alters public interfaces, contracts, or data models

## Changes Made
<!-- Describe the specific changes made in this PR -->

## Contract Reference Tables
<!-- Complete when this PR adds or changes contract entrypoints, state transitions, authorization, or emitted events -->
<!-- See the contract reference tables in the contracts documentation for the expected format -->

- [ ] State-transition table added/updated (from state → to state → entrypoint → precondition)
- [ ] Authorization table added/updated (entrypoint → required role → failure behavior)
- [ ] Emitted events documented per entrypoint
- [ ] Terminal states and calls against them documented
- [ ] Unsupported/invalid transitions explicitly identified
- [ ] Tables validated against contract tests

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

## Evidence for Sensitive Changes
<!-- Complete when this PR touches financial accounting, wallet authorization, chain/network validation, or secret handling -->
<!-- See the evidence requirements in CONTRIBUTING.md -->

- [ ] Not a financial or security-sensitive change (skip the rest of this section)
- [ ] Tests cover the relevant failure and boundary cases (not only the happy path)
- [ ] Invariant checks documented (e.g. accounting balances, authorization denials, network validation)
- [ ] Audit notes included describing the risk considered and why the change is safe
- [ ] No wallet authorization, chain/network validation, accounting invariants, or secret-handling requirements were weakened

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
