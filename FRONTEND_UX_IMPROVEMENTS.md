# Frontend UX Improvements

This document tracks user-facing workflow improvements in the frontend. It is the owning documentation for the capabilities below and is kept compatible with existing interfaces unless a change is explicitly versioned.

## Bulk action review and per-item outcomes (#267)

Multi-stream workflows now use a review-then-confirm flow with a result for every requested action.

### Preflight summary

Before anything executes, the bulk action dialog lists every requested action together with the affected stream, so users can review the full set before committing. The summary is rendered as a labelled list so assistive technology can enumerate each entry.

### Explicit confirmation

No bulk action runs until the user confirms. Cancelling (via the Cancel control or `Escape`) closes the dialog without executing anything and without submitting to the wallet.

### Accessibility

- The review surface is a modal dialog with `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the dialog title, and `aria-describedby` pointing at the preflight summary.
- Keyboard support: focus moves into the dialog on open and is trapped while it is open; `Escape` cancels; `Enter`/`Space` activate the focused control.
- Progress and results are announced through a polite live region (`aria-live="polite"`), and failures are surfaced in an assertive region so screen-reader users hear them promptly.

### Per-item outcomes

After execution each requested action reports its own outcome:

- **Succeeded** — the action completed.
- **Failed** — the action did not complete; the reason is shown next to the item.
- **Cancelled** — the action was not attempted (for example, the user cancelled mid-run).

Partial failures are expected: successful items stay successful while failed items are reported individually, and the summary reflects the counts.

### Duplicate submission prevention

While a bulk action is in flight the confirm control is disabled and guarded against re-entry, so a second wallet submission cannot be triggered by repeated clicks or key presses. The guard is released only after the run settles.

### Testing

Focused automated coverage accompanies the change and includes:

- partial failure (some items succeed, some fail) producing correct per-item outcomes;
- cancellation before execution and mid-run;
- prevention of duplicate wallet submissions from repeated confirmation.

### Compatibility

Existing single-stream action interfaces are unchanged. The bulk review flow is additive and does not weaken wallet authorization, chain/network validation, financial accounting invariants, or secret-handling requirements.

## Transaction-safe drafts for incomplete stream setup (#268)

A user can save an unsigned stream configuration as a draft and resume it later. A draft is a local, client-side record of an incomplete setup — it is **not** a stream and does **not** reserve funds.

### What a draft is (and is not)

- A draft captures only the configuration fields the user has entered so far (for example recipient, amount, duration, and start time).
- A draft **never** contains secrets or signatures: no private keys, seed phrases, signed payloads, or wallet signatures are persisted. Signing happens only at the final review step, after the draft is loaded.
- Saving a draft does **not** imply that funds are reserved, that a transaction was submitted, or that a stream already exists. The UI labels drafts explicitly as "Draft — not signed, no funds reserved" so this is unambiguous.

### Expiry

Drafts carry a creation timestamp and expire after a bounded window. Expired drafts are not offered for resume; the user is told the draft expired and must start a fresh setup. Expiry is evaluated on load so a stale draft cannot be silently resumed.

### Network / chain changes

Each draft records the chain/network it was created for. If the connected wallet is on a different network when the draft is loaded, the draft is not resumed automatically: the user is shown the mismatch and must either switch networks or discard the draft. Chain/network validation is never bypassed to make a draft load.

### Schema upgrades

Drafts are versioned. On load, a draft whose schema version is older than the current version is either migrated to the current shape or discarded if it cannot be safely migrated. Unknown or malformed drafts are discarded rather than partially applied, so an outdated draft can never produce an invalid configuration.

### Final review before signing

Resuming a draft always routes through a final review step that surfaces the full configuration (recipient, amount, duration, start time, and network) before any wallet interaction. Nothing is signed until the user confirms at this review, and the review makes clear that no funds have been reserved up to that point.

### Testing

Focused automated coverage accompanies the change and includes:

- draft expiry (an expired draft is not resumable);
- network/chain change (a draft created on another network is not resumed automatically);
- schema upgrade (an older-version draft is migrated or discarded, never partially applied);
- the final review step surfacing the full configuration before signing;
- confirmation that persisted drafts contain no secrets or signatures.

### Compatibility

Draft persistence is additive and local to the frontend. Existing stream creation interfaces are unchanged, and the feature does not weaken wallet authorization, chain/network validation, financial accounting invariants, or secret-handling requirements.
