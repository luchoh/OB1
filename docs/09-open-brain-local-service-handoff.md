# Open Brain Local Service Handoff

This is the deployment handoff for running the local MCP service as a managed LAN service.

`launchd` setup itself is expected to be handled by the sysadmin. This document defines the service contract so that setup is mechanical rather than interpretive.

## Canonical Runtime

- repo path: [local/open-brain-mcp](/Users/luchoh/Dev/OB1/local/open-brain-mcp)
- start wrapper: [scripts/run-open-brain-local.sh](/Users/luchoh/Dev/OB1/scripts/run-open-brain-local.sh)
- migrations: [scripts/apply-open-brain-local-migrations.sh](/Users/luchoh/Dev/OB1/scripts/apply-open-brain-local-migrations.sh)
- verifier: [scripts/verify-open-brain-local.sh](/Users/luchoh/Dev/OB1/scripts/verify-open-brain-local.sh)
- full smoke: [scripts/smoke-open-brain-local-mcp.sh](/Users/luchoh/Dev/OB1/scripts/smoke-open-brain-local-mcp.sh)
- running-service smoke: [scripts/smoke-open-brain-running-service.sh](/Users/luchoh/Dev/OB1/scripts/smoke-open-brain-running-service.sh)

## Required Env

Minimum required values:

- `MCP_ACCESS_KEY`
- PostgreSQL connectivity:
  - `PGHOST`
  - `PGPORT`
  - `PGDATABASE`
  - `PGUSER`
  - `PGPASSWORD`
- model endpoints:
  - `LLM_BASE_URL`
  - `LLM_HEALTH_URL`
  - `LLM_MODEL`
  - `EMBEDDING_BASE_URL`
  - `EMBEDDING_HEALTH_URL`
  - `EMBEDDING_MODEL`

Recommended service-specific values:

- `OPEN_BRAIN_HOST=0.0.0.0`
- `OPEN_BRAIN_PORT=8787`
- `OPEN_BRAIN_SERVICE_NAME=open-brain-local`
- `OPEN_BRAIN_LLM_SERVICE_NAME=mlx-server`
- `OPEN_BRAIN_EMBEDDING_SERVICE_NAME=ob1-embedding`
- `DOCLING_BASE_URL=http://10.10.10.100:5001`
- `DOCLING_SERVICE_NAME=docling`

Reference template:

- [`.env.open-brain-local.example`](/Users/luchoh/Dev/OB1/.env.open-brain-local.example)

## Managed Service Contract

The sysadmin-managed service should:

1. Apply DB migrations before first start:
   - [scripts/apply-open-brain-local-migrations.sh](/Users/luchoh/Dev/OB1/scripts/apply-open-brain-local-migrations.sh)
2. Start the runtime with:
   - [scripts/run-open-brain-local.sh](/Users/luchoh/Dev/OB1/scripts/run-open-brain-local.sh)
   - note: the wrapper does not source env files itself; env loading remains in the app config so inherited `launchd` env can override repo-local defaults
3. Expose these endpoints on the chosen LAN bind:
   - `/`
   - `/health`
   - `/mcp`
   - `/ingest/thought`
4. Register in Consul only after `/health` returns `200`
5. Advertise the LAN IP in Consul, not `127.0.0.1`

## Consul Registration

Template file:

- [ops/consul/open-brain-local.service.json.example](/Users/luchoh/Dev/OB1/ops/consul/open-brain-local.service.json.example)

Expected service identity:

- service name: `open-brain-local`
- service id: `open-brain-local-8787`
- advertised address: the host LAN IP
- advertised port: `8787`
- health check: `GET http://127.0.0.1:8787/health`

The health check intentionally targets loopback. The catalog address should still be the LAN IP so clients can connect from elsewhere on the network.

## Verification

After the sysadmin wires the managed service, verify in this order:

1. Upstreams and schema:
   ```bash
   ./scripts/verify-open-brain-local.sh
   ```
2. Service health:
   ```bash
   curl -fsS http://<lan-ip>:8787/health
   ```
3. MCP endpoint with auth:
   ```bash
   curl -fsS \
     -H "x-access-key: $MCP_ACCESS_KEY" \
     http://<lan-ip>:8787/
   ```
4. Full local MCP smoke:
   - before managed deployment:
     - [scripts/smoke-open-brain-local-mcp.sh](/Users/luchoh/Dev/OB1/scripts/smoke-open-brain-local-mcp.sh)
   - after managed deployment:
     - [scripts/smoke-open-brain-running-service.sh](/Users/luchoh/Dev/OB1/scripts/smoke-open-brain-running-service.sh)

## Current Data Contract

- canonical embedding dimension: `1536`
- importer dedupe key: supported and recommended
- importer metadata bypass: supported via `extract_metadata=false`
- document ingest path: [recipes/document-import](/Users/luchoh/Dev/OB1/recipes/document-import#L1)

## Sysadmin Prompt

Use this exact prompt if you want to hand off the managed-service work cleanly:

```text
Please deploy the Open Brain local MCP runtime as a managed LAN service on the M3 Ultra.

Use the repo’s existing service contract:
- start wrapper: scripts/run-open-brain-local.sh
- migrations: scripts/apply-open-brain-local-migrations.sh
- verification: scripts/verify-open-brain-local.sh
- Consul template: ops/consul/open-brain-local.service.json.example

Required behavior:
- bind the service for LAN access, not loopback only
- keep the canonical port at 8787 unless you have a concrete conflict
- do not register in Consul until /health returns 200
- advertise the LAN IP in Consul under service name open-brain-local
- keep the health check on the local host side, e.g. http://127.0.0.1:8787/health
- preserve the existing model and database env contract from .env.open-brain-local

Please return:
- the final launchd label
- the final env file path used by the service
- the final advertised LAN URL
- the final Consul service id/name
- any deviations from the repo template
```
