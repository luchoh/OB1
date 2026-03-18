#!/usr/bin/env python3
"""
Directed prompt evaluation for Claude conversation extraction.

Autoresearch-style mapping:
- mutable artifact: prompt.md
- fixed evaluator: this file
- fixed case set: eval-cases.json

The goal is not to eyeball outputs. It is to score candidate prompts against a
small high-signal QA set before running wider imports.
"""

import argparse
import importlib.util
import json
import os
import re
import statistics
import sys
import textwrap
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from recipes.shared_docling import local_llm_base_url

CASE_FILE_PATH = Path(__file__).with_name("eval-cases.json")
PROMPT_FILE_PATH = Path(__file__).with_name("prompt.md")
IMPORTER_PATH = Path(__file__).with_name("import-claude.py")

LOCAL_LLM_MODEL = os.environ.get("LLM_MODEL", "mlx-community/Qwen3.5-397B-A17B-nvfp4")
LOCAL_LLM_ENABLE_THINKING = os.environ.get("LLM_ENABLE_THINKING", "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

try:
    import requests
except ImportError:
    print("Missing dependency: requests")
    print("Install with: pip install requests")
    sys.exit(1)


def load_importer_module():
    spec = importlib.util.spec_from_file_location("import_claude_module", IMPORTER_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_cases(path):
    with open(path) as handle:
        payload = json.load(handle)
    if not isinstance(payload, list):
        raise ValueError("Case file must contain a JSON array")
    return payload


def load_conversations(export_path, importer):
    conversations = importer.extract_conversations(export_path)
    lookup = {}
    for conversation in conversations:
        lookup[importer.conversation_id(conversation)] = conversation
    return lookup


def extract_tool_arguments(response_json, expected_name):
    tool_calls = response_json.get("choices", [{}])[0].get("message", {}).get("tool_calls", [])
    if not tool_calls:
        inline_tool_args = extract_inline_tool_arguments(
            response_json.get("choices", [{}])[0].get("message", {}).get("content"),
            expected_name,
        )
        if inline_tool_args:
            return inline_tool_args
        raise ValueError("Judge model did not return a tool call")

    call = next(
        (item for item in tool_calls if item.get("function", {}).get("name") == expected_name),
        tool_calls[0],
    )
    arguments = call.get("function", {}).get("arguments")
    if not isinstance(arguments, str) or not arguments.strip():
        raise ValueError("Judge tool call arguments were empty")
    return json.loads(arguments)


def normalize_chat_content(content):
    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "".join(parts).strip()

    return ""


def extract_inline_tool_arguments(content, expected_name):
    text = normalize_chat_content(content)
    if "<function=" not in text:
        return None

    function_match = re.search(r"<function=([^>\n]+)>\s*([\s\S]*)", text)
    if not function_match:
        return None

    function_name = function_match.group(1).strip()
    if not function_name or (expected_name and function_name != expected_name):
        return None

    body = function_match.group(2) or ""
    params = {}
    for match in re.finditer(r"<parameter=([^>\n]+)>\s*([\s\S]*?)\s*</parameter>", body):
        key = match.group(1).strip()
        if not key:
            continue
        raw_value = (match.group(2) or "").strip()
        try:
            params[key] = json.loads(raw_value)
        except json.JSONDecodeError:
            params[key] = raw_value

    return params or None


def is_valid_judgment(payload):
    required = {
        "total_score",
        "decision",
        "notes",
    }
    return isinstance(payload, dict) and required.issubset(payload.keys())


def parse_judgment_text(text):
    normalized = normalize_chat_content(text).strip()
    score_match = re.search(r"^\s*SCORE:\s*(\d{1,3})\s*$", normalized, flags=re.MULTILINE | re.IGNORECASE)
    decision_match = re.search(r"^\s*DECISION:\s*(accept|reject)\s*$", normalized, flags=re.MULTILINE | re.IGNORECASE)
    notes_block_match = re.search(r"^\s*NOTES:\s*$([\s\S]*)", normalized, flags=re.MULTILINE | re.IGNORECASE)

    if not score_match or not decision_match:
        raise ValueError(f"Judge returned unparseable content: {normalized[:1200]}")

    notes = []
    if notes_block_match:
        for line in notes_block_match.group(1).splitlines():
            stripped = line.strip()
            if stripped.startswith("- "):
                notes.append(stripped[2:].strip())
            elif stripped:
                break

    return {
        "total_score": int(score_match.group(1)),
        "decision": decision_match.group(1).lower(),
        "notes": notes[:3],
    }


def judge_case(case, conversation_excerpt, thoughts):
    system_prompt = textwrap.dedent(
        """
        You are doing strict QA for a second-brain memory extractor.

        Grade the extracted thoughts against the raw user messages and the case expectations.
        Reward:
        - grounding in the user's actual messages
        - concrete, personal, project-specific memory
        - durable future retrieval value
        - non-generic phrasing
        - appropriate coverage without redundant thoughts

        Penalize heavily:
        - generic support/advice phrasing
        - over-generalized "I learned that..." statements
        - facts that are not clearly tied to the user's real context
        - missing the main project/decision/diagnosis in the conversation
        - extracting thoughts for cases that should be empty

        Scoring:
        - 90-100: second-brain grade
        - 70-89: usable but not production-quality
        - below 70: should be improved before trust

        Return exactly this format and nothing else:
        SCORE: <integer 0-100>
        DECISION: <accept|reject>
        NOTES:
        - <short note>
        - <short note>
        - <short note>

        Keep notes short and return at most 3 notes.
        """
    ).strip()

    user_prompt = {
        "case": case,
        "conversation_excerpt": conversation_excerpt,
        "extracted_thoughts": thoughts,
    }

    last_error = None
    for _ in range(3):
        try:
            response = requests.post(
                f"{local_llm_base_url()}/chat/completions",
                headers={"Content-Type": "application/json"},
                json={
                    "model": LOCAL_LLM_MODEL,
                    "temperature": 0,
                    "max_tokens": 500,
                    "chat_template_kwargs": {
                        "enable_thinking": LOCAL_LLM_ENABLE_THINKING,
                    },
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": json.dumps(user_prompt, ensure_ascii=False, indent=2)},
                    ],
                },
                timeout=180,
            )
            response.raise_for_status()
            content = normalize_chat_content(response.json().get("choices", [{}])[0].get("message", {}).get("content"))
            try:
                payload = parse_judgment_text(content)
            except Exception as exc:
                last_error = ValueError(f"Judge returned unparseable content: {content[:1200]}")
                continue
            if is_valid_judgment(payload):
                return payload
            last_error = ValueError(f"Judge returned malformed payload: {payload}")
        except Exception as exc:
            last_error = exc

    raise last_error


def case_excerpt(conversation, importer, thought_limit):
    messages = importer.extract_messages(conversation)
    user_text = importer.extract_user_text(messages)
    limit = min(16000, importer.summarize_input_limit(thought_limit))
    excerpt = user_text[:limit].strip()
    return excerpt if excerpt else textwrap.shorten(user_text.replace("\n", " "), width=2200, placeholder=" ...")


def evaluate_case(case, conversation, importer, prompt_template):
    messages = importer.extract_messages(conversation)
    user_text = importer.extract_user_text(messages)
    message_count = importer.count_messages(messages)
    word_count = len(user_text.split())
    created_at = importer.conversation_created_at(conversation)
    date_str = created_at.strftime("%Y-%m-%d") if created_at else "unknown"
    thought_limit = importer.determine_thought_limit(word_count, message_count)

    thoughts = importer.summarize_local(
        case["title"],
        date_str,
        user_text,
        thought_limit,
        prompt_template=prompt_template,
    )

    judgment = judge_case(case, case_excerpt(conversation, importer, thought_limit), thoughts)
    return {
        "case": case,
        "thought_limit": thought_limit,
        "thoughts": thoughts,
        "judgment": judgment,
    }


def evaluate_prompt(export_path, cases_path=None, prompt_file=None, prompt_template=None, verbose=True):
    importer = load_importer_module()
    cases = load_cases(cases_path or CASE_FILE_PATH)
    template = prompt_template if prompt_template is not None else importer.load_prompt_template(prompt_file or PROMPT_FILE_PATH)
    conversations = load_conversations(export_path, importer)

    results = []
    for case in cases:
        conversation = conversations.get(case["conversation_id"])
        if conversation is None:
            raise KeyError(f"Conversation not found in export: {case['conversation_id']} ({case['title']})")

        result = evaluate_case(case, conversation, importer, template)
        results.append(result)

        if verbose:
            verdict = result["judgment"]["decision"]
            score = result["judgment"]["total_score"]
            print(f"{case['title']}: {score}/100 ({verdict})")
            print(f"  thoughts: {len(result['thoughts'])}")
            for note in result["judgment"]["notes"][:3]:
                print(f"  - {note}")

    total_scores = [result["judgment"]["total_score"] for result in results]
    accepted = sum(1 for result in results if result["judgment"]["decision"] == "accept")
    summary = {
        "case_count": len(results),
        "mean_score": round(statistics.mean(total_scores), 2),
        "median_score": round(statistics.median(total_scores), 2),
        "accepted": accepted,
        "results": results,
    }

    if verbose:
        print("-" * 60)
        print(f"mean_score: {summary['mean_score']}")
        print(f"median_score: {summary['median_score']}")
        print(f"accepted: {accepted}/{len(results)}")

    return summary


def parse_args():
    parser = argparse.ArgumentParser(description="Evaluate Claude extraction prompt on a directed QA sample.")
    parser.add_argument("export_path", help="Path to Claude export zip or extracted directory")
    parser.add_argument("--cases", default=str(CASE_FILE_PATH), help="Case file (default: eval-cases.json)")
    parser.add_argument("--prompt-file", default=str(PROMPT_FILE_PATH), help="Prompt file to evaluate")
    parser.add_argument("--report", help="Optional path to write JSON report")
    return parser.parse_args()


def main():
    args = parse_args()
    summary = evaluate_prompt(
        export_path=args.export_path,
        cases_path=args.cases,
        prompt_file=args.prompt_file,
        verbose=True,
    )

    if args.report:
        with open(args.report, "w") as handle:
            json.dump(summary, handle, indent=2, ensure_ascii=False)
        print(f"report: {args.report}")


if __name__ == "__main__":
    main()
