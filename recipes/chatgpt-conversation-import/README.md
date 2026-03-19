# ChatGPT Conversation Import

Import a ChatGPT data export into Open Brain as distilled, searchable thoughts.

## What It Does

- reads a ChatGPT export zip or extracted folder
- supports both `conversations.json` and sharded `conversations-000.json` style exports
- preserves user text from newer multimodal turns and includes attachment filenames as context
- filters low-value conversations
- distills each kept conversation into a selective set of durable thoughts
- uses an adaptive thought cap: usually `1-3`, but up to `7` for dense conversations
- derives claim metadata for each distilled thought:
  - `claim_kind`
  - `epistemic_status`
  - `claim_subject`
  - `claim_object`
  - `claim_scope`
- applies deterministic secret hygiene before ingest, redacting obvious literal secrets from both extracted thoughts and stored source text
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

Current boundary:
- the importer reads conversation JSON plus message-level attachment metadata
- it does not separately ingest binary ChatGPT-export files or images
- `--raw` mode skips claim typing as well as thought distillation

Prompt and evaluation artifacts:
- [prompt.md](/Users/luchoh/Dev/OB1/recipes/chatgpt-conversation-import/prompt.md#L1)
- [eval-prompt.py](/Users/luchoh/Dev/OB1/recipes/chatgpt-conversation-import/eval-prompt.py#L1)
- [eval-cases.json](/Users/luchoh/Dev/OB1/recipes/chatgpt-conversation-import/eval-cases.json#L1)
- [program.md](/Users/luchoh/Dev/OB1/recipes/chatgpt-conversation-import/program.md#L1)

Shared claim-typing artifacts:
- [claim prompt](/Users/luchoh/Dev/OB1/recipes/claim-typing/prompt.md#L1)
- [claim evaluator](/Users/luchoh/Dev/OB1/recipes/claim-typing/eval-prompt.py#L1)
- [claim cases](/Users/luchoh/Dev/OB1/recipes/claim-typing/eval-cases.json#L1)

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

## Prompt QA

Run the fixed prompt benchmark on a real export:

```bash
recipes/chatgpt-conversation-import/.venv/bin/python \
  recipes/chatgpt-conversation-import/eval-prompt.py \
  /path/to/chatgpt-export.zip
```

Run autoresearch against the fixed benchmark:

```bash
recipes/chatgpt-conversation-import/.venv/bin/python \
  recipes/prompt-autoresearch.py \
  /path/to/chatgpt-export.zip \
  --eval-module recipes/chatgpt-conversation-import/eval-prompt.py \
  --prompt-file recipes/chatgpt-conversation-import/prompt.md \
  --cases recipes/chatgpt-conversation-import/eval-cases.json
```

## Important Flags

- `--dry-run`: parse, filter, and summarize without writing
- `--limit N`: test with a small subset first
- `--after YYYY-MM-DD`: only import newer conversations
- `--before YYYY-MM-DD`: only import older conversations
- `--raw`: skip summarization and ingest the user text directly
  - secret hygiene still applies before ingest
  - claim typing is skipped in raw mode
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

`Why did one conversation produce more than 3 thoughts?`
- The importer now uses an adaptive cap based on conversation size. Long dense conversations can yield more than `3`, but the model is still instructed to stay selective and return fewer when appropriate.
