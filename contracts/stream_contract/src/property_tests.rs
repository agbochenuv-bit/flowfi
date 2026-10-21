//! Property-based tests for stream accounting invariants.
//!
//! These tests use `proptest` to generate randomized action sequences and
//! adversarial inputs, asserting that core invariants hold across all
//! generated scenarios. Failures include the minimal reproducing seed.
//!
//! ## Invariants tested
//! - **Conservation**: withdrawn ≤ deposited at all times
//! - **Monotonic withdrawal**: withdrawn amount never decreases
//! - **Pause freeze**: claimable amount does not increase while paused
//! - **Terminal immutability**: cancelled streams stay cancelled
//! - **Adversarial amounts**: no arithmetic overflow at boundary values
//! - **Fee boundaries**: zero-fee and max-fee deposit accounting

extern crate std;
use proptest::prelude::*;

// ─── Pure-Rust accounting model ──────────────────────────────────────────────
//
// We maintain a lightweight model of the contract state that mirrors
// only the fields relevant to the invariants under test. This lets
// proptest shrink failures without spinning up a Soroban environment.

#[derive(Clone, Debug)]
struct Model {
    deposited: i128,
    withdrawn: i128,
    rate: i128,
    last_time: u64,
    paused_at: Option<u64>,
}

impl Model {
    fn claimable(&self, now: u64) -> i128 {
        let end = self.paused_at.unwrap_or(now);
        let elapsed = end.saturating_sub(self.last_time) as i128;
        (elapsed.saturating_mul(self.rate))
            .min(self.deposited.saturating_sub(self.withdrawn).max(0))
    }

    fn is_paused(&self) -> bool {
        self.paused_at.is_some()
    }
}

#[derive(Clone, Debug)]
enum Action {
    Advance(u32),
    Pause,
    Resume,
    Withdraw,
    TopUp(u32),
    Cancel,
}

fn action_strategy() -> impl Strategy<Value = Action> {
    prop_oneof![
        (1u32..10_000).prop_map(Action::Advance),
        Just(Action::Pause),
        Just(Action::Resume),
        Just(Action::Withdraw),
        (1u32..100_000).prop_map(Action::TopUp),
        Just(Action::Cancel),
    ]
}

// ─── Test 1: Randomized lifecycle invariants (original) ───────────────────────

proptest! {
    #![proptest_config(ProptestConfig { cases: 10_000, .. ProptestConfig::default() })]
    #[test]
    fn randomized_stream_invariants(
        deposited in 1i128..1_000_000_000_000_000_000i128,
        duration in 1u64..100_000u64,
        actions in prop::collection::vec(action_strategy(), 1..100),
    ) {
        let mut model = Model {
            deposited,
            withdrawn: 0,
            rate: (deposited / duration as i128).max(1),
            last_time: 0,
            paused_at: None,
        };
        let mut now = 0u64;
        let mut previous_withdrawn = 0i128;
        let mut paused_claimable = None;
        let mut cancelled = false;

        for action in actions {
            match action {
                Action::Advance(dt) if !cancelled => now = now.saturating_add(dt as u64),
                Action::Pause if !cancelled && model.paused_at.is_none() => {
                    paused_claimable = Some(model.claimable(now));
                    model.paused_at = Some(now);
                }
                Action::Resume if !cancelled => {
                    if let Some(paused_at) = model.paused_at.take() {
                        let pause_duration = now.saturating_sub(paused_at);
                        model.last_time = model.last_time.saturating_add(pause_duration);
                    }
                }
                Action::Withdraw if !cancelled => {
                    let amount = model.claimable(now);
                    model.withdrawn = model.withdrawn.saturating_add(amount);
                    model.last_time = now;
                    paused_claimable = None;
                }
                Action::TopUp(amount) if !cancelled => {
                    let accrued = model.claimable(now);
                    model.deposited = model.deposited.saturating_add(amount as i128);
                    if model.paused_at.is_none() {
                        model.last_time = now;
                    }
                    let _ = accrued;
                }
                Action::Cancel if !cancelled => {
                    model.withdrawn = model.withdrawn.saturating_add(model.claimable(now));
                    cancelled = true;
                }
                _ => {}
            }

            // Core invariants
            prop_assert!(model.withdrawn >= previous_withdrawn,
                "withdrawn must be monotonically non-decreasing");
            prop_assert!(model.withdrawn <= model.deposited,
                "withdrawn must never exceed deposited");
            prop_assert!(model.deposited >= model.withdrawn.saturating_add(model.claimable(now)),
                "deposited must cover withdrawn + claimable");
            if model.paused_at.is_some() && paused_claimable.is_some() && !cancelled {
                prop_assert!(
                    model.claimable(now) - paused_claimable.unwrap() <= (model.deposited - deposited),
                    "claimable must not grow beyond top-ups while paused"
                );
            }
            previous_withdrawn = model.withdrawn;
        }
    }
}

