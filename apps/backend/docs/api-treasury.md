# Treasury API Documentation

This document covers the REST API specifications for the Treasury module (`routes/treasury.ts`) and explains its architecture and integration with the on-chain Soroban contracts (`group_treasury` / `proposals`).

---

## 1. Architecture Overview

### Current Implementation

The `routes/treasury.ts` module provides REST endpoints for managing treasury proposals and votes using a PostgreSQL database.

**What this module does:**
- Accepts proposal creation requests with validation
- Stores proposals in the `treasuryProposals` table
- Records user votes in the `proposalVotes` table
- Retrieves proposals with user-specific vote status
- Enforces authentication via `requireAuth` middleware
- Uses `contractId` from `GROUP_TREASURY_CONTRACT_ID` env var (defaults to `'stub'`)

**Database Tables:**
- `treasuryProposals`: Stores proposal data (id, contractId, proposalId, amount, recipient, token, status, threshold, etc.)
- `proposalVotes`: Stores user votes (treasuryProposalId, userId, vote, signature)

**Authentication:**
- All endpoints require authentication via `requireAuth` middleware
- User ID is extracted from the authenticated request
- Used for tracking votes and preventing duplicate voting

> **⚠️ Note:** Current implementation is off-chain only. Soroban contract integration is not yet implemented.


---

## 2. TTL-per-Ledger Conversion Table

Soroban measures Time-To-Live (TTL) and expiration in **ledgers**. On Stellar (Mainnet & Testnet), 1 ledger is closed approximately every **5 seconds**.

| TTL Value | Human Duration | Ledger Count (≈ 5s/ledger) | Description |
| :--- | :--- | :--- | :--- |
| `'24h'` | 24 Hours (1 day) | `17,280` ledgers | Short-term or urgent proposals |
| `'72h'` | 72 Hours (3 days) | `51,840` ledgers | Medium-term standard proposals |
| `'7d'` | 7 Days (1 week) | `120,960` ledgers | Long-term major allocations |

**Conversion Formula:**

$$\text{Ledgers} = \frac{\text{Duration in Seconds}}{5}$$

**Example:**
- 24 hours = 24 × 60 × 60 = 86,400 seconds
- 86,400 / 5 = 17,280 ledgers ✅

---

## 3. Endpoints Specification

### 1. Propose a Withdrawal
>- **Route**: POST /api/treasury/propose
- **Description**: Creates a new withdrawal proposal for a group treasury.

#### Validation Rules
- `amount`: Positive number (> 0)
- `token`: Non-empty string (token identifier)
- `recipient`: Valid Stellar public key (must start with `G` and be 56 characters)
- `ttl`: Must be one of: `'24h'`, `'72h'`, `'7d'`
- `conversationId` (optional): Valid UUID format
- `threshold` (optional): Integer >= 1 (defaults to `3` if not provided)
- All requests require authentication via bearer token

>#### Request Body Example
> ```json
> {
>   "amount": 1000,
>   "token": "USDC",
>   "recipient": "GAB1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234",
>   "ttl": "24h",
>   "conversationId": "123e4567-e89b-12d3-a456-426614174000",
>   "threshold": 3
> }
> ```
>
>#### Response Shapes & Status Codes
>- **201 Created**: Proposal created successfully in the database.
> ```json
> {
>   "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
>   "contractId": "CA3D2C5C6B7A8B9C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5F6A7B8C9D0E",
>   "proposalId": "prop-1734567890123",
>   "conversationId": "123e4567-e89b-12d3-a456-426614174000",
>   "status": "active",
>   "recipient": "GAB1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234",
>   "amount": "1000",
>   "token": "USDC",
>   "threshold": 3,
>   "ttlLedgers": 17280,
>   "createdAt": "2026-07-29T08:00:00.000Z",
>   "updatedAt": "2026-07-29T08:00:00.000Z"
> }
> ```
>- **400 Bad Request**: Invalid input (e.g., invalid recipient address format, invalid TTL value, invalid amount).
>- **401 Unauthorized**: Authentication missing or invalid bearer token.
>- **500 Internal Server Error**: Database error or server issue.
### 2. Approve a Proposal

