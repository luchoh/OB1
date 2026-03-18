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


def parse_prompt_revision(text):
    normalized = normalize_chat_content(text).strip()
    prompt_match = re.search(
        r"^PROMPT:\s*<<<PROMPT\s*([\s\S]*?)(?:\s*^PROMPT\s*$|\Z)",
        normalized,
        flags=re.MULTILINE,
    )
    if not prompt_match:
        raise ValueError(f"Model returned unparseable prompt revision: {normalized[:1600]}")

    prompt = prompt_match.group(1).strip()
    why_match = re.search(r"^WHY:\s*$([\s\S]*?)^PROMPT:\s*<<<PROMPT", normalized, flags=re.MULTILINE)
    why = []
    if why_match:
        for line in why_match.group(1).splitlines():
            stripped = line.strip()
            if stripped.startswith("- "):
                why.append(stripped[2:].strip())
            elif stripped:
                break

    return {
        "prompt": prompt,
        "why": why[:5],
    }


def summarize_weak_cases(results, limit=4):
    ranked = sorted(results, key=lambda item: (item["judgment"]["total_score"], item["case"]["title"]))
    weak = []
    for result in ranked:
        if result["judgment"]["total_score"] >= 90 and result["judgment"]["decision"] == "accept":
            continue
        weak.append(
            {
                "title": result["case"]["title"],
                "expected_mode": result["case"].get("expected_mode"),
                "expected_min_thoughts": result["case"].get("expected_min_thoughts"),
                "expected_max_thoughts": result["case"].get("expected_max_thoughts"),
                "expectations": result["case"].get("expectations", []),
                "score": result["judgment"]["total_score"],
                "decision": result["judgment"]["decision"],
                "thoughts": result["thoughts"],
                "notes": result["judgment"]["notes"][:4],
            }
        )
        if len(weak) >= limit:
            break
    return weak


def propose_prompt(current_prompt, summary, attempt_index):
    system_prompt = textwrap.dedent(
        """
        Revise the extraction prompt to improve the fixed QA score.

        Hard constraints:
        - Keep the {limit} placeholder exactly if it is present in the current prompt.
        - Keep the output contract unchanged.
        - Reduce hallucinated backstory, generic support/advice phrasing, and assistant-derived abstractions.
        - Keep dense technical/project conversations rich enough; do not solve precision problems by flattening everything into 1 thought.

        Prefer small, targeted edits over rewriting the entire prompt.

        Return exactly this format and nothing else:
        WHY:
        - <short reason>
        - <short reason>
        PROMPT:
        <<<PROMPT
        <full revised prompt>
        PROMPT
        """
    ).strip()

    user_payload = {
        "attempt_index": attempt_index,
        "current_mean_score": summary["mean_score"],
        "current_accepted": summary["accepted"],
        "case_count": summary["case_count"],
        "weak_cases": summarize_weak_cases(summary["results"]),
        "current_prompt": current_prompt,
    }

    response = requests.post(
        f"{local_llm_base_url()}/chat/completions",
        headers={"Content-Type": "application/json"},
        json={
            "model": LOCAL_LLM_MODEL,
            "temperature": 0.6,
            "max_tokens": 5000,
            "chat_template_kwargs": {
                "enable_thinking": LOCAL_LLM_ENABLE_THINKING,
            },
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False, indent=2)},
            ],
        },
        timeout=300,
    )
    response.raise_for_status()
    proposal = parse_prompt_revision(response.json().get("choices", [{}])[0].get("message", {}).get("content"))
    revised_prompt = proposal.get("prompt", "").strip()
    if "{limit}" in current_prompt and "{limit}" not in revised_prompt:
        raise ValueError("Revised prompt is missing the {limit} placeholder")
    return {
        "prompt": revised_prompt,
        "why": proposal.get("why", []),
    }


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
    parser.add_argument("--cases", required=True, help="Fixed case set")
    parser.add_argument("--rounds", type=int, default=3, help="Maximum rounds")
    parser.add_argument("--candidates", type=int, default=2, help="Candidates per round")
    parser.add_argument("--report", help="Optional JSON report path")
    return parser.parse_args()


def main():
    args = parse_args()
    prompt_path = Path(args.prompt_file)
    eval_module = load_eval_module(args.eval_module)

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
            proposal = propose_prompt(best_prompt, best_summary, attempt_index)
            candidate_prompt = proposal["prompt"]
            if candidate_prompt == best_prompt:
                print(f"candidate {candidate_index}: identical, skipped")
                continue

            print(f"candidate {candidate_index}: evaluating")
            candidate_summary = eval_module.evaluate_prompt(
                export_path=args.export_path,
                cases_path=args.cases,
                prompt_template=candidate_prompt,
                verbose=False,
            )
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
