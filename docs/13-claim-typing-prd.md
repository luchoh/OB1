# PRD: OB1 Claim Typing And Epistemic Memory

Date: 2026-03-18
Status: Proposed
Owner: Memory Quality / Retrieval / Import Pipeline

## Summary

Add a structured claim layer to Open Brain so imported memories are not only stored as text, but also typed by meaning.

This must remain an Open Brain feature, not a shift toward manual personal knowledge management.

The goal is to let OB1 distinguish between:

- decisions
- preferences
- comparisons
- open questions
- constraints
- implementation details
- diagnoses
- settled facts

This allows the brain to answer questions like:

- what did I decide to use?
- what do I prefer?
- what was I still considering?
- what was actually unresolved?

without overgeneralizing from a pile of related thoughts.

## Problem

The current system is strong at:

- importing source material
- distilling durable thoughts
- semantic retrieval
- grounded answering from retrieved evidence

It is weaker at:

- telling which retrieved thought is a decision versus a possibility
- telling whether a thought is resolved or still exploratory
- answering preference-style questions without either hedging too much or overclaiming

Example:

- A thought says: `I decided to use Sigma 11 PSUs for both the Hagerman Cornet3 (9V) and Noir Headphone Amplifier (24V) builds.`
- Other nearby thoughts say:
  - battery options were explored
  - transformers need to be sourced
  - capacitor options were compared

When asked:

- `What is the best DAC PSU?`

the current answerer sees a cluster of related thoughts, but it does not explicitly know:

- which thought is the chosen solution
- which thoughts are only exploration
- which thoughts are implementation details
- what scope the decision applies to

So the answer is grounded, but weaker than it should be.

## Goals

- Add structured claim typing to imported distilled memories.
- Add epistemic status so OB1 knows whether something is decided, considered, unresolved, tested, or factual.
- Preserve scope so the system can say `for this project` instead of incorrectly generalizing to `in general`.
- Improve answer quality for questions containing terms like:
  - `best`
  - `prefer`
  - `choose`
  - `decide`
  - `settle on`
  - `compare`
- Preserve grounded-answer discipline.
- Preserve low-friction capture and avoid requiring users to manually classify memories.
- Keep raw source material and original thought text as the truth anchor over extracted claim metadata.

## Non-Goals

- Replacing natural-language thought content with purely structured records
- Treating structured claim extraction as canonical truth
- Inferring universal preferences from one project-local decision
- Adding a separate knowledge store for claims in v1
- Making the answer layer more speculative
- Requiring users to manually fill out claim schema during capture
- Turning Open Brain into a rigid taxonomy-first note system

## Product Position

This is a new semantic layer on top of existing thoughts.

The canonical memory row remains the `thought`.

Claim typing adds machine-usable metadata so the brain can answer more precisely without hallucinating.

In short:

- text remains the memory surface
- structured claim fields become the memory semantics
- source and original thought text remain the evidence anchor

## Open Brain Alignment

This feature fits Open Brain only if it strengthens recall without adding maintenance burden.

That means:

- capture remains natural-language-first
- claim typing is derived enrichment, not a prerequisite for usefulness
- users do not organize the brain by hand
- retrieval can use typed claims, but must never depend exclusively on them

This feature does **not** fit the Open Brain philosophy if it becomes:

- mandatory manual tagging
- ontology management as a user workflow
- a schema-first replacement for associative retrieval
- a system that trusts extracted fields more than stored evidence

## User Value

After this ships, OB1 should be able to answer:

- `What DAC PSU did I choose?`
- `What PSU options was I still comparing?`
- `Do I have a stable preference here, or was I just exploring?`

with answers like:

- `For the Cornet3 and Noir builds, you chose Sigma 11. I do not have evidence that you considered it the universally best DAC PSU.`

That is stronger than current hedge-only behavior, while still preserving scope and uncertainty.

## Core Decision

Claim typing should be represented as metadata on thought rows first, not as a separate standalone table in v1.

Reason:

