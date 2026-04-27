# Model Council Flow

Queries 4 LLMs in parallel via OpenRouter (GPT-4o, Claude Sonnet, Gemini Flash, Grok), then synthesizes a consensus answer.

## Secrets

| Secret | Description |
|--------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter API key |

## Price

90 cents per call.

## Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `question` | string | yes | The question to ask all models |

## Response

| Field | Description |
|-------|-------------|
| `question` | The original question |
| `individual` | Array of `{ model, response }` from each LLM |
| `synthesis` | Synthesized consensus answer |
