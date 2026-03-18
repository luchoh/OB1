#!/usr/bin/env python3
"""
Directed evaluation for the graph augmentation PRD.

Autoresearch-style mapping:
- mutable artifact: 12-graph-augmentation-prd.md
- fixed evaluator: this file
- fixed case set: 12-graph-augmentation-prd-eval-cases.json
- fixed evidence set: 12-graph-augmentation-evidence.md
"""

import argparse
import json
import os
import re
import statistics
import sys
import textwrap
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from recipes.shared_docling import local_llm_base_url

CASE_FILE_PATH = Path(__file__).with_name("12-graph-augmentation-prd-eval-cases.json")
PRD_FILE_PATH = Path(__file__).with_name("12-graph-augmentation-prd.md")
EVIDENCE_FILE_PATH = Path(__file__).with_name("12-graph-augmentation-evidence.md")

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


def load_cases(path):
    with open(path) as handle:
        payload = json.load(handle)
    if not isinstance(payload, list):
        raise ValueError("Case file must contain a JSON array")
    return payload


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


def is_valid_judgment(payload):
    required = {"total_score", "decision", "notes"}
    return isinstance(payload, dict) and required.issubset(payload.keys())


def _excerpt_by_keywords(text, keywords, default_count=4):
    paragraphs = [block.strip() for block in text.split("\n\n") if block.strip()]
    matched = []
    for paragraph in paragraphs:
        lowered = paragraph.lower()
        if any(keyword in lowered for keyword in keywords):
            matched.append(paragraph)
        if len(matched) >= 4:
            break
    if not matched:
        matched = paragraphs[:default_count]
    return "\n\n".join(matched)


def relevant_prd_excerpt(prd_text, case):
    title = case["title"].lower()
    keyword_map = {
        "canonical boundary": ["canonical", "source of truth", "write path", "derived"],
        "desktop multi-database capability": ["desktop", "multiple databases", "staging", "production graph"],
        "cross-database transaction boundary": ["transaction", "multiple databases", "asynchronous", "projector"],
        "pgvector canonical justification": ["pgvector", "canonical", "exact", "hybrid", "filtering"],
        "neo4j vector capability boundary": ["vector index", "nodes", "relationships", "second canonical vector store", "v1"],
        "neo4j vector operational cost": ["os-memory", "filesystem-cache", "vector indexes", "operational cost"],
        "provenance-first scope": ["provenance", "phase 1", "entity extraction", "graph of everything"],
        "confidence discipline": ["confidence", "evidence", "llm-extracted", "deterministic"],
        "official graphrag scope": ["graphrag", "implementation reference", "first-party"],
        "retrieval integration": ["graph-assisted", "semantic retrieval", "ask_brain", "default retrieval"],
        "evaluation plan": ["evaluation", "success", "question set", "grounded-answer"],
        "implementation readiness": ["node", "relationship", "projection state", "canonical_id"],
    }
    return _excerpt_by_keywords(prd_text, keyword_map.get(title, []))


def relevant_evidence_excerpt(evidence_text, case):
    title = case["title"].lower()
    keyword_map = {
        "canonical boundary": ["postgresql", "derived", "source of truth", "recommended v1 graph stance"],
        "desktop multi-database capability": ["developer edition", "enterprise", "multiple databases", "single machine"],
        "cross-database transaction boundary": ["transaction cannot span", "multiple databases", "asynchronous"],
        "pgvector canonical justification": ["pgvector", "exact nearest-neighbor", "hnsw", "hybrid", "filtering"],
        "neo4j vector capability boundary": ["native vector indexes", "nodes or relationships", "second vector store"],
        "neo4j vector operational cost": ["filesystem cache", "os memory", "vector footprint"],
        "provenance-first scope": ["provenance-first", "derived relationship layer", "do not duplicate canonical embeddings"],
        "confidence discipline": ["confidence", "evidence", "LLM-derived", "deterministic"],
        "official graphrag scope": ["official first-party graphrag", "implementation reference", "package"],
        "retrieval integration": ["graph-assisted retrieval", "vector-only", "canonical vectors"],
        "evaluation plan": ["product questions", "success means", "grounded-answer discipline"],
        "implementation readiness": ["production graph database", "staging graph database", "projection state"],
    }
    return _excerpt_by_keywords(evidence_text, keyword_map.get(title, []))


def judge_case(case, prd_text, prd_excerpt, evidence_excerpt):
    system_prompt = textwrap.dedent(
        """
        You are doing strict QA for a technical PRD against a fixed evidence dossier.

        Grade the document against the case expectations and the evidence excerpt.
        Reward:
        - clear architecture boundaries
        - operationally implementable rollout
        - explicit risk control
        - concrete evaluation criteria
        - consistency with the fixed evidence dossier

        Penalize heavily:
        - vague graph-of-everything language
        - missing source-of-truth boundaries
        - hidden write-path coupling
        - missing rebuild/sync semantics
        - missing confidence/evidence discipline for extracted facts
        - contradicting the evidence dossier
        - generic product copy without implementation value

        Scoring:
        - 90-100: implementation-ready PRD quality
        - 70-89: directionally good but underspecified
        - below 70: too vague or risky to trust

        Return exactly this format and nothing else:
        SCORE: <integer 0-100>
        DECISION: <accept|reject>
        NOTES:
        - <short note>
        - <short note>
        - <short note>
        """
    ).strip()

    user_prompt = {
        "case": case,
        "relevant_prd_excerpt": prd_excerpt,
        "relevant_evidence_excerpt": evidence_excerpt,
        "full_prd": prd_text,
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
            except Exception:
                last_error = ValueError(f"Judge returned unparseable content: {content[:1200]}")
                continue
            if is_valid_judgment(payload):
                return payload
            last_error = ValueError(f"Judge returned malformed payload: {payload}")
        except Exception as exc:
            last_error = exc

    raise last_error


def evaluate_case(case, prd_text, evidence_text):
    prd_excerpt = relevant_prd_excerpt(prd_text, case)
    evidence_excerpt = relevant_evidence_excerpt(evidence_text, case)
    judgment = judge_case(case, prd_text, prd_excerpt, evidence_excerpt)
    return {
        "case": case,
        "thoughts": [prd_excerpt],
        "judgment": judgment,
    }


def evaluate_prompt(export_path=None, cases_path=None, prompt_file=None, prompt_template=None, verbose=True):
    del export_path
    cases = load_cases(cases_path or CASE_FILE_PATH)
    prd_text = prompt_template if prompt_template is not None else Path(prompt_file or PRD_FILE_PATH).read_text().strip()
    evidence_text = EVIDENCE_FILE_PATH.read_text().strip()

    results = []
    for case in cases:
        result = evaluate_case(case, prd_text, evidence_text)
        results.append(result)

        if verbose:
            verdict = result["judgment"]["decision"]
            score = result["judgment"]["total_score"]
            print(f"{case['title']}: {score}/100 ({verdict})")
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
    parser = argparse.ArgumentParser(description="Evaluate the graph augmentation PRD against a fixed evidence dossier.")
    parser.add_argument("--cases", default=str(CASE_FILE_PATH), help="Case file")
    parser.add_argument("--prompt-file", default=str(PRD_FILE_PATH), help="PRD file to evaluate")
    parser.add_argument("--report", help="Optional JSON report")
    return parser.parse_args()


def main():
    args = parse_args()
    summary = evaluate_prompt(
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
