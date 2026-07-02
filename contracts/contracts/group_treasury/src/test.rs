#![cfg(test)]

use super::*;
use crate::storage::{DataKey, ProposalStatus, WithdrawProposal};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env,
};

// ── Minimal mock token contract ───────────────────────────────────────────────

mod mock_token {
    use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

    #[contracttype]
    pub enum Key {
        Balance(Address),
    }

    #[contract]
    pub struct MockToken;

    #[contractimpl]
    impl MockToken {
        pub fn mint(env: Env, to: Address, amount: i128) {
            let key = Key::Balance(to);
            let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
            env.storage().persistent().set(&key, &(current + amount));
        }

        pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
            from.require_auth();
            let from_key = Key::Balance(from.clone());
            let to_key = Key::Balance(to.clone());
            let from_bal: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
            assert!(from_bal >= amount, "insufficient balance");
            env.storage()
                .persistent()
                .set(&from_key, &(from_bal - amount));
            let to_bal: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
            env.storage().persistent().set(&to_key, &(to_bal + amount));
        }

        pub fn balance(env: Env, id: Address) -> i128 {
            env.storage()
                .persistent()
                .get(&Key::Balance(id))
                .unwrap_or(0)
        }
    }
}

use mock_token::MockTokenClient;

/// Returns (contract_id, token_id, admin, member)
fn setup(env: &Env) -> (Address, Address, Address, Address) {
    let admin = Address::generate(env);
    let member = Address::generate(env);

    let token_id = env.register(mock_token::MockToken, ());
    let token = MockTokenClient::new(env, &token_id);
    token.mint(&member, &1_000_000);

    let contract_id = env.register(GroupTreasuryContract, ());
    let client = GroupTreasuryContractClient::new(env, &contract_id);
    client.initialize(&admin, &token_id, &1);

    (contract_id, token_id, admin, member)
}

#[test]
fn test_initialize() {
    let env = Env::default();
    let (contract_id, token_id, _admin, _member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    assert_eq!(client.balance(&token_id), 0);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let env = Env::default();
    let (contract_id, token_id, _admin, _member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let other = Address::generate(&env);
    client.initialize(&other, &token_id, &1);
}

#[test]
fn test_deposit_increases_balance() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, token_id, _admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    client.deposit(&member, &token_id, &300_000);
    assert_eq!(client.balance(&token_id), 300_000);
}

#[test]
fn test_balance_reflects_multiple_deposits() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, token_id, _admin, member) = setup(&env);
    let token = MockTokenClient::new(&env, &token_id);
    let member2 = Address::generate(&env);
    token.mint(&member2, &500_000);

    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    client.deposit(&member, &token_id, &200_000);
    client.deposit(&member2, &token_id, &150_000);

    assert_eq!(client.balance(&token_id), 350_000);
}

#[test]
fn test_admin_can_withdraw() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, token_id, _admin, member) = setup(&env);
    let token = MockTokenClient::new(&env, &token_id);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);

    client.deposit(&member, &token_id, &400_000);
    client.withdraw(&recipient, &token_id, &100_000);

    assert_eq!(client.balance(&token_id), 300_000);
    assert_eq!(token.balance(&recipient), 100_000);
}

#[test]
fn test_balance_correct_after_deposits_and_withdrawals() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, token_id, _admin, member) = setup(&env);
    let token = MockTokenClient::new(&env, &token_id);
    let member2 = Address::generate(&env);
    token.mint(&member2, &500_000);

    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);

    client.deposit(&member, &token_id, &600_000);
    client.deposit(&member2, &token_id, &200_000);
    client.withdraw(&recipient, &token_id, &300_000);

    // 600_000 + 200_000 - 300_000 = 500_000
    assert_eq!(client.balance(&token_id), 500_000);
}

#[test]
#[should_panic]
fn test_non_admin_cannot_withdraw() {
    let env = Env::default();
    // Do not mock all auths — calling withdraw without the admin's auth must panic.

    let admin = Address::generate(&env);
    let token_id = env.register(mock_token::MockToken, ());

    let contract_id = env.register(GroupTreasuryContract, ());
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id, &1);

    let recipient = Address::generate(&env);
    // admin.require_auth() inside withdraw will fail — no auth context set up.
    client.withdraw(&recipient, &token_id, &100);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_deposit_zero_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, token_id, _admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    client.deposit(&member, &token_id, &0);
}

