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

## Canonical Services

- PostgreSQL: `ob1` database with `pgvector`
- Inference: `http://10.10.10.101:8035/v1` using `mlx-community/Qwen3.5-397B-A17B-nvfp4`
- Inference health: `http://10.10.10.101:8035/health`
- Embeddings: `http://10.10.10.101:8082/v1` using `mlx-community/Qwen3-Embedding-8B-mxfp8`
- Embedding health: `http://10.10.10.101:8082/health`
- Document parsing: `http://10.10.10.100:5001` via the `docling` Consul service
- Document parsing health: `http://10.10.10.100:5001/health`
- Rollback embedding path: `http://10.10.10.101:8081/v1` using the Nomic model

## Embedding Contract

- Accepted v1 production contract: `1536` dimensions
- The canonical owner of that contract is `ob1-embedding`, not application clients
- The canonical endpoint now returns `1536` dimensions server-side
- Accepted request behavior: no `dimensions` field or `dimensions=1536`
- Expected error behavior: `400` for unsupported dimensions

## Recommended First Run

1. Copy [`.env.open-brain-local.example`](/Users/luchoh/Dev/OB1/.env.open-brain-local.example) to your real runtime env file and fill in secrets.
2. Run [`scripts/apply-open-brain-local-migrations.sh`](/Users/luchoh/Dev/OB1/scripts/apply-open-brain-local-migrations.sh) to apply the canonical SQL from [`local/open-brain-mcp/migrations`](/Users/luchoh/Dev/OB1/local/open-brain-mcp/migrations).
3. Install and run the local MCP service from [`local/open-brain-mcp`](/Users/luchoh/Dev/OB1/local/open-brain-mcp).
4. Run [`scripts/verify-open-brain-local.sh`](/Users/luchoh/Dev/OB1/scripts/verify-open-brain-local.sh) to confirm Consul registration, health, model IDs, the embedding contract, and PostgreSQL schema shape.
5. Run [`scripts/smoke-open-brain-local-mcp.sh`](/Users/luchoh/Dev/OB1/scripts/smoke-open-brain-local-mcp.sh) to verify the local server itself end to end.
6. Only change embedding dimensionality if you are prepared to regenerate all embeddings and adjust the schema.
7. Keep client-side dimensionality reduction disabled unless the canonical service contract changes.

## Notes

- The bootstrap schema uses `vector(1536)` as the default production path for `Qwen3-Embedding-8B`.
- The accepted long-term design is server-side dimensionality control in `ob1-embedding`.
- The service now serves the production embedding dimension directly, so clients should not perform their own truncation in steady state.
- The canonical runtime scaffold now lives in [`local/open-brain-mcp`](/Users/luchoh/Dev/OB1/local/open-brain-mcp) and mirrors the Hono/MCP pattern used by the extension examples.
- The canonical document-ingest path is now the live Docling service plus [recipes/document-import](/Users/luchoh/Dev/OB1/recipes/document-import#L1).
- Run one worker per model service and scale embeddings with batching, not worker duplication.
- Pre-stage model artifacts locally and prefer offline startup semantics.
- If later testing proves that `halfvec(3072)` materially improves retrieval quality, that should be treated as an explicit schema migration rather than an in-place tweak.
