# Concepts: Transfer Risk Analysis Design Rationale

This document explains the architectural design, security rationale, and implementation of the two-path risk analysis engine powering the `POST /transfers/analyse` endpoint in the Clicked AI Agent service (`apps/ai_agent`).

---

## 1. Overview of the Two-Path Design

The `POST /transfers/analyse` endpoint evaluates transaction payloads (`amount`, `sender`, `recipient`, `memo`) to detect potential fraud or risk signals before Stellar blockchain transfers are finalized.

To balance deterministic security, response latency, and intelligent threat detection, the service employs a dual-path architecture:

```
                  +-----------------------------------+
                  |  Incoming Transfer Analysis Request |
                  |   (amount, sender, recipient, memo)|
                  +-----------------+-----------------+
                                    |
                                    v
                       Amount > 10,000.0 XLM ?
                        /               \
                       /                 \
                 YES  /                   \ NO
                     v                     v
          +--------------------+  +--------------------+
          |  Rule-Based Path   |  |      LLM Path      |
          |  (Short-Circuit)   |  |   (gpt-4o-mini)    |
          +---------+----------+  +---------+----------+
                    |                       |
                    v                       v
          +--------------------------------------------+
          |           TransferAnalyseResponse          |
          |      (flagged, reason, confidence)         |
          +--------------------------------------------+
```

---

## 2. Rule-Based Path: High-Value Threshold Short-Circuit

### Rule Threshold & Condition
Sourced from `main.py`:
- **Threshold Value**: `_HIGH_VALUE_THRESHOLD = 10_000.0` (XLM)
- **Evaluation Condition**: `if request.amount > _HIGH_VALUE_THRESHOLD:`

### Execution Behavior
If a transfer request exceeds `10,000.0 XLM`:
- **Immediate Short-Circuit**: Bypasses the OpenAI LLM invocation entirely.
- **Fixed Response**:
  - `flagged`: `true`
  - `reason`: `"Amount {amount} XLM exceeds 10000.0 XLM threshold"`
  - `confidence`: `0.99`

### Design Rationale
1. **Security Guarantee & Non-Determinism Prevention**: High-value transactions pose maximum protocol risk. Relying solely on an LLM for large amounts introduces non-deterministic risks (e.g. potential prompt injections, hallucinations, or upstream API outages).
2. **Zero-Latency Execution**: Rule evaluation operates instantly in memory without network latency or external service dependencies.
3. **Cost Efficiency**: Avoids unnecessary LLM token consumption on transfers that warrant automatic flagging due to monetary policy.

---

## 3. LLM Evaluation Path: Contextual Fraud & Pattern Analysis

For transfers where `amount <= 10,000.0 XLM`, the service delegates analysis to OpenAI's `gpt-4o-mini` model.

### Why Simple Rules Are Insufficient
Traditional rule-based systems rely on static thresholds or address blacklists. They cannot easily detect:
- **Suspicious Memo Content**: Social engineering tactics, phishing links, coercion phrasing, or scam keywords inside transaction memos.
- **Contextual Anomaly Detection**: Subtle patterns across combined transaction metadata (`sender`, `recipient`, `memo`).

### LLM Prompt & Criteria
Sourced from `main.py`:
```text
Analyse this Stellar transfer for fraud risk.
Amount: {request.amount} XLM
Sender: {request.sender}
Recipient: {request.recipient}
Memo: {request.memo}

Reply with JSON only using keys: flagged (bool), reason (string under 100 chars or null), confidence (float 0-1). Flag if suspicious patterns are detected.
```

### Response Mapping
- **Model**: `gpt-4o-mini` with `response_format={"type": "json_object"}` and a 10-second timeout.
- **Output Schema**: Returns a `TransferAnalyseResponse` containing `flagged` (boolean), `reason` (short explanatory message or `null`), and `confidence` (float between `0.0` and `1.0`).

---

## 4. Usage Guidelines & Risk Heuristic Disclaimer

### Heuristic Nature Notice
> **Important**: The transfer risk analysis score is a **fraud/risk-signal heuristic**, not a definitive guarantee or cryptographic transaction block. It evaluates input signals to estimate risk probability.

### Caller & Integration Recommendations
Client applications consuming `POST /transfers/analyse` are expected to use the results as an advisory guardrail:

- **When `flagged=true` & `confidence >= 0.8`**:
  - Present a high-risk warning modal to the user prior to transaction signing.
  - Require secondary authentication (e.g., 2FA or PIN confirmation).
  - Optionally route the transfer to a manual compliance review queue for multi-sig group treasuries.
- **When `flagged=false`**:
  - Allow standard single-tap wallet signing flow.
