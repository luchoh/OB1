# Claim Typing

Derived claim typing for distilled chat memories.

This recipe does not create thoughts. It classifies existing distilled thoughts with structured metadata such as:

- `claim_kind`
- `epistemic_status`
- `claim_subject`
- `claim_object`
- `claim_scope`

The goal is to help OB1 answer questions like:
- `What did I choose?`
- `What options was I considering?`
- `What is still unresolved?`

without turning the brain into a manual ontology workflow.

## Artifacts

- [prompt.md](/Users/luchoh/Dev/OB1/recipes/claim-typing/prompt.md#L1)
- [eval-prompt.py](/Users/luchoh/Dev/OB1/recipes/claim-typing/eval-prompt.py#L1)
- [eval-cases.json](/Users/luchoh/Dev/OB1/recipes/claim-typing/eval-cases.json#L1)
- [program.md](/Users/luchoh/Dev/OB1/recipes/claim-typing/program.md#L1)

## Run The Fixed Evaluator

```bash
set -a
source .env.open-brain-local
set +a
recipes/chatgpt-conversation-import/.venv/bin/python \
  recipes/claim-typing/eval-prompt.py
```

## Backfill Existing Chat Thoughts

This updates metadata only and does not rewrite embeddings:

```bash
set -a
source .env.open-brain-local
set +a
recipes/chatgpt-conversation-import/.venv/bin/python \
  scripts/backfill-chat-claim-typing.py \
  --source all
```

Useful flags:
- `--dry-run`
- `--conversation-limit N`
- `--source chatgpt|claude|all`
- `--force`

## Notes

- Claim typing is derived enrichment, not a truth source.
- If the extractor cannot type a thought reliably, it should emit no claim.
- The original thought text and cited evidence remain the truth anchor.
