# OB1 MinIO Service Authentication Decision

Date: 2026-03-23

Status: Adopted

## Summary

OB1 should use a split model:

- local development default:
  - static `MINIO_*` credentials
  - typically from `.env.open-brain-local`
- managed services:
  - MinIO-native service accounts with scoped policies
  - still presented to the worker as `MINIO_ACCESS_KEY` and `MINIO_SECRET_KEY`
- optional parity testing:
  - Keycloak/OIDC may be used only as an opt-in pre-start credential materialization flow
  - it is not the default developer workflow
  - it is not the current direct worker contract

The canonical runtime path is now Consul-backed MinIO discovery plus env-driven credentials:

- `CONSUL_HTTP_ADDR`
- optional `CONSUL_HTTP_TOKEN`
- `MINIO_SERVICE_NAME`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_SECURE`

`MINIO_ENDPOINT` remains available only as an explicit override for isolated/manual scenarios.

## Why Not Default To Keycloak For Development

Keycloak-backed human auth and service-to-MinIO auth are different concerns.

For OB1 background jobs, making Keycloak the default MinIO path in development would add the wrong dependency surface:

- the current workers do not implement direct OIDC or STS token exchange
- local development should not require shared Keycloak availability or issuer trust wiring
- importer debugging should fail on importer logic, not on token refresh or issuer config
- service isolation is clearer with per-service MinIO credentials than with reused human identities

This repo already separates human auth from background-service auth:

- human access is moving toward Keycloak on the OB1 side
- background jobs continue to use service credentials

## Canonical Managed-Service Mechanism

Use MinIO service accounts with separate scoped policies per service.

At runtime, each worker should receive:

- `CONSUL_HTTP_ADDR`
- optional `CONSUL_HTTP_TOKEN`
- `MINIO_SERVICE_NAME=minio`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_SECURE`

The difference between local development and managed service is the credential source, not the endpoint-discovery path:

- local development:
  - static local credentials are acceptable
- managed service:
  - per-service credentials issued and rotated by the sysadmin
  - do not reuse shared admin credentials

## Scope Boundaries

Use separate MinIO identities for:

- document importer
- IMAP attachment Markdown publisher
- Telegram bridge raw audio uploader
- dictation service object reader and artifact publisher
- dictation artifact importer

Do not share one MinIO identity across these workers.

The OB1 multibrain direction already assumes background jobs should stay service-scoped and bound as tightly as practical.

## Bucket And Prefix Policy Model

Keep the current bucket names and prefix layout.

### `open-brain-document-originals`

Document importer:

- read/write `documents/originals/**`
- read/write `documents/markdown/**`

IMAP attachment Markdown publisher:

- read/write `imap-attachments/markdown/**`

### `telegram-raw-audio`

Telegram bridge:

- write `telegram/**`

Dictation service:

- read `telegram/**`

### `dictation-artifacts`

Dictation service:

- write `canonical/**`

Dictation importer:

- list/read `canonical/**`

### Restrictions

For all worker identities:

- no delete permission
- no bucket-admin permission
- no wildcard access outside the required bucket and prefix
- managed services should not auto-create buckets

## Runtime Env Contract

### Canonical Runtime Vars Today

The canonical runtime env for MinIO-backed workers is:

- `CONSUL_HTTP_ADDR`
- optional `CONSUL_HTTP_TOKEN`
- `MINIO_SERVICE_NAME`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_SECURE`

Optional compatibility override:

- `MINIO_ENDPOINT`

Service-specific bucket and prefix vars remain in place:

- document import:
  - `OPEN_BRAIN_DOCUMENT_MINIO_BUCKET`
  - `OPEN_BRAIN_DOCUMENT_MINIO_PREFIX`
- IMAP attachment Markdown:
  - `OPEN_BRAIN_IMAP_ATTACHMENT_MARKDOWN_MINIO_BUCKET`
  - `OPEN_BRAIN_IMAP_ATTACHMENT_MARKDOWN_MINIO_PREFIX`
- dictation importer:
  - `DICTATION_MINIO_BUCKET`
  - `DICTATION_MINIO_PREFIX`
- Telegram bridge:
  - `TELEGRAM_RAW_AUDIO_BUCKET`

For managed services, set `TELEGRAM_ENSURE_RAW_BUCKET=false`.

### What This Means In Practice

Current worker code should use Consul discovery for MinIO in all environments.

Use `MINIO_ENDPOINT` only when explicitly overriding that discovery path for debugging or an isolated manual run.

Do not introduce a second direct worker auth contract for OIDC in v1.

If a stronger identity source is used by the platform later, it should still materialize `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, and `MINIO_SECURE` before process start until the workers explicitly support a different auth contract.

## Local Development Default

Document this explicitly:

- local dev:
  - static MinIO credentials are acceptable
  - MinIO endpoint discovery should still go through Consul
- managed service:
  - per-service MinIO service-account credentials

`.env.open-brain-local` is a developer convenience path.
It is not the managed-service secret distribution model.

## Optional OIDC Parity Profile

An optional OIDC parity profile is acceptable for staging or sysadmin parity testing, but only with the following constraints:

- it is opt-in, not the default
- it runs as a pre-start helper or wrapper, not as direct worker logic
- it must materialize the same credential runtime env vars before the worker starts
- if the chosen MinIO STS path requires a session token, parity mode is blocked until the workers add explicit session-token support

Do not document direct worker-side Keycloak token management as available today.
That is a future enhancement, not the current contract.

## Secret Distribution And Rotation

Use this operational model:

- local development:
  - `.env.open-brain-local`
- managed services:
  - per-service credentials files or env files owned by the sysadmin
  - injected by launchd or equivalent host-managed process supervision
- source of truth:
  - 1Password, Vault, or another sysadmin-managed secret store

Rotation expectations:

- rotate per-service MinIO credentials on a fixed cadence
- rotate immediately on disclosure or host compromise
- replace one service at a time
- verify the restarted worker
- revoke the old credential after verification

## Current Conclusion

Until direct worker-side OIDC support exists, treat Consul-backed MinIO discovery plus env-based key/secret MinIO auth as the canonical OB1 runtime contract.

That does not mean "one shared static key everywhere."

It means:

- local development may use a simple static credential
- local development should still discover `minio` through Consul
- managed services should use separate scoped MinIO service-account credentials
- optional OIDC parity is allowed only as a pre-start compatibility layer, not as the default developer path
