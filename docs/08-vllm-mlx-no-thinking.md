# vllm-mlx No-Thinking Fix

Date: 2026-03-14
Status: No-thinking fixed in `mlx-server`; structured extraction findings added

## What The Official Control Is

For Qwen3 / Qwen3.5, the documented non-thinking switch is:

```json
{
  "chat_template_kwargs": {
    "enable_thinking": false
  }
}
```

That is the clean control. Prompt hacks like `/no_think` are not the right fix.

## What We Verified

The live inference path through the `mlx-server` Consul service now honors `chat_template_kwargs.enable_thinking=false`.

Verified outcome:

- `message.content` contains only final content
- no `Thinking Process:` leakage
- `message.reasoning` is `null` when thinking is disabled

## Historical Root Cause

From the current `vllm-mlx` source:

- `vllm_mlx/reasoning/qwen3_parser.py` explicitly says Qwen3 supports a strict switch via `enable_thinking=False`
- `vllm_mlx/api/models.py` does **not** expose `chat_template_kwargs` on `ChatCompletionRequest`
- `vllm_mlx/server.py` therefore cannot pass request-level `chat_template_kwargs` into `engine.chat(...)`
- `vllm_mlx/engine/simple.py` hardcodes `enable_thinking` from model name instead of honoring request input

That gap has now been fixed on the live service.

## Structured Extraction Findings

After no-thinking was fixed, we investigated structured extraction for Qwen3.5 on the same endpoint.

### What Works Reliably

Tool calling works reliably for structured extraction.

Validated live:

- request uses `chat_template_kwargs.enable_thinking=false`
- request includes a single function tool with a JSON-schema-like parameter object
- request uses `tool_choice: "required"`
- response returns `message.tool_calls[0].function.arguments` with valid JSON
- `finish_reason` is `tool_calls`

This works for:

- ChatGPT thought extraction
- local metadata extraction

### What Does Not Work Reliably

`response_format` on this `vllm-mlx` stack is not reliable for semantic array-of-string outputs.

Observed live behavior:

- simple schemas like `{"ok": true}` work
- array-of-string extraction can stop immediately after:
  - `{`
  - `"thoughts": [`
- response reports `finish_reason: "stop"` with only a few completion tokens

So the current conclusion is:

- no-thinking control is fixed
- `response_format` is still not trustworthy for this extraction workload
- tool calling is the correct production contract for OB1 extraction tasks on this stack

## Recommended Production Contract

For Qwen3.5 extraction tasks on `mlx-server`:

1. Send `chat_template_kwargs: {"enable_thinking": false}`
2. Use tool calling for structured outputs
3. Prefer `tool_choice: "required"` when the task must return structured data
4. Parse `message.tool_calls[*].function.arguments` as JSON

Do not rely on:

- prompt-only JSON contracts for critical extraction
- `response_format` for array-of-string semantic extraction on this runtime

## Historical Server-Side Fix

The clean fix in `vllm-mlx` is:

1. Extend `ChatCompletionRequest` with:

```python
chat_template_kwargs: dict | None = None
```

2. In `server.py`, when building `chat_kwargs`, pass through:

```python
if request.chat_template_kwargs:
    chat_kwargs["chat_template_kwargs"] = request.chat_template_kwargs
```

3. In `engine/simple.py` and `engine/batched.py`, thread `chat_template_kwargs` into chat template application.

4. Merge request-level kwargs into template kwargs before `apply_chat_template(...)`, for example:

```python
template_kwargs = {
    "tokenize": False,
    "add_generation_prompt": True,
    "enable_thinking": enable_thinking,
}
if chat_template_kwargs:
    template_kwargs.update(chat_template_kwargs)
```

5. Keep `--reasoning-parser qwen3` enabled on the server for cases where thinking is intentionally enabled and you want clean `reasoning` vs `content` separation.

## OB1 Changes Already Made

OB1 now sends the documented no-thinking field on its Qwen chat calls:

- [local/open-brain-mcp/src/models.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/models.mjs#L121)
- [recipes/chatgpt-conversation-import/import-chatgpt.py](/Users/luchoh/Dev/OB1/recipes/chatgpt-conversation-import/import-chatgpt.py#L356)

OB1 also now uses tool calling for structured extraction in:

- [local/open-brain-mcp/src/models.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/models.mjs#L159)
- [recipes/chatgpt-conversation-import/import-chatgpt.py](/Users/luchoh/Dev/OB1/recipes/chatgpt-conversation-import/import-chatgpt.py#L430)

The shared no-thinking env knob is:

- `LLM_ENABLE_THINKING=false`

Defined in:

- [local/open-brain-mcp/src/config.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/config.mjs#L101)
- [.env.open-brain-local.example](/Users/luchoh/Dev/OB1/.env.open-brain-local.example#L1)

## Acceptance Tests

### No-Thinking

```json
{
  "model": "mlx-community/Qwen3.5-397B-A17B-nvfp4",
  "temperature": 0,
  "max_tokens": 500,
  "chat_template_kwargs": {
    "enable_thinking": false
  },
  "messages": [
    {
      "role": "system",
      "content": "Return only valid JSON."
    },
    {
      "role": "user",
      "content": "..."
    }
  ]
}
```

Expected outcome:

- `message.content` contains only the final answer / JSON
- `message.reasoning` is empty or absent
- no `Thinking Process:` text leaks into `content`

### Tool Calling

This request shape is the recommended extraction contract:

```json
{
  "model": "mlx-community/Qwen3.5-397B-A17B-nvfp4",
  "temperature": 0,
  "chat_template_kwargs": {
    "enable_thinking": false
  },
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "submit_thoughts",
        "parameters": {
          "type": "object",
          "required": ["thoughts"],
          "properties": {
            "thoughts": {
              "type": "array",
              "items": { "type": "string" }
            }
          }
        }
      }
    }
  ],
  "tool_choice": "required",
  "messages": [
    {
      "role": "system",
      "content": "Extract durable first-person knowledge from the conversation. Use the tool."
    },
    {
      "role": "user",
      "content": "..."
    }
  ]
}
```

Expected outcome:

- `message.content` is `null` or empty
- `message.tool_calls[0].function.arguments` is valid JSON
- `finish_reason` is `tool_calls`

## Historical Sysadmin Prompt

```text
Please update the M3 Ultra `vllm-mlx` inference service so request-level Qwen no-thinking control actually works.

Target behavior:
- The canonical inference path remains the `mlx-server` Consul service `/v1`
- Model remains `mlx-community/Qwen3.5-397B-A17B-nvfp4`
- Qwen requests with `chat_template_kwargs.enable_thinking=false` must disable reasoning output at the template level
- Keep `--reasoning-parser qwen3` enabled for cases where thinking is intentionally on

Root cause already verified:
- `qwen3_parser.py` documents `enable_thinking=False`
- current `ChatCompletionRequest` does not expose `chat_template_kwargs`
- current `server.py` does not pass `chat_template_kwargs` into `engine.chat`
- current engine code hardcodes `enable_thinking` instead of honoring request input

Please patch `vllm-mlx` so:
1. `ChatCompletionRequest` accepts `chat_template_kwargs`
2. `server.py` passes it to the engine
3. `engine/simple.py` and `engine/batched.py` merge request-level `chat_template_kwargs` into the `apply_chat_template(...)` call

Acceptance:
- A request with `chat_template_kwargs: {\"enable_thinking\": false}` returns only final content
- No `Thinking Process:` text appears in `message.content`
- Requests with thinking enabled still work normally
```