>- **Route**: POST /api/treasury/proposals/:id/approve

- **Description**: Registers an approval vote for a specific treasury proposal. The vote is recorded in the database with the authenticated user's ID.

#### Validation Rules
- `id` (path parameter): Valid proposal UUID identifier.
- `signature` (body): Optional string for cryptographic verification.
- Proposal must exist in the database.
- Proposal must have status `'active'`.
- User cannot vote twice on the same proposal (unique constraint violation).

>#### Request Body Example
> ```json
> {
>   "signature": "a1b2c3d4e5f6..."
> }
> ```
>
>#### Response Shapes & Status Codes
>- **200 OK**: Vote recorded successfully.
> ```json
> {
>   "success": true
> }
> ```
>- **404 Not Found**: Proposal ID does not exist.
> ```json
> {
>   "error": "Proposal not found"
> }
> ```
>- **409 Conflict**: Proposal is no longer active or user has already voted on this proposal.
> ```json
> {
>   "error": "Proposal is no longer active"
> }
> ```
> ```json
> {
>   "error": "Already voted on this proposal"
> }
> ```

> **⚠️ Technical Note:** Both endpoints (`/approve` and `/reject`) use the same `handleVote()` function internally. The only difference is the vote value passed to the function. Consider refactoring to a single endpoint `POST /treasury/proposals/:id/vote` with `{ vote: 'approve' | 'reject' }` in the body for better RESTful design.
---

### 3. Reject a Proposal

>- **Route**: POST /api/treasury/proposals/:id/reject

- **Description**: Registers a rejection vote for a specific treasury proposal. The vote is recorded in the database with the authenticated user's ID.

#### Validation Rules
- `id` (path parameter): Valid proposal UUID identifier.
- `signature` (body): Optional string for cryptographic verification.
- Proposal must exist in the database.
- Proposal must have status `'active'`.
- User cannot vote twice on the same proposal (unique constraint violation).

>#### Request Body Example
> ```json
> {
>   "signature": "a1b2c3d4e5f6..."
> }
> ```
>
>#### Response Shapes & Status Codes
>- **200 OK**: Vote recorded successfully.
> ```json
> {
>   "success": true
> }
> ```
>- **404 Not Found**: Proposal ID does not exist.
> ```json
> {
>   "error": "Proposal not found"
> }
> ```
>- **409 Conflict**: Proposal is no longer active or user has already voted on this proposal.
> ```json
> {
>   "error": "Proposal is no longer active"
> }
> ```
> ```json
> {
>   "error": "Already voted on this proposal"
> }
> ```

> **⚠️ Technical Note:** Both endpoints (`/approve` and `/reject`) use the same `handleVote()` function internally. The only difference is the vote value passed to the function. Consider refactoring to a single endpoint `POST /treasury/proposals/:id/vote` with `{ vote: 'approve' | 'reject' }` in the body for better RESTful design.

---

### 4. List Proposals

>- **Route**: GET /api/treasury/proposals

- **Description**: Retrieves all treasury proposals, optionally filtered by conversationId. Includes the authenticated user's vote status for each proposal.

#### Query Parameters
- `conversationId` (optional): Valid UUID to filter proposals by conversation.

>#### Response Shapes & Status Codes
>- **200 OK**: Returns array of proposals.
> ```json
> [
>   {
>     "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
>     "contractId": "CA3D2C5C...",
>     "proposalId": "prop-1734567890123",
>     "conversationId": "123e4567-e89b-12d3-a456-426614174000",
>     "status": "active",
>     "recipient": "GAB1234567890ABCDEF...",
>     "amount": "1000",
>     "token": "USDC",
>     "threshold": 3,
>     "createdAt": "2026-07-29T08:00:00.000Z",
>     "updatedAt": "2026-07-29T08:00:00.000Z",
>     "hasVoted": true,
>     "myVote": "approve"
>   }
> ]
> ```
>
> **Empty response (no proposals):**
> ```json
> []
> ```
>
>- **401 Unauthorized**: Authentication missing or invalid bearer token.
>- **500 Internal Server Error**: Database error.
---
