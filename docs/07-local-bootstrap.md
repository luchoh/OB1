# Local Bootstrap

This is the concrete bootstrap path for the current local-only Open Brain design.

## Files

- App config template: [`.env.open-brain-local.example`](/Users/luchoh/Dev/OB1/.env.open-brain-local.example)
- Core SQL bootstrap: [`docs/sql/ob1-core-bootstrap.sql`](/Users/luchoh/Dev/OB1/docs/sql/ob1-core-bootstrap.sql)
- Product spec: [`docs/05-local-network-prd.md`](/Users/luchoh/Dev/OB1/docs/05-local-network-prd.md)
- Verification script: [`scripts/verify-open-brain-local.sh`](/Users/luchoh/Dev/OB1/scripts/verify-open-brain-local.sh)

## Canonical Services

- PostgreSQL: `ob1` database with `pgvector`
- Inference: `http://10.10.10.101:8035/v1` using `mlx-community/Qwen3.5-397B-A17B-nvfp4`
- Inference health: `http://10.10.10.101:8035/health`
- Embeddings: `http://10.10.10.101:8082/v1` using `mlx-community/Qwen3-Embedding-8B-mxfp8`
- Embedding health: `http://10.10.10.101:8082/health`
- Rollback embedding path: `http://10.10.10.101:8081/v1` using the Nomic model

## Embedding Contract

- Accepted v1 production contract: `1536` dimensions
- The canonical owner of that contract is `ob1-embedding`, not application clients
- The canonical endpoint now returns `1536` dimensions server-side
- Accepted request behavior: no `dimensions` field or `dimensions=1536`
- Expected error behavior: `400` for unsupported dimensions

## Recommended First Run

1. Copy [`.env.open-brain-local.example`](/Users/luchoh/Dev/OB1/.env.open-brain-local.example) to your real runtime env file and fill in secrets.
2. Run [`docs/sql/ob1-core-bootstrap.sql`](/Users/luchoh/Dev/OB1/docs/sql/ob1-core-bootstrap.sql) against the `ob1` database.
3. Build the local MCP service against the canonical endpoints above.
4. Run [`scripts/verify-open-brain-local.sh`](/Users/luchoh/Dev/OB1/scripts/verify-open-brain-local.sh) to confirm Consul registration, health, model IDs, the embedding contract, and PostgreSQL schema shape.
5. Only change embedding dimensionality if you are prepared to regenerate all embeddings and adjust the schema.
6. Keep client-side dimensionality reduction disabled unless the canonical service contract changes.

## Notes

- The bootstrap schema uses `vector(1536)` as the default production path for `Qwen3-Embedding-8B`.
- The accepted long-term design is server-side dimensionality control in `ob1-embedding`.
- The service now serves the production embedding dimension directly, so clients should not perform their own truncation in steady state.
- Run one worker per model service and scale embeddings with batching, not worker duplication.
- Pre-stage model artifacts locally and prefer offline startup semantics.
- If later testing proves that `halfvec(3072)` materially improves retrieval quality, that should be treated as an explicit schema migration rather than an in-place tweak.
