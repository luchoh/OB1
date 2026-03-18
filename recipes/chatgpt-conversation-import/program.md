# ChatGPT Prompt Autoresearch

This task uses the autoresearch pattern for prompt tuning.

Mutable artifact:
- `prompt.md`

Fixed evaluator:
- `eval-prompt.py`

Fixed sample:
- `eval-cases.json`

Scope:
- Only change `prompt.md`.
- Do not change `import-chatgpt.py`, `eval-prompt.py`, or `eval-cases.json` during the tuning loop.

Goal:
- maximize `mean_score`
- maximize `accepted`
- preserve the second-brain bar: grounded, durable, non-generic personal memory

Loop:
1. Run the baseline:
   - `../chatgpt-conversation-import/.venv/bin/python -u eval-prompt.py <chatgpt-export.zip> --report prompt-eval-report.json`
2. Read the weakest cases and the judge notes.
3. Edit `prompt.md` only.
4. Re-run the evaluator.
5. Keep the prompt only if the score meaningfully improves.
6. Stop when the score plateaus or all cases are accepted at a second-brain grade.

Do not optimize for:
- generic summarization quality
- "sounds nice" wording
- extracting more thoughts than the case deserves

Optimize for:
- no assistant-derived hallucinated backstory
- no generic support/advice memories
- strong project-specific grounding
- correct empty output for transient consumer/support chats
