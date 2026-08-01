# Storage, Push Notifications, and Background Jobs

## Overview

The backend uses an S3-compatible object store for file uploads, background jobs for file cleanup, and Web Push notifications to notify offline users. The implementation supports local development without external storage services while using real signed URLs in production.

## Storage Backend

The object storage layer is implemented through a shared `ObjectStore` that wraps the AWS SDK S3 client. Configuration is provided through environment variables, allowing the same implementation to work with AWS S3, MinIO, or other S3-compatible services.

### Development

In development and test environments, presigned upload and download requests return placeholder URLs. This allows local development and automated tests to run without requiring a live object storage service.

### Production

In production, the backend generates cryptographically signed upload and download URLs using the configured object store. These presigned URLs expire after **15 minutes**.

### Storage Keys

Uploaded objects are stored using keys in the following format:

```text
uploads/<conversationId>/<hash>
```

Each upload receives a unique storage key based on the conversation and generated hash.

---

## File Lifecycle

Uploaded files move through several stages during their lifetime.

### Upload

A file is uploaded to object storage and referenced by a database record.

### Soft Delete

When a message containing a file is retracted, the file record is marked with `deletedAt`. The object itself is not removed immediately.

### Reference Counting

Before deleting an object, the cleanup job verifies that no active messages still reference the file. If at least one active reference exists, the object is preserved.

### Hard Delete

If a soft-deleted file has no remaining live references, the cleanup job deletes the object from storage and records the deletion by setting `hardDeletedAt`.

### Garbage Collection

The cleanup job also removes pending uploads that remain unconfirmed for more than **24 hours**, deleting both the stored object and its database record.

---

## Push Notifications

Push notifications are delivered only to eligible offline devices.

### Recipient Selection

The backend skips:

- The message sender
- Members who have muted the conversation
- Users currently connected online

Only active devices with push notifications enabled are considered.

### Coalescing

Multiple messages sent within a **2-second** window are combined into a single push notification for each device.

### Rate Limiting

Each device is limited to receiving one push notification every **30 seconds**.

### Dead Subscription Cleanup

Subscriptions returning HTTP **404** or **410** are considered invalid and are removed automatically.

### Temporary Backoff

Transient push failures temporarily disable a subscription for **5 minutes** before it becomes eligible again.

---

## Background Jobs

A background cleanup job runs every **5 minutes**. It performs the following tasks:

- Hard-deletes eligible files from object storage.
- Removes stale pending uploads older than 24 hours.
- Re-enables push subscriptions whose temporary backoff period has expired.