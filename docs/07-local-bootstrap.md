# Local Bootstrap

This is the concrete bootstrap path for the current local-only Open Brain design.

## Files

- App config template: [`.env.open-brain-local.example`](/Users/luchoh/Dev/OB1/.env.open-brain-local.example)
- Core SQL bootstrap: [`docs/sql/ob1-core-bootstrap.sql`](/Users/luchoh/Dev/OB1/docs/sql/ob1-core-bootstrap.sql)
- Product spec: [`docs/05-local-network-prd.md`](/Users/luchoh/Dev/OB1/docs/05-local-network-prd.md)

## Canonical Services

- PostgreSQL: `ob1` database with `pgvector`
- Inference: `http://10.10.10.101:8035` using `mlx-community/Qwen3.5-397B-A17B-nvfp4`
- Embeddings: `http://10.10.10.101:8082` using `mlx-community/Qwen3-Embedding-8B-mxfp8`
- Rollback embedding path: `http://10.10.10.101:8081` using the Nomic model

## Current Embedding Reality

- The canonical embedding service on `8082` currently returns `4096` values.
- It currently ignores the OpenAI-style `dimensions` parameter.
- The bootstrap schema therefore assumes client-side prefix truncation to `1536` before insert and search.

## Recommended First Run

1. Copy [`.env.open-brain-local.example`](/Users/luchoh/Dev/OB1/.env.open-brain-local.example) to your real runtime env file and fill in secrets.
2. Run [`docs/sql/ob1-core-bootstrap.sql`](/Users/luchoh/Dev/OB1/docs/sql/ob1-core-bootstrap.sql) against the `ob1` database.
3. Build the local MCP service against the canonical endpoints above.
4. Only change embedding dimensionality if you are prepared to regenerate all embeddings and adjust the schema.

## Notes

- The bootstrap schema uses `vector(1536)` as the default production path for `Qwen3-Embedding-8B`.
- Until the embedding service supports server-side dimension control, the application needs to truncate the returned Qwen embedding to the configured storage dimension.
- A live smoke test has already succeeded with this approach: fetch from `8082`, truncate client-side to `1536`, insert into `thoughts`, query with `match_thoughts`, and roll back.
- If later testing proves that `halfvec(3072)` materially improves retrieval quality, that should be treated as an explicit schema migration rather than an in-place tweak.
