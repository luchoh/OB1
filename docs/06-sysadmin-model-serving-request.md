# Sysadmin Prompt: M3 Ultra Model Serving for Open Brain Local

Date: 2026-03-14

Use the prompt below as-is or adapt it.

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

Validated current model-serving state:
- Inference endpoint:
  - URL: http://10.10.10.101:8035
  - Service name in Consul: mlx-server
  - Model returned by /v1/models: mlx-community/Qwen3.5-397B-A17B-nvfp4
  - owned_by: vllm-mlx
  - This is working and should be treated as the current canonical inference service unless you recommend a better local serving arrangement on the M3 Ultra

- Current embedding endpoint:
  - URL: http://10.10.10.101:8081
  - Service name in Consul: llama-cpp-embedding
  - Current model: nomic-ai/nomic-embed-text-v1.5-GGUF:nomic-embed-text-v1.5.Q8_0.gguf
  - This is working, but we do NOT want to assume it is the long-term canonical embedding service

Target model choices:
- Inference model:
  - Qwen/Qwen3.5-397B-A17B
  - Existing local serving format appears to be: mlx-community/Qwen3.5-397B-A17B-nvfp4
  - This part may already be complete

- Embedding model:
  - Preferred canonical model: Qwen/Qwen3-Embedding-8B
  - Preferred Apple Silicon serving format if appropriate: mlx-community/Qwen3-Embedding-8B-mxfp8

What I need you to decide:
1. What is the best service/runtime on the M3 Ultra for serving Qwen3-Embedding-8B?
   Options may include:
   - the existing llama.cpp-based embedding service
   - a separate vllm-mlx service
   - mlx-embeddings or another MLX-native service
   - another local service you consider superior for this host and model

2. Whether the existing inference service for Qwen3.5-397B-A17B should remain as-is, or whether you recommend a different runtime/service layout on the M3 Ultra.

3. What the canonical production endpoints and Consul service names should be for:
   - inference
   - embeddings

4. What embedding dimension we should standardize on for the first production schema.
   Context:
   - We are using PostgreSQL + pgvector
   - The application can support configurable dimensions
   - We currently expect to store indexed embeddings in PostgreSQL
   - If the full embedding dimensionality is not the right production choice, recommend the best reduced output dimension

Please return:
- Your recommended serving stack for both models on the M3 Ultra
- Final model identifiers to use in config
- Final endpoint URLs to use in app config
- Final Consul service names and health-check approach
- Whether the embedding service should stay on llama.cpp or move to a different service
- Recommended embedding dimension for production
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

- The main unresolved technical decision is the embedding runtime, not the inference runtime.
- The current inference service already exposes the desired Qwen 3.5 family on an OpenAI-compatible endpoint.
- The current embedding endpoint is a valid bootstrap path, but the canonical target model is `Qwen3-Embedding-8B`.
