# POST /proposals/summarise

## 1. Description

The `/proposals/summarise` endpoint generates a plain‑English summary and a risk assessment for a Clicked governance
proposal. It is designed to help frontend readers quickly understand the proposal's intent and evaluate its potential
impact.

**What it does:**

- Accepts a proposal title, description, and requested amount
- Calls OpenAI (`gpt-4o-mini`) to produce a **2‑sentence summary**
- Returns a **risk level** (`low`, `medium`, or `high`) based on amount size, clarity, and red flags
- Includes defensive fallbacks for invalid or missing LLM responses

---


## 2. Request

### Request Body

| Field         | Type     | Required | Description                                               |
|---------------|----------|----------|-----------------------------------------------------------|
| `title`       | `string` | Yes      | Title of the governance proposal                          |
| `description` | `string` | Yes      | Detailed description of the proposal's purpose and impact |
| `amount`      | `float`  | Yes      | Amount in XLM requested for the proposal                  |

### Example Request

```json
{
  "title": "Community Events Fund",
  "description": "Requesting funds to organize 3 community events in Q4 to increase platform adoption",
  "amount": 5000.0
}
```

---

## 3. Response

### Response Body

| Field     | Type     | Description                                        |
|-----------|----------|----------------------------------------------------|
| `summary` | `string` | A 2-sentence plain-English summary of the proposal |
| `risk`    | `string` | Risk level: `"low"`, `"medium"`, or `"high"`       |

### Risk Levels

| Level      | Description                | Typical Triggers                                 |
|------------|----------------------------|--------------------------------------------------|
| `"low"`    | Safe, well-scoped proposal | Small amounts, clear purpose, low impact         |
| `"medium"` | Moderate risk              | Moderate amounts, some ambiguity, mixed impact   |
| `"high"`   | High risk                  | Large amounts, unclear intent, obvious red flags |

### Example Response

```json
{
  "summary": "Requesting 5,000 XLM to host three community events in Q4 to boost platform adoption. The funds will cover venue costs, marketing, and speaker fees.",
  "risk": "low"
}
```

---

## 4. Status Codes

| Status Code                 | Description                                   | Response Example                                   |
|-----------------------------|-----------------------------------------------|----------------------------------------------------|
| `200 OK`                    | Proposal successfully summarized              | `{ "summary": "...", "risk": "low" }`              |
| `502 Bad Gateway`           | LLM did not return a summary (empty response) | `{ "detail": "LLM did not return a summary" }`     |
| `500 Internal Server Error` | OpenAI API key missing or LLM service error   | `{ "detail": "OPENAI_API_KEY is not configured" }` |

### Error Response Example (502)

```json
{
  "detail": "LLM did not return a summary"
}
```

### Error Response Example (500)

```json
{
  "detail": "OPENAI_API_KEY is not configured"
}
```

## 5. Fallback Behavior

The endpoint includes defensive fallbacks to handle invalid or missing LLM responses:

| Scenario                                       | Behavior                                     |
|------------------------------------------------|----------------------------------------------|
| `risk` is not `"low"`, `"medium"`, or `"high"` | Defaults to `"medium"`                       |
| `summary` is empty or missing                  | Returns `502 Bad Gateway` with error message |
| OpenAI API key is missing                      | Returns `500 Internal Server Error`          |
| OpenAI API request fails                       | Returns `500 Internal Server Error`          |

### Fallback Example

If the LLM returns an invalid risk value (e.g., `"critical"`), the endpoint automatically defaults to `"medium"`:

**LLM Response (Invalid):**

```json
{
  "summary": "This proposal requests funds for community events.",
  "risk": "critical"
}
```

### Actual Response (Fallback Applied):

```json
{
  "summary": "This proposal requests funds for community events.",
  "risk": "medium"
}
```

---

Paso 9: Worked Examples
Agrega esta sección final:

markdown

## 6. Worked Examples

>### Example 1: Low Risk Proposal
>
> **Request:**
>
>
>```json
>{
>  "title": "Community Events Fund",
>   "description": "Requesting funds to organize 3 community events in Q4 to increase platform adoption and user engagement. Events will include workshops, AMAs, and networking sessions.",
> "amount": 5000.0
> }     
>```
> Response:
> 
> ```json
> {
>   "summary": "Requesting 5,000 XLM to host three community events in Q4 to boost platform adoption. The funds will cover venue costs, marketing, and speaker fees.",
>   "risk": "low"
> }             
> ```

> Example 2: Medium Risk Proposal
> Request:
> 
> ```json
> {
>   "title": "Development Team Expansion",
>   "description": "Hiring two additional developers to accelerate platform development. The team will work on new features and bug fixes.",
>   "amount": 50000.0
> }          
> ```
> Response:
> 
> ```json
> {
>   "summary": "Requesting 50,000 XLM to hire two developers for platform development. The funds will support salaries and onboarding costs for the new team members.",
>   "risk": "medium"
> }     
>  ```
> 

> Example 3: High Risk Proposal
> Request:
> 
> ```json
> {
>   "title": "Major Protocol Upgrade",
>   "description": "Requesting funds for a protocol upgrade that will change the platform's tokenomics.",
>   "amount": 500000.0
> }  
> ```
> Response:
> 
> ```json
> {
>   "summary": "Requesting 500,000 XLM for a major protocol upgrade that will modify tokenomics. The proposal lacks detail on implementation timeline and community feedback.",
>   "risk": "high"
> }
> ```
> 
> 