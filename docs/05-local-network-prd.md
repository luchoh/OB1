# PRD: Open Brain Local on M3 Ultra

Date: 2026-03-14
Status: Validated v1 direction
Owner: Platform / AI Infrastructure

## Summary

Build a local-network-only version of Open Brain that runs on an Apple Silicon Mac Studio-class host (target: M3 Ultra, 512 GB RAM) and keeps all storage, inference, indexing, and MCP access inside the private network.

The current OB1 repo is not a runnable local product. It is a guide and a set of extension templates that assume:

- Supabase for relational storage, auth context, and Edge Function hosting
- OpenRouter for embeddings and metadata extraction
- Public or semi-public remote MCP endpoints

This PRD defines a new deployment target, "Open Brain Local", that preserves the Open Brain interaction model while replacing all external services with self-hosted equivalents.

The validated v1 operating assumption is now:

- use `Qwen3.5-397B-A17B` on MLX for chat, reasoning, and metadata extraction
- use `Qwen3-Embedding-8B` on the dedicated `ob1-embedding` MLX service for vector generation
- keep `llama-cpp-embedding` only as rollback
- use PostgreSQL + `pgvector` as the primary store and vector index

## Problem

The documented OB1 setup depends on external SaaS and public URLs. That conflicts with the target operating constraints:

- Must run against local infrastructure on an M3 Ultra
- Must not send data outside the private network
- Must support semantic retrieval, capture, and MCP access
- Should align with the existing OB1 schema and extension model where practical

## Goals

- Provide Open Brain core functionality without external network dependencies
- Keep all user data, embeddings, metadata extraction, and MCP traffic on the LAN
- Reuse as much of the OB1 data model and MCP shape as is reasonable
- Support future extension work from this repo with a defined compatibility layer
- Be operable using the services already available in the local environment where that reduces work

## Non-Goals

- Exact drop-in compatibility with Supabase internals
- Public internet access, public SaaS model gateways, or hosted vector databases
- Full multi-tenant SaaS auth in v1
- Slack/Discord capture in the first milestone unless those services are already internalized

## User Requirements

- Primary host: Apple Silicon M3 Ultra with 512 GB RAM
- Network boundary: private LAN only
- Control plane: internal service discovery via Consul is acceptable
- Data boundary: no outbound calls for embeddings, metadata extraction, MCP, storage, or search

## Current-State Findings

### Repo Findings

- The base guide is documentation-driven and assumes Supabase + OpenRouter.
- Extension implementations use Deno/Hono + MCP SDK + `@supabase/supabase-js`.
- The repo does not contain a local core server that can be started directly.
- The ChatGPT import recipe already supports local summarization via Ollama, but still assumes external embeddings unless modified.

### Environment Findings

From the local OB1 env contract and Consul:

- Consul is configured and requires a token
- A PostgreSQL service is registered and reachable on the LAN
- That PostgreSQL instance is PostgreSQL 16.10
- `pgvector` is now installed on that server and available as `vector 0.8.0`
- The `ob1` database now exists and has `CREATE EXTENSION vector` applied
- A smoke test against `vector` type operations succeeded
- Healthy internal services currently include:
  - PostgreSQL
  - Qdrant
  - MinIO
  - Neo4j
  - Docling
- `mlx-server` is registered in Consul and responds to OpenAI-compatible `chat/completions`
- The currently exposed MLX model is `mlx-community/Qwen3.5-397B-A17B-nvfp4`
- `ob1-embedding` is registered in Consul and responds to OpenAI-compatible `embeddings`
- The canonical embedding model now exposed there is `mlx-community/Qwen3-Embedding-8B-mxfp8`
- The `ob1-embedding` service now returns `1536`-dimensional embeddings server-side by default
- It accepts either no `dimensions` field or `dimensions = 1536`
- It returns `400` for unsupported dimensions such as `3072`
- The embedding runtime is now pinned to a local artifact path at `/Volumes/llama-models/mlx-embedding/.cache/huggingface/hub/models--mlx-community--Qwen3-Embedding-8B-mxfp8/snapshots/51c773b7464b630a6c67b4f75dbd796b658d6236`
- The earlier `llama-cpp-embedding` service remains available as a fallback path and serves the Nomic embedding model
- The MLX model does not support `/v1/embeddings`, so generation and embedding must remain separate services
- Offline startup semantics are enabled for both inference and embeddings
- `ob1-embedding` now loads from a local artifact path on disk
- Consul registration for `ob1-embedding` is now gated on successful readiness and a passing `/health` check

