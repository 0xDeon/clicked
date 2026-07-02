//! Tests for the proposals contract (#45).
//!
//! Includes the original voting/finalization/execution tests plus the
//! acceptance criteria for `execute_withdraw`.

#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::testutils::Ledger;
use soroban_sdk::{Env, String};

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

fn advance_time(env: &Env, seconds: u64) {
    env.ledger()
        .set_timestamp(env.ledger().timestamp() + seconds);
}

fn setup(
    env: &Env,
) -> (
    ProposalsContractClient<'static>,
    Address, // proposals admin
    Address, // alice
    Address, // bob
    Address, // carol
    group_treasury::GroupTreasuryContractClient<'static>,
    Address, // treasury_admin
    Address, // treasury_member
    Address, // token_id
) {
    env.mock_all_auths();

    // Register proposals contract.
    let proposals_id = env.register_contract(None, ProposalsContract);
    let proposals = ProposalsContractClient::new(env, &proposals_id);

    let proposals_admin = Address::generate(env);
    proposals.initialize(&proposals_admin);

    let alice = Address::generate(env);
    let bob = Address::generate(env);
    let carol = Address::generate(env);

    // Register treasury + token.
    let treasury_admin = Address::generate(env);
    let treasury_member = Address::generate(env);

    let token_id = env.register(mock_token::MockToken, ());
    let token = MockTokenClient::new(env, &token_id);
    token.mint(&treasury_member, &1_000_000);

    let treasury_addr = env.register(group_treasury::GroupTreasuryContract, ());
    let treasury = group_treasury::GroupTreasuryContractClient::new(env, &treasury_addr);
    treasury.initialize(&treasury_admin, &token_id);
    treasury.add_member(&treasury_member);

    // Deposit into treasury so `execute_withdraw` has something to withdraw.
    token.transfer(env.clone(), &treasury_member, &treasury_addr, &0);

    // easier: call deposit, which also calls TokenClient::transfer from `from` to treasury
    treasury.deposit(&treasury_member, &token_id, &500);

    (
        proposals,
        proposals_admin,
        alice,
        bob,
        carol,
        treasury,
        treasury_admin,
        treasury_member,
        token_id,
    )
}

fn create_proposal_in(
    env: &Env,
    client: &ProposalsContractClient<'static>,
    proposer: &Address,
    expires_in_secs: u64,
    treasury: &Address,
    token: &Address,
    to: &Address,
    amount: i128,
) -> u64 {
    let now = env.ledger().timestamp();
    let desc = String::from_str(env, "fund a community art mural");

    client.create_proposal(
        proposer.clone(),
        &desc,
        &(now + expires_in_secs),
        treasury.clone(),
        token.clone(),
        to.clone(),
        &amount,
    )
}

#[test]
fn create_then_vote_then_pass_then_execute_happy_path() {
    let env = Env::default();
    let (client, _proposals_admin, alice, bob, carol, _treasury, _treasury_admin, _m, _token_id) =
        setup(&env);

    let id = create_proposal_in(
        &env, &client, &alice, 1_000,
        &_m, // dummy treasury address for happy path; execute_withdraw not used here
        &_m, // dummy token
        &alice, 1,
    );

    client.vote(&alice, &id, &true);
    client.vote(&bob, &id, &true);
    client.vote(&carol, &id, &false);

    advance_time(&env, 1_001);
    let status = client.finalize_proposal(&id);
    assert_eq!(status, ProposalStatus::Passed);

    client.execute_proposal(&alice, &id);
    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Executed);
}

#[test]
fn finalize_with_more_no_votes_rejects() {
    let env = Env::default();
    let (client, _proposals_admin, alice, bob, carol, _treasury, _treasury_admin, m, token_id) =
        setup(&env);

    let id = create_proposal_in(&env, &client, &alice, 500, &m, &token_id, &alice, 1);

    client.vote(&alice, &id, &false);
    client.vote(&bob, &id, &true);
    client.vote(&carol, &id, &false);

    advance_time(&env, 501);
    let status = client.finalize_proposal(&id);
    assert_eq!(status, ProposalStatus::Rejected);
}

#[test]
fn finalize_with_a_tie_rejects() {
    let env = Env::default();
    let (client, _proposals_admin, alice, bob, _carol, _treasury, _tadmin, m, token_id) =
        setup(&env);

    let id = create_proposal_in(&env, &client, &alice, 500, &m, &token_id, &alice, 1);
    client.vote(&alice, &id, &true);
    client.vote(&bob, &id, &false);

    advance_time(&env, 501);
    assert_eq!(client.finalize_proposal(&id), ProposalStatus::Rejected);
}

