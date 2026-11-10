# Gemini provider verification

Required by `ai.md` §2 before code depends on a model. Repeat the check whenever the key, project or model changes. Never record the key itself.

## 2026-11-10 (Kelechi, US03)

| Operation | Model ID | Settings | Result |
| --- | --- | --- | --- |
| Query embedding | `gemini-embedding-001` | `taskType: RETRIEVAL_QUERY`, `outputDimensionality: 768` | Pass: 768 finite values. Raw L2 norm was about 0.59, so client-side normalization (`normalizeVector`) is required at 768 dimensions. |
| Structured generation | `gemini-3.5-flash-lite` | `responseMimeType: application/json`, `responseSchema` = GeneratedAnswer, temperature 0.1 | Pass: valid JSON matching the schema. Usage reported 21 prompt and 38 output tokens. |

- SDK: `@google/genai` 2.31.0 (pinned).
- Calls: one embedding and one generation, with synthetic text only.
- **Not yet recorded:** the project's actual requests-per-minute and requests-per-day limits for each model, and confirmation that the Google Cloud project has no billing account attached. The project owner must read these from Google AI Studio and add them here. Durable quota admission (`quota_buckets`, ai.md §10) needs these numbers.
