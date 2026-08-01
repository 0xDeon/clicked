# Group file sharing over MLS

Sharing a file with a group encrypts it **once**. The random file key that
protects it is distributed by putting it inside the MLS group message that
references the file, so every member derives the same key from group state and
the server never holds one.

This is the same file subsystem DMs use — presigned upload, a `files` row, a
presigned download — with single-ciphertext delivery instead of one envelope per
recipient device.

## Why one ciphertext

The obvious alternative is to encrypt the file separately for each recipient
device. In a 30-person group with 3 devices each that is 90 copies of the same
bytes, and it grows again on every new device.

MLS already solves this: the group agrees on epoch secrets, so a message
encrypted to the group is readable by exactly the devices in the tree at that
epoch. Putting the file key in such a message gives every member the key without
the server ever learning it, and object storage holds one object instead of
ninety.

## Flow

```text
Sender device                       Backend                     Other members
  |                                    |                              |
  |-- generate random fileKey ---------|                              |
  |-- encrypt file with fileKey -------|                              |
  |                                    |                              |
  |-- POST /uploads ------------------>|                              |
  |   { conversationId, size,          |                              |
  |     mimeType, sha256 }             |                              |
  |<- { fileId, uploadUrl, mlsEpoch }--|                              |
  |                                    |                              |
  |-- PUT ciphertext to uploadUrl ---->| (object storage)             |
  |-- POST /uploads/:id/confirm ------>|                              |
  |                                    |                              |
  |-- send_message ------------------->|                              |
  |   { contentType: "image",          |                              |
  |     fileId,                        |                              |
  |     ciphertext: MLS(fileKey, ...), |                              |
  |     mlsEpoch }                     |--- new_message ------------->|
  |                                    |                              |
  |                                    |<-- GET /files/:fileId -------|
  |                                    |--- { url, mlsEpoch } ------->|
  |                                    |                              |
  |                                    |    decrypt with the fileKey  |
  |                                    |    recovered from the message|
```

1. The sender generates a random file key, encrypts the file locally, and
   uploads the ciphertext to a presigned slot.
2. `POST /uploads` returns `mlsEpoch` — the group's current epoch — so the
   client knows which epoch to encrypt the accompanying message to.
3. The sender sends one message carrying `fileId` and a `ciphertext` that
   contains the file key, encrypted to the group's epoch secrets. No per-device
   envelopes: see [mls-group-membership.md](./mls-group-membership.md) for the
   send-path rules.
4. Every member decrypts that message with group state, recovers the same file
   key, downloads the single ciphertext and decrypts it locally.

## What the server stores

Nothing new. The existing `files` row records the object's location, size, MIME
type and hash. The file key is not a column and never appears in a request body:
it exists only inside the message ciphertext, which the server cannot read.

`messages.mls_epoch` on the referencing message is what ties a file to an epoch,
so no separate epoch column is needed on `files`.

## Access control

`GET /files/:fileId` grants a short-lived presigned download URL when **both**
hold:

1. The caller is a member of a conversation the file was shared into.
2. For files whose references are all MLS group messages, the calling **device**
   holds an epoch window that covers at least one of those references.

The second rule mirrors the message read path exactly. A device that could not
decrypt the message carrying the file key has no use for the ciphertext, so the
server does not hand it out. Denials carry the same reason codes the history
endpoint uses:

```json
{ "error": "This device has no key for this file", "reason": "mls_no_key_before_join" }
```

| Code                       | Meaning                                     |
| -------------------------- | ------------------------------------------- |
| `mls_no_key_before_join`   | Shared before this device joined the group. |
| `mls_no_key_after_removal` | Shared after this device was removed.       |
| `mls_not_a_group_member`   | This device holds no leaf in the group.     |

### Removed members lose access going forward

When a member is removed, the commit that removes them rekeys the group. Every
file shared from that epoch on has its key distributed in messages encrypted to
secrets the removed device does not have — so it could not open those files even
if it obtained the ciphertext. The epoch check makes the server refuse to hand
over the ciphertext in the first place, closing the gap between "cannot decrypt"
and "cannot download".

Files shared **before** the removal are still served to that device while it
remains a conversation member. It already held those file keys; withholding
bytes it has already been able to read would be theatre rather than forward
secrecy. Removing the user from the conversation entirely cuts off all of it,
via the membership check.

### Re-sharing an old file to newer members

A file can be referenced by more than one message. Re-sending it in a later
epoch — with the same file key, re-encrypted to the new epoch's secrets — is how
a group deliberately makes an older file available to members who joined since.

Access is therefore granted if **any** reachable reference falls inside the
device's window, and the response reports which epoch granted it:

```json
{ "url": "https://...", "mlsEpoch": 6 }
```

When no reference is readable, the denial reports the reason from the earliest
reference, so the message is about the original share rather than an incidental
re-share.

## Uploads

`POST /uploads` requires the uploading device to hold an active leaf when the
conversation has an MLS group. A device that cannot send into the group cannot
distribute a file key either, so letting it claim an upload slot would only
create an orphaned object.

```json
{ "fileId": "uuid", "uploadUrl": "https://...", "mlsEpoch": 7 }
```

`mlsEpoch` is `null` for conversations with no MLS group; nothing else about the
upload path changes for DMs.

## Thumbnails

A thumbnail is a separate `files` row with `isThumbnail: true` and its own
ciphertext. Clients may encrypt it under the same file key or a distinct one —
either way the key travels in the same MLS group message, and the download route
applies the identical epoch check because the thumbnail is referenced by the same
message.

## Implementation references

- download + epoch gate: `apps/backend/src/routes/files.ts`
- upload slot: `apps/backend/src/routes/uploads.ts`
- epoch window lookup: `apps/backend/src/services/mlsGroups.ts`
- reason codes: `apps/backend/src/lib/mlsVisibility.ts`
- send-path rules for MLS messages: `apps/backend/src/lib/validateMessagePayload.ts`
- tests: `apps/backend/src/__tests__/mlsGroupFiles.test.ts`
