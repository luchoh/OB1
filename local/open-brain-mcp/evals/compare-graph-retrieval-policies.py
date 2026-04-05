#!/usr/bin/env python3
"""
Compare baseline and candidate graph retrieval policies against the fixed evaluator.
"""

import argparse
import hashlib
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
EVAL_MODULE_PATH = Path(__file__).with_name("eval-graph-retrieval.py")
DEFAULT_POLICY_PATH = REPO_ROOT / "local/open-brain-mcp/config/graph-retrieval-policy.json"
DEFAULT_CASES_PATH = Path(__file__).with_name("graph-retrieval-eval-cases.json")


def load_eval_module():
    spec = importlib.util.spec_from_file_location("ob1_eval_graph_retrieval", EVAL_MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def stable_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def policy_hash(policy_text):
    payload = json.loads(policy_text)
    return hashlib.sha256(stable_json(payload).encode("utf-8")).hexdigest()


def compare_decision(baseline, candidate):
    baseline_accepted = baseline["accepted"]
    candidate_accepted = candidate["accepted"]
    baseline_mean = baseline["mean_score"]
    candidate_mean = candidate["mean_score"]

    if (
        candidate_accepted > baseline_accepted
        or (candidate_accepted == baseline_accepted and candidate_mean > baseline_mean + 0.01)
    ):
        return "candidate_better"

    if (
        candidate_accepted < baseline_accepted
        or (candidate_accepted == baseline_accepted and candidate_mean < baseline_mean - 0.01)
    ):
        return "baseline_better"

    return "no_clear_winner"


def build_notes(baseline, candidate):
    notes = []
    accepted_delta = candidate["accepted"] - baseline["accepted"]
    mean_delta = round(candidate["mean_score"] - baseline["mean_score"], 2)

    if accepted_delta:
        notes.append(f"accepted delta: {accepted_delta:+d}")
    if mean_delta:
        notes.append(f"mean score delta: {mean_delta:+.2f}")
    if not notes:
        notes.append("accepted count and mean score are materially unchanged")

    return notes


def main():
    parser = argparse.ArgumentParser(description="Compare two graph retrieval policy files on the fixed OB1 eval cases.")
    parser.add_argument(
        "--baseline-file",
        default=str(DEFAULT_POLICY_PATH),
        help="Baseline graph retrieval policy JSON file",
    )
    parser.add_argument(
        "--candidate-file",
        required=True,
        help="Candidate graph retrieval policy JSON file",
    )
    parser.add_argument(
        "--cases",
        default=str(DEFAULT_CASES_PATH),
        help="Fixed eval case set JSON file",
    )
    parser.add_argument(
        "--output",
        help="Optional report output path",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Pass through verbose evaluation output",
    )
    args = parser.parse_args()

    eval_module = load_eval_module()
    baseline_path = Path(args.baseline_file).resolve()
    candidate_path = Path(args.candidate_file).resolve()
    cases_path = Path(args.cases).resolve()

    baseline_text = baseline_path.read_text()
    candidate_text = candidate_path.read_text()

    baseline_report = eval_module.evaluate_policy(baseline_text, cases_path, verbose=args.verbose)
    candidate_report = eval_module.evaluate_policy(candidate_text, cases_path, verbose=args.verbose)

    report = {
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "baseline_policy_path": str(baseline_path),
        "candidate_policy_path": str(candidate_path),
        "baseline_policy_hash": policy_hash(baseline_text),
        "candidate_policy_hash": policy_hash(candidate_text),
        "case_count": len(candidate_report["results"]),
        "mean_score_baseline": baseline_report["mean_score"],
        "mean_score_candidate": candidate_report["mean_score"],
        "accepted_cases_baseline": baseline_report["accepted"],
        "accepted_cases_candidate": candidate_report["accepted"],
        "decision": compare_decision(baseline_report, candidate_report),
        "notes": build_notes(baseline_report, candidate_report),
        "baseline_report": baseline_report,
        "candidate_report": candidate_report,
    }

    serialized = json.dumps(report, indent=2)
    if args.output:
        output_path = Path(args.output).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(serialized)

    print(serialized)


if __name__ == "__main__":
    main()