#[test]
fn test_multi_token_deposits_tracked_separately() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let member = Address::generate(&env);

    // Register two different tokens (e.g. XLM and USDC)
    let xlm_id = env.register(mock_token::MockToken, ());
    let usdc_id = env.register(mock_token::MockToken, ());

    let xlm = MockTokenClient::new(&env, &xlm_id);
    let usdc = MockTokenClient::new(&env, &usdc_id);

    xlm.mint(&member, &100_000);
    usdc.mint(&member, &100_000);

    let contract_id = env.register(GroupTreasuryContract, ());
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    client.initialize(&admin, &xlm_id, &1); // initialize with XLM for compatibility

    // Deposit XLM and USDC
    client.deposit(&member, &xlm_id, &40_000);
    client.deposit(&member, &usdc_id, &70_000);

    // Verify balances are tracked separately
    assert_eq!(client.balance(&xlm_id), 40_000);
    assert_eq!(client.balance(&usdc_id), 70_000);
}

#[test]
#[should_panic(expected = "insufficient funds")]
fn test_withdraw_insufficient_funds_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, token_id, _admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);

    client.deposit(&member, &token_id, &50_000);
    client.withdraw(&recipient, &token_id, &60_000); // 60k is more than 50k balance
}

// ── Member Management Tests ───────────────────────────────────────────────────

#[test]
fn test_add_member() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, _token_id, admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    client.add_member(&member);
    assert!(client.is_member(&member));
}

#[test]
#[should_panic(expected = "member already exists")]
fn test_add_duplicate_member_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, _token_id, _admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    client.add_member(&member);
    client.add_member(&member); // Should panic
}

#[test]
#[should_panic]
fn test_non_admin_cannot_add_member() {
    let env = Env::default();
    // Do not mock all auths - non-admin should fail

    let admin = Address::generate(&env);
    let member = Address::generate(&env);
    let non_admin = Address::generate(&env);

    let token_id = env.register(mock_token::MockToken, ());
    let contract_id = env.register(GroupTreasuryContract, ());
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id, &1);

    // non_admin tries to add member - should fail due to auth
    client.add_member(&member);
}

#[test]
fn test_remove_member() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, _token_id, _admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    client.add_member(&member);
    assert!(client.is_member(&member));

    client.remove_member(&member);
    assert!(!client.is_member(&member));
}

#[test]
#[should_panic(expected = "member not found")]
fn test_remove_nonexistent_member_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, _token_id, _admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    client.remove_member(&member); // Member was never added
}

#[test]
fn test_get_members() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, _token_id, _admin, member1) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    let member2 = Address::generate(&env);
    let member3 = Address::generate(&env);

    client.add_member(&member1);
    client.add_member(&member2);
    client.add_member(&member3);

    let members = client.get_members();
    assert_eq!(members.len(), 3);
}

#[test]
fn test_is_member_returns_false_for_non_member() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, _token_id, _admin, _member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    let non_member = Address::generate(&env);
    assert!(!client.is_member(&non_member));
}

#[test]
fn test_initialize_creates_empty_members_list() {
    let env = Env::default();
    let (contract_id, _token_id, _admin, _member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    let members = client.get_members();
    assert_eq!(members.len(), 0);
}

// ── Threshold Tests ───────────────────────────────────────────────────────────

#[test]
fn test_get_threshold_returns_configured_value() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let token_id = env.register(mock_token::MockToken, ());

    let contract_id = env.register(GroupTreasuryContract, ());
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id, &3);

    assert_eq!(client.get_threshold(), 3);
}

#[test]
#[should_panic(expected = "threshold must be at least 1")]
fn test_initialize_zero_threshold_panics() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let token_id = env.register(mock_token::MockToken, ());

    let contract_id = env.register(GroupTreasuryContract, ());
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id, &0);
}

// ── Voting Tests (approve_withdraw / reject_withdraw) ──────────────────────────

/// Registers a treasury initialised with `threshold`, mocks all auths, and adds
/// `num_members` members. Returns (contract_id, token_id, members).
fn voting_setup(
    env: &Env,
    threshold: u32,
    num_members: u32,
) -> (Address, Address, soroban_sdk::Vec<Address>) {
    env.mock_all_auths();

    let admin = Address::generate(env);
    let token_id = env.register(mock_token::MockToken, ());
    let contract_id = env.register(GroupTreasuryContract, ());
    let client = GroupTreasuryContractClient::new(env, &contract_id);
    client.initialize(&admin, &token_id, &threshold);

    let mut members = soroban_sdk::Vec::new(env);
    for _ in 0..num_members {
        let member = Address::generate(env);
        client.add_member(&member);
        members.push_back(member);
    }

    (contract_id, token_id, members)
}

