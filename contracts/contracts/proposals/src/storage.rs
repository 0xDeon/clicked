use soroban_sdk::{contracttype, Address, String};

#[contracttype]
pub enum DataKey {
    Admin,
    NextProposalId,
    Proposal(u64),
    Vote(u64, Address), // (proposal_id, voter) -> bool (true = yes, false = no)
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Approved,
    Passed,
    Rejected,
    Executed,
    Expired,
}

#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub description: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub yes_votes: u32,
    pub no_votes: u32,
    pub status: ProposalStatus,

    // Withdrawal execution parameters.
    pub treasury: Address,
    pub token: Address,
    pub to: Address,
    pub amount: i128,
}

// ── Events ───────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct ProposalCreatedEvent {
    pub id: u64,
    pub proposer: Address,
    pub expires_at: u64,

    pub treasury: Address,
    pub token: Address,
    pub to: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct VoteCastEvent {
    pub id: u64,
    pub voter: Address,
    pub support: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct ProposalFinalizedEvent {
    pub id: u64,
    pub status: ProposalStatus,
    pub yes_votes: u32,
    pub no_votes: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct ProposalExpiredEvent {
    pub id: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct ProposalExecutedEvent {
    pub id: u64,
    pub executor: Address,
}
