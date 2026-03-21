#!/usr/bin/env python3
"""
Generic prompt autoresearch loop.

Recipe-specific inputs:
- prompt file
- eval module
- eval case set
"""

import argparse
import importlib.util
import json
import os
import re
import sys
import textwrap
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from recipes.shared_docling import local_llm_base_url

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


def load_eval_module(path):
    spec = importlib.util.spec_from_file_location("prompt_eval_module", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


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


def extract_json_payload(text):
    trimmed = text.strip()
    trimmed = re.sub(r"^```json\s*", "", trimmed, flags=re.IGNORECASE)
    trimmed = re.sub(r"^```\s*", "", trimmed)
    trimmed = re.sub(r"\s*```$", "", trimmed)

    try:
        return json.loads(trimmed)
    except json.JSONDecodeError:
        start = trimmed.find("{")
        end = trimmed.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise
        return json.loads(trimmed[start : end + 1])


def extract_tool_arguments(response_json, expected_name):
    try:
        tool_calls = response_json["choices"][0]["message"]["tool_calls"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("Model did not return a tool call") from exc

    if not isinstance(tool_calls, list) or not tool_calls:
        raise ValueError("Model did not return a tool call")

    call = None
    for item in tool_calls:
        if isinstance(item, dict) and item.get("function", {}).get("name") == expected_name:
            call = item
            break
    if call is None:
        call = tool_calls[0]

    arguments = call.get("function", {}).get("arguments")
    if not isinstance(arguments, str) or not arguments.strip():
        raise ValueError("Tool call arguments were empty")

    return extract_json_payload(arguments)


def build_named_tool_choice(name):
    return {
        "type": "function",
        "function": {
            "name": name,
        },
    }


def detect_artifact_kind(current_prompt):
    try:
        json.loads(current_prompt)
        return "json"
    except json.JSONDecodeError:
        return "text"


def build_revision_tool(artifact_kind):
    artifact_property_name = "artifact_json" if artifact_kind == "json" else "artifact"
    artifact_property = {
        "type": "object",
        "description": "The full revised artifact as a JSON object.",
    } if artifact_kind == "json" else {
        "type": "string",
        "description": "The full revised artifact text.",
    }

    return {
        "type": "function",
        "function": {
            "name": "submit_revision",
            "description": "Return the full revised artifact text and short reasons for the changes.",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "required": [artifact_property_name, "why"],
                "properties": {
                    artifact_property_name: artifact_property,
                    "why": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Up to 5 short reasons for the revision.",
                    },
                },
            },
        },
    }


