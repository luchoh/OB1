# Local Bootstrap

This is the concrete bootstrap path for the current local-only Open Brain design.

## Files

- App config template: [`.env.open-brain-local.example`](/Users/luchoh/Dev/OB1/.env.open-brain-local.example)
- Core SQL bootstrap: [`docs/sql/ob1-core-bootstrap.sql`](/Users/luchoh/Dev/OB1/docs/sql/ob1-core-bootstrap.sql)
- Canonical migration directory: [`local/open-brain-mcp/migrations`](/Users/luchoh/Dev/OB1/local/open-brain-mcp/migrations)
- Migration runner: [`scripts/apply-open-brain-local-migrations.sh`](/Users/luchoh/Dev/OB1/scripts/apply-open-brain-local-migrations.sh)
- Local MCP service: [`local/open-brain-mcp`](/Users/luchoh/Dev/OB1/local/open-brain-mcp)
- Product spec: [`docs/05-local-network-prd.md`](/Users/luchoh/Dev/OB1/docs/05-local-network-prd.md)
- Verification script: [`scripts/verify-open-brain-local.sh`](/Users/luchoh/Dev/OB1/scripts/verify-open-brain-local.sh)
- End-to-end smoke test: [`scripts/smoke-open-brain-local-mcp.sh`](/Users/luchoh/Dev/OB1/scripts/smoke-open-brain-local-mcp.sh)
- Managed-service handoff: [`docs/09-open-brain-local-service-handoff.md`](/Users/luchoh/Dev/OB1/docs/09-open-brain-local-service-handoff.md)

## Canonical Services

- PostgreSQL: `ob1` database with `pgvector`
- Inference: the `mlx-server` Consul service using `mlx-community/Qwen3.5-397B-A17B-nvfp4`
- Inference health: the discovered `mlx-server` service `/health` endpoint
- Embeddings: the `ob1-embedding` Consul service using `mlx-community/Qwen3-Embedding-8B-mxfp8`
- Embedding health: the discovered `ob1-embedding` service `/health` endpoint
- Document parsing: via the `docling` Consul service
- Document parsing health: the discovered `docling` service `/health` endpoint
- Rollback embedding path: the `llama-cpp-embedding` Consul service using the Nomic model

## Embedding Contract

- Accepted v1 production contract: `1536` dimensions
- The canonical owner of that contract is `ob1-embedding`, not application clients
- The canonical endpoint now returns `1536` dimensions server-side
- Accepted request behavior: no `dimensions` field or `dimensions=1536`
- Expected error behavior: `400` for unsupported dimensions

## Recommended First Run

1. Copy [`.env.open-brain-local.example`](/Users/luchoh/Dev/OB1/.env.open-brain-local.example) to your real runtime env file and fill in secrets.
2. If you use `direnv`, allow the repo env:
   - `direnv allow`
3. Enter the repo shell:
   - `devenv shell`
4. Run [`scripts/apply-open-brain-local-migrations.sh`](/Users/luchoh/Dev/OB1/scripts/apply-open-brain-local-migrations.sh) to apply the canonical SQL from [`local/open-brain-mcp/migrations`](/Users/luchoh/Dev/OB1/local/open-brain-mcp/migrations).
5. Start the local MCP runtime with:
   - `devenv up open_brain_local`
6. Run [`scripts/verify-open-brain-local.sh`](/Users/luchoh/Dev/OB1/scripts/verify-open-brain-local.sh) to confirm Consul registration, health, model IDs, the embedding contract, and PostgreSQL schema shape.
7. Run [`scripts/smoke-open-brain-local-mcp.sh`](/Users/luchoh/Dev/OB1/scripts/smoke-open-brain-local-mcp.sh) to verify the local server itself end to end.
8. Only change embedding dimensionality if you are prepared to regenerate all embeddings and adjust the schema.
9. Keep client-side dimensionality reduction disabled unless the canonical service contract changes.

## Notes

- The bootstrap schema uses `vector(1536)` as the default production path for `Qwen3-Embedding-8B`.
- The accepted long-term design is server-side dimensionality control in `ob1-embedding`.
- The service now serves the production embedding dimension directly, so clients should not perform their own truncation in steady state.
- The canonical runtime scaffold now lives in [`local/open-brain-mcp`](/Users/luchoh/Dev/OB1/local/open-brain-mcp) and mirrors the Hono/MCP pattern used by the extension examples.
- The local runtime now exposes grounded answering through the `ask_brain` MCP tool and the `/ask` HTTP route.
- The canonical document-ingest path is now the live Docling service plus [recipes/document-import](/Users/luchoh/Dev/OB1/recipes/document-import#L1).
- Document and attachment import now use an OCR-first Docling pass and automatically retry with the `vlm` pipeline when extraction quality is clearly weak.
- Run one worker per model service and scale embeddings with batching, not worker duplication.
- Pre-stage model artifacts locally and prefer offline startup semantics.
- `.envrc` now points `direnv` at the repo `devenv` definition, and `devenv.nix` loads `.env.open-brain-local`.
- If later testing proves that `halfvec(3072)` materially improves retrieval quality, that should be treated as an explicit schema migration rather than an in-place tweak.
