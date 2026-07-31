# POST /transfers/analyse — Transfer Fraud Analysis

Analyses a Stellar transfer for fraud risk. The endpoint has two code paths:

1. **Rule-based short-circuit** — high-value transfers are immediately flagged without calling the LLM.
2. **LLM analysis** — all other transfers are analysed by GPT-4o-mini.

---

## Request

`POST /transfers/analyse`

### Request body (`TransferAnalyseRequest`)

| Field       | Type    | Description                                           |
|-------------|---------|-------------------------------------------------------|
| `amount`    | `float` | Transfer amount in XLM.                               |
| `sender`    | `str`   | Sender Stellar account address (ed25519 public key).  |
| `recipient` | `str`   | Recipient Stellar account address.                    |
| `memo`      | `str`   | Transfer memo text.                                   |

Example:

```json
{
  "amount": 5000.0,
  "sender": "GABC…",
  "recipient": "GDEF…",
  "memo": "invoice payment"
}
```

---

## Analysis paths

### 1. Rule-based short-circuit (high-value transfers)

**Condition:** `request.amount > 10_000.0` (strictly greater than 10 000 XLM).

When the threshold is exceeded the LLM is **never called**. The response is returned immediately with hardcoded values:

| Field        | Value                            |
|--------------|----------------------------------|
| `flagged`    | `true`                           |
| `reason`     | `"Amount {n} XLM exceeds 10000.0 XLM threshold"` |
| `confidence` | `0.99`                           |

Transfers **equal to** 10 000.0 XLM take the LLM path; only values strictly above trigger the short-circuit.

### 2. LLM analysis path (default)

All transfers with `amount <= 10_000.0` are sent to `gpt-4o-mini` with a prompt that includes the amount, sender, recipient, and memo. The model is instructed to:

- Reply with JSON only
- Return `flagged` (bool), `reason` (string under 100 chars or `null`), `confidence` (float 0–1)
- Flag suspicious patterns

The LLM call has a 10-second timeout. Requests are billed normally per OpenAI usage.

---

## Response (`TransferAnalyseResponse`)

| Field        | Type          | Description                                                                 |
|--------------|---------------|-----------------------------------------------------------------------------|
| `flagged`    | `bool`        | Whether the transfer is considered suspicious.                              |
| `reason`     | `str` or null | Human-readable explanation. `null` when the transfer is not flagged.        |
| `confidence` | `float`       | Confidence in the assessment, ranging from `0.0` (low confidence) to `1.0` (certain). |

### Fallback defaults

If the LLM response omits a key, the following defaults are applied:

| Omitted key   | Default  |
|---------------|----------|
| `flagged`     | `false`  |
| `confidence`  | `0.0`    |

`reason` is passed through as-is (`null` if absent or explicitly `null`).

---

## Errors

| Status | Condition                                | Body detail                        |
|--------|------------------------------------------|------------------------------------|
| 422    | Missing required field or type mismatch  | Validation error per FastAPI       |
| 500    | `OPENAI_API_KEY` environment variable is not set | `"OPENAI_API_KEY is not configured"` |
| 500    | `openai` package is not installed        | `"openai package is not installed"` |

---

## Examples

### High-value transfer (rule-based path)

```json
// Request
POST /transfers/analyse
{"amount": 25000.0, "sender": "GABC", "recipient": "GDEF", "memo": "wholesale"}

// Response (200)
{"flagged": true, "reason": "Amount 25000.0 XLM exceeds 10000.0 XLM threshold", "confidence": 0.99}
```

### Normal transfer (LLM path — flagged)

```json
// Request
POST /transfers/analyse
{"amount": 500.0, "sender": "GABC", "recipient": "GDEF", "memo": "unusual pattern"}

// Response (200)
{"flagged": true, "reason": "Suspicious memo detected", "confidence": 0.88}
```

### Normal transfer (LLM path — clean)

```json
// Request
POST /transfers/analyse
{"amount": 200.0, "sender": "GABC", "recipient": "GDEF", "memo": "salary"}

// Response (200)
{"flagged": false, "reason": null, "confidence": 0.12}
```

### Missing required field

```json
// Request
POST /transfers/analyse
{"sender": "GABC", "recipient": "GDEF", "memo": "no amount"}

// Response (422)
{"detail": [{"type": "missing", "loc": ["body", "amount"], "msg": "Field required", ...}]}
```