Implication: the network now has a validated end-to-end local path for PostgreSQL, vector search, generation, and embeddings, but the architecture must explicitly separate generation models from embedding models.

### Accepted Serving Decision (March 2026)

- Keep `mlx-server` as the canonical inference service
- Keep `ob1-embedding` as the canonical embedding contract
- Keep `llama-cpp-embedding` only as rollback
- Do not move embeddings back behind generic `vllm-mlx serve`
- Standardize v1 production embeddings on `1536` dimensions
- Put dimensionality control in the `ob1-embedding` service
- Keep offline startup semantics enabled for both model services

### Model Research Findings (March 2026)

- For embeddings, the strongest fit for this project is `Qwen/Qwen3-Embedding-8B`
- For local Apple Silicon serving, a direct MLX port exists as `mlx-community/Qwen3-Embedding-8B-mxfp8`
- Qwen reports that `Qwen3-Embedding-8B` ranks No. 1 on the multilingual MTEB leaderboard in its official evaluation set, with strong English performance as well
- `Qwen3-Embedding-8B` is Apache 2.0 licensed, supports 100+ languages, supports instructions, and supports user-defined output dimensions
- That embedding model is now confirmed live locally on the dedicated `ob1-embedding` service discovered through Consul
- The official model card marks the model as MRL-capable, which means reduced-dimension outputs are a supported part of the model design
- A strong smaller alternative exists in `jinaai/jina-embeddings-v5-text-small`, but it is not the best absolute model for this hardware budget and uses a non-commercial license
- For inference, the strongest model that cleanly fits the current deployment direction is `Qwen/Qwen3.5-397B-A17B`, already validated locally as `mlx-community/Qwen3.5-397B-A17B-nvfp4`
- `Qwen3.5-397B-A17B` is especially attractive for this project because its official evaluation includes strong MCP, tool-use, and search-agent results, which map directly to the "brain" workflow
- `moonshotai/Kimi-K2.5` is a credible frontier alternative and may exceed Qwen on some agentic tasks, but the standard MLX conversion advertises a larger memory footprint than 512 GB, making it a riskier default for this host

## Product Definition

### Product Name

Open Brain Local

### Core Product Promise

Any MCP-capable AI client on the LAN can capture, search, browse, and summarize personal knowledge stored in a local relational database with local vector search and local model inference.

### Core Jobs To Be Done

- Save a thought from an MCP-connected client
- Retrieve semantically related thoughts
- Browse recent thoughts and statistics
- Import local document and conversation history
- Extend the brain with domain-specific tables and MCP tools

## Recommended Architecture

### Decision

Use a local-first stack on the M3 Ultra:

- PostgreSQL 16 + `pgvector` for the system of record and primary vector search
- `mlx-server` for chat, reasoning, and metadata extraction
- `ob1-embedding` for vector generation
- A self-hosted MCP application server
- MinIO for object/file storage
- Docling for document parsing
- Consul for service registration and discovery
- Traefik or equivalent local-only reverse proxy for internal routing

### Why This Is the Recommended Path

This is the best fit for the repo and for the private-network constraint:

- It preserves the OB1 relational schema and extension pattern
- It avoids depending on Supabase-specific managed features
- It keeps vector retrieval colocated with the primary data store
- It avoids introducing a second source of truth unless needed
- It can reuse local infrastructure patterns already present in the environment

### Explicit Rejections

