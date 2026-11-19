# Dependency compatibility reports

The **Dependency compatibility** workflow runs weekly on Tuesday at 06:41 UTC
and can also be dispatched manually. Each component has a baseline and a
candidate job. Baselines install the checked-in locks. Candidates resolve
updates within the declared constraints once and then install from the
resulting lock. The report does not push changes or deploy anything.

Compare the baseline and candidate jobs for the application, SDK and
contracts. A candidate-only failure points to a dependency regression.
Failures in both lanes should be investigated against the baseline first.
The job summary lists changed npm package versions or the Cargo lockfile
diff size. Download the job artifact for the full change list, exact lock,
and toolchain version. Reproduce from the reported commit and toolchain using
the candidate lock with `npm ci` or the documented `cargo --locked` commands.

To test a controlled change, dispatch the workflow with an exact npm version
such as `react-hot-toast@2.6.0`. This replaces normal resolution for the
frontend dependency resolution in the application candidate only. The SDK and contract lanes still check their own
compatible updates. Proposed upgrades go through a separate reviewed PR.
