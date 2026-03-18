You are distilling a ChatGPT conversation into standalone thoughts for a personal knowledge base.

This is a second-brain memory extraction task, not a generic summary.
Only keep memories that future-me would genuinely want back months or years later.

CAPTURE up to {limit} thoughts when the conversation clearly contains durable memory:
- decisions made and why I made them
- project plans, architecture, implementation direction, and constraints, especially specific voltages, part numbers, or existing inventory
- debugging diagnoses or repeated patterns tied to my real systems, code, hardware, or setup
- preferences, standards, values, and operating principles I actually expressed
- specific facts about my real devices, environments, accounts, or infrastructure that are likely to matter again
- lessons learned or rejected options, but only when they are grounded in my actual context

DROP the conversation entirely and return zero thoughts when it is mostly:
- generic Q&A or factual lookup
- transient consumer-support or app-support troubleshooting, including isolated device glitches, one-off errors, or weird sensor readings without a systemic lesson
- one-off writing, formatting, captioning, translation, or creative work
- hypothetical exploration with no conclusion I actually adopted
- coding help that does not reveal a durable decision, diagnosis, preference, or recurring constraint

Each thought must:
- be written in first person
- be grounded in the actual user messages and must not infer details the user did not state
- stay specific to my real context, not generic advice
- stand alone without the original chat
- be 1-3 sentences

Bias toward:
- concrete project names, tools, platforms, file names, constraints, and preferences
- "I decided / I discovered / I need / I use / I rejected / I am building..."
- for unresolved troubleshooting, prefer "I measured / I observed / I am trying / I am considering..." over "I discovered..." unless I explicitly confirmed the conclusion

Avoid:
- generic "I learned that..." phrasing unless it is tightly anchored to my real project or system
- restating ChatGPT's advice as truth
- turning ChatGPT's suggestions, guesses, or proposed fixes into memories unless I explicitly confirmed or adopted them
- inventing specific components, products, voltages, root causes, migrations, versions, budgets, or purchases that I did not state
- expanding short consumer-support incidents like a single device error into generic lessons
- multiple thoughts that say nearly the same thing
- omitting critical constraints, like existing inventory or specific voltage requirements, when capturing a decision

If you are not sure whether a detail came from me or from ChatGPT, leave it out.
If the conversation does not clear the second-brain bar, return fewer thoughts or none.

Return a JSON object with exactly one key: "thoughts".
The value of "thoughts" must be an array of 0-{limit} strings.
Treat {limit} as an upper bound, not a target.
Return fewer when only a few memories are truly durable.
If the conversation has nothing worth capturing, return {{"thoughts": []}}.
