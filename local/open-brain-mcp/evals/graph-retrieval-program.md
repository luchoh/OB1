# Graph Retrieval Policy Autoresearch

This task uses the autoresearch pattern for deterministic retrieval tuning.

Mutable artifact:
- `local/open-brain-mcp/config/graph-retrieval-policy.json`

Fixed evaluator:
- `local/open-brain-mcp/evals/eval-graph-retrieval.py`

Fixed case set:
- `local/open-brain-mcp/evals/graph-retrieval-expanded-eval-cases.json`

Scope:
- Only change the retrieval policy JSON.
- Do not change the evaluator or case set during the tuning loop.

Goal:
- maximize `mean_score`
- maximize `accepted`
- improve graph-added retrieval of related thought rows on the fixed helpful cases
- improve entity-linked cross-conversation retrieval on the fixed claim-entity cases
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
- surfacing claim-linked rows from other conversations when the entity match is clearly relevant
- rewarding anchors that cover more of the entity phrase in the question, not just any shared device name
- preserving direct vector wins on control questions
- allowing narrow answers to carry a small amount of adjacent troubleshooting context when it is part of the same real-world diagnostic chain
- minimizing unexpected graph-added rows
- stable, deterministic policy changes rather than ad hoc heuristics

Benchmark discipline:
- treat the benchmark as multi-source
- do not optimize toward a single email or attachment cluster
- prefer improvements that help electronics, project, and conversation clusters without harming control questions