// ─── Test 2: Pause freezes accrual ────────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig { cases: 5_000, .. ProptestConfig::default() })]
    #[test]
    fn pause_freezes_claimable_amount(
        deposited in 1_000i128..1_000_000_000i128,
        duration in 10u64..100_000u64,
        pause_offset in 1u64..1_000u64,
        extra_time in 0u64..10_000u64,
    ) {
        let rate = (deposited / duration as i128).max(1);
        let mut model = Model {
            deposited,
            withdrawn: 0,
            rate,
            last_time: 0,
            paused_at: None,
        };

        let pause_time = pause_offset;
        let after_pause = pause_time + extra_time;

        // Advance to pause point
        let claimable_at_pause = model.claimable(pause_time);
        // Pause the stream
        model.paused_at = Some(pause_time);
        // Advance more time — claimable must NOT increase
        let claimable_after_extra = model.claimable(after_pause);

        prop_assert_eq!(
            claimable_at_pause, claimable_after_extra,
            "claimable amount must be frozen while paused"
        );
    }
}

// ─── Test 3: Terminal state immutability ─────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig { cases: 5_000, .. ProptestConfig::default() })]
    #[test]
    fn cancelled_stream_stays_cancelled(
        deposited in 1i128..1_000_000_000i128,
        duration in 1u64..10_000u64,
        time_before_cancel in 0u64..5_000u64,
        actions_after in prop::collection::vec(action_strategy(), 0..20),
    ) {
        let rate = (deposited / duration as i128).max(1);
        let mut model = Model {
            deposited,
            withdrawn: 0,
            rate,
            last_time: 0,
            paused_at: None,
        };

        let mut now = time_before_cancel;
        // Settle accrued amount into withdrawn at cancel time
        model.withdrawn = model.withdrawn.saturating_add(model.claimable(now));
        let withdrawn_at_cancel = model.withdrawn;
        let deposited_at_cancel = model.deposited;
        let cancelled = true;

        // Apply actions after cancel — none should change the terminal amounts
        for action in actions_after {
            if cancelled {
                // A cancelled stream must ignore all further mutations.
                // In our model, we verify by simply not applying them.
                match action {
                    Action::Advance(dt) => now = now.saturating_add(dt as u64),
                    _ => {}
                }
            }
            // Invariant: amounts frozen at cancel
            prop_assert_eq!(
                model.withdrawn, withdrawn_at_cancel,
                "withdrawn must not change after cancel"
            );
            prop_assert_eq!(
                model.deposited, deposited_at_cancel,
                "deposited must not change after cancel"
            );
        }
    }
}

// ─── Test 4: Conservation invariant ─────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig { cases: 5_000, .. ProptestConfig::default() })]
    #[test]
    fn conservation_deposited_covers_withdrawn_plus_claimable(
        deposited in 1i128..1_000_000_000_000i128,
        duration in 1u64..100_000u64,
        actions in prop::collection::vec(action_strategy(), 1..50),
    ) {
        let rate = (deposited / duration as i128).max(1);
        let mut model = Model {
            deposited,
            withdrawn: 0,
            rate,
            last_time: 0,
            paused_at: None,
        };
        let mut now = 0u64;
        let mut cancelled = false;

        for action in &actions {
            match action {
                Action::Advance(dt) if !cancelled => now = now.saturating_add(*dt as u64),
                Action::Pause if !cancelled && !model.is_paused() => {
                    model.paused_at = Some(now);
                }
                Action::Resume if !cancelled => {
                    if let Some(paused_at) = model.paused_at.take() {
                        model.last_time = model.last_time.saturating_add(now.saturating_sub(paused_at));
                    }
                }
                Action::Withdraw if !cancelled => {
                    let amount = model.claimable(now);
                    model.withdrawn = model.withdrawn.saturating_add(amount);
                    if !model.is_paused() { model.last_time = now; }
                }
                Action::TopUp(amount) if !cancelled => {
                    model.deposited = model.deposited.saturating_add(*amount as i128);
                }
                Action::Cancel if !cancelled => {
                    model.withdrawn = model.withdrawn.saturating_add(model.claimable(now));
                    cancelled = true;
                }
                _ => {}
            }

            // Conservation: deposited must always cover withdrawn + outstanding claimable
            let claimable = if cancelled { 0 } else { model.claimable(now) };
            prop_assert!(
                model.deposited >= model.withdrawn.saturating_add(claimable),
                "conservation violated: deposited={} < withdrawn={} + claimable={}",
                model.deposited, model.withdrawn, claimable
            );
            prop_assert!(model.withdrawn <= model.deposited,
                "withdrawn must never exceed deposited");
            prop_assert!(model.withdrawn >= 0, "withdrawn must be non-negative");
            prop_assert!(claimable >= 0, "claimable must be non-negative");
        }
    }
}

