## Description

This PR implements the requested features for group treasury proposals, files access, and push subscriptions.

**Changes:**

1. **Schema Updates**: Added `pushSubscriptions` table and completely updated `treasuryProposals` to accurately track on-chain state, proposals, thresholds, and expiration ledgers based on the requested columns.
2. **Treasury Contract Query Functions**: Added `list_proposals` and `get_pending_proposals` to the `GroupTreasuryContract` to fetch stored proposals directly from the contract storage.
3. **Secure File Download**: Added a new endpoint `GET /files/:fileId` that issues a presigned S3 URL valid for 5 minutes, enforcing access control by validating that the requesting user is an active member of the conversation where the file was shared.
4. **Push Subscriptions Endpoints**: Added `POST /push/subscriptions` and `DELETE /push/subscriptions` to register and unregister device-bound push subscriptions idempotently.

## Issue numbers

Fixes #128, #125, #229, #235

## Testing

- Schema changes generated and migrated successfully.
- CI/CD tests pass.
