# US03 grounded answers handoff

`POST /api/v1/chat` accepts `{requestId, disasterId, question}` (contract unchanged in `packages/contracts`) and returns a `ChatResponse` with status `supported`, `partial`, `insufficient_evidence` or `extractive_fallback`.

## Pipeline

`answerQuestion` in `apps/api/src/services/generation/answerQuestion.ts` runs these steps:

1. Read the active release and epoch. If there is none, return 503 `CORPUS_UNAVAILABLE` with no provider calls.
2. Redact obvious emails and phone numbers. Only redacted text goes to Gemini.
3. Embed the query (`RETRIEVAL_QUERY`, 768 dimensions, L2-normalized). This is skipped when the release's embedding profile uses a different model. If embedding fails, retrieval continues as `lexical_only`.
4. Run semantic top 20 and lexical top 20 through `RetrievalRepository`, filtered to the captured release and the selected disaster.
5. `fuseAndSelect`:
   - Drops chunks that are cross-disaster, from another release, or unapproved. This repeats the SQL filter as defence in depth.
   - Fuses the two rankings with RRF (k = 60), breaking ties by chunk ID.
   - Applies the sufficiency gate. A chunk passes if its cosine similarity is at least the floor, or if it matched lexically and shares at least 2 content terms with the question.
   - De-duplicates text and keeps at most 2 chunks per source, 6 chunks total and 12,000 characters.
6. If no evidence remains, return `insufficient_evidence` without calling Gemini.
7. Build the factual prompt. The system instruction is fixed. The question and passages go in separate JSON blocks with `<` and `>` escaped, so source text cannot forge a block. Citation IDs are `S1`–`S6`.
8. Generate one structured-JSON call: temperature 0.1, 1,024 output tokens, no tools or grounding.
9. Validate the output with a strict Zod schema. Unknown citation IDs, uncited claims, scheme URLs, markdown links, HTML and donation instructions are rejected. On provider failure or invalid output, return `extractive_fallback`: the exact excerpts with no claims, and never a second generation call.
10. Re-read the snapshot. If the release or epoch changed, return 409 `KB_CHANGED`.

Questions that contain a link return 422 `APPEAL_REVIEW_REQUIRED`. A non-factual mode or `campaignIds` returns 422 `MODE_UNAVAILABLE` until US08 adds the router.

## Integration points

- **`RetrievalRepository`** (`services/retrieval/retriever.ts`) is for Anson and Jayson. It needs:
  - `activeCorpus()`, which returns the snapshot and embedding profile.
  - `semanticSearch` and `lexicalSearch`. Both must filter by release and disaster **before LIMIT** and return results best-first.
  - `currentSnapshot()`.

  There is no corpus migration yet, so `apps/api/src/index.ts` passes `chat: null` and the route returns 503 `CHAT_UNAVAILABLE`.
- **Gemini adapter** (`adapters/gemini/geminiClient.ts`) is created from `GEMINI_API_KEY` and the two model variables. If the key is set without both model IDs, startup fails.
- **US08** adds `appeal_explanation` and `comparison` templates beside `buildFactualPrompt`.

## Contract fixtures (ai.md §9)

`fixtures/synthetic/us03-chat/` holds one JSON file per response type. Each file contains `{request, httpStatus, response}`, built from synthetic `.test` data. The 200 responses are `supported`, `partial`, `historical-dated`, `insufficient-evidence`, `insufficient-model-abstained`, `degraded-extractive-fallback` and `degraded-lexical-only`. The error envelopes cover 400 and 413 `INVALID_CHAT_INPUT`, 422 `APPEAL_REVIEW_REQUIRED` and `MODE_UNAVAILABLE`, 503 `CHAT_UNAVAILABLE` and `CORPUS_UNAVAILABLE`, and 409 `KB_CHANGED`.

The fixtures are produced by the real pipeline. `apps/api/test/us03-chat-fixtures.test.ts` fails if any file drifts from actual output. After an intentional change, regenerate them with `UPDATE_FIXTURES=1 npm run api:test` and review the diff. Kelechi (service owner) and Conor (UI owner) approve them together. Conflict and appeal-explanation responses belong to the US08 `appeal_explanation` mode, so they are not included yet.

## Known limitations

- `semanticSimilarityFloor = 0.7` is an **untuned initial value**. Tune it on the US09 development set, freeze it, then measure on held-out cases.
- The provider concurrency cap (2) and the 429 cooldown are process-local. Durable quota admission (`quota_buckets`), per-session rate limits and request-key deduplication (ai.md §10) are not implemented.
- Current-channel questions do not yet read the structured registry for eligibility. Answers come from reviewed prose with source dates.
- Validation is structural. It cannot prove that a claim follows from its citation; US09 human review measures that.
- Request telemetry (`request_events`) is not emitted; that coordination belongs to US10/US12.

## Checks

Run on 2026-11-10: `npm run build`, `npm run check` (API 123/123, web 22/22, bundle secret scan) and `npm run dataset:typecheck`, all passing. The US03 tests in `apps/api/test/us03-grounded-answers.test.ts` use synthetic `.test` data. The live provider check is in `docs/provider-verification.md`. An end-to-end run against real published sources has not been done, because it needs the retrieval repository and a published release.
