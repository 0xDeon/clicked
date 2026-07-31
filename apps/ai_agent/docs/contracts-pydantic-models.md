# Pydantic Request/Response Models

This document serves as a single reference for all Pydantic data models defined in `apps/ai_agent/main.py`. By defining them here, other API documentation files (`api-*.md`) can cross-reference these models by name rather than duplicating their field lists.

## Chat Models

### `ChatRequest`
Used for submitting a user message to the AI agent.
- `message` (`str`): The content of the user's message. Must be a valid string.
- `conversation_id` (`str`): The unique identifier for the conversation. Must be a valid string.

### `ChatResponse`
The agent's reply to a chat request.
- `reply` (`str`): The AI-generated response text. Must be a valid string.

## Transfer Analysis Models

### `TransferAnalyseRequest`
Payload for requesting fraud risk analysis on a Stellar transfer.
- `amount` (`float`): The transfer amount in XLM. Must be a valid float.
- `sender` (`str`): The Stellar address of the sender. Must be a valid string.
- `recipient` (`str`): The Stellar address of the recipient. Must be a valid string.
- `memo` (`str`): The memo string attached to the transaction. Must be a valid string.

### `TransferAnalyseResponse`
The result of the transfer risk analysis.
- `flagged` (`bool`): Whether the transfer was flagged as suspicious. Must be a valid boolean.
- `reason` (`str | None`): The reason it was flagged, or null/None if not flagged. Must be a string or null.
- `confidence` (`float`): The model's confidence in the flagging decision, between 0.0 and 1.0. Must be a valid float.

## Message Indexing Models

### `IndexMessageRequest`
Payload for upserting a message into the Weaviate vector database for semantic search.
- `messageId` (`str`): The unique identifier of the message. Must be a valid string.
- `conversationId` (`str`): The unique identifier of the conversation. Must be a valid string.
- `senderId` (`str`): The unique identifier of the sender. Must be a valid string.
- `content` (`str`): The plaintext content of the message to embed. Must be a valid string.

## Proposal Summarisation Models

### `ProposalSummariseRequest`
Payload for generating a frontend-friendly summary and risk assessment for a DAO proposal.
- `title` (`str`): The title of the proposal. Must be a valid string.
- `description` (`str`): The full text description of the proposal. Must be a valid string.
- `amount` (`float`): The funding amount requested in XLM. Must be a valid float.

### `ProposalSummariseResponse`
The generated summary and evaluated risk level.
- `summary` (`str`): A concise 2-sentence summary of the proposal. Must be a valid string.
- `risk` (`RiskLevel`): The evaluated risk of the proposal. Must be exactly one of the literal values: `"low"`, `"medium"`, or `"high"`.

---

*Note: Validation constraints for these models are enforced natively by Pydantic based on their type annotations. The AI Agent endpoint strictly coerces payloads and raises HTTP 422 Unprocessable Entity if payloads do not match these definitions.*
