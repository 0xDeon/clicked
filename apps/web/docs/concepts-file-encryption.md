# File & Thumbnail Encryption Pipeline

This document explains the end-to-end (E2E) encrypted file sharing architecture in Clicked, detailing the roles of `lib/fileEncryption.ts`, `lib/thumbnail.ts`, and `EncryptedThumbnail.tsx`. 

Our architecture guarantees that the server only ever handles ciphertext. It never has access to the plaintext files or the keys required to decrypt them.

## The End-to-End File Flow

The lifecycle of an encrypted file attachment follows a strict sequence to ensure zero-knowledge server routing.

1. **File Selection (Client):** The user selects a file for upload via the UI.
2. **Client-Side Encryption:** Using `lib/fileEncryption.ts`, the client generates a unique AES-256-GCM symmetric key and Initialization Vector (IV). The file is encrypted in memory, outputting the ciphertext.
3. **Presigned URL Request:** The client requests a presigned upload URL from the server for the storage provider (e.g., S3/R2). **No encryption keys are sent during this request.**
4. **Ciphertext Upload:** The client uploads the encrypted file directly to the storage provider using the presigned URL.
5. **Message Transmission:** The client constructs the chat message. The AES key and IV used for the file are placed *inside* the E2E-encrypted message payload. The server routes this message to the recipient without being able to read the payload.
6. **Recipient Download:** When the recipient receives the message, their client requests a presigned GET URL for the ciphertext from the storage provider and downloads it.
7. **Client-Side Decryption:** The recipient's client extracts the AES key and IV from the decrypted message payload. It passes the ciphertext, key, and IV to `lib/fileEncryption.ts` to decrypt the file in memory and offer it as a downloadable Blob.

## Key Lifecycle: Where the Key Lives

Security relies on strict key isolation. Here is the exact state of the AES decryption key at every stage:

| Stage | Key Location & State | Server Visibility |
|---|---|---|
| **Generation** | In-memory on the sender's device. | None |
| **File Encryption** | In-memory on the sender's device. | None |
| **Storage Upload** | Does not exist in the upload payload. | None |
| **Message Routing** | Encrypted within the E2EE message payload using the channel/recipient key. | **Zero** (Server sees opaque payload) |
| **File Download** | Retained securely in the recipient's local state. | None |
| **Decryption** | In-memory on the recipient's device. | None |

## Thumbnail Generation & Encryption

To provide a smooth UI without compromising security, image and video attachments utilize a parallel, optional thumbnail pipeline alongside the main file flow.

1. **Client-Side Generation:** Before the main file is encrypted, `lib/thumbnail.ts` processes the plaintext media in memory to generate a low-resolution thumbnail image.
2. **Parallel Encryption:** The generated thumbnail is encrypted using `lib/fileEncryption.ts`. It typically receives its own unique AES key and IV to keep it decoupled from the main file.
3. **Parallel Upload:** The client requests a separate presigned URL and uploads the encrypted thumbnail ciphertext to the storage provider.
4. **Payload Attachment:** The thumbnail's storage ID, AES key, and IV are appended to the E2EE message payload alongside the main file's metadata.
5. **Secure Rendering:** On the recipient's side, the `EncryptedThumbnail.tsx` component handles the visual display. It fetches the encrypted thumbnail, decrypts it in memory using the keys from the message payload, and renders it directly to the DOM using a temporary `blob:` Object URL. This ensures the plaintext thumbnail never touches the recipient's disk unless explicitly saved.
