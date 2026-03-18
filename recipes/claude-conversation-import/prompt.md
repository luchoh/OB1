You are distilling a Claude conversation into standalone thoughts for a personal knowledge base.

This is a second-brain memory extraction task, not a summarization task.
Only keep memories that future-me would genuinely want back months or years later.

CAPTURE up to {limit} thoughts when the conversation clearly contains durable memory:
- project state, architecture, implementation direction, system constraints
- decisions made and why they were made, but only when I explicitly stated or clearly endorsed them
- debugging diagnoses tied to my actual systems, code, hardware, or setup
- preferences, standards, values, and recurring operating principles
- durable personal or business context that changes how future work should be done
- specific facts about my real devices, environments, accounts, or infrastructure when they are likely to matter again

DROP the conversation entirely and return zero thoughts when it is mostly:
- generic support or troubleshooting that is not clearly durable
- consumer-device/carrier/app support with no lasting project consequence
- factual lookup, plan pricing, shopping, or consumer Q&A with no lasting consequence
- one-off formatting, writing, brainstorming, or casual chat
- hypothetical exploration without a conclusion I actually adopted
- coding help that does not reveal a durable decision, diagnosis, or preference

Each thought must:
- be written in first person
- be grounded in the actual user messages
- stay specific to my real context, not generic advice
- stand alone without the original chat
- be 1-3 sentences

Bias toward:
- concrete project names, tools, versions, platforms, file names, and constraints
- “I decided / I discovered / I need / I use / I rejected / I’m building...”
- for unresolved troubleshooting, prefer “I measured / I observed / I am trying / I am considering...” over “I discovered...” unless I explicitly confirmed the conclusion

Avoid:
- generic “I learned that...” wording unless it is anchored to my actual project or system
- restating Claude’s advice as universal truth
- turning Claude’s suggestions, guesses, or proposed fixes into memories unless I explicitly confirmed or adopted them
- inventing specific component values, root causes, migrations, branches, versions, or hardware changes that I did not state
- turning my questions about whether something is normal, broken, or correct into a confirmed conclusion unless I explicitly resolved it
- converting raw measurements or proposed part swaps into causal explanations unless I explicitly stated the explanation
- turning an attempted change into “to fix X” unless I explicitly said that was the confirmed reason
- obvious support boilerplate
- multiple thoughts that say nearly the same thing

If you are not sure whether a detail came from me or from Claude, leave it out.
If a troubleshooting chat does not contain a durable diagnosis, constraint, decision, or repeated pattern from my real environment, return fewer thoughts or none.

Return a JSON object with exactly one key: "thoughts".
The value of "thoughts" must be an array of 0-{limit} strings.
Treat {limit} as an upper bound, not a target.
Return fewer when only a few memories are truly durable.
If the conversation does not clear the second-brain bar, return {{"thoughts": []}}.
