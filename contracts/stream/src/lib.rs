use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol};

const DAY_IN_LEDGERS: u32 = 17_280;
const PERSISTENT_BUMP: u32 = DAY_IN_LEDGERS * 30;
const PERSISTENT_THRESHOLD: u32 = DAY_IN_LEDGERS * 7;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum StreamError {
    NotFound = 1,
    Unauthorized = 2,
    InvalidRate = 3,
    InvalidEffectiveTime = 4,
    StaleState = 5,
    AmendmentNotFound = 6,
    AlreadyApproved = 7,
    AmendmentNotReady = 8,
    AmendmentExpired = 9,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Stream {
    pub sender: Address,
    pub recipient: Address,
    pub rate: i128,
    pub last_accrual: u64,
    pub accrued: i128,
    pub paused: bool,
    pub version: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Amendment {
    pub id: u64,
    pub new_rate: i128,
    pub effective_at: u64,
    pub base_version: u32,
    pub sender_approved: bool,
    pub recipient_approved: bool,
    pub applied: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AmendmentProposed {
    pub stream_id: u64,
    pub amendment_id: u64,
    pub new_rate: i128,
    pub effective_at: u64,
    pub base_version: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AmendmentApproved {
    pub stream_id: u64,
    pub amendment_id: u64,
    pub approver: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AmendmentApplied {
    pub stream_id: u64,
    pub amendment_id: u64,
    pub old_rate: i128,
    pub new_rate: i128,
    pub effective_at: u64,
    pub accrued_preserved: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AmendmentRejected {
    pub stream_id: u64,
    pub amendment_id: u64,
    pub reason: u32,
}

fn stream_key(env: &Env, id: u64) -> Symbol {
    let _ = env;
    let _ = id;
    symbol_short!("stream")
}

fn amendment_key(env: &Env, stream_id: u64, amendment_id: u64) -> (Symbol, u64, u64) {
    let _ = env;
    (symbol_short!("amend"), stream_id, amendment_id)
}

fn load_stream(env: &Env, id: u64) -> Result<Stream, StreamError> {
    env.storage()
        .persistent()
        .get(&stream_key(env, id))
        .ok_or(StreamError::NotFound)
}

fn save_stream(env: &Env, id: u64, stream: &Stream) {
    let key = stream_key(env, id);
    env.storage().persistent().set(&key, stream);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_THRESHOLD, PERSISTENT_BUMP);
}

fn load_amendment(env: &Env, stream_id: u64, amendment_id: u64) -> Result<Amendment, StreamError> {
    env.storage()
        .persistent()
        .get(&amendment_key(env, stream_id, amendment_id))
        .ok_or(StreamError::AmendmentNotFound)
}

fn save_amendment(env: &Env, stream_id: u64, amendment: &Amendment) {
    let key = amendment_key(env, stream_id, amendment.id);
    env.storage().persistent().set(&key, amendment);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_THRESHOLD, PERSISTENT_BUMP);
}

fn accrue(stream: &mut Stream, now: u64) {
    if stream.paused || now <= stream.last_accrual {
        return;
    }
    let elapsed = (now - stream.last_accrual) as i128;
    stream.accrued += stream.rate * elapsed;
    stream.last_accrual = now;
}

#[contract]
pub struct StreamContract;

#[contractimpl]
impl StreamContract {
    pub fn propose_amendment(
        env: Env,
        stream_id: u64,
        proposer: Address,
        new_rate: i128,
        effective_at: u64,
        base_version: u32,
    ) -> Result<u64, StreamError> {
        proposer.require_auth();
        if new_rate < 0 {
            return Err(StreamError::InvalidRate);
        }
        let stream = load_stream(&env, stream_id)?;
        if proposer != stream.sender && proposer != stream.recipient {
            return Err(StreamError::Unauthorized);
        }
        if base_version != stream.version {
            return Err(StreamError::StaleState);
        }
        let now = env.ledger().timestamp();
        if effective_at <= now {
            return Err(StreamError::InvalidEffectiveTime);
        }
        let amendment_id = env
            .storage()
            .instance()
            .get::<Symbol, u64>(&symbol_short!("amendct"))
            .unwrap_or(0)
            + 1;
        env.storage()
            .instance()
            .set(&symbol_short!("amendct"), &amendment_id);
        let amendment = Amendment {
            id: amendment_id,
            new_rate,
            effective_at,
            base_version,
            sender_approved: proposer == stream.sender,
            recipient_approved: proposer == stream.recipient,
            applied: false,
        };
        save_amendment(&env, stream_id, &amendment);
        env.events().publish(
            (symbol_short!("amend"), symbol_short!("propose")),
            AmendmentProposed {
                stream_id,
                amendment_id,
                new_rate,
                effective_at,
                base_version,
            },
        );
        Ok(amendment_id)
    }

    pub fn approve_amendment(
        env: Env,
        stream_id: u64,
        amendment_id: u64,
        approver: Address,
    ) -> Result<(), StreamError> {
        approver.require_auth();
        let stream = load_stream(&env, stream_id)?;
        let mut amendment = load_amendment(&env, stream_id, amendment_id)?;
        if amendment.applied {
            return Err(StreamError::AlreadyApproved);
        }
        if amendment.base_version != stream.version {
            return Err(StreamError::StaleState);
        }
        if env.ledger().timestamp() >= amendment.effective_at {
            return Err(StreamError::AmendmentExpired);
        }
        if approver == stream.sender {
            if amendment.sender_approved {
                return Err(StreamError::AlreadyApproved);
            }
            amendment.sender_approved = true;
        } else if approver == stream.recipient {
            if amendment.recipient_approved {
                return Err(StreamError::AlreadyApproved);
            }
            amendment.recipient_approved = true;
        } else {
            return Err(StreamError::Unauthorized);
        }
        save_amendment(&env, stream_id, &amendment);
        env.events().publish(
            (symbol_short!("amend"), symbol_short!("approve")),
            AmendmentApproved {
                stream_id,
                amendment_id,
                approver,
            },
        );
        Ok(())
    }

    pub fn apply_amendment(
        env: Env,
        stream_id: u64,
        amendment_id: u64,
    ) -> Result<(), StreamError> {
        let mut stream = load_stream(&env, stream_id)?;
        let mut amendment = load_amendment(&env, stream_id, amendment_id)?;
        if amendment.applied {
            return Err(StreamError::AlreadyApproved);
        }
        if amendment.base_version != stream.version {
            return Err(StreamError::StaleState);
        }
        if !(amendment.sender_approved && amendment.recipient_approved) {
            return Err(StreamError::AmendmentNotReady);
        }
        let now = env.ledger().timestamp();
        if now < amendment.effective_at {
            return Err(StreamError::InvalidEffectiveTime);
        }
        accrue(&mut stream, amendment.effective_at);
        let old_rate = stream.rate;
        let accrued_preserved = stream.accrued;
        stream.rate = amendment.new_rate;
        stream.version += 1;
        amendment.applied = true;
        save_stream(&env, stream_id, &stream);
        save_amendment(&env, stream_id, &amendment);
        env.events().publish(
            (symbol_short!("amend"), symbol_short!("apply")),
            AmendmentApplied {
                stream_id,
                amendment_id,
                old_rate,
                new_rate: amendment.new_rate,
                effective_at: amendment.effective_at,
                accrued_preserved,
            },
        );
        Ok(())
    }

    pub fn reject_amendment(
        env: Env,
        stream_id: u64,
        amendment_id: u64,
        rejector: Address,
    ) -> Result<(), StreamError> {
        rejector.require_auth();
        let stream = load_stream(&env, stream_id)?;
        let mut amendment = load_amendment(&env, stream_id, amendment_id)?;
        if rejector != stream.sender && rejector != stream.recipient {
            return Err(StreamError::Unauthorized);
        }
        if amendment.applied {
            return Err(StreamError::AlreadyApproved);
        }
        amendment.applied = true;
        save_amendment(&env, stream_id, &amendment);
        env.events().publish(
            (symbol_short!("amend"), symbol_short!("reject")),
            AmendmentRejected {
                stream_id,
                amendment_id,
                reason: StreamError::Unauthorized as u32,
            },
        );
        Ok(())
    }

    pub fn get_amendment(env: Env, stream_id: u64, amendment_id: u64) -> Result<Amendment, StreamError> {
        load_amendment(&env, stream_id, amendment_id)
    }
}
