# Graph Retrieval Policy Autoresearch

This task uses the autoresearch pattern for deterministic retrieval tuning.

Mutable artifact:
- `local/open-brain-mcp/config/graph-retrieval-policy.json`

Fixed evaluator:
- `local/open-brain-mcp/evals/eval-graph-retrieval.py`

Fixed case set:
- `local/open-brain-mcp/evals/graph-retrieval-eval-cases.json`

Scope:
- Only change the retrieval policy JSON.
- Do not change the evaluator or case set during the tuning loop.

Goal:
- maximize `mean_score`
- maximize `accepted`
- improve graph-added retrieval of related thought rows on the fixed helpful cases
- preserve low-noise behavior on the fixed control cases

Loop:
1. Run the baseline evaluator.
2. Read the weakest cases and notes.
3. Edit the retrieval policy JSON only.
4. Re-run the evaluator.
5. Keep the revision only if the score improves.
6. Stop when the score plateaus.

Do not optimize for:
- changing the questions
- changing the expected target ids
- adding broad noisy graph expansion
- forcing source rows into every answer

Optimize for:
- surfacing sibling distilled thoughts from the same conversation or provenance cluster
- preserving direct vector wins on control questions
- minimizing unexpected graph-added rows
- stable, deterministic policy changes rather than ad hoc heuristics

Benchmark discipline:
- treat the benchmark as multi-source
- do not optimize toward a single email or attachment cluster
- prefer improvements that help electronics, project, and conversation clusters without harming control questions
