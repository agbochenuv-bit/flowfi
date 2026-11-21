//! Recurring stream contract.
//!
//! Streams can be created directly (single instance) or from a bounded
//! recurring schedule. Each instance produced by a schedule is independently
//! funded, uniquely identified, and independently cancellable. Linkage between
//! instances is deterministic: `(schedule_id, index)`.
//!
//! ## Sponsorship
//!
//! A stream may optionally be created with an explicit `sponsor`. The sponsor
//! is a distinct role from `owner` (sender) and `recipient`: it may cover the
//! transaction costs and/or initial funding of a stream, but it never gains
//! sender or recipient privileges. Sponsorship is recorded in state and emitted
//! in events separately from the sender/recipient so attribution is explicit.
//! When no sponsor is supplied the stream is unsponsored and behaves exactly as
//! before.
//!
//! ## Rate and duration ceilings
//!
//! Protocol policy may bound per-stream configuration via two ceilings:
//!
//! - `max_rate`: maximum stream rate in token base units **per second**
//!   (`amount / interval`, integer division).
//! - `max_duration`: maximum stream duration in **seconds** (`interval * count`).
//!
//! A ceiling of `0` means "unbounded" for that dimension. Ceilings are applied
//! only at creation time: streams and schedules created before a policy change
//! retain their agreed terms, and later policy changes never retroactively
//! reject or alter existing streams.
//!
//! ## Fee rebates
//!
//! Eligible streams may receive a bounded fee rebate. Eligibility is explicit
//! and deterministic:
//!
//! - The stream must be **sponsored** (`sponsor.is_some()`). Unsponsored
//!   streams are never eligible.
//! - The stream must not be cancelled.
//! - The stream `amount` must be at least `MIN_REBATE_AMOUNT`.
//!
//! The rebate is `amount * REBATE_BPS / 10_000` using integer division, so it
//! rounds **down** deterministically and can never exceed the stream amount.
//! The result is additionally capped at `MAX_REBATE` so a single rebate is
//! always bounded. Rebates are recorded per stream (idempotent: a stream can be
//! rebated at most once) and accumulated into a treasury counter, preserving
//! conservation of funds: `rebate <= amount` and the treasury total is exactly
//! the sum of applied rebates.

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec};

/// Bounds enforced on recurring schedules.
pub const MIN_INTERVAL: u64 = 60;
pub const MAX_INTERVAL: u64 = 31_536_000; // one year
pub const MAX_INSTANCES: u32 = 52;

/// Minimum stream amount (token base units) required for rebate eligibility.
pub const MIN_REBATE_AMOUNT: i128 = 1_000;
/// Rebate rate in basis points (1 bps = 0.01%).
pub const REBATE_BPS: i128 = 50; // 0.5%
/// Absolute cap on a single rebate, in token base units.
pub const MAX_REBATE: i128 = 10_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Stream {
    pub id: u64,
    pub owner: Address,
    pub recipient: Address,
    /// Optional sponsor that covered costs/funding. Distinct from `owner` and
    /// `recipient`; carries no sender or recipient privileges.
    pub sponsor: Option<Address>,
    pub amount: i128,
    pub start: u64,
    pub cancelled: bool,
}

/// A bounded recurring schedule. `count` is the maximum number of instances
/// that may ever be spawned from this schedule.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Schedule {
    pub id: u64,
    pub owner: Address,
    pub recipient: Address,
    /// Optional sponsor inherited by spawned instances. Distinct from `owner`
    /// and `recipient`; carries no sender or recipient privileges.
    pub sponsor: Option<Address>,
    pub amount: i128,
    pub start: u64,
    pub interval: u64,
    pub count: u32,
    pub spawned: u32,
}

/// Configurable protocol policy ceilings. `0` disables a ceiling.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Policy {
    /// Max rate in token base units per second (`amount / interval`).
    pub max_rate: i128,
    /// Max duration in seconds (`interval * count`).
    pub max_duration: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    InvalidInterval = 1,
    InvalidCount = 2,
    InvalidAmount = 3,
    ScheduleNotFound = 4,
    ScheduleExhausted = 5,
    InsufficientFunding = 6,
    DuplicateExecution = 7,
    StreamNotFound = 8,
    Unauthorized = 9,
    RateExceedsCeiling = 10,
    DurationExceedsCeiling = 11,
    InvalidSponsor = 12,
    NotRebateEligible = 13,
    RebateAlreadyApplied = 14,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DataKey {
    pub kind: u32,
    pub id: u64,
}

