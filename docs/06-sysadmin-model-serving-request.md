# Sysadmin Prompt: M3 Ultra Model Serving for Open Brain Local

Date: 2026-03-14

Status: Closed

This file now serves as a historical handoff record. The prompt below is what was used to drive the production v1 serving contract; the live environment has since been updated.

## Implemented Outcome

- `mlx-server` remains the canonical inference service, discovered through Consul
- `ob1-embedding` remains the canonical embedding service, discovered through Consul
- `ob1-embedding` now serves `1536`-dimensional embeddings by default
- Accepted request behavior: no `dimensions` field or `dimensions = 1536`
- Expected error behavior: `400` for unsupported dimensions such as `3072`
- Offline startup semantics are enabled for both inference and embeddings
- `ob1-embedding` now loads from a local artifact path on disk
- Consul registration is now gated on successful readiness and a passing `/health` check

## Historical Prompt

Use the prompt below only as historical context or when recreating the same request on another environment.

## Copy/Paste Prompt

```text
We are building a local-network-only "Open Brain" deployment.

Constraints:
- Host class: Apple Silicon M3 Ultra with 512 GB RAM
- No internet egress for runtime inference or embeddings
- OpenAI-compatible HTTP endpoints preferred
- Services should be registered in Consul with accurate health checks
- This system will be used for MCP-driven capture, retrieval, metadata extraction, and semantic search

Current known state:
- Consul is reachable and is currently our service discovery source
- Consul itself is running on the M2 Max
- The actual inference/embedding services are running on the M3 Ultra
- PostgreSQL + pgvector is already available for the `ob1` database
- PostgreSQL HNSW indexing constraints matter for the embedding shape:
  - `vector` HNSW indexing fails above 2000 dimensions
  - `halfvec` HNSW indexing works at 3072 dimensions
  - `halfvec` HNSW indexing fails above 4000 dimensions

Validated current model-serving state:
- Inference endpoint:
  - URL: the discovered `mlx-server` service root
  - Service name in Consul: mlx-server
  - Model returned by /v1/models: mlx-community/Qwen3.5-397B-A17B-nvfp4
  - owned_by: vllm-mlx
  - This is working and should be treated as the current canonical inference service unless you recommend a better local serving arrangement on the M3 Ultra

- Canonical embedding endpoint:
  - URL: the discovered `ob1-embedding` service root
  - Service name in Consul: ob1-embedding
  - Model returned by /v1/models: mlx-community/Qwen3-Embedding-8B-mxfp8
  - /health is healthy
  - /v1/embeddings works
  - Important issue: the service currently returns 4096 values and ignores the OpenAI-style `dimensions` parameter

- Rollback embedding endpoint:
  - URL: the discovered `llama-cpp-embedding` service root
  - Service name in Consul: llama-cpp-embedding
  - Current model: nomic-ai/nomic-embed-text-v1.5-GGUF:nomic-embed-text-v1.5.Q8_0.gguf
  - This should be treated as a rollback path, not the target canonical embedding service

Target model choices:
- Inference model:
  - Qwen/Qwen3.5-397B-A17B
  - Existing local serving format appears to be: mlx-community/Qwen3.5-397B-A17B-nvfp4
  - This part may already be complete

- Embedding model:
  - Preferred canonical model: Qwen/Qwen3-Embedding-8B
  - Preferred Apple Silicon serving format if appropriate: mlx-community/Qwen3-Embedding-8B-mxfp8
  - Target production API behavior: return a fixed 1536-dimensional embedding from the canonical endpoint

Production requirement:
- We do NOT want dimensionality reduction logic duplicated across clients.
- Dimensionality control should be owned by the canonical embedding service.
- The clean target state is:
  - `ob1-embedding` remains the canonical embedding endpoint
  - the endpoint returns production-shaped embeddings directly
  - the production shape for v1 should be 1536 dimensions unless you strongly recommend another shape

What I need from you:
1. Keep or improve the current inference service for Qwen3.5-397B-A17B on the M3 Ultra.

2. Update the canonical embedding service so that `ob1-embedding` returns production-ready embeddings directly.
   Preferred outcome:
   - same canonical endpoint contract through the `ob1-embedding` service
   - same service name: ob1-embedding
   - same canonical model family: Qwen3-Embedding-8B
   - canonical served output dimension: 1536

3. Decide the cleanest implementation for that service-side dimensionality control.
   Acceptable options include:
   - make the service honor the OpenAI-style `dimensions` parameter
   - make the service always emit a fixed 1536-dimensional vector
   - place a small adapter in front of the raw model service that performs the reduction server-side

4. Confirm whether 1536 is the right production dimension for v1, or whether you strongly recommend 3072 with `halfvec` and the operational tradeoffs that implies.

Please return:
- Your recommended serving stack for both models on the M3 Ultra
- Final model identifiers to use in config
- Final endpoint URLs to use in app config
- Final Consul service names and health-check approach
- Whether the current `ob1-embedding` runtime is the right long-term service, or whether it should be replaced behind the same service contract
- Recommended production embedding dimension
- Whether the canonical embedding endpoint will support server-side dimensionality control
- Any memory, concurrency, batching, or quantization notes we should lock into the PRD
- Any operational caveats for MLX / vllm-mlx / llama.cpp on this host

Decision criteria:
- Highest practical quality on this hardware
- Operational stability
- Clean OpenAI-compatible API surface
- No internet dependency at runtime
- Good fit for MCP and retrieval workflows

Please optimize for the best long-term production setup on the M3 Ultra, not the fastest short-term hack.
```