def extract_message_content(response_json):
    try:
        message = response_json["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("Model did not return a message") from exc

    content = normalize_chat_content(message.get("content"))
    if not content.strip():
        raise ValueError("Model returned an empty message")
    return content


def serialize_revised_artifact(proposal, artifact_kind):
    if artifact_kind == "json":
        if "artifact_json" in proposal:
            return json.dumps(proposal["artifact_json"], ensure_ascii=False, indent=2)
        artifact_text = str(proposal.get("artifact", "")).strip()
        if not artifact_text:
            raise ValueError("JSON artifact proposal was empty")
        parsed = json.loads(artifact_text)
        return json.dumps(parsed, ensure_ascii=False, indent=2)

    artifact_text = str(proposal.get("artifact", "")).strip()
    if not artifact_text:
        raise ValueError("Revised artifact was empty")
    return artifact_text


def summarize_weak_cases(results, limit=4):
    def truncate_text(value, limit_chars=220):
        if not isinstance(value, str):
            value = str(value)
        value = value.strip()
        if len(value) <= limit_chars:
            return value
        return f"{value[: limit_chars - 1]}…"

    def case_label(item):
        case = item.get("case", {})
        return (
            case.get("title")
            or case.get("id")
            or case.get("question")
            or "untitled-case"
        )

    ranked = sorted(results, key=lambda item: (item["judgment"]["total_score"], case_label(item)))
    weak = []
    for result in ranked:
        if result["judgment"]["total_score"] >= 90 and result["judgment"]["decision"] == "accept":
            continue
        case = result.get("case", {})
        weak.append(
            {
                "title": case_label(result),
                "question": case.get("question"),
                "expected_mode": case.get("expected_mode"),
                "expected_min_thoughts": case.get("expected_min_thoughts"),
                "expected_max_thoughts": case.get("expected_max_thoughts"),
                "expectations": case.get("expectations", []),
                "score": result["judgment"]["total_score"],
                "decision": result["judgment"]["decision"],
                "thoughts": [truncate_text(thought) for thought in result.get("thoughts", [])[:4]],
                "notes": [truncate_text(note, 140) for note in result["judgment"]["notes"][:3]],
            }
        )
        if len(weak) >= limit:
            break
    return weak


def load_research_program(program_file):
    if program_file:
        path = Path(program_file)
    else:
        path = None

    if path and path.exists():
        return path.read_text().strip()

    return textwrap.dedent(
        """
        Revise the extraction prompt to improve the fixed QA score.

        Hard constraints:
        - Keep the {limit} placeholder exactly if it is present in the current prompt.
        - Keep the output contract unchanged.
        - Reduce hallucinated backstory, generic support/advice phrasing, and assistant-derived abstractions.
        - Keep dense technical/project conversations rich enough; do not solve precision problems by flattening everything into 1 thought.

        Prefer small, targeted edits over rewriting the entire prompt.
        """
    ).strip()


def proposal_user_payload(current_prompt, summary, attempt_index):
    return {
        "attempt_index": attempt_index,
        "current_mean_score": summary["mean_score"],
        "current_accepted": summary["accepted"],
        "case_count": summary["case_count"],
        "weak_cases": summarize_weak_cases(summary["results"]),
        "current_prompt": current_prompt,
    }


def proposal_user_content(current_prompt, summary, attempt_index, artifact_kind):
    payload = proposal_user_payload(current_prompt, summary, attempt_index)
    if artifact_kind != "json":
        return json.dumps(payload, ensure_ascii=False, indent=2)

    weak_cases = summarize_weak_cases(summary["results"])
    weak_lines = []
    for case in weak_cases:
        weak_lines.append(f"- {case['title']}: score={case['score']} decision={case['decision']}")
        if case.get("question"):
            weak_lines.append(f"  question: {case['question']}")
        if case.get("notes"):
            weak_lines.append(f"  notes: {'; '.join(case['notes'])}")

    weak_text = "\n".join(weak_lines) if weak_lines else "- none"
    return textwrap.dedent(
        f"""
        Attempt index: {attempt_index}
        Current mean score: {summary["mean_score"]}
        Current accepted: {summary["accepted"]}/{summary["case_count"]}

        Weak cases:
        {weak_text}

        Current artifact JSON:
        ```json
        {current_prompt}
        ```
        """
    ).strip()


def propose_prompt_tool(current_prompt, summary, attempt_index, research_program, proposal_temperature):
    artifact_kind = detect_artifact_kind(current_prompt)
    artifact_instruction = (
        "Put the full revised artifact as a JSON object in artifact_json. artifact_json must be a real JSON object, not a quoted string."
        if artifact_kind == "json"
        else "Put the full revised artifact text in artifact."
    )
    system_prompt = textwrap.dedent(
        f"""
        {research_program}

        You must return exactly one submit_revision tool call.
        Do not answer in prose.
        {artifact_instruction}
        Put short reasons in why.
        """
    ).strip()

    user_content = proposal_user_content(current_prompt, summary, attempt_index, artifact_kind)

    response = requests.post(
        f"{local_llm_base_url()}/chat/completions",
        headers={"Content-Type": "application/json"},
        json={
            "model": LOCAL_LLM_MODEL,
            "temperature": proposal_temperature,
            "max_tokens": 5000,
            "chat_template_kwargs": {
                "enable_thinking": LOCAL_LLM_ENABLE_THINKING,
            },
            "tools": [build_revision_tool(artifact_kind)],
            "tool_choice": build_named_tool_choice("submit_revision"),
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
        },
        timeout=300,
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"{response.status_code} {response.reason}: {normalize_chat_content(response.text)}"
    )
    response_json = response.json()
    proposal = extract_tool_arguments(response_json, "submit_revision")
    revised_prompt = serialize_revised_artifact(proposal, artifact_kind)
    why = proposal.get("why", [])
    if not isinstance(why, list):
        why = []

    if "{limit}" in current_prompt and "{limit}" not in revised_prompt:
        raise ValueError("Revised prompt is missing the {limit} placeholder")
    return {
        "prompt": revised_prompt,
        "why": why[:5],
    }


def propose_prompt_json(current_prompt, summary, attempt_index, research_program, proposal_temperature):
    artifact_kind = detect_artifact_kind(current_prompt)
    artifact_instruction = (
        "Return the revised artifact in artifact_json as a JSON object. artifact_json must be a real JSON object, not a quoted string."
        if artifact_kind == "json"
        else "Return the revised artifact in artifact as a string."
    )
    system_prompt = textwrap.dedent(
        f"""
        {research_program}

        Return only a single JSON object.
        Do not use markdown fences.
        {artifact_instruction}
        The JSON object must have exactly two keys:
        - why: array of short strings
        """
    ).strip()

    user_content = proposal_user_content(current_prompt, summary, attempt_index, artifact_kind)

    response = requests.post(
        f"{local_llm_base_url()}/chat/completions",
        headers={"Content-Type": "application/json"},
        json={
            "model": LOCAL_LLM_MODEL,
            "temperature": proposal_temperature,
            "max_tokens": 5000,
            "chat_template_kwargs": {
                "enable_thinking": LOCAL_LLM_ENABLE_THINKING,
            },
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
        },
        timeout=300,
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"{response.status_code} {response.reason}: {normalize_chat_content(response.text)}"
        )

    response_json = response.json()
    proposal = extract_json_payload(extract_message_content(response_json))
    revised_prompt = serialize_revised_artifact(proposal, artifact_kind)
    why = proposal.get("why", [])
    if not isinstance(why, list):
        why = []

    if "{limit}" in current_prompt and "{limit}" not in revised_prompt:
        raise ValueError("Revised prompt is missing the {limit} placeholder")
    return {
        "prompt": revised_prompt,
        "why": why[:5],
    }


def propose_prompt(
    current_prompt,
    summary,
    attempt_index,
    research_program,
    submission_mode,
    proposal_temperature,
):
    if submission_mode == "json":
        return propose_prompt_json(
            current_prompt,
            summary,
            attempt_index,
            research_program,
            proposal_temperature,
        )
    return propose_prompt_tool(
        current_prompt,
        summary,
        attempt_index,
        research_program,
        proposal_temperature,
    )


def is_better(candidate, incumbent):
    if candidate["mean_score"] > incumbent["mean_score"]:
        return True
    if candidate["mean_score"] == incumbent["mean_score"] and candidate["accepted"] > incumbent["accepted"]:
        return True
    return False


def parse_args():
    parser = argparse.ArgumentParser(description="Run a generic autoresearch loop over a prompt file.")
    parser.add_argument("export_path", help="Path to export zip or extracted directory")
    parser.add_argument("--eval-module", required=True, help="Path to eval-prompt.py module")
    parser.add_argument("--prompt-file", required=True, help="Mutable prompt file")
    parser.add_argument("--program-file", help="Optional program.md; defaults to sibling of prompt file when present")
    parser.add_argument("--cases", required=True, help="Fixed case set")
    parser.add_argument("--rounds", type=int, default=3, help="Maximum rounds")
    parser.add_argument("--candidates", type=int, default=2, help="Candidates per round")
    parser.add_argument(
        "--proposal-temperature",
        type=float,
        default=0.3,
        help="Sampling temperature used when proposing revised artifacts",
    )
    parser.add_argument("--report", help="Optional JSON report path")
    parser.add_argument(
        "--submission-mode",
        choices=["tool", "json"],
        default="tool",
        help="How the proposer returns revised artifacts",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    prompt_path = Path(args.prompt_file)
    program_path = Path(args.program_file) if args.program_file else prompt_path.with_name("program.md")
    eval_module = load_eval_module(args.eval_module)
    research_program = load_research_program(program_path if program_path.exists() else None)

    best_prompt = prompt_path.read_text().strip()
    print("baseline")
    best_summary = eval_module.evaluate_prompt(
        export_path=args.export_path,
        cases_path=args.cases,
        prompt_template=best_prompt,
        verbose=True,
    )

    history = [
        {
            "round": 0,
            "candidate": "baseline",
            "mean_score": best_summary["mean_score"],
            "accepted": best_summary["accepted"],
            "summary": best_summary,
        }
    ]

    for round_index in range(1, args.rounds + 1):
        print("=" * 60)
        print(f"round {round_index}")
        improved = False

        for candidate_index in range(1, args.candidates + 1):
            attempt_index = (round_index - 1) * args.candidates + candidate_index
            try:
                proposal = propose_prompt(
                    best_prompt,
                    best_summary,
                    attempt_index,
                    research_program,
                    args.submission_mode,
                    args.proposal_temperature,
                )
            except Exception as exc:
                print(f"candidate {candidate_index}: proposal failed")
                print(f"  {exc}")
                history.append(
                    {
                        "round": round_index,
                        "candidate": candidate_index,
                        "stage": "proposal",
                        "error": str(exc),
                    }
                )
                continue

            candidate_prompt = proposal["prompt"]
            if candidate_prompt == best_prompt:
                print(f"candidate {candidate_index}: identical, skipped")
                history.append(
                    {
                        "round": round_index,
                        "candidate": candidate_index,
                        "stage": "proposal",
                        "status": "identical",
                        "why": proposal.get("why", []),
                    }
                )
                continue

            print(f"candidate {candidate_index}: evaluating")
            try:
                candidate_summary = eval_module.evaluate_prompt(
                    export_path=args.export_path,
                    cases_path=args.cases,
                    prompt_template=candidate_prompt,
                    verbose=False,
                )
            except Exception as exc:
                print(f"candidate {candidate_index}: evaluation failed")
                print(f"  {exc}")
                history.append(
                    {
                        "round": round_index,
                        "candidate": candidate_index,
                        "stage": "evaluation",
                        "error": str(exc),
                        "why": proposal.get("why", []),
                    }
                )
                continue

            print(
                f"  mean={candidate_summary['mean_score']} "
                f"accepted={candidate_summary['accepted']}/{candidate_summary['case_count']}"
            )
            history.append(
                {
                    "round": round_index,
                    "candidate": candidate_index,
                    "mean_score": candidate_summary["mean_score"],
                    "accepted": candidate_summary["accepted"],
                    "why": proposal["why"],
                    "summary": candidate_summary,
                    "prompt": candidate_prompt,
                }
            )

            if is_better(candidate_summary, best_summary):
                best_prompt = candidate_prompt
                best_summary = candidate_summary
                prompt_path.write_text(best_prompt.rstrip() + "\n")
                improved = True
                print("  accepted")
                for note in proposal["why"][:4]:
                    print(f"    - {note}")

        if not improved:
            print("plateau")
            break

    print("=" * 60)
    print(f"final mean_score: {best_summary['mean_score']}")
    print(f"final accepted: {best_summary['accepted']}/{best_summary['case_count']}")
    print(f"prompt file: {prompt_path}")

    if args.report:
        with open(args.report, "w") as handle:
            json.dump(
                {
                    "best_summary": best_summary,
                    "history": history,
                    "final_prompt": best_prompt,
                },
                handle,
                indent=2,
                ensure_ascii=False,
            )
        print(f"report: {args.report}")


if __name__ == "__main__":
    main()