#### Self-host Supabase as the primary approach

Rejected for v1 as the default recommendation.

Reason:

- It is closer to the original OB1 guide, but it is heavier operationally than needed for the actual feature set in use here
- The repo relies on only a thin slice of Supabase capabilities for the base system
- A smaller local-first stack is easier to reason about and easier to keep fully offline

#### Shared Postgres + Qdrant as the primary architecture

Rejected for v1 as the default recommendation.

Reason:

- Qdrant is healthy today and is a viable fallback
- However, a shared-store plus external vector-store split adds more moving parts than needed if `pgvector` can be installed
- `pgvector` is already installed and enabled for the current `ob1` bootstrap path

Qdrant remains a fallback if:

- the shared PostgreSQL service cannot be modified
- vector search performance requirements exceed acceptable PostgreSQL behavior
- operational isolation argues for a dedicated vector store later

## Functional Requirements

### FR1: Local Capture

The system must accept a thought payload from MCP and persist:

- raw content
- normalized metadata
- embedding vector
- timestamps
- source metadata

### FR2: Local Semantic Search

The system must support semantic similarity search over embeddings with:

- similarity threshold
- result count
- structured metadata filters
- recency ordering as a secondary control

### FR3: MCP Access

The system must expose local-only MCP endpoints for:

- `capture_thought`
- `search_thoughts`
- `list_thoughts`
- `stats`

Authentication must be local and lightweight, using an access key or internal auth gateway.

### FR4: Metadata Extraction

The system must perform local-only metadata extraction for:

- people
- action items
- dates
- topics
- type classification

### FR5: Import Pipelines

The system must support local import of:

- ChatGPT export archives
- documents and PDFs
- optional email or transcript ingestion

### FR6: Extension Compatibility

The system must provide a clear compatibility path for OB1 extensions that currently expect Supabase access patterns.

## Non-Functional Requirements

### NFR1: No Egress

The product must not require internet egress in steady state.

### NFR2: LAN-Only Reachability

Services must bind only to localhost or private interfaces and be published only through local-only routing.

### NFR3: Recoverability

All critical state must be recoverable from:

- PostgreSQL backups
- MinIO object backups
- service configuration in source control

### NFR4: Observability

The system must emit logs, metrics, and traces to the local observability stack where available.

### NFR5: Performance

The target system should deliver:

- sub-second metadata extraction queue admission
- search latency under 500 ms for typical recall paths
- predictable ingest throughput for bulk imports

## Architecture Detail

### 1. Database Layer

Primary recommendation:

- Dedicated OB1 database on PostgreSQL 16 running on the M3 Ultra or on the shared internal PostgreSQL host with `pgvector` enabled

Schema:

- Keep the core `thoughts` concept from the OB1 guide
- Add migration-managed schemas rather than dashboard-pasted SQL
- Preserve JSONB metadata to stay close to the extension design pattern

Vector strategy:

- Make vector dimensionality configuration-driven and tied to the selected embedding model
- The recommended canonical embedding model is `Qwen3-Embedding-8B`
- Because pgvector approximate indexes support `vector` up to 2,000 dimensions and `halfvec` up to 4,000 dimensions, the full 4,096-dim output of Qwen cannot be indexed directly with the default `vector` path
- v1 default should be `Qwen3-Embedding-8B` with a reduced output dimension that fits indexed PostgreSQL storage
- Accepted v1 production contract: store `1536` dimensions in `vector(1536)`
- The embedding service, not application clients, should own the dimensionality contract
- The service-side fix is now the expected production path; client-side truncation should be removed from application code
- Higher-recall experimental path: request `3072` output dimensions and store/index as `halfvec(3072)` after a dedicated retrieval benchmark
- Do not mix embeddings from different models in the same vector column or ANN index
- If multiple embedding models are supported later, version them explicitly with either separate columns or separate embedding tables/indexes

### 2. Model Gateway

Primary recommendation:

- Standardize on local OpenAI-compatible inference endpoints with separate roles for generation and embeddings

