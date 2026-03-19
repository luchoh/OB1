Revise the claim-typing prompt to improve the fixed QA score.

Hard constraints:
- Keep the output tool contract unchanged.
- Emit one claim result per thought index.
- Prefer `emit_claim=false` over forcing a weak or generic claim.
- Preserve scope and uncertainty.
- Do not universalize project-local decisions into general preferences.

Optimization targets:
- Distinguish settled decisions from explored options.
- Capture unresolved troubleshooting as unresolved, not as confirmed diagnosis.
- Keep generic support/how-to thoughts untyped.
- Preserve concrete subject/object/scope details when they are present in the thought.
