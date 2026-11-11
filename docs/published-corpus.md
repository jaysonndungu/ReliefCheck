# Publish the first ReliefCheck corpus

Apply db/migrations/0001_staff_roles.sql and db/migrations/0002_published_corpus.sql with the migration role. The second migration creates the corpus tables and pgvector in the extensions schema. If pgvector is already installed, it must be in extensions. Grant the request-handler role read access only to the public-facing corpus views and the disaster list.

```sql
GRANT USAGE ON SCHEMA relief, extensions TO reliefcheck_app;
GRANT SELECT ON relief.disasters, relief.active_corpus, relief.published_chunks TO reliefcheck_app;
```

The publish command runs separately from the API. Set CORPUS_OPERATOR_DATABASE_URL for the command using the migration/operator connection. Keep DATABASE_URL set to the restricted request-handler connection on the API. Use the configured Gemini key only after confirming free-tier quota for the release.

1. Use the US06 adapters to extract a small set of authorized sources for both disasters. Retain the exact extraction and private source snapshot. Use the same source and document JSON shape as fixtures/synthetic/us07-extraction.json.
2. Run npm run dataset:preprocess -- path/to/extraction.json. Have an enabled staff reviewer compare the cleaned preview with the source and check its metadata, disaster assignment, permissions and flags.
3. Put the approved extraction objects into a private release JSON file with top-level actor, expectedEpoch and sources fields. Set actor to an enabled admin staff UUID. Use the current epoch from relief.kb_state, initially zero. For each extraction, include reviewedCleanedHash from its reviewed preview and set the source fields reviewStatus, reviewedBy and reviewedAt to approved, the reviewer staff UUID and the actual review timestamp. Keep this file in private storage.
4. Build the workspaces, then publish the reviewed release.

```sh
npm run build
npm run dataset:publish -- path/to/approved-release.json
```

The command rechecks the preview hashes, reuses matching stored embeddings, and creates any missing embeddings before writing the release. Publication advances the epoch atomically. If the epoch changes, review the new active release before retrying. Start with a small release that fits the project's Gemini quota.

Check GET /api/v1/health/ready for HTTP 200, then ask one known-answer question per disaster and open each citation. Ask a question with no evidence and verify the app abstains. All draft candidates remain pending until staff review them. This path uses a private operator command. Staff UI, durable ingestion jobs, and the appeal registry remain separate work.
