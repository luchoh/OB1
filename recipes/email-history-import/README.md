# Email History Import

Import a standard IMAP mailbox into the local Open Brain service as searchable email thoughts.

## What It Does

Connects to a standard IMAP mailbox, fetches each RFC 822 message, parses it locally, and ingests each email into OB1 through the local `/ingest/thought` contract.

It also supports unattended mailbox watching:
- run [watch-imap.py](/Users/luchoh/Dev/OB1/recipes/email-history-import/watch-imap.py#L1) as a background process
- new mail sent to the inbox is imported automatically on the next poll cycle
- failed message imports are retried automatically because the sync log only advances after a full successful message run

Attachments are now first-class inputs:
- attachment files are detected from the MIME message
- each attachment is sent through the same Docling pipeline used by the document importer
- attachments use OCR first and automatically escalate to Docling `vlm` when the initial extraction is weak
- extracted attachment chunks become searchable `document_chunk` rows
- distilled attachment summaries become searchable `document_summary` rows
- attachment originals remain in IMAP while the converted Markdown artifact can be retained in MinIO
- each attachment-derived row links back to the parent email with stable provenance metadata

Each imported email is stored with:
- sender metadata
- subject
- date
- mailbox
- IMAP flags
- RFC 822 message ID when present

The importer is idempotent:
- each message writes with a stable mailbox/UID-based `dedupe_key`
- successful runs are also recorded in `imap-sync-log.json`

By default the importer also distills each email into up to 3 durable `email_thought` entries using the local Qwen endpoint.
Use `--no-distill` if you want raw email records only.

## Prerequisites

- working local OB1 setup
- a reachable IMAP account
- Python 3.10+
- the local OB1 service running
- your real `.env.open-brain-local`
- a reachable Docling service if attachment processing is enabled
- MinIO access if you want attachment-converted Markdown retention

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
EMAIL HISTORY IMPORT -- CREDENTIAL TRACKER
--------------------------------------

FROM YOUR LOCAL OPEN BRAIN SETUP
  OB1 ingest URL:        ____________
  MCP access key:        ____________

FROM YOUR IMAP ACCOUNT
  IMAP host:             ____________
  IMAP port:             ____________
  IMAP username:         ____________
  IMAP mailbox:          ____________

--------------------------------------
```

## Steps

From the repo root:

```bash
cd recipes/email-history-import
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
set -a
source ../../.env.open-brain-local
set +a
python import-imap.py \
  --host imap.example.com \
  --username you@example.com \
  --mailbox INBOX \
  --dry-run \
  --limit 25
```

If you omit `--password`, the importer prompts for it securely.

If the dry run looks right:

```bash
python import-imap.py \
  --host imap.example.com \
  --username you@example.com \
  --mailbox INBOX
```

Useful examples:

```bash
# only import mail since January 1, 2025
python import-imap.py --host imap.example.com --username you@example.com --since 2025-01-01

# only import unseen mail from a specific sender
python import-imap.py --host imap.example.com --username you@example.com --unseen --from alice@example.com

# strip quoted reply blocks before ingest
python import-imap.py --host imap.example.com --username you@example.com --strip-quotes

# skip attachment parsing if you only want the email body
python import-imap.py --host imap.example.com --username you@example.com --no-attachments

# reprocess only specific attachments from matching messages
python import-imap.py --host imap.example.com --username you@example.com \
  --mailbox INBOX --ignore-sync-log --attachments-only \
  --attachment-name AHIztok_Shema_15_07032026.pdf \
  --attachment-name AHIztok_Shema_15_10032026.pdf

# keep original attachment in IMAP, but retain the converted Markdown artifact in MinIO
python import-imap.py --host imap.example.com --username you@example.com \
  --retain-attachment-markdown \
  --minio-service-name "${MINIO_SERVICE_NAME:-minio}" \
  --minio-bucket open-brain-document-originals \
  --minio-prefix imap-attachments/markdown

# watch the mailbox forever and auto-import new mail
python watch-imap.py --host imap.example.com --username you@example.com --verbose
```

For the current local managed deployment, keep `MINIO_ENDPOINT` unset, discover MinIO through `MINIO_SERVICE_NAME=minio`, and set `MINIO_SECURE=false` explicitly when retaining attachment Markdown.

## Expected Outcome

After running the import, you should see your emails as rows in the `thoughts` table. Each thought's `content` field contains a structured email snapshot and the `metadata` jsonb field includes:
- `source`: `"imap"`
- `sender`: sender email address
- `subject`: email subject line
- `date`: original send date
- `mailbox`
- `flags`
- `imap_uid`
- `rfc822_message_id`

If the email has attachments that Docling can parse, you should also see:
- `document_chunk` rows with `source: "imap_attachment"`
- `document_summary` rows with `source: "imap_attachment"`
- `email_dedupe_key` metadata linking those rows back to the parent email

You can search for any email content using the local OB1 MCP server's `search_thoughts` tool.

## Runtime Notes

- The importer uses IMAP `SEARCH` with the explicit filters you provide.
- `--since` and `--before` are applied through IMAP search and re-checked locally after parsing.
- The importer writes with `extract_metadata=false` because sender, subject, date, mailbox, and flags are already structured and large mailboxes should not pay an LLM extraction cost per message.
- Distillation is enabled by default and creates separate `email_thought` rows linked back to the source email with stable dedupe keys.
- Attachment processing is enabled by default and uses the shared Docling pipeline.
- Attachment-derived metadata now records `docling_pipeline_used`, `docling_fallback_triggered`, and the quality signals behind any fallback.
- When `--retain-attachment-markdown` is enabled, the original attachment still stays in IMAP and only the converted Markdown artifact is written to MinIO.
- MinIO-backed attachment retention requires an explicit `MINIO_SECURE` value or `--minio-secure` / `--no-minio-secure`.
- If attachment summary extraction fails, the importer still keeps the attachment chunks and records the summary error in metadata.
- `--no-attachments` disables attachment processing.
- `--attachments-only` turns the importer into an attachment reprocess tool and skips email body + email thought ingest.
- `--attachment-name FILE` limits attachment processing to exact filenames. Repeatable.
- `--no-attachment-summaries` keeps attachment chunks but skips attachment summary thoughts.
- `--attachment-chunker hierarchical|hybrid` controls the Docling chunker used for attachments.
- `--retain-attachment-markdown` plus the `--minio-*` flags publishes the attachment-derived Markdown artifact to MinIO.
- The sync log now records an importer schema version, so older body-only imports are reprocessed once and pick up attachments safely under the existing dedupe model.
- The current search flags are `SINCE`, `BEFORE`, `UNSEEN`, `FROM`, `SUBJECT`, and `TEXT`.
- `watch-imap.py` is the unattended mode. It polls the mailbox forever, reuses the same importer, and relies on `imap-sync-log.json` for idempotency and retry behavior.

## Auto Mode

For a workstation/local service:

```bash
cd recipes/email-history-import
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
set -a
source ../../.env.open-brain-local
set +a
python watch-imap.py --verbose
```

For a managed service, use:

```bash
./scripts/run-open-brain-imap-watch.sh --verbose
```

Recommended env:
- `IMAP_HOST`
- `IMAP_PORT=993`
- `IMAP_ACCOUNT` or `IMAP_USERNAME`
- `IMAP_PASSWORD`
- `IMAP_MAILBOX=INBOX`
- `IMAP_POLL_INTERVAL_SECONDS=60`
- `IMAP_ERROR_BACKOFF_SECONDS=300`

## Troubleshooting

`Login failed`
- Confirm the server host, port, username, and password. If the provider requires an app password, use that instead of your normal mailbox password.

`Import runs but no thoughts appear in OB1`
- Check that `MCP_ACCESS_KEY` is loaded and the local OB1 service is healthy.

`Attachment processing fails`
- Confirm Docling is reachable through `DOCLING_BASE_URL` or Consul discovery, or pass `--docling-url http://host:port`.
- Re-run with `--attachment-chunker hierarchical` before assuming the file itself is bad. The importer already retries with `vlm` automatically when the first pass is weak.

`Mailbox select failed`
- Make sure the mailbox name is valid for that server. Common values are `INBOX`, `Archive`, or provider-specific folder names.

`Large mailbox`
- Import in batches with `--since`, `--before`, `--from`, `--subject`, or `--text`.

`Large attachment looks slow`
- The unattended watcher still processes it automatically; it just keeps running until Docling and summarization finish.
- Use `--verbose` so the logs show `processing_attachment=` and `processed_attachment=` progress lines.

`Need to re-run everything from scratch`
- Remove `imap-sync-log.json` and rerun. The `dedupe_key` still protects the DB from duplicates.
