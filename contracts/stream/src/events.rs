use soroban_sdk::{contracttype, Address, Env};

/// Emitted when a new stream is created.
///
/// `sponsor` is `Some(addr)` when a third party covered the transaction costs
/// and/or initial funding for the stream. The sponsor never receives sender or
/// recipient privileges; those remain bound to `sender` and `recipient`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCreated {
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub sponsor: Option<Address>,
    pub amount: i128,
}

/// Emitted when a sponsor funds or covers costs for an existing stream.
///
/// Kept separate from `StreamCreated` so sponsorship attribution is explicit
/// and never conflated with sender/recipient roles.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamSponsored {
    pub stream_id: u64,
    pub sponsor: Address,
    pub amount: i128,
}

/// Emitted when a fee rebate is applied to an eligible stream operation.
///
/// `fee_charged` is the fee actually collected after the rebate, `rebate` is
/// the amount returned to the payer, and `treasury_delta` is the net change to
/// the treasury balance. Invariant: `fee_charged + rebate == gross_fee` and
/// `treasury_delta == fee_charged`, so funds are conserved across the rebate.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeRebateApplied {
    pub stream_id: u64,
    pub payer: Address,
    pub gross_fee: i128,
    pub rebate: i128,
    pub fee_charged: i128,
    pub treasury_delta: i128,
}

/// Emitted when the treasury balance is adjusted as part of rebate accounting.
///
/// Kept separate from `FeeRebateApplied` so treasury movements are auditable
/// independently of the rebate decision that produced them.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TreasuryAdjusted {
    pub stream_id: u64,
    pub delta: i128,
    pub balance_after: i128,
}

pub fn emit_stream_created(
    env: &Env,
    stream_id: u64,
    sender: &Address,
    recipient: &Address,
    sponsor: &Option<Address>,
    amount: i128,
) {
    let event = StreamCreated {
        stream_id,
        sender: sender.clone(),
        recipient: recipient.clone(),
        sponsor: sponsor.clone(),
        amount,
    };
    env.events().publish(("stream_created",), event);
}

pub fn emit_stream_sponsored(env: &Env, stream_id: u64, sponsor: &Address, amount: i128) {
    let event = StreamSponsored {
        stream_id,
        sponsor: sponsor.clone(),
        amount,
    };
    env.events().publish(("stream_sponsored",), event);
}

pub fn emit_fee_rebate_applied(
    env: &Env,
    stream_id: u64,
    payer: &Address,
    gross_fee: i128,
    rebate: i128,
    fee_charged: i128,
    treasury_delta: i128,
) {
    let event = FeeRebateApplied {
        stream_id,
        payer: payer.clone(),
        gross_fee,
        rebate,
        fee_charged,
        treasury_delta,
    };
    env.events().publish(("fee_rebate_applied",), event);
}

pub fn emit_treasury_adjusted(env: &Env, stream_id: u64, delta: i128, balance_after: i128) {
    let event = TreasuryAdjusted {
        stream_id,
        delta,
        balance_after,
    };
    env.events().publish(("treasury_adjusted",), event);
}