/// Writes a pending `WithdrawProposal` straight into contract storage. Stands in
/// for `propose_withdraw` (#122), which is not implemented yet.
fn seed_proposal(
    env: &Env,
    contract_id: &Address,
    id: u32,
    to: &Address,
    token: &Address,
    amount: i128,
    expires_at: u64,
) {
    env.as_contract(contract_id, || {
        let proposal = WithdrawProposal {
            id,
            proposer: to.clone(),
            to: to.clone(),
            token: token.clone(),
            amount,
            approvals: 0,
            rejections: 0,
            status: ProposalStatus::Active,
            expires_at,
        };
        env.storage()
            .instance()
            .set(&DataKey::Proposal(id), &proposal);
    });
}

#[test]
fn test_approve_reaches_threshold_passes() {
    let env = Env::default();
    let (contract_id, token_id, members) = voting_setup(&env, 2, 2);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);
    seed_proposal(&env, &contract_id, 0, &recipient, &token_id, 1_000, 10_000);

    client.approve_withdraw(&members.get(0).unwrap(), &0);
    let after_first = client.get_proposal(&0);
    assert_eq!(after_first.approvals, 1);
    assert_eq!(after_first.status, ProposalStatus::Active);

    client.approve_withdraw(&members.get(1).unwrap(), &0);
    let after_second = client.get_proposal(&0);
    assert_eq!(after_second.approvals, 2);
    assert_eq!(after_second.status, ProposalStatus::Passed);
}

#[test]
fn test_single_approval_below_threshold_stays_active() {
    let env = Env::default();
    let (contract_id, token_id, members) = voting_setup(&env, 2, 2);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);
    seed_proposal(&env, &contract_id, 0, &recipient, &token_id, 1_000, 10_000);

    client.approve_withdraw(&members.get(0).unwrap(), &0);

    let proposal = client.get_proposal(&0);
    assert_eq!(proposal.approvals, 1);
    assert_eq!(proposal.status, ProposalStatus::Active);
}

#[test]
#[should_panic(expected = "already voted")]
fn test_double_vote_panics() {
    let env = Env::default();
    let (contract_id, token_id, members) = voting_setup(&env, 2, 2);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);
    seed_proposal(&env, &contract_id, 0, &recipient, &token_id, 1_000, 10_000);

    let voter = members.get(0).unwrap();
    client.approve_withdraw(&voter, &0);
    client.approve_withdraw(&voter, &0); // second vote must panic
}

#[test]
#[should_panic(expected = "already voted")]
fn test_approve_then_reject_same_member_panics() {
    let env = Env::default();
    let (contract_id, token_id, members) = voting_setup(&env, 2, 2);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);
    seed_proposal(&env, &contract_id, 0, &recipient, &token_id, 1_000, 10_000);

    let voter = members.get(0).unwrap();
    client.approve_withdraw(&voter, &0);
    client.reject_withdraw(&voter, &0); // switching vote must panic
}

#[test]
#[should_panic(expected = "not a member")]
fn test_non_member_approve_panics() {
    let env = Env::default();
    let (contract_id, token_id, _members) = voting_setup(&env, 1, 1);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);
    seed_proposal(&env, &contract_id, 0, &recipient, &token_id, 1_000, 10_000);

    let outsider = Address::generate(&env);
    client.approve_withdraw(&outsider, &0);
}

#[test]
#[should_panic(expected = "not a member")]
fn test_non_member_reject_panics() {
    let env = Env::default();
    let (contract_id, token_id, _members) = voting_setup(&env, 1, 1);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);
    seed_proposal(&env, &contract_id, 0, &recipient, &token_id, 1_000, 10_000);

    let outsider = Address::generate(&env);
    client.reject_withdraw(&outsider, &0);
}

#[test]
#[should_panic(expected = "proposal is not pending")]
fn test_vote_on_non_pending_panics() {
    let env = Env::default();
    // threshold 1: the first approval flips the proposal to Passed.
    let (contract_id, token_id, members) = voting_setup(&env, 1, 2);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);
    seed_proposal(&env, &contract_id, 0, &recipient, &token_id, 1_000, 10_000);

    client.approve_withdraw(&members.get(0).unwrap(), &0);
    assert_eq!(client.get_proposal(&0).status, ProposalStatus::Passed);

    // A different member voting on the now-approved proposal must panic.
    client.approve_withdraw(&members.get(1).unwrap(), &0);
}

