#!/usr/bin/env python3
"""
Directed prompt evaluation for claim typing.

Autoresearch-style mapping:
- mutable artifact: prompt.md
- fixed evaluator: this file
- fixed case set: eval-cases.json
"""

import argparse
import json
import statistics
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from recipes.claim_typing import extract_claims, load_claim_prompt


CASE_FILE_PATH = Path(__file__).with_name("eval-cases.json")
PROMPT_FILE_PATH = Path(__file__).with_name("prompt.md")


def load_cases(path):
    with open(path) as handle:
        payload = json.load(handle)
    if not isinstance(payload, list):
        raise ValueError("Case file must contain a JSON array")
    return payload


def text_contains_any(value, needles):
    if not needles:
        return True
    haystack = json.dumps(value, ensure_ascii=False).lower() if not isinstance(value, str) else value.lower()
    return any(str(needle).strip().lower() in haystack for needle in needles if str(needle).strip())


def score_expectation(actual, expected):
    notes = []
    emit_claim = bool(expected.get("emit_claim"))
    actual_emits = bool(actual.get("claim_kind")) and bool(actual.get("epistemic_status"))

    if not emit_claim:
        if actual_emits:
            return 0, ["Expected no claim, but the extractor emitted one."]
        return 100, []

    if not actual_emits:
        return 0, ["Expected a claim, but the extractor left the thought untyped."]

    checks = []
    checks.append((
        actual.get("claim_kind") == expected.get("claim_kind"),
        f"claim_kind expected {expected.get('claim_kind')} got {actual.get('claim_kind')}",
    ))
    checks.append((
        actual.get("epistemic_status") == expected.get("epistemic_status"),
        f"epistemic_status expected {expected.get('epistemic_status')} got {actual.get('epistemic_status')}",
    ))

    subject_needles = expected.get("claim_subject_contains_any", [])
    if subject_needles:
        checks.append((
            text_contains_any(actual.get("claim_subject"), subject_needles),
            "claim_subject missed expected tokens",
        ))

    object_needles = expected.get("claim_object_contains_any", [])
    if object_needles:
        checks.append((
            text_contains_any(actual.get("claim_object"), object_needles),
            "claim_object missed expected tokens",
        ))

    scope_needles = expected.get("claim_scope_contains", [])
    if scope_needles:
        checks.append((
            text_contains_any(actual.get("claim_scope"), scope_needles),
            "claim_scope missed expected tokens",
        ))

    total_checks = len(checks)
    passed = 0
    for ok, note in checks:
        if ok:
            passed += 1
        else:
            notes.append(note)

    score = int(round((passed / total_checks) * 100)) if total_checks else 100
    return score, notes[:3]


def evaluate_case(case, prompt_template, model_backend="local"):
    claims = extract_claims(
        case["source_name"],
        case["title"],
        case["date_str"],
        case["full_text"],
        case["thoughts"],
        model_backend=model_backend,
        prompt_template=prompt_template,
    )

    thought_results = []
    total_scores = []
    all_notes = []
    for index, expected in enumerate(case["expectations"]):
        actual = claims[index] if index < len(claims) else {}
        score, notes = score_expectation(actual, expected)
        thought_results.append(
            {
                "thought_index": index + 1,
                "thought": case["thoughts"][index],
                "actual": actual,
                "expected": expected,
                "score": score,
                "notes": notes,
            }
        )
        total_scores.append(score)
        all_notes.extend(notes)

    mean_score = round(statistics.mean(total_scores), 2) if total_scores else 0.0
    decision = "accept" if mean_score >= 90 else "reject"
    return {
        "case": case,
        "thoughts": case["thoughts"],
        "claims": claims,
        "judgment": {
            "total_score": mean_score,
            "decision": decision,
            "notes": all_notes[:3],
        },
        "thought_results": thought_results,
    }


def evaluate_prompt(export_path=None, cases_path=None, prompt_file=None, prompt_template=None, verbose=True):
    del export_path
    cases = load_cases(cases_path or CASE_FILE_PATH)
    template = prompt_template if prompt_template is not None else load_claim_prompt(prompt_file or PROMPT_FILE_PATH)

    results = []
    for case in cases:
        result = evaluate_case(case, template)
        results.append(result)
        if verbose:
            print(
                f"- {case['title']}: {result['judgment']['total_score']:.2f} "
                f"({result['judgment']['decision']})"
            )
            for note in result["judgment"]["notes"]:
                print(f"    - {note}")

    mean_score = round(statistics.mean(result["judgment"]["total_score"] for result in results), 2) if results else 0.0
    accepted = sum(1 for result in results if result["judgment"]["decision"] == "accept")

    summary = {
        "case_count": len(results),
        "accepted": accepted,
        "mean_score": mean_score,
        "results": results,
    }

    if verbose:
        print("─" * 60)
        print(f"Mean score: {summary['mean_score']:.2f}")
        print(f"Accepted:   {summary['accepted']}/{summary['case_count']}")

    return summary


def parse_args():
    parser = argparse.ArgumentParser(description="Evaluate the claim-typing prompt.")
    parser.add_argument("--cases", default=str(CASE_FILE_PATH))
    parser.add_argument("--prompt-file", default=str(PROMPT_FILE_PATH))
    parser.add_argument("--report")
    return parser.parse_args()


def main():
    args = parse_args()
    summary = evaluate_prompt(cases_path=args.cases, prompt_file=args.prompt_file, verbose=True)
    if args.report:
        with open(args.report, "w") as handle:
            json.dump(summary, handle, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
