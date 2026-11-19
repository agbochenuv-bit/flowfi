# Project

## Accessibility audit

Accessibility is verified for the critical flows — wallet setup, stream creation,
transaction confirmation, and error recovery — through automated checks in CI
plus a documented manual audit.

### Automated checks

Automated accessibility checks run in CI on every pull request via the
`accessibility` job in `.github/workflows/ci.yml`. They use axe-based assertions
against the critical-flow screens and fail the build on new violations. Focused
coverage includes failure and boundary cases such as missing form labels,
focus traps in modals, and error-state announcements.

Run the checks locally with the same command CI uses (see the workflow for the
exact invocation).

### Manual audit scenarios

Each critical flow has a manual keyboard-navigation and screen-reader scenario.
Perform these before release and record results in the PR or release checklist.

| Flow | Keyboard scenario | Screen-reader scenario | Remediation owner |
| --- | --- | --- | --- |
| Wallet setup | Tab through all fields and buttons in order; focus is visible; no keyboard traps; submit reachable without a mouse. | Screen reader announces each field label, validation errors, and success state. | Frontend maintainer |
| Stream creation | Reach every input and the create action via keyboard; focus returns to a sensible element after submit. | Screen reader announces field labels, amount/recipient context, and submission result. | Frontend maintainer |
| Transaction confirmation | Confirm/cancel actions are keyboard reachable; focus is trapped within the confirmation dialog and restored on close. | Screen reader announces the dialog role, its title, and the confirmation outcome. | Frontend maintainer |
| Error recovery | Error messages are reachable and dismissible via keyboard; focus moves to the error. | Screen reader announces errors via a live region and reads the recovery action. | Frontend maintainer |

Failures found during the manual audit are filed as issues assigned to the
remediation owner listed above and must be resolved before the next release.