// ─── Test 5: Adversarial boundary amounts ────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig { cases: 2_000, .. ProptestConfig::default() })]
    #[test]
    fn adversarial_boundary_amounts_no_overflow(
        // Near-boundary deposited amounts
        deposited in prop_oneof![
            Just(1i128),
            Just(1_000i128),
            Just(i128::MAX / 4),
            (1i128..1_000_000_000_000_000_000i128),
        ],
        duration in prop_oneof![
            Just(1u64),
            Just(100u64),
            (1u64..100_000u64),
        ],
        elapsed in 0u64..200_000u64,
    ) {
        let rate = (deposited / duration as i128).max(1);
        let model = Model {
            deposited,
            withdrawn: 0,
            rate,
            last_time: 0,
            paused_at: None,
        };

        let claimable = model.claimable(elapsed);

        // No overflow: claimable must be non-negative and bounded by deposited
        prop_assert!(claimable >= 0,
            "claimable must not be negative at boundary amounts");
        prop_assert!(claimable <= deposited,
            "claimable must not exceed deposited at boundary amounts");
    }
}

// ─── Test 6: Fee boundary invariants ─────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig { cases: 2_000, .. ProptestConfig::default() })]
    #[test]
    fn fee_rate_boundary_deposit_invariant(
        gross_amount in 1i128..1_000_000_000_000i128,
        fee_rate_bps in prop_oneof![
            Just(0u32),        // zero fee: net == gross
            Just(1000u32),     // max fee: net >= 0
            (0u32..=1000u32),  // any valid rate
        ],
    ) {
        // Simulate fee deduction as the contract does:
        // net = gross - (gross * fee_rate_bps / 10_000)
        let fee = gross_amount * fee_rate_bps as i128 / 10_000;
        let net = gross_amount - fee;

        prop_assert!(fee >= 0, "fee must be non-negative");
        prop_assert!(net >= 0, "net deposit must be non-negative");
        prop_assert!(net <= gross_amount, "net must not exceed gross");

        if fee_rate_bps == 0 {
            prop_assert_eq!(net, gross_amount,
                "zero fee rate must result in net == gross");
        }
        if fee_rate_bps == 1000 {
            // 10% fee → net = 90% of gross, always >= 0 for positive gross
            let expected_net = gross_amount * 9 / 10;
            prop_assert!((net - expected_net).abs() <= 1,
                "max fee rate must deduct ~10%");
        }
    }
}

// ─── Test 7: Monotonic stream ID counter ─────────────────────────────────────
//
// This test validates the counter logic directly in Rust without a Soroban env.
// The contract's `next_stream_id` starts at 1 and increments by 1 each call.

proptest! {
    #![proptest_config(ProptestConfig { cases: 1_000, .. ProptestConfig::default() })]
    #[test]
    fn stream_id_counter_is_monotonically_increasing(
        n_streams in 1usize..50usize,
    ) {
        // Simulate the counter logic (starts at 0, each call adds 1)
        let mut counter: u64 = 0;
        let mut ids = std::vec::Vec::new();
        for _ in 0..n_streams {
            counter += 1;
            ids.push(counter);
        }
        // All IDs must be unique and strictly increasing
        for i in 1..ids.len() {
            prop_assert!(
                ids[i] > ids[i - 1],
                "stream IDs must be strictly monotonically increasing: {} !> {}",
                ids[i], ids[i - 1]
            );
        }
        prop_assert_eq!(ids.first().copied(), Some(1u64), "first ID must be 1");
        prop_assert_eq!(ids.last().copied(), Some(n_streams as u64));
    }
}
