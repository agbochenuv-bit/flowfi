use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StreamStatus {
    Active,
    Completed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransferStatus {
    Pending,
    Accepted,
    Rejected,
    Expired,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Stream {
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub deposit: i128,
    pub withdrawn: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub status: StreamStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferProposal {
    pub stream_id: u64,
    pub proposed_owner: Address,
    pub status: TransferStatus,
    pub expires_at: u64,
}

/// Lifecycle phase surfaced on a stream receipt.
///
/// Mapping from `StreamStatus`:
/// - `Active` -> `ReceiptLifecycle::Active`
/// - `Completed` -> `ReceiptLifecycle::Completed`
/// - `Cancelled` -> `ReceiptLifecycle::Cancelled`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReceiptLifecycle {
    Active,
    Completed,
    Cancelled,
}

/// Non-transferable, read-only receipt metadata for wallets and indexers.
///
/// A receipt is a *view* of a stream. Holding or observing a receipt confers
/// no privileged action: withdrawals, transfers, and cancellation still
/// require the stream's sender/recipient authorization checks. The receipt
/// carries no owner field and cannot be transferred.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamReceipt {
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub deposit: i128,
    pub withdrawn: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub lifecycle: ReceiptLifecycle,
}

const TRANSFER_TTL: u64 = 7 * 24 * 60 * 60;

#[contract]
pub struct StreamContract;

#[contractimpl]
impl StreamContract {
    fn stream_key(env: &Env, stream_id: u64) -> Symbol {
        let _ = env;
        let _ = stream_id;
        Symbol::new(env, "stream")
    }

    fn transfer_key(env: &Env, stream_id: u64) -> Symbol {
        let _ = stream_id;
        Symbol::new(env, "transfer")
    }

    fn lifecycle_of(status: &StreamStatus) -> ReceiptLifecycle {
        match status {
            StreamStatus::Active => ReceiptLifecycle::Active,
            StreamStatus::Completed => ReceiptLifecycle::Completed,
            StreamStatus::Cancelled => ReceiptLifecycle::Cancelled,
        }
    }

    pub fn get_stream(env: Env, stream_id: u64) -> Stream {
        env.storage()
            .persistent()
            .get(&Self::stream_key(&env, stream_id))
            .expect("stream not found")
    }

    /// Read-only receipt metadata derived from the current stream state.
    ///
    /// This is a pure view: it performs no authorization and mutates no
    /// storage, so receipt visibility never grants a privileged action.
    pub fn get_receipt(env: Env, stream_id: u64) -> StreamReceipt {
        let stream: Stream = Self::get_stream(env.clone(), stream_id);
        StreamReceipt {
            stream_id,
            sender: stream.sender,
            recipient: stream.recipient,
            token: stream.token,
            deposit: stream.deposit,
            withdrawn: stream.withdrawn,
            start_time: stream.start_time,
            end_time: stream.end_time,
            lifecycle: Self::lifecycle_of(&stream.status),
        }
    }

    pub fn get_transfer(env: Env, stream_id: u64) -> Option<TransferProposal> {
        env.storage()
            .persistent()
            .get(&Self::transfer_key(&env, stream_id))
    }

    /// Current sender proposes transferring future funding/management rights.
    /// Accrued recipient claims are preserved because `withdrawn` is untouched.
    pub fn propose_transfer(
        env: Env,
        stream_id: u64,
        proposed_owner: Address,
    ) -> TransferProposal {
        let stream: Stream = Self::get_stream(env.clone(), stream_id);
        stream.sender.require_auth();

        if stream.status != StreamStatus::Active {
            panic!("cannot transfer terminal stream");
        }

        let now = env.ledger().timestamp();
        let proposal = TransferProposal {
            stream_id,
            proposed_owner: proposed_owner.clone(),
            status: TransferStatus::Pending,
            expires_at: now + TRANSFER_TTL,
        };

        env.storage()
            .persistent()
            .set(&Self::transfer_key(&env, stream_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "transfer_pending"), stream_id),
            (stream.sender, proposed_owner),
        );

        proposal
    }

    /// Proposed owner accepts, taking over sender rights. Recipient claims preserved.
    pub fn accept_transfer(env: Env, stream_id: u64) -> Stream {
        let mut proposal: TransferProposal = env
            .storage()
            .persistent()
            .get(&Self::transfer_key(&env, stream_id))
            .expect("no transfer proposal");

        if proposal.status != TransferStatus::Pending {
            panic!("proposal not pending");
        }

        proposal.proposed_owner.require_auth();

        let now = env.ledger().timestamp();
        if now > proposal.expires_at {
            proposal.status = TransferStatus::Expired;
            env.storage()
                .persistent()
                .set(&Self::transfer_key(&env, stream_id), &proposal);
            env.events()
                .publish((Symbol::new(&env, "transfer_expired"), stream_id), ());
            panic!("proposal expired");
        }

        let mut stream: Stream = Self::get_stream(env.clone(), stream_id);
        if stream.status != StreamStatus::Active {
            panic!("cannot transfer terminal stream");
        }

        let previous_sender = stream.sender.clone();
        stream.sender = proposal.proposed_owner.clone();
        proposal.status = TransferStatus::Accepted;

        env.storage()
            .persistent()
            .set(&Self::stream_key(&env, stream_id), &stream);
        env.storage()
            .persistent()
            .set(&Self::transfer_key(&env, stream_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "transfer_accepted"), stream_id),
            (previous_sender, proposal.proposed_owner),
        );

        stream
    }

    /// Proposed owner rejects the proposal.
    pub fn reject_transfer(env: Env, stream_id: u64) {
        let mut proposal: TransferProposal = env
            .storage()
            .persistent()
            .get(&Self::transfer_key(&env, stream_id))
            .expect("no transfer proposal");

        if proposal.status != TransferStatus::Pending {
            panic!("proposal not pending");
        }

        proposal.proposed_owner.require_auth();
        proposal.status = TransferStatus::Rejected;

        env.storage()
            .persistent()
            .set(&Self::transfer_key(&env, stream_id), &proposal);

        env.events()
            .publish((Symbol::new(&env, "transfer_rejected"), stream_id), ());
    }

    /// Mark a pending proposal expired once its TTL has elapsed.
    pub fn expire_transfer(env: Env, stream_id: u64) {
        let mut proposal: TransferProposal = env
            .storage()
            .persistent()
            .get(&Self::transfer_key(&env, stream_id))
            .expect("no transfer proposal");

        if proposal.status != TransferStatus::Pending {
            panic!("proposal not pending");
        }

        let now = env.ledger().timestamp();
        if now <= proposal.expires_at {
            panic!("proposal not expired");
        }

        proposal.status = TransferStatus::Expired;
        env.storage()
            .persistent()
            .set(&Self::transfer_key(&env, stream_id), &proposal);

        env.events()
            .publish((Symbol::new(&env, "transfer_expired"), stream_id), ());
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::Env;

    fn setup(env: &Env) -> (StreamContractClient, u64, Address, Address) {
        let contract_id = env.register_contract(None, StreamContract);
        let client = StreamContractClient::new(env, &contract_id);
        let sender = Address::generate(env);
        let recipient = Address::generate(env);
        let token = Address::generate(env);
        let stream = Stream {
            sender: sender.clone(),
            recipient: recipient.clone(),
            token,
            deposit: 1000,
            withdrawn: 250,
            start_time: 0,
            end_time: 1000,
            status: StreamStatus::Active,
        };
        env.storage()
            .persistent()
            .set(&StreamContract::stream_key(env, 1), &stream);
        (client, 1, sender, recipient)
    }

    #[test]
    fn accept_transfer_preserves_claims() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, id, _sender, _recipient) = setup(&env);
        let new_owner = Address::generate(&env);

        client.propose_transfer(&id, &new_owner);
        let stream = client.accept_transfer(&id);

        assert_eq!(stream.sender, new_owner);
        assert_eq!(stream.withdrawn, 250);
        assert_eq!(stream.recipient, _recipient);
    }

    #[test]
    fn reject_transfer_keeps_sender() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, id, sender, _recipient) = setup(&env);
        let new_owner = Address::generate(&env);

        client.propose_transfer(&id, &new_owner);
        client.reject_transfer(&id);

        assert_eq!(client.get_stream(&id).sender, sender);
        assert_eq!(
            client.get_transfer(&id).unwrap().status,
            TransferStatus::Rejected
        );
    }

    #[test]
    fn expire_transfer_after_ttl() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, id, _sender, _recipient) = setup(&env);
        let new_owner = Address::generate(&env);

        client.propose_transfer(&id, &new_owner);
        env.ledger().set_timestamp(TRANSFER_TTL + 1);
        client.expire_transfer(&id);

        assert_eq!(
            client.get_transfer(&id).unwrap().status,
            TransferStatus::Expired
        );
    }

    #[test]
    fn receipt_reflects_active_stream() {
        let env = Env::default();
        let (client, id, sender, recipient) = setup(&env);

        let receipt = client.get_receipt(&id);

        assert_eq!(receipt.stream_id, id);
        assert_eq!(receipt.sender, sender);
        assert_eq!(receipt.recipient, recipient);
        assert_eq!(receipt.deposit, 1000);
        assert_eq!(receipt.withdrawn, 250);
        assert_eq!(receipt.start_time, 0);
        assert_eq!(receipt.end_time, 1000);
        assert_eq!(receipt.lifecycle, ReceiptLifecycle::Active);
    }

    #[test]
    fn receipt_metadata_stable_across_transfer() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, id, _sender, recipient) = setup(&env);
        let new_owner = Address::generate(&env);

        let before = client.get_receipt(&id);
        client.propose_transfer(&id, &new_owner);
        client.accept_transfer(&id);
        let after = client.get_receipt(&id);

        // Immutable receipt fields are preserved through the transfer.
        assert_eq!(before.stream_id, after.stream_id);
        assert_eq!(before.recipient, after.recipient);
        assert_eq!(before.token, after.token);
        assert_eq!(before.deposit, after.deposit);
        assert_eq!(before.withdrawn, after.withdrawn);
        assert_eq!(before.start_time, after.start_time);
        assert_eq!(before.end_time, after.end_time);
        assert_eq!(before.lifecycle, after.lifecycle);
        // Only the sender (management) field follows the transfer.
        assert_eq!(after.sender, new_owner);
        assert_eq!(after.recipient, recipient);
    }

    #[test]
    fn receipt_lifecycle_maps_terminal_states() {
        let env = Env::default();
        let (client, id, _sender, _recipient) = setup(&env);

        let mut stream = client.get_stream(&id);
        stream.status = StreamStatus::Completed;
        env.storage()
            .persistent()
            .set(&StreamContract::stream_key(&env, id), &stream);
        assert_eq!(client.get_receipt(&id).lifecycle, ReceiptLifecycle::Completed);

        stream.status = StreamStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&StreamContract::stream_key(&env, id), &stream);
        assert_eq!(client.get_receipt(&id).lifecycle, ReceiptLifecycle::Cancelled);
    }

    #[test]
    fn receipt_visibility_grants_no_privileged_action() {
        let env = Env::default();
        let (client, id, _sender, _recipient) = setup(&env);
        let observer = Address::generate(&env);

        // Reading the receipt requires no auth and succeeds for anyone.
        let _ = client.get_receipt(&id);

        // Without the sender's authorization, a transfer proposal must fail
        // even though the observer can see the receipt.
        let result = client.try_propose_transfer(&id, &observer);
        assert!(result.is_err());
    }

    #[test]
    fn receipt_missing_stream_fails() {
        let env = Env::default();
        let (client, _id, _sender, _recipient) = setup(&env);

        let result = client.try_get_receipt(&999);
        assert!(result.is_err());
    }
}