#[test]
fn finalize_with_zero_votes_rejects() {
    let env = Env::default();
    let (client, _proposals_admin, alice, _bob, _carol, _treasury, _tadmin, m, token_id) =
        setup(&env);

    let id = create_proposal_in(&env, &client, &alice, 500, &m, &token_id, &alice, 1);
    advance_time(&env, 501);

    assert_eq!(client.finalize_proposal(&id), ProposalStatus::Rejected);
}

#[test]
#[should_panic(expected = "cannot finalize before expiry")]
fn finalize_before_expiry_panics() {
    let env = Env::default();
    let (client, _proposals_admin, alice, _bob, _carol, _treasury, _tadmin, m, token_id) =
        setup(&env);

    let id = create_proposal_in(&env, &client, &alice, 1_000, &m, &token_id, &alice, 1);
    client.finalize_proposal(&id);
}

#[test]
#[should_panic(expected = "proposal already finalized")]
fn finalize_twice_panics() {
    let env = Env::default();
    let (client, _proposals_admin, alice, _bob, _carol, _treasury, _tadmin, m, token_id) =
        setup(&env);

    let id = create_proposal_in(&env, &client, &alice, 500, &m, &token_id, &alice, 1);

    advance_time(&env, 501);
    client.finalize_proposal(&id);
    client.finalize_proposal(&id);
}

#[test]
#[should_panic(expected = "proposal is not in Passed state")]
fn execute_when_rejected_panics() {
    let env = Env::default();
    let (client, _proposals_admin, alice, bob, carol, _treasury, _tadmin, m, token_id) =
        setup(&env);

    let id = create_proposal_in(&env, &client, &alice, 500, &m, &token_id, &alice, 1);
    client.vote(&alice, &id, &false);
    client.vote(&bob, &id, &true);
    client.vote(&carol, &id, &false);

    advance_time(&env, 501);
    client.finalize_proposal(&id);
    client.execute_proposal(&alice, &id);
}

#[test]
#[should_panic(expected = "proposal is not in Passed state")]
fn execute_when_still_active_panics() {
    let env = Env::default();
    let (client, _proposals_admin, alice, _bob, _carol, _treasury, _tadmin, m, token_id) =
        setup(&env);

    let id = create_proposal_in(&env, &client, &alice, 1_000, &m, &token_id, &alice, 1);
    client.execute_proposal(&alice, &id);
}

#[test]
#[should_panic(expected = "voting window has closed")]
fn vote_after_expiry_panics() {
    let env = Env::default();
    let (client, _proposals_admin, alice, bob, _carol, _treasury, _tadmin, m, token_id) =
        setup(&env);

    let id = create_proposal_in(&env, &client, &alice, 500, &m, &token_id, &alice, 1);
    advance_time(&env, 600);
    client.vote(&bob, &id, &true);
}

#[test]
#[should_panic(expected = "voter has already voted")]
fn double_vote_panics() {
    let env = Env::default();
    let (client, _proposals_admin, alice, _bob, _carol, _treasury, _tadmin, m, token_id) =
        setup(&env);

    let id = create_proposal_in(&env, &client, &alice, 500, &m, &token_id, &alice, 1);
    client.vote(&alice, &id, &true);
    client.vote(&alice, &id, &false);
}

#[test]
#[should_panic(expected = "expires_at must be in the future")]
fn create_with_past_expiry_panics() {
    let env = Env::default();
    let (client, _proposals_admin, alice, _bob, _carol, _treasury, _tadmin, m, token_id) =
        setup(&env);

    let desc = String::from_str(&env, "x");
    client.create_proposal(
        alice,
        &desc,
        &env.ledger().timestamp(),
        m,
        token_id,
        alice,
        &1,
    );
}

#[test]
#[should_panic(expected = "proposal not expired")]
fn finalize_expired_before_expiry_panics() {
    let env = Env::default();
    let (client, _padmin, alice, _bob, _carol, _treasury, _tadmin, m, token_id) = setup(&env);

    let id = create_proposal_in(&env, &client, &alice, 1_000, &m, &token_id, &alice, 1);
    client.finalize_expired_proposal(&id);
}