const KEY_STREAM: u32 = 0;
const KEY_SCHEDULE: u32 = 1;
const KEY_NEXT_STREAM: u32 = 2;
const KEY_NEXT_SCHEDULE: u32 = 3;
const KEY_POLICY: u32 = 4;
const KEY_REBATE: u32 = 5;
const KEY_TREASURY: u32 = 6;

#[contract]
pub struct StreamContract;

#[contractimpl]
impl StreamContract {
    /// Create a single stream instance directly.
    ///
    /// `owner` (sender) must authorize. An optional `sponsor` may be supplied to
    /// cover costs/funding; the sponsor is recorded for attribution only and
    /// never gains sender or recipient privileges. A sponsor equal to the
    /// recipient is rejected so sponsorship cannot be used to smuggle
    /// recipient authority.
    pub fn create_stream(
        env: Env,
        owner: Address,
        recipient: Address,
        sponsor: Option<Address>,
        amount: i128,
        start: u64,
    ) -> Result<u64, Error> {
        owner.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if let Some(ref s) = sponsor {
            if *s == recipient {
                return Err(Error::InvalidSponsor);
            }
        }
        let id = next_id(&env, KEY_NEXT_STREAM);
        let stream = Stream {
            id,
            owner,
            recipient,
            sponsor,
            amount,
            start,
            cancelled: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey { kind: KEY_STREAM, id }, &stream);
        Ok(id)
    }

    /// Create a bounded recurring schedule. Rejects out-of-bounds intervals and
    /// instance counts so a schedule can never spawn unbounded instances.
    /// Also enforces the current rate and duration ceilings (see module docs).
    ///
    /// An optional `sponsor` is recorded for attribution and inherited by
    /// spawned instances; it never gains sender or recipient privileges.
    pub fn create_schedule(
        env: Env,
        owner: Address,
        recipient: Address,
        sponsor: Option<Address>,
        amount: i128,
        start: u64,
        interval: u64,
        count: u32,
    ) -> Result<u64, Error> {
        owner.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if interval < MIN_INTERVAL || interval > MAX_INTERVAL {
            return Err(Error::InvalidInterval);
        }
        if count == 0 || count > MAX_INSTANCES {
            return Err(Error::InvalidCount);
        }
        if let Some(ref s) = sponsor {
            if *s == recipient {
                return Err(Error::InvalidSponsor);
            }
        }
        enforce_ceilings(&env, amount, interval, count)?;
        let id = next_id(&env, KEY_NEXT_SCHEDULE);
        let schedule = Schedule {
            id,
            owner,
            recipient,
            sponsor,
            amount,
            start,
            interval,
            count,
            spawned: 0,
        };
        env.storage()
            .persistent()
            .set(&DataKey { kind: KEY_SCHEDULE, id }, &schedule);
        Ok(id)
    }

    /// Spawn the next stream instance from a schedule.
    ///
    /// Missed intervals are skipped deterministically: the next instance is
    /// always anchored at `start + spawned * interval`, so a late call never
    /// double-spawns an interval and never shifts the schedule. Each spawned
    /// instance is independently funded (the caller must supply `funding`
    /// covering `amount`) and independently cancellable. The schedule's sponsor
    /// (if any) is carried onto the instance for attribution only.
    pub fn spawn_from_schedule(
        env: Env,
        schedule_id: u64,
        funding: i128,
    ) -> Result<u64, Error> {
        let key = DataKey {
            kind: KEY_SCHEDULE,
            id: schedule_id,
        };
        let mut schedule: Schedule = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::ScheduleNotFound)?;

        schedule.owner.require_auth();

        if schedule.spawned >= schedule.count {
            return Err(Error::ScheduleExhausted);
        }
        if funding < schedule.amount {
            return Err(Error::InsufficientFunding);
        }

        let index = schedule.spawned;
        let start = schedule
            .start
            .checked_add((index as u64).checked_mul(schedule.interval).ok_or(Error::InvalidInterval)?)
            .ok_or(Error::InvalidInterval)?;

        // Deterministic linkage: stream id derived from schedule id + index.
        let stream_id = schedule
            .id
            .checked_mul(MAX_INSTANCES as u64)
            .and_then(|v| v.checked_add(index as u64))
            .ok_or(Error::InvalidCount)?;

        let stream = Stream {
            id: stream_id,
            owner: schedule.owner.clone(),
            recipient: schedule.recipient.clone(),
            sponsor: schedule.sponsor.clone(),
            amount: schedule.amount,
            start,
            cancelled: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey { kind: KEY_STREAM, id: stream_id }, &stream);

