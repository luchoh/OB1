# Graph PRD Autoresearch

This task uses the autoresearch pattern for design-document refinement.

Mutable artifact:
- `12-graph-augmentation-prd.md`

Fixed evaluator:
- `12-graph-augmentation-prd-eval.py`

Fixed sample:
- `12-graph-augmentation-prd-eval-cases.json`

Fixed evidence:
- `12-graph-augmentation-evidence.md`

Scope:
- Only change `12-graph-augmentation-prd.md`.
- Do not change the evaluator, cases, or evidence during the tuning loop.

Goal:
- maximize `mean_score`
- maximize `accepted`
- preserve architectural discipline, implementation readiness, rollout safety, and consistency with the fixed evidence dossier

Loop:
1. Run the baseline evaluator.
2. Read the weakest cases and judge notes.
3. Edit the PRD only.
4. Re-run the evaluator.
5. Keep the revision only if the score meaningfully improves.
6. Stop when the score plateaus or all cases are accepted at a high implementation bar.

Do not optimize for:
- generic product-language polish
- adding broad aspirational scope
- rewriting the PRD into vague "knowledge graph" marketing copy
- force-fitting the PRD to Neo4j-native vectors just because the feature exists

Optimize for:
- clear Postgres-canonical / Neo4j-derived boundary
- explicit treatment of local Desktop multi-database capability
- explicit acknowledgement that Neo4j vectors and official GraphRAG exist
- correct reasons for not making them canonical in v1
- provenance-first rollout
- operational rebuildability
- confidence and evidence discipline for extracted graph facts
- graph-assisted retrieval that remains subordinate to grounded answering
