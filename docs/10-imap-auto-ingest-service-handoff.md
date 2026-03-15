# IMAP Auto-Ingest Service Handoff

This is the deployment handoff for running the IMAP mailbox watcher as an unattended local service.

`launchd` wiring is expected to be handled by the sysadmin. This document defines the service contract so the setup is mechanical.

## Canonical Runtime

- watcher: [recipes/email-history-import/watch-imap.py](/Users/luchoh/Dev/OB1/recipes/email-history-import/watch-imap.py)
- wrapper: [scripts/run-open-brain-imap-watch.sh](/Users/luchoh/Dev/OB1/scripts/run-open-brain-imap-watch.sh)
- importer used by the watcher: [recipes/email-history-import/import-imap.py](/Users/luchoh/Dev/OB1/recipes/email-history-import/import-imap.py)
- local OB1 ingest target: [local/open-brain-mcp](/Users/luchoh/Dev/OB1/local/open-brain-mcp)

## Required Env

Minimum required values:

- `IMAP_HOST`
- `IMAP_PORT`
- `IMAP_ACCOUNT` or `IMAP_USERNAME`
- `IMAP_PASSWORD`
- `IMAP_MAILBOX`
- `MCP_ACCESS_KEY`

Recommended values:

- `IMAP_POLL_INTERVAL_SECONDS=60`
- `IMAP_ERROR_BACKOFF_SECONDS=300`
- `OPEN_BRAIN_INGEST_URL=http://localhost:8787/ingest/thought`
- `DOCLING_SERVICE_NAME=docling`
- `CONSUL_HTTP_ADDR=https://consul.lincoln.luchoh.net`

Reference template:

- [`.env.open-brain-local.example`](/Users/luchoh/Dev/OB1/.env.open-brain-local.example)

## Managed Service Contract

The sysadmin-managed service should:

1. Ensure the local OB1 ingest service is already running and healthy.
2. Ensure Python dependencies for [recipes/email-history-import](/Users/luchoh/Dev/OB1/recipes/email-history-import) are installed.
   - preferred: create [recipes/email-history-import/.venv](/Users/luchoh/Dev/OB1/recipes/email-history-import) and install [requirements.txt](/Users/luchoh/Dev/OB1/recipes/email-history-import/requirements.txt)
   - alternative: set `PYTHON_BIN` to another interpreter that already has the recipe dependencies
3. Start the watcher with:
   - [scripts/run-open-brain-imap-watch.sh](/Users/luchoh/Dev/OB1/scripts/run-open-brain-imap-watch.sh)
4. Pass `--verbose` so the logs show message and attachment progress.
5. Keep exactly one watcher instance active for the mailbox.

## Behavior Contract

- New mail sent to the configured IMAP mailbox is imported automatically on the next poll cycle.
- Attachments are processed automatically through the same Docling path as manual imports.
- If a full message import fails, the sync log is not advanced, so the watcher retries it on a later cycle.
- Large attachments may take longer, but they are still processed automatically; no special operator command is required for steady-state new mail.

## Verification

After deployment, verify in this order:

1. Confirm the local OB1 service is healthy:
   ```bash
   curl -fsS http://localhost:8787/health
   ```
2. Start the watcher manually once:
   ```bash
   ./scripts/run-open-brain-imap-watch.sh --once --verbose
   ```
3. Send a test email to the watched inbox.
4. Wait one poll cycle plus attachment processing time.
5. Query OB1 with a real MCP client and confirm the new email appears.

## Sysadmin Prompt

Use this exact prompt if you want to hand off the auto-ingest setup cleanly:

```text
Please deploy the Open Brain IMAP watcher as a managed local service.

Use the repo’s existing service contract:
- watcher: recipes/email-history-import/watch-imap.py
- wrapper: scripts/run-open-brain-imap-watch.sh
- importer used by the watcher: recipes/email-history-import/import-imap.py

Required behavior:
- run exactly one watcher instance for the mailbox
- keep the existing local OB1 service as the ingest target
- pass the real IMAP credentials and mailbox env
- pass --verbose so message/attachment progress is visible in logs
- restart the watcher if it exits
- do not register this worker in Consul; it is a background ingest job, not a network service

Please return:
- the final launchd label
- the final env file path used by the watcher
- the final command/arguments used
- the log file path
```
