# Document Import

Import local documents into Open Brain through the live Docling service on your LAN.

## What It Does

- discovers the Docling service from Consul or `DOCLING_BASE_URL`
- parses and chunks documents through Docling
- retries with Docling's `vlm` pipeline when the first OCR/text pass is clearly weak
- ingests each chunk into the local OB1 service with stable `dedupe_key` values
- can retain both the original document bytes and the converted Markdown artifact in MinIO
- optionally distills each document into 0-3 summary thoughts from the Docling chunk text with the local Qwen endpoint

This recipe uses the current local stack:
- Docling on the LAN
- local Qwen inference through the `mlx-server` Consul service
- local OB1 ingest on `localhost:8787`
- optional MinIO for retained document artifacts
- no hosted Supabase/OpenRouter path

## Prerequisites

- Python 3.10+
- `requests` installed from [requirements.txt](/Users/luchoh/Dev/OB1/recipes/document-import/requirements.txt)
- the local OB1 service running from [local/open-brain-mcp](/Users/luchoh/Dev/OB1/local/open-brain-mcp#L1)
- your real `.env.open-brain-local`
- MinIO access if you want original PDF plus converted Markdown retention
- either:
  - `DOCLING_BASE_URL` set, or
  - `CONSUL_HTTP_ADDR` and `CONSUL_HTTP_TOKEN` loaded so the script can discover `docling`

## Local Run

From the repo root:

```bash
cd recipes/document-import
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
set -a
source ../../.env.open-brain-local
set +a
python import-documents.py /path/to/document.pdf --dry-run
```

If the dry run looks right:

```bash
python import-documents.py /path/to/document.pdf
```

To retain the original PDF plus converted Markdown in MinIO:

```bash
python import-documents.py /path/to/document.pdf \
  --retain-artifacts \
  --minio-service-name "${MINIO_SERVICE_NAME:-minio}" \
  --minio-bucket open-brain-document-originals \
  --minio-prefix documents
```

For the current local managed deployment, keep `MINIO_ENDPOINT` unset, discover MinIO through `MINIO_SERVICE_NAME=minio`, and set `MINIO_SECURE=false` explicitly.

To import a directory:

```bash
python import-documents.py /path/to/docs --recursive
```

## Options

- `--dry-run`: run Docling conversion and summary extraction without writing to OB1
- `--recursive`: walk directories recursively
- `--limit N`: only process the first `N` files
- `--chunker hierarchical|hybrid`: choose the Docling chunker; `hierarchical` is the verified default
- `--no-summaries`: skip whole-document summary extraction
- `--docling-url URL`: bypass Consul and point directly at a Docling base URL
- `--retain-artifacts`: upload the original file and converted Markdown artifact to MinIO
- `--minio-service-name`, `--minio-access-key`, `--minio-secret-key`, `--minio-secure`, `--minio-bucket`, `--minio-prefix`: MinIO retention settings
- `--minio-endpoint`: explicit MinIO endpoint override when not using Consul discovery
- `--verbose`: print extracted summary thoughts

## Runtime Defaults

By default the script uses:

- Docling: `DOCLING_BASE_URL` or Consul discovery of `docling`
- summarizer model: `LLM_MODEL`
- summarizer endpoint: `LLM_BASE_URL` or Consul discovery of `mlx-server`
- summarizer thinking mode: `LLM_ENABLE_THINKING=false`
- ingest endpoint: `http://localhost:8787/ingest/thought`
- ingest key: `MCP_ACCESS_KEY`
- Docling extraction strategy: OCR-first with automatic VLM fallback on low-quality extraction
- retained artifact bucket: `OPEN_BRAIN_DOCUMENT_MINIO_BUCKET` or `DOCUMENT_IMPORT_MINIO_BUCKET`, default `open-brain-document-originals`
- retained artifact prefix: `OPEN_BRAIN_DOCUMENT_MINIO_PREFIX` or `DOCUMENT_IMPORT_MINIO_PREFIX`, default `documents`
- retained artifact secure mode: set `MINIO_SECURE` explicitly or pass `--minio-secure` / `--no-minio-secure` when using MinIO retention

## Notes

- Chunk records are ingested with `extract_metadata=false`; the importer already provides structured metadata and only needs embeddings plus storage.
- Each imported chunk gets a deterministic `dedupe_key`, so re-running the same document version is idempotent.
- The current idempotency key is based on the file content hash and chunk index. If the file contents change, the new version is stored as new rows.
- `hybrid` chunking is available, but `hierarchical` is the verified default on the current Docling service.
- Imported metadata now records whether Docling stayed on the standard pipeline or escalated to `vlm`, plus the quality signals that triggered fallback.
- When `--retain-artifacts` is enabled, each ingested row records both the original-file MinIO reference and the converted-Markdown MinIO reference.
- If whole-document summary extraction fails, chunk ingest still succeeds and the error is recorded in metadata for inspection.

## Converter Bakeoff

Use the included harness to compare Docling, Marker, and MinerU on your actual PDFs:

```bash
cd recipes/document-import
python benchmark-pdf-converters.py /path/to/sample-pdfs --recursive
```

Useful options:

- `--converters docling marker mineru`: choose which converters to run
- `--converters docling-service marker mineru`: use the live Docling service instead of the local Docling Python package
- `--output-dir DIR`: write all Markdown outputs and the report under a custom directory
- `--timeout SECONDS`: cap runtime per converter

The harness writes:

- one Markdown output per converter per PDF
- stdout/stderr logs for package or CLI adapters
- `converter-bakeoff-report.md`
- `converter-bakeoff-results.json`

## Troubleshooting

`Could not discover a passing Docling service in Consul`
- Load the real `.env.open-brain-local`, or pass `--docling-url http://host:port`.

`Local OB1 ingest failed (401)`
- The importer does not have the right `MCP_ACCESS_KEY`.

`Docling returned zero chunks`
- The importer already tries `vlm` automatically when the standard OCR pass is weak. Re-run with `--chunker hierarchical` before assuming the file itself is bad.