#[test]
#[should_panic(expected = "proposal expired")]
fn test_vote_on_expired_panics() {
    let env = Env::default();
    let (contract_id, token_id, members) = voting_setup(&env, 2, 2);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);
    seed_proposal(&env, &contract_id, 0, &recipient, &token_id, 1_000, 100);

    env.ledger().set_timestamp(200); // past expires_at
    client.approve_withdraw(&members.get(0).unwrap(), &0);
}

#[test]
fn test_reject_blocking_minority_rejects() {
    let env = Env::default();
    // threshold 2 of 3 members → blocking minority = 3 - 2 + 1 = 2 rejections.
    let (contract_id, token_id, members) = voting_setup(&env, 2, 3);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);
    seed_proposal(&env, &contract_id, 0, &recipient, &token_id, 1_000, 10_000);

    client.reject_withdraw(&members.get(0).unwrap(), &0);
    let after_first = client.get_proposal(&0);
    assert_eq!(after_first.rejections, 1);
    assert_eq!(after_first.status, ProposalStatus::Active);

    client.reject_withdraw(&members.get(1).unwrap(), &0);
    let after_second = client.get_proposal(&0);
    assert_eq!(after_second.rejections, 2);
    assert_eq!(after_second.status, ProposalStatus::Rejected);
}

#[test]
#[should_panic(expected = "proposal not found")]
fn test_approve_unknown_proposal_panics() {
    let env = Env::default();
    let (contract_id, _token_id, members) = voting_setup(&env, 1, 1);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    // No proposal seeded; member votes on a non-existent id.
    client.approve_withdraw(&members.get(0).unwrap(), &0);
}

#[test]
#[should_panic]
fn test_vote_without_auth_panics() {
    let env = Env::default();
    // Set up without mock_all_auths so require_auth fails.
    let admin = Address::generate(&env);
    let member = Address::generate(&env);
    let token_id = env.register(mock_token::MockToken, ());
    let contract_id = env.register(GroupTreasuryContract, ());
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    env.mock_all_auths();
    client.initialize(&admin, &token_id, &1);
    client.add_member(&member);
    let recipient = Address::generate(&env);
    seed_proposal(&env, &contract_id, 0, &recipient, &token_id, 1_000, 10_000);
    env.set_auths(&[]); // clear mocked auths — the vote must now fail

    client.approve_withdraw(&member, &0);
}

// ── Full multisig flow suite (#127) ────────────────────────────────────────────
//
// A dedicated suite walking the multisig withdraw lifecycle end to end:
// propose → approve/reject → execute, plus expiry and pending-filtering.
//
// Four scenarios exercise APIs that already exist on `main`
// (`approve_withdraw` / `reject_withdraw`) and run as real, passing tests; they
// create proposals via the in-file `seed_proposal` stand-in until
// `propose_withdraw` (#122) lands.
//
// The remaining six scenarios depend on contract functions that are not yet
// implemented (`propose_withdraw` #122, an execute entrypoint, an expiry
// finalizer, and `get_pending_proposals`). Calling a not-yet-generated client
// method does not compile even inside an `#[ignore]`d test, so those scenarios
// are documented stubs carrying an explicit `#[ignore = "..."]` reason and the
// exact assertions to wire up once their owning work merges. They are written
// against the ledger-sequence (`set_sequence_number` / `ttl_ledgers`) timing
// model that #122 introduces.
mod multisig_flow {
    use super::{seed_proposal, voting_setup};
    use crate::storage::ProposalStatus;
    use crate::GroupTreasuryContractClient;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{Address, Env};

    // ── Implemented behavior: real, passing tests ──────────────────────────────

    /// Scenario 3 — approvals reaching the threshold flip the proposal to `Passed`.
    #[test]
    fn multisig_approvals_reach_threshold_passes() {
        let env = Env::default();
        let (contract_id, token_id, members) = voting_setup(&env, 2, 2);
        let client = GroupTreasuryContractClient::new(&env, &contract_id);
        let recipient = Address::generate(&env);
        seed_proposal(&env, &contract_id, 0, &recipient, &token_id, 1_000, 10_000);

        client.approve_withdraw(&members.get(0).unwrap(), &0);
        assert_eq!(client.get_proposal(&0).status, ProposalStatus::Active);

        client.approve_withdraw(&members.get(1).unwrap(), &0);
        let passed = client.get_proposal(&0);
        assert_eq!(passed.approvals, 2);
        assert_eq!(passed.status, ProposalStatus::Passed);
    }