Preferred operating model:

- Run the model gateway on the M3 Ultra
- Expose separate endpoints for `chat/completions` and `embeddings`
- Keep model configuration under source control

Validated current endpoints:

- Generation:
  - Base URL: discovered from the `mlx-server` Consul service
  - Health: the discovered `mlx-server` `/health` route
  - Service: `mlx-server`
  - Model: `mlx-community/Qwen3.5-397B-A17B-nvfp4`
  - Role: chat, reasoning, metadata extraction
- Embeddings:
  - Base URL: discovered from the `ob1-embedding` Consul service
  - Health: the discovered `ob1-embedding` `/health` route
  - Service: `ob1-embedding`
  - Model: `mlx-community/Qwen3-Embedding-8B-mxfp8`
  - Production output dimension: `1536`
  - Role: vector generation only
- Rollback embeddings:
  - Base URL: discovered from the `llama-cpp-embedding` Consul service
  - Service: `llama-cpp-embedding`
  - Model: `nomic-ai/nomic-embed-text-v1.5-GGUF:nomic-embed-text-v1.5.Q8_0.gguf`
  - Role: rollback only

Recommended canonical v1 models:

- Inference:
  - Canonical model: `Qwen/Qwen3.5-397B-A17B`
  - Local serving format: `mlx-community/Qwen3.5-397B-A17B-nvfp4`
  - Why: already validated locally, Apache 2.0, 262K native context, and strong official results on MCP-Mark, Tool Decathlon, DeepPlanning, and search-agent benchmarks
- Embeddings:
  - Canonical model: `Qwen/Qwen3-Embedding-8B`
  - Local serving format: `mlx-community/Qwen3-Embedding-8B-mxfp8`
  - Why: best overall fit for a private knowledge base on this hardware budget, permissive license, multilingual, instruction-aware, stronger than the earlier Nomic bootstrap endpoint, and now already live locally on the dedicated embedding service

Recommended fallback models:

- Operational embedding fallback: keep `llama-cpp-embedding` available as a temporary rollback path with the Nomic model
- Fast embedding fallback: `jinaai/jina-embeddings-v5-text-small-retrieval-mlx`
- Experimental frontier inference fallback: `moonshotai/Kimi-K2.5` only after explicit validation on the target host with a quantization known to fit 512 GB

Implementation note:

- v1 should explicitly lock chat and metadata extraction to `Qwen3.5-397B-A17B`
- v1 should explicitly lock embeddings to `Qwen3-Embedding-8B`
- If additional embedding models are introduced later, they must be added through a versioned embedding strategy rather than silently swapped in place
- Consul registration should be retained, and clients should continue direct readiness checks against the actual inference endpoints during startup and diagnostics
- The old Nomic embedding endpoint should be treated as a rollback path, not the target long-term model choice
- Production requirement: dimensionality control must live in the `ob1-embedding` service, not in application clients
- Target steady state: `ob1-embedding` now honors a fixed production dimension of `1536` for the canonical API response
- Allowed v1 production behavior: `dimensions = null` or `dimensions = 1536`
- Recommended v1 failure mode: return `400` for unsupported dimensions until retrieval versioning is introduced
- Use model-native Matryoshka-style truncation, not PCA or a separate reducer
- Re-normalize server-side after truncation so cosine similarity remains stable

### Operational Defaults

- Run one worker process per model service
- Do not scale MLX services by adding multiple Uvicorn workers, because that duplicates model memory
- Scale embeddings with intra-request batching, not worker count
- Keep inference and embeddings in separate daemons so readiness, restart behavior, and memory pressure are isolated
- Only register Consul services after the model is actually loaded and `/health` returns `200`
- Tighten the registration helper so readiness failure prevents registration
- Pre-stage model artifacts locally and run with offline semantics
- Keep public API model names stable even if the on-disk artifact paths differ
- Do not silently inject embedding instructions in v1; if query/document instruction behavior is added later, version it explicitly
- Confirm startup paths use local artifacts and offline flags rather than hub metadata fetches

