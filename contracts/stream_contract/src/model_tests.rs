//! Model-based lifecycle sequences. The small state machine below uses only
//! accounting rules; every operation is also sent to the Soroban contract.
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env,
};

#[derive(Clone, Copy, Debug)]
enum Op {
    Advance(u64),
    Pause,
    Resume,
    TopUp(i128),
    Withdraw,
    Cancel,
    WrongWithdraw,
}

#[derive(Debug)]
struct Model {
    deposited: i128,
    withdrawn: i128,
    rate: i128,
    anchor: u64,
    paused_at: Option<u64>,
    active: bool,
}

impl Model {
    fn claimable(&self, now: u64) -> i128 {
        if !self.active {
            return 0;
        }
        let until = self.paused_at.unwrap_or(now);
        ((until - self.anchor) as i128 * self.rate).min(self.deposited - self.withdrawn)
    }
}

// Fixed LCG makes every generated case reproducible without external entropy.
fn sequence(seed: u64) -> std::vec::Vec<Op> {
    let mut value = seed;
    let mut ops = std::vec::Vec::new();
    for _ in 0..24 {
        value = value.wrapping_mul(6364136223846793005).wrapping_add(1);
        ops.push(match (value >> 32) % 7 {
            0 => Op::Advance(1 + value % 20),
            1 => Op::Pause,
            2 => Op::Resume,
            3 => Op::TopUp(if value & 1 == 0 { 100 } else { 0 }),
            4 => Op::Withdraw,
            5 => Op::Cancel,
            _ => Op::WrongWithdraw,
        });
    }
    ops
}

fn run(seed: u64, ops: &[Op]) {
    let env = Env::default();
    env.mock_all_auths();
    let token_address = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let stranger = Address::generate(&env);
    token::StellarAssetClient::new(&env, &token_address).mint(&sender, &10_000);
    let contract = StreamContractClient::new(&env, &env.register(StreamContract, ()));
    let stream_id = contract.create_stream(&sender, &recipient, &token_address, &1_000, &100);
    let mut model = Model {
        deposited: 1_000,
        withdrawn: 0,
        rate: 10,
        anchor: env.ledger().timestamp(),
        paused_at: None,
        active: true,
    };
    let token_client = token::Client::new(&env, &token_address);
    let initial_sender_balance = token_client.balance(&sender);

    for (index, op) in ops.iter().enumerate() {
        let now = env.ledger().timestamp();
        let expected = match *op {
            Op::Advance(seconds) => {
                env.ledger().with_mut(|l| l.timestamp += seconds);
                true
            }
            Op::Pause => {
                let valid = model.active && model.paused_at.is_none();
                assert_eq!(
                    contract.try_pause_stream(&sender, &stream_id).is_ok(),
                    valid,
                    "seed={seed} step={index}"
                );
                if valid {
                    model.paused_at = Some(now);
                }
                valid
            }
            Op::Resume => {
                let valid = model.active && model.paused_at.is_some();
                assert_eq!(
                    contract.try_resume_stream(&sender, &stream_id).is_ok(),
                    valid,
                    "seed={seed} step={index}"
                );
                if let Some(paused) = model.paused_at.filter(|_| valid) {
                    model.anchor += now - paused;
                    model.paused_at = None;
                }
                valid
            }
            Op::TopUp(amount) => {
                let valid = model.active && amount > 0;
                assert_eq!(
                    contract
                        .try_top_up_stream(&sender, &stream_id, &amount)
                        .is_ok(),
                    valid,
                    "seed={seed} step={index}"
                );
                if valid {
                    model.deposited += amount;
                }
                valid
            }
            Op::Withdraw => {
                let claimable = model.claimable(now);
                let valid = model.active && model.paused_at.is_none() && claimable > 0;
                let result = contract.try_withdraw(&recipient, &stream_id);
                assert_eq!(result.is_ok(), valid, "seed={seed} step={index}");
                if valid {
                    assert_eq!(result.unwrap().unwrap(), claimable);
                    model.withdrawn += claimable;
                    model.anchor = now;
                    if model.withdrawn == model.deposited {
                        model.active = false;
                    }
                }
                valid
            }
            Op::Cancel => {
                let valid = model.active;
                assert_eq!(
                    contract.try_cancel_stream(&sender, &stream_id).is_ok(),
                    valid,
                    "seed={seed} step={index}"
                );
                if valid {
                    model.withdrawn += model.claimable(now);
                    model.active = false;
                    model.paused_at = None;
                }
                valid
            }
            Op::WrongWithdraw => {
                assert!(
                    contract.try_withdraw(&stranger, &stream_id).is_err(),
                    "seed={seed} step={index}"
                );
                false
            }
        };
        let stream = contract.get_stream(&stream_id).unwrap();
        assert_eq!(
            stream.deposited_amount, model.deposited,
            "seed={seed} step={index} op={op:?}"
        );
        assert_eq!(
            stream.withdrawn_amount, model.withdrawn,
            "seed={seed} step={index} op={op:?}"
        );
        assert_eq!(
            stream.is_active, model.active,
            "seed={seed} step={index} op={op:?}"
        );
        assert_eq!(
            stream.paused,
            model.paused_at.is_some(),
            "seed={seed} step={index} op={op:?}"
        );
        assert!(
            model.withdrawn <= model.deposited,
            "seed={seed} step={index}"
        );
        if model.active {
            assert_eq!(
                contract.get_claimable_amount(&stream_id),
                Some(model.claimable(env.ledger().timestamp())),
                "seed={seed} step={index} op={op:?}"
            );
        }
        // Tokens are conserved across recipient, sender, and contract balances.
        assert_eq!(
            token_client.balance(&sender)
                + token_client.balance(&recipient)
                + token_client.balance(&contract.address),
            initial_sender_balance + 1_000,
            "seed={seed} step={index} op={op:?} accepted={expected}"
        );
        if !model.active {
            assert_eq!(model.claimable(env.ledger().timestamp()), 0);
        }
    }
}

#[test]
fn generated_lifecycle_sequences_match_reference_model() {
    for seed in 1..=32 {
        run(seed, &sequence(seed));
    }
}

#[test]
fn minimized_regression_sequences() {
    // Keep a failing seed here after reducing its operation list.
    run(
        0,
        &[
            Op::Advance(10),
            Op::Pause,
            Op::Advance(20),
            Op::Resume,
            Op::Withdraw,
            Op::Cancel,
        ],
    );
    run(
        0,
        &[Op::TopUp(0), Op::WrongWithdraw, Op::Cancel, Op::Resume],
    );
}