## Notes

- The prompt above is retained for auditability.
- The dimensionality-control issue described in the historical prompt is now resolved in production.
- The steady-state design is service-side dimensionality control in `ob1-embedding`, not client-side truncation.

## Follow-Up Implementation Prompt

```text
Please implement the agreed production serving contract for Open Brain Local on the M3 Ultra.

Accepted stack:
- Inference service stays as:
  - service: mlx-server
  - endpoint: the discovered `mlx-server` `/v1` route
  - health: the discovered `mlx-server` `/health` route
  - model: mlx-community/Qwen3.5-397B-A17B-nvfp4

- Embedding service stays as:
  - service: ob1-embedding
  - endpoint: the discovered `ob1-embedding` `/v1` route
  - health: the discovered `ob1-embedding` `/health` route
  - model: mlx-community/Qwen3-Embedding-8B-mxfp8

- Rollback only:
  - service: llama-cpp-embedding
  - endpoint: the discovered `llama-cpp-embedding` `/v1` route
  - model: nomic-ai/nomic-embed-text-v1.5-GGUF:nomic-embed-text-v1.5.Q8_0.gguf

Required change:
- Update `ob1-embedding` so the canonical endpoint returns production-ready 1536-dimensional embeddings directly.

Required production behavior:
1. `ob1-embedding` owns dimensionality control server-side.
2. The canonical production dimension is 1536.
3. Accept either:
   - no `dimensions` field, in which case return 1536
   - `dimensions=1536`, in which case return 1536
4. Return HTTP 400 for unsupported dimensions for now.
5. Use model-native Matryoshka-style truncation, not PCA or a separate reducer.
6. Re-normalize server-side after truncation if needed for stable cosine behavior.
7. Keep the public model identifier stable even if the on-disk artifact path differs.

Operational requirements:
- Keep inference and embeddings in separate daemons.
- Run one worker per model service.
- Scale embeddings with batching, not multiple workers.
- Only register Consul service health after the model is loaded and `/health` returns 200.
- Prevent failed readiness from still registering as healthy.
- Pre-stage model artifacts locally and prefer offline startup semantics such as `HF_HUB_OFFLINE=1`.

Please return when done with:
- confirmation that `ob1-embedding` now returns 1536-dimensional vectors
- whether the endpoint honors `dimensions=1536` or uses a fixed 1536 contract
- final local artifact paths or runtime config used
- any changes to health or Consul registration behavior
```