### 3. MCP Application Server

Primary recommendation:

- Build a local Hono-based MCP HTTP service that mirrors the repo's extension pattern

Responsibilities:

- authenticate inbound MCP requests
- call the MLX endpoint for metadata extraction and other generation tasks
- call the embedding endpoint for vector generation
- write/read PostgreSQL
- expose the canonical tool contract

### 4. File and Document Ingestion

Primary recommendation:

- Store raw uploaded files in MinIO
- Use Docling for document normalization and chunk extraction
- Persist extracted chunks and summaries into PostgreSQL

### 5. Service Discovery and Routing

Primary recommendation:

- Register all OB1 services in Consul
- Route only through local-only hostnames or private IPs
- Front HTTP services with internal TLS only if desired

## Security and Network Controls

### Mandatory Controls

- Default-deny outbound traffic for OB1 services
- No external model APIs
- No external vector APIs
- No public MCP endpoint
- Secrets sourced from local secret management or host environment only

### Local Auth Model

v1 should use:

- per-service access keys for MCP
- internal network policy and reverse proxy controls

v2 can add:

- internal OIDC via Dex if user-facing auth becomes necessary

## Data Model Notes

### Core Table

`thoughts`

Required columns:

- `id`
- `content`
- `embedding`
- `metadata`
- `created_at`
- `updated_at`

Recommended supporting columns:

- `embedding_model`
- `embedding_dimension`
- `content_hash`

### Metadata Contract

Preserve the repo's flexible metadata style:

- `people`
- `action_items`
- `dates_mentioned`
- `topics`
- `type`
- `source`

## Migration Strategy

### Phase 0: Infrastructure

- Confirm whether bootstrap will use the shared `ob1` database or a dedicated PostgreSQL instance on the M3 Ultra
- Keep `pgvector` enabled on the chosen PostgreSQL target
- Stand up or re-home `Qwen3.5-397B-A17B` serving on the M3 Ultra if the current MLX endpoint is only temporary
- Keep `Qwen3-Embedding-8B` on the dedicated `ob1-embedding` service as the canonical embedding endpoint
- Retain the earlier Nomic service only as a rollback path until the new embedding stack proves stable
- Pre-stage model artifacts locally and force offline startup semantics where supported
- Register services in Consul
- Stand up MinIO and document parsing dependencies if they are not already assigned to the M3 Ultra

### Phase 1: Core Open Brain Local

- Implement the local MCP service
- Implement the `thoughts` schema and vector indexes using the selected embedding dimension
- Implement capture, search, browse, and stats
- Lock generation to `Qwen3.5-397B-A17B` and embeddings to `Qwen3-Embedding-8B`
- Validate no-egress behavior
- Benchmark `Qwen3-Embedding-8B` at `1536` versus `3072` output dimensions before freezing the production schema
- Keep client-side dimensionality reduction disabled in steady state

### Phase 2: Imports

- Port ChatGPT import to local embeddings and local generation
- Add local document ingest through Docling
- Add batch re-embedding jobs

### Phase 3: Extension Compatibility

- Port extension READMEs and code from Supabase assumptions to the new local service contract
- Decide whether extensions talk directly to PostgreSQL or through the MCP/core API layer

## Acceptance Criteria

- A user can connect from a LAN MCP client and save a thought without any external network dependency
- A user can query semantically related thoughts using only local embeddings and local vector search
- A packet capture or egress firewall log shows no outbound dependency during normal capture and retrieval
- Backups can restore the database and object storage to a working state
- The core MCP tools are usable from at least one client end to end on the LAN

## Risks

### Risk 1: Model Serving Instability

The core AI services are stable today, but model-serving remains the most operationally sensitive part of the system because startup time, memory pressure, and readiness gates are tightly coupled.

Mitigation:

- Make the M3 Ultra the primary inference host
- Keep Consul registration gated on successful readiness and a passing `/health` check
- Add direct application-level readiness checks for both generation and embedding endpoints

