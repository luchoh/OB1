# ChatGPT Conversation Import

Import a ChatGPT data export into Open Brain as distilled, searchable thoughts.

## What It Does

- reads a ChatGPT export zip or extracted folder
- filters low-value conversations
- distills each kept conversation into 1-3 durable thoughts
- ingests those thoughts into the local OB1 service

The local-first path uses:
- local Qwen inference through the `mlx-server` Consul service
- local OB1 ingest on `localhost:8787`
- local embeddings through the OB1 service
- no internet egress in steady state
- Qwen tool calling for structured extraction

## Prerequisites

- Python 3.10+
- `requests` installed from [requirements.txt](/Users/luchoh/Dev/OB1/recipes/chatgpt-conversation-import/requirements.txt)
- the local OB1 service running
- your real `.env.open-brain-local`
- a ChatGPT data export zip or extracted folder

## Export Your ChatGPT History

In ChatGPT:

1. Open `Settings`
2. Open `Data Controls`
3. Choose `Export Data`
4. Confirm the export request
5. Download the zip from the email OpenAI sends you

The importer accepts either:
- the downloaded zip directly
- the extracted folder

## Local Run

From the repo root:

```bash
cd recipes/chatgpt-conversation-import
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
set -a
source ../../.env.open-brain-local
set +a
python import-chatgpt.py /path/to/chatgpt-export.zip --dry-run --limit 10
```

If the dry run looks right:

```bash
python import-chatgpt.py /path/to/chatgpt-export.zip
```

This importer uses Qwen tool calling for thought extraction rather than `response_format`, because that is the reliable structured-output path on the current `mlx-server`. Details are in [docs/08-vllm-mlx-no-thinking.md](/Users/luchoh/Dev/OB1/docs/08-vllm-mlx-no-thinking.md#L1).

## Important Flags

- `--dry-run`: parse, filter, and summarize without writing
- `--limit N`: test with a small subset first
- `--after YYYY-MM-DD`: only import newer conversations
- `--before YYYY-MM-DD`: only import older conversations
- `--raw`: skip summarization and ingest the user text directly
- `--verbose`: print the full extracted thoughts
- `--report FILE`: write a markdown import report

## Runtime Defaults

By default the script uses:

- summarizer model: `LLM_MODEL`
- summarizer endpoint: `LLM_BASE_URL` or Consul discovery of `mlx-server`
- summarizer thinking mode: `LLM_ENABLE_THINKING=false`
- ingest endpoint: `http://localhost:8787/ingest/thought`
- ingest key: `MCP_ACCESS_KEY`

You can override the ingest path with:

```bash
export OPEN_BRAIN_INGEST_URL=http://localhost:8787/ingest/thought
export OPEN_BRAIN_INGEST_KEY="$MCP_ACCESS_KEY"
```

## Optional Local Fallback

If you want to summarize with Ollama instead of the canonical MLX endpoint:

```bash
python import-chatgpt.py /path/to/chatgpt-export.zip --model ollama --ollama-model qwen3
```

## Troubleshooting

`No conversations JSON files found`
- Point the script at the export zip or the extracted export directory.

`Unauthorized`
- The local OB1 service is up, but the importer does not have the right `MCP_ACCESS_KEY`.

`No thoughts extracted`
- This is expected for low-value or purely transactional conversations. Use `--raw` if you want everything.

`Already imported`
- The sync log is `chatgpt-sync-log.json` in this recipe directory. Remove it if you want to re-run from scratch.