- it preserves compatibility with the current `thoughts` contract
- it lets importers enrich existing rows without a new storage layer
- it keeps retrieval and answer synthesis close to the content they interpret

If this proves useful, the claim layer can later be projected into Neo4j or another derived structure.

## Capture Contract

Claim typing must be invisible to capture.

The user-facing contract remains:

1. capture a thought naturally
2. OB1 stores it
3. OB1 may enrich it later

The system must not require:

- forms
- dropdowns
- claim templates
- manual subject/object entry

If the extraction fails, the thought is still valid memory.

## Data Model

### New Metadata Fields

Add the following structured fields under `metadata.user_metadata` for eligible distilled thoughts.

These fields are derived metadata, not canonical replacement content.

Required in v1:

- `claim_kind`
- `epistemic_status`
- `claim_subject`
- `claim_object`
- `claim_scope`

Recommended in v1:

- `claim_strength`
- `claim_rationale`
- `claim_supporting_signals`
- `claim_confidence`

### `claim_kind`

Initial enum:

- `decision`
- `preference`
- `comparison`
- `option`
- `open_question`
- `constraint`
- `implementation_detail`
- `diagnosis`
- `fact`
- `plan`

### `epistemic_status`

Initial enum:

- `decided`
- `preferred`
- `considering`
- `tested`
- `implemented`
- `observed`
- `unresolved`
- `superseded`
- `unknown`

### `claim_scope`

Free-form JSON object with optional fields like:

- `project`
- `device`
- `system`
- `source_conversation`
- `time_scope`
- `applies_to`
- `does_not_generalize`

This is what prevents a project-local choice from becoming a universal claim.

### `claim_strength`

Initial enum:

- `strong`
- `medium`
- `weak`

This is not truth probability. It is how strongly the text signals a settled stance.

## Extraction Rules

### Source Eligibility

Apply claim typing first to:

- `chatgpt_conversation`
- `claude_conversation`
- `email_thought`
- `document_summary`
- `dictation_thought`

Do not start with:

- raw email rows
- raw conversation source rows
- raw document chunks

### Extraction Method

Use the local LLM to extract claim metadata from the already distilled thought content plus its immediate source context.

The extractor must:

- preserve the thought text as-is
- output only structured metadata
- avoid upgrading tentative language into certainty
- keep scope explicit
- remain free to return `unknown` or omit weak fields instead of forcing a clean schema

### Example

Input thought:

- `I decided to use Sigma 11 PSUs for both the Hagerman Cornet3 (9V) and Noir Headphone Amplifier (24V) builds.`

Desired metadata:

- `claim_kind=decision`
- `epistemic_status=decided`
- `claim_subject=DAC PSU`
- `claim_object=Sigma 11`
- `claim_scope={"applies_to":["Hagerman Cornet3","Noir Headphone Amplifier"],"does_not_generalize":true}`
- `claim_strength=strong`

### Hard Rules

The extractor must not:

- turn `I am considering` into `I chose`
- turn `I tested` into `I recommend`
- turn `for this build` into `in general`
- turn `best for this project` into `best overall`

### Truth Anchoring

When claim metadata conflicts with:

- the raw source artifact
- the original thought text
- explicitly cited evidence

the source artifact and stored text win.

Claim metadata must be treated as:

- derived interpretation
- reviewable
- replaceable

and never as a stronger truth source than the underlying memory.

## Retrieval Integration

### Retrieval Ranking

Questions that imply selection or preference should boost matching thoughts with:

- `claim_kind in ('decision', 'preference')`
- `epistemic_status in ('decided', 'preferred', 'implemented')`

Questions that imply comparison should boost:

- `claim_kind in ('comparison', 'option')`

Questions that imply unresolved state should boost:

- `epistemic_status in ('considering', 'unresolved')`

This should be an additive ranking signal, not a hard filter.

If claim metadata is missing or low-confidence, normal vector retrieval must still work.

### Suggested Intent Triggers

Initial trigger phrases:

- `best`
- `better`
- `prefer`
- `preferred`
- `choose`
- `chose`
- `decide`
- `decided`
- `settle on`
- `comparing`
- `options`