### Risk 5: Hidden Runtime Egress

Model runtimes may still perform metadata lookups or remote fetches if configured with remote-style model identifiers only.

Mitigation:

- Pre-stage model artifacts locally
- Prefer local artifact paths or explicit offline mode such as `HF_HUB_OFFLINE=1`
- Validate cold-start behavior with network egress blocked

### Risk 4: Frontier Model Drift

The best absolute frontier model may change faster than the project should churn its core schema and serving stack.

Mitigation:

- Freeze a single canonical inference model and a single canonical embedding model for v1
- Re-evaluate only at explicit upgrade points
- Treat experimental alternatives as benchmark candidates, not silent replacements

### Risk 2: Shared Database Coupling

Using the shared PostgreSQL service for OB1 may require coordination around ownership, changes, and operational boundaries.

Mitigation:

- Prefer a dedicated OB1 PostgreSQL instance on the M3 Ultra if change control is heavy
- Keep Qdrant available as a fallback path

### Risk 3: Extension Drift

Repo extensions currently assume Supabase APIs and auth semantics.

Mitigation:

- Define a narrow compatibility layer
- Port one extension first and treat that as the reference migration pattern

## Open Questions

- Should the initial deployment reuse the shared PostgreSQL service or create a dedicated PostgreSQL instance on the M3 Ultra?
- Is user-facing auth required in v1, or is LAN boundary + access key sufficient?
- Should Qdrant remain a hot standby path for vector search, or be excluded from v1 entirely?

## Recommendation

Build v1 as:

- PostgreSQL 16 + `pgvector`
- `Qwen3.5-397B-A17B` for chat and metadata extraction
- `Qwen3-Embedding-8B` for vectors
- Hono-based local MCP service
- MinIO for file blobs
- Docling for document extraction
- Consul registration for all services

This gives the cleanest local-only architecture with the least product distortion relative to the OB1 mental model.

## Appendix A: Current `pgvector` Status and Repeatable Install Path

What is true in the current environment:

- the registered PostgreSQL service is reachable
- it is PostgreSQL 16.10
- `pgvector` exists in local Nixpkgs
- the running PostgreSQL package now exposes the `vector` extension
- the `ob1` database exists
- `CREATE EXTENSION vector` has already been applied in `ob1`
- vector type and operator smoke tests have passed

If this needs to be reproduced on another PostgreSQL 16 host, use the following install path.

### If the PostgreSQL service is NixOS-managed

Add `pgvector` to the PostgreSQL package on the host:

```nix
{
  services.postgresql = {
    enable = true;
    package = pkgs.postgresql_16;
    extensions = ps: with ps; [
      pgvector
    ];
  };
}
```

Apply the change using the host's normal deploy flow, for example:

```bash
sudo nixos-rebuild switch
```

Then verify that PostgreSQL now knows about the extension:

```sql
SELECT name, default_version
FROM pg_available_extensions
WHERE name = 'vector';
```

### Enable the Extension in the OB1 Database

Create the target database if needed:

```sql
CREATE DATABASE ob1;
```

Connect to it and enable the extension:

```sql
\c ob1
CREATE EXTENSION vector;
SELECT extversion FROM pg_extension WHERE extname = 'vector';
```

### Notes

- Installing the package on the server makes the extension available
- `CREATE EXTENSION vector;` enables it per database
- Once enabled, the OB1 schema can use `vector(<embedding_dimension>)` columns and HNSW indexes

## Appendix B: Fallback If Shared PostgreSQL Cannot Be Modified

If change control on the shared PostgreSQL service is undesirable:

- run a dedicated PostgreSQL 16 + `pgvector` instance on the M3 Ultra
- keep the same schema and MCP contract
- treat the shared internal PostgreSQL service as unrelated infrastructure

This is the preferred fallback because it preserves the recommended architecture without introducing a split Postgres/Qdrant write path in v1.
