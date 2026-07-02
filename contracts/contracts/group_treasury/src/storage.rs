use soroban_sdk::{contracttype, Address, Vec};

#[contracttype]
pub enum DataKey {
    Admin,
    Balances,
    Members,
    Threshold,          // u32: approvals required to execute a withdraw proposal
    ProposalCount,      // u32: total proposals created (also next id source)
    Proposal(u32),      // WithdrawProposal by id
    Vote(u32, Address), // (proposal_id, voter) -> bool (true = approve, false = reject)
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Passed,
    Rejected,
    Executed,
    Expired,
}

#[contracttype]
#[derive(Clone)]
pub struct WithdrawProposal {
    pub id: u32,
    pub proposer: Address,
    pub to: Address,
    pub token: Address,
    pub amount: i128,
    pub approvals: u32,
    pub rejections: u32,
    pub status: ProposalStatus,
    pub expires_at: u64,
}

#[contracttype]
pub struct DepositEvent {
    pub from: Address,
    pub amount: i128,
}

#[contracttype]
pub struct WithdrawEvent {
    pub to: Address,
    pub amount: i128,
}

#[contracttype]
pub struct MemberAddedEvent {
    pub member: Address,
    pub added_by: Address,
}

#[contracttype]
pub struct MemberRemovedEvent {
    pub member: Address,
    pub removed_by: Address,
}

/// Emitted whenever a member casts a vote on a withdraw proposal.
#[contracttype]
pub struct WithdrawVoteCastEvent {
    pub id: u32,
    pub voter: Address,
    pub approve: bool,
}

/// Emitted when a proposal's approvals reach the configured threshold.
#[contracttype]
pub struct ProposalApprovedEvent {
    pub id: u32,
    pub approvals: u32,
    pub threshold: u32,
}

/// Emitted when a proposal's rejections reach the blocking minority.
#[contracttype]
pub struct ProposalRejectedEvent {
    pub id: u32,
    pub rejections: u32,
}

/// Emitted when a new withdraw proposal is created.
#[contracttype]
pub struct ProposalCreatedEvent {
    pub id: u32,
    pub proposer: Address,
    pub to: Address,
    pub token: Address,
    pub amount: i128,
    pub expires_at: u64,
}