#[test]
#[should_panic(expected = "proposal not Pending")]
fn finalize_expired_when_passed_panics() {
    let env = Env::default();
    let (client, _padmin, alice, _bob, _carol, _treasury, _tadmin, m, token_id) = setup(&env);

    let id = create_proposal_in(&env, &client, &alice, 500, &m, &token_id, &alice, 1);

    advance_time(&env, 501);
    client.finalize_proposal(&id); // becomes Passed
    client.finalize_expired_proposal(&id);
}

#[test]
fn finalize_expired_success() {
    let env = Env::default();
    let (client, _padmin, alice, _bob, _carol, _treasury, _tadmin, m, token_id) = setup(&env);

    let id = create_proposal_in(&env, &client, &alice, 500, &m, &token_id, &alice, 1);

    advance_time(&env, 501);
    client.finalize_expired_proposal(&id);

    let proposal = client.get_proposal(&id);
    assert_eq!(proposal.status, ProposalStatus::Expired);
}

// ─────────────────────────────────────────────────────────────────────────────
// execute_withdraw acceptance criteria

#[test]
#[should_panic(expected = "proposal not approved")]
fn execute_withdraw_pending_panics() {
    let env = Env::default();
    let (client, _padmin, alice, _bob, _carol, _treasury, _tadmin, treasury_member, token_id) =
        setup(&env);

    // Create an Active (i.e. not Approved) proposal.
    let treasury_addr = _treasury.address();
    let to = alice.clone();
    let id = create_proposal_in(
        &env,
        &client,
        &alice,
        1_000,
        &treasury_addr,
        &token_id,
        &to,
        10,
    );

    client.execute_withdraw(&alice, &id);

    // keep compiler happy
    let _ = treasury_member;
}

#[test]
#[should_panic(expected = "proposal already executed")]
fn execute_withdraw_already_executed_panics() {
    let env = Env::default();
    let (client, _padmin, alice, _bob, _carol, treasury, _tadmin, treasury_member, token_id) =
        setup(&env);

    let treasury_addr = treasury.address();
    let to = alice.clone();
    let id = create_proposal_in(
        &env,
        &client,
        &alice,
        1_000,
        &treasury_addr,
        &token_id,
        &to,
        10,
    );

    advance_time(&env, 1_001);
    client.vote(&alice, &id, &true);
    client.finalize_proposal(&id);

    client.execute_withdraw(&treasury_member, &id);
    client.execute_withdraw(&treasury_member, &id);
}

#[test]
fn execute_withdraw_reduces_balance() {
    let env = Env::default();
    let (client, _padmin, alice, _bob, _carol, treasury, _tadmin, treasury_member, token_id) =
        setup(&env);

    let treasury_addr = treasury.address();
    let to = alice.clone();
    let amount: i128 = 100;

    let id = create_proposal_in(
        &env,
        &client,
        &alice,
        1_000,
        &treasury_addr,
        &token_id,
        &to,
        amount,
    );

    // Mark as Approved by setting directly through execution path:
    // finalize->Passed then execute_proposal is unrelated; so we update status by calling finalize_proposal
    // after votes so that contract logic sets Passed/Rejected. Then we treat Passed as Approved in execute_withdraw.
    // This repo currently uses ProposalStatus::Passed/Rejected for finalize; Approved is separate.

    advance_time(&env, 1_001);
    // No votes -> Rejected; we need Passed -> make it Passed.
    client.vote(&treasury_member, &id, &true);
    client.finalize_proposal(&id);

    // Execute withdraw.
    let before = treasury.balance(&token_id);
    client.execute_withdraw(&treasury_member, &id);
    let after = treasury.balance(&token_id);

    assert_eq!(after, before - amount);
}

#[test]
#[should_panic(expected = "caller is not a treasury member")]
fn execute_withdraw_non_member_panics() {
    let env = Env::default();
    let (client, _padmin, alice, _bob, _carol, treasury, _tadmin, _member, token_id) = setup(&env);

    let treasury_addr = treasury.address();
    let to = alice.clone();
    let id = create_proposal_in(
        &env,
        &client,
        &alice,
        1_000,
        &treasury_addr,
        &token_id,
        &to,
        10,
    );

    advance_time(&env, 1_001);
    client.vote(&alice, &id, &true);
    client.finalize_proposal(&id);

    // alice is not a treasury member
    client.execute_withdraw(&alice, &id);
}
