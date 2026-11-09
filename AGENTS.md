# ReliefCheck

Read [ai.md](ai.md) and the assigned story before implementing a feature. It is the team's design specification.

Use the shared API contracts in `packages/contracts` and the `/api/v1` prefix. Keep credentials server-side and coordinate shared contract and migration changes with the relevant story owners. Run `npm run build` before handing off changes.

For Gemini Developer API free-tier development, use `gemini-3.5-flash-lite` for answers and `gemini-embedding-001` for 768-dimensional embeddings. The model IDs are in `.env.example`. Set `GEMINI_API_KEY` in your ignored `.env` or in the hosting environment. Confirm the project has free-tier quota for both models before running inference.
