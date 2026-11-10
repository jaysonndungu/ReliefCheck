# Gemini provider verification

Required by `ai.md` §2 before code depends on a model. Repeat the check whenever the key, project or model changes. Never record the key itself.

## 2026-11-10 (Kelechi, US03)

| Operation | Model ID | Settings | Result |
| --- | --- | --- | --- |
| Query embedding | `gemini-embedding-001` | `taskType: RETRIEVAL_QUERY`, `outputDimensionality: 768` | Pass: 768 finite values. Raw L2 norm was about 0.59, so client-side normalization (`normalizeVector`) is required at 768 dimensions. |
| Structured generation | `gemini-3.5-flash-lite` | `responseMimeType: application/json`, `responseSchema` = GeneratedAnswer, temperature 0.1 | Pass: valid JSON matching the schema. Usage reported 21 prompt and 38 output tokens. |

- SDK: `@google/genai` 2.31.0 (pinned).
- Calls: one embedding and one generation, with synthetic text only.
### Project quotas (reported by the project owner from Google AI Studio, 2026-11-10)

| Model | RPM | TPM | RPD | App ceiling at 80% (ai.md §10) |
| --- | --- | --- | --- | --- |
| `gemini-3.5-flash-lite` (generation) | 15 | 250,000 | 500 | 12 RPM, 400 RPD |
| `gemini-embedding-001` (embeddings) | 100 | 30,000 | 1,000 | 80 RPM, 24,000 TPM, 800 RPD |

What these limits mean for the team:

- **Chat:** each answered question uses one embedding call and at most one generation call, so generation allows at most about 400 answered questions per day, for the whole project. Evaluation runs (US09) use the same budget. Do not run the full 40-case set repeatedly against this key.
- **Ingestion:** each chunk is embedded with one call, so at 800 embedding calls per day a release with more than about 700 new chunks cannot finish in one day. ai.md allows up to 2,000 chunks per release. Reuse unchanged embeddings and keep the corpus small (US05–US07, US11).
- **Throughput:** 24,000 embedding TPM is roughly 40 maximum-size chunks (2,400 characters each) per minute. Ingestion must also leave capacity for chat queries.
- **Still unconfirmed:** that the Google Cloud project has no billing account attached (ai.md invariant 9).
- **Not built yet:** durable quota admission (`quota_buckets`, ai.md §10) should enforce these 80% ceilings.