    /// Scenario 4 — a member voting twice on the same proposal panics.
    #[test]
    #[should_panic(expected = "already voted")]
    fn multisig_double_vote_panics() {
        let env = Env::default();
        let (contract_id, token_id, members) = voting_setup(&env, 2, 2);
        let client = GroupTreasuryContractClient::new(&env, &contract_id);
        let recipient = Address::generate(&env);
        seed_proposal(&env, &contract_id, 0, &recipient, &token_id, 1_000, 10_000);

        let voter = members.get(0).unwrap();
        client.approve_withdraw(&voter, &0);
        client.approve_withdraw(&voter, &0); // second vote must panic
    }

    /// Scenario 5 — rejections reaching the blocking minority flip the proposal
    /// to `Rejected`. threshold 2 of 3 → blocking minority = 3 - 2 + 1 = 2.
    #[test]
    fn multisig_rejection_blocks_proposal() {
        let env = Env::default();
        let (contract_id, token_id, members) = voting_setup(&env, 2, 3);
        let client = GroupTreasuryContractClient::new(&env, &contract_id);
        let recipient = Address::generate(&env);
        seed_proposal(&env, &contract_id, 0, &recipient, &token_id, 1_000, 10_000);

        client.reject_withdraw(&members.get(0).unwrap(), &0);
        assert_eq!(client.get_proposal(&0).status, ProposalStatus::Active);

        client.reject_withdraw(&members.get(1).unwrap(), &0);
        let rejected = client.get_proposal(&0);
        assert_eq!(rejected.rejections, 2);
        assert_eq!(rejected.status, ProposalStatus::Rejected);
    }

    /// Scenario 9 — approving after the proposal has expired panics.
    ///
    /// The live contract checks expiry against `ledger().timestamp()`, so this
    /// active test advances time with `set_timestamp`. Once #122 migrates expiry
    /// to ledger sequence, switch this to `env.ledger().set_sequence_number(...)`.
    #[test]
    #[should_panic(expected = "proposal expired")]
    fn multisig_approve_after_expiry_panics() {
        let env = Env::default();
        let (contract_id, token_id, members) = voting_setup(&env, 2, 2);
        let client = GroupTreasuryContractClient::new(&env, &contract_id);
        let recipient = Address::generate(&env);
        seed_proposal(&env, &contract_id, 0, &recipient, &token_id, 1_000, 100);

        env.ledger().set_timestamp(200); // past expires_at
        client.approve_withdraw(&members.get(0).unwrap(), &0);
    }

    // ── Pending contract work: documented, ignored stubs ───────────────────────
    //
    // Each stub compiles (no calls to not-yet-generated client methods) and
    // carries the precise assertions to enable once its dependency merges.

    /// Scenario 1 — a member can submit a withdraw proposal.
    #[test]
    #[ignore = "blocked on #122: propose_withdraw not yet implemented"]
    fn multisig_propose_by_member() {
        // TODO(#122): with
        //   propose_withdraw(env, proposer, to, token, amount, ttl_ledgers) -> u32
        // assert:
        //   - the returned id equals the stored proposal's id
        //   - the proposer is auto-recorded as the first approval (approvals == 1)
        //   - status == Active and
        //     expires_at == env.ledger().sequence() + ttl_ledgers
        //   - a ProposalCreatedEvent is emitted
        // Drive time with env.ledger().set_sequence_number(...).
    }

    /// Scenario 2 — a non-member submitting a proposal panics.
    #[test]
    #[ignore = "blocked on #122: propose_withdraw not yet implemented"]
    fn multisig_propose_by_non_member_panics() {
        // TODO(#122): calling propose_withdraw with a non-member proposer must
        // panic ("not a member"); insufficient treasury balance must panic with
        // "insufficient funds".
    }

    /// Scenario 6 — executing an approved (`Passed`) proposal transfers funds and
    /// marks it `Executed`.
    #[test]
    #[ignore = "blocked: group_treasury execute entrypoint not yet implemented (no issue identified)"]
    fn multisig_execute_on_approved() {
        // TODO: once an execute fn exists, drive a proposal to `Passed` via
        // approvals, deposit funds, execute, then assert:
        //   - recipient balance increased by amount
        //   - treasury balance decreased by amount
        //   - proposal status == Executed
        //   - a WithdrawEvent is emitted
    }