        schedule.spawned += 1;
        env.storage().persistent().set(&key, &schedule);
        Ok(stream_id)
    }

    /// Compute the deterministic rebate for a stream without applying it.
    ///
    /// Returns `0` for ineligible streams (unsponsored, cancelled, or below
    /// `MIN_REBATE_AMOUNT`). Otherwise returns
    /// `min(amount * REBATE_BPS / 10_000, MAX_REBATE)`, rounded down.
    pub fn quote_rebate(env: Env, stream_id: u64) -> Result<i128, Error> {
        let stream = load_stream(&env, stream_id)?;
        Ok(rebate_for(&stream))
    }

    /// Apply the fee rebate for an eligible stream.
    ///
    /// The stream owner must authorize. Rejects ineligible streams with
    /// `NotRebateEligible` and double-application with `RebateAlreadyApplied`.
    /// On success the rebate is recorded for the stream and accumulated into
    /// the treasury counter, and a `rebate` accounting event is emitted.
    pub fn apply_rebate(env: Env, stream_id: u64) -> Result<i128, Error> {
        let stream = load_stream(&env, stream_id)?;
        stream.owner.require_auth();

        let rebate_key = DataKey {
            kind: KEY_REBATE,
            id: stream_id,
        };
        if env.storage().persistent().has(&rebate_key) {
            return Err(Error::RebateAlreadyApplied);
        }

        let rebate = rebate_for(&stream);
        if rebate <= 0 {
            return Err(Error::NotRebateEligible);
        }

        // Conservation: a rebate can never exceed the stream amount.
        if rebate > stream.amount {
            return Err(Error::NotRebateEligible);
        }

        env.storage().persistent().set(&rebate_key, &rebate);

        let treasury_key = DataKey {
            kind: KEY_TREASURY,
            id: 0,
        };
        let total: i128 = env
            .storage()
            .persistent()
            .get(&treasury_key)
            .unwrap_or(0);
        let new_total = total.checked_add(rebate).ok_or(Error::InvalidAmount)?;
        env.storage().persistent().set(&treasury_key, &new_total);

        env.events().publish(
            (soroban_sdk::symbol_short!("rebate"), stream_id),
            (rebate, new_total),
        );

        Ok(rebate)
    }

    /// Total rebates accumulated into the treasury counter.
    pub fn treasury_rebates(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey {
                kind: KEY_TREASURY,
                id: 0,
            })
            .unwrap_or(0)
    }

    /// Rebate recorded for a stream, if any.
    pub fn stream_rebate(env: Env, stream_id: u64) -> Option<i128> {
        env.storage()
            .persistent()
            .get(&DataKey {
                kind: KEY_REBATE,
                id: stream_id,
            })
    }
}

fn load_stream(env: &Env, stream_id: u64) -> Result<Stream, Error> {
    env.storage()
        .persistent()
        .get(&DataKey {
            kind: KEY_STREAM,
            id: stream_id,
        })
        .ok_or(Error::StreamNotFound)
}

/// Deterministic rebate for a stream. Returns `0` when ineligible.
fn rebate_for(stream: &Stream) -> i128 {
    if stream.cancelled || stream.sponsor.is_none() {
        return 0;
    }
    if stream.amount < MIN_REBATE_AMOUNT {
        return 0;
    }
    let raw = stream.amount.saturating_mul(REBATE_BPS) / 10_000;
    if raw > MAX_REBATE {
        MAX_REBATE
    } else {
        raw
    }
}

fn next_id(env: &Env, kind: u32) -> u64 {
    let key = DataKey { kind, id: 0 };
    let current: u64 = env.storage().persistent().get(&key).unwrap_or(0);
    let next = current + 1;
    env.storage().persistent().set(&key, &next);
    next
}

fn enforce_ceilings(
    env: &Env,
    amount: i128,
    interval: u64,
    count: u32,
) -> Result<(), Error> {
    let policy: Policy = env
        .storage()
        .persistent()
        .get(&DataKey {
            kind: KEY_POLICY,
            id: 0,
        })
        .unwrap_or(Policy {
            max_rate: 0,
            max_duration: 0,
        });

    if policy.max_rate > 0 {
        let rate = amount / (interval as i128);
        if rate > policy.max_rate {
            return Err(Error::RateExceedsCeiling);
        }
    }

    if policy.max_duration > 0 {
        let duration = interval.saturating_mul(count as u64);
        if duration > policy.max_duration {
            return Err(Error::DurationExceedsCeiling);
        }
    }

    Ok(())
}