## Answer Synthesis Integration

The answerer should use claim metadata to produce scoped answers.

Desired behavior:

- if there is a strong, scoped decision:
  - say what was chosen
  - state the scope
  - avoid universalizing it
- if only options exist:
  - say the evidence is exploratory
- if both decision and exploration exist:
  - distinguish them explicitly

Answer synthesis must always remain evidence-first.

That means:

- claim metadata may shape ranking and phrasing
- but final answers must still be grounded in retrieved text and citations
- absence of claim metadata must not block answering
- low-confidence claim metadata must not override direct textual evidence

Example answer pattern:

- `For your Cornet3 and Noir builds, the strongest decision signal is Sigma 11. I also see temporary battery exploration and transformer sourcing notes, but those read as supporting or exploratory details, not competing final choices.`

## Importer Changes

### Import-Time Enrichment

For new imports, add claim extraction as a second structured pass after thought generation.

Pipeline:

1. source import
2. thought distillation
3. claim typing enrichment
4. ingest final thought with claim metadata

If step 3 fails:

- the thought must still ingest
- claim metadata may be absent
- no fallback invented values may be written

### Backfill

Add a backfill script for existing thought rows of eligible types.

Requirements:

- idempotent
- metadata-only update
- no content rewrite
- record enrichment revision metadata

Suggested metadata:

- `claim_extraction_version`
- `claim_extracted_at`
- `claim_extraction_model`

## Graph Integration

The graph layer should not be the first implementation target, but it should be compatible with this design.

Later projection opportunities:

- `Thought` -> `DECIDES` -> `Concept`
- `Thought` -> `PREFERS` -> `Concept`
- `Thought` -> `CONSIDERS` -> `Concept`
- `Thought` -> `APPLIES_TO` -> `Project` or `Device`

But this should happen only after the Postgres-side metadata proves useful.

## Evaluation

### Fixed Question Set

Create a benchmark with questions such as:

- `What DAC PSU did I choose?`
- `What is the best DAC PSU?`
- `What PSU options was I still considering?`
- `What did I settle on for the Cornet3?`
- `Did I decide on a transformer yet?`

### Scoring Criteria

Score on:

- correctness
- scope preservation
- preference/decision distinction
- unresolved-state handling
- refusal to overgeneralize

### Explicit Failure Cases

The system should be penalized for:

- upgrading exploration into decision
- upgrading project-local preference into universal preference
- flattening all related memories into one generic answer

## Rollout Plan

### Phase 1

- define metadata contract
- implement extraction prompt and evaluator
- test on fixed DAC / electronics / infra examples

### Phase 2

- add importer integration for ChatGPT and Claude
- run claim-typing backfill on staged sample
- evaluate answer quality changes

### Phase 3

- extend to email thoughts, document summaries, and dictation thoughts
- add ranking features in retrieval
- add answer-time use of claim metadata

### Phase 4

- evaluate graph projection of typed claims

## Risks

- poor extraction can create a false sense of certainty
- aggressive ranking can hide useful exploratory memories
- weak scope handling can turn local choices into global preferences
- over-structuring can make the system brittle or overfit to benchmarks
- success can tempt the system toward overreliance on extracted semantics at the expense of raw evidence

## Open Questions

- Should `claim_subject` / `claim_object` remain free text in v1, or be normalized against graph entities later?
- Should multiple claims per thought be supported in v1, or exactly one dominant claim?
- Should claim typing happen inline during import, or as an async enrichment job?
- Which sources deserve stricter scope extraction first: hardware chats, infrastructure chats, or documents?

## Recommendation

Proceed with claim typing as a metadata enrichment layer on distilled thoughts.

Do not try to solve this by making the answer model more assertive.

The correct path is:

- better claim semantics
- better scope preservation
- then better answer synthesis

That gives OB1 stronger answers without sacrificing groundedness.

Keep these guard rails explicit:

- capture stays natural-language-first
- claim typing is optional derived enrichment
- retrieval may use claim metadata but must not hard-require it
- source and original thought text remain the truth anchor