    /// Scenario 7 — executing a still-pending (`Active`) proposal panics.
    #[test]
    #[ignore = "blocked: group_treasury execute entrypoint not yet implemented (no issue identified)"]
    fn multisig_execute_on_pending_panics() {
        // TODO: executing a proposal that has not reached threshold must panic
        // (expected message TBD by the execute implementation, e.g. "not approved").
    }

    /// Scenario 8 — an expired proposal can be finalized to its terminal state.
    #[test]
    #[ignore = "blocked: expiry finalizer not yet implemented (no issue identified)"]
    fn multisig_finalize_expired() {
        // TODO: with ledger-sequence expiry, seed/propose a proposal, advance past
        // expiry via env.ledger().set_sequence_number(expires_at + 1), then call
        // the finalizer and assert the proposal settles (e.g. Rejected when it
        // never reached threshold) and cannot be voted on afterwards.
    }

    /// Scenario 10 — `get_pending_proposals` returns only still-`Active` proposals.
    #[test]
    #[ignore = "blocked: get_pending_proposals not yet implemented (no issue identified)"]
    fn multisig_get_pending_proposals_filtering() {
        // TODO: create several proposals, drive some to Passed/Rejected/Executed,
        // then assert get_pending_proposals() returns exactly the Active ones and
        // excludes terminal-state proposals.
    }
}
// ── propose_withdraw Tests (#122) ─────────────────────────────────────────────

#[test]
fn test_propose_withdraw_returned_id_matches_stored() {
    let env = Env::default();
    let (contract_id, token_id, members) = voting_setup(&env, 1, 1);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let token = mock_token::MockTokenClient::new(&env, &token_id);
    let member = members.get(0).unwrap();
    token.mint(&member, &500_000);
    client.deposit(&member, &token_id, &500_000);

    let recipient = Address::generate(&env);
    let id = client.propose_withdraw(&member, &recipient, &token_id, &100_000, &100);
    let proposal = client.get_proposal(&id);

    assert_eq!(id, proposal.id);
}

#[test]
#[should_panic(expected = "proposer is not a member")]
fn test_propose_withdraw_non_member_panics() {
    let env = Env::default();
    let (contract_id, token_id, _members) = voting_setup(&env, 1, 1);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let token = mock_token::MockTokenClient::new(&env, &token_id);
    let outsider = Address::generate(&env);
    token.mint(&outsider, &500_000);
    client.deposit(&outsider, &token_id, &500_000);

    let recipient = Address::generate(&env);
    client.propose_withdraw(&outsider, &recipient, &token_id, &100_000, &100);
}

#[test]
#[should_panic(expected = "insufficient funds")]
fn test_propose_withdraw_insufficient_balance_panics() {
    let env = Env::default();
    let (contract_id, token_id, members) = voting_setup(&env, 1, 1);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let token = mock_token::MockTokenClient::new(&env, &token_id);
    let member = members.get(0).unwrap();
    token.mint(&member, &50_000);
    client.deposit(&member, &token_id, &50_000);

    let recipient = Address::generate(&env);
    client.propose_withdraw(&member, &recipient, &token_id, &100_000, &100);
}

#[test]
fn test_propose_withdraw_auto_adds_proposer_approval() {
    let env = Env::default();
    let (contract_id, token_id, members) = voting_setup(&env, 1, 1);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let token = mock_token::MockTokenClient::new(&env, &token_id);
    let member = members.get(0).unwrap();
    token.mint(&member, &500_000);
    client.deposit(&member, &token_id, &500_000);

    let recipient = Address::generate(&env);
    let id = client.propose_withdraw(&member, &recipient, &token_id, &100_000, &100);
    let proposal = client.get_proposal(&id);

    assert_eq!(proposal.approvals, 1);
}

#[test]
fn test_propose_withdraw_increments_proposal_id() {
    let env = Env::default();
    let (contract_id, token_id, members) = voting_setup(&env, 1, 1);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let token = mock_token::MockTokenClient::new(&env, &token_id);
    let member = members.get(0).unwrap();
    token.mint(&member, &500_000);
    client.deposit(&member, &token_id, &500_000);

    let recipient = Address::generate(&env);
    let id0 = client.propose_withdraw(&member, &recipient, &token_id, &100_000, &100);
    let id1 = client.propose_withdraw(&member, &recipient, &token_id, &100_000, &100);

    assert_eq!(id0, 0);
    assert_eq!(id1, 1);
}
