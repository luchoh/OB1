#!/usr/bin/env python3
"""
Directed retrieval-only evaluation for graph-assisted retrieval policy.

Mutable artifact:
- local/open-brain-mcp/config/graph-retrieval-policy.json

Fixed evaluator:
- this file

Fixed case set:
- graph-retrieval-eval-cases.json
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import ssl
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
CASE_FILE_PATH = Path(__file__).with_name("graph-retrieval-eval-cases.json")
SCRIPT_PATH = REPO_ROOT / "scripts" / "eval-open-brain-retrieval.mjs"


def load_env_file(path):
    if not path.exists():
        return
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def discover_consul_service_root(service_name):
    base = os.environ.get("CONSUL_HTTP_ADDR", "https://consul.lincoln.luchoh.net").rstrip("/")
    token = os.environ.get("CONSUL_HTTP_TOKEN", "")
    skip_tls = os.environ.get("CONSUL_SKIP_TLS_VERIFY", "").strip().lower() in {"1", "true", "yes", "on"}

    headers = {}
    if token:
        headers["X-Consul-Token"] = token

    context = None
    if base.startswith("https://"):
        context = ssl.create_default_context()
        if skip_tls:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE

    request = urllib.request.Request(
        f"{base}/v1/health/service/{service_name}?passing=1",
        headers=headers,
    )
    with urllib.request.urlopen(request, timeout=20, context=context) as response:
        payload = json.load(response)

    if not payload:
        raise RuntimeError(f"No passing Consul instances for {service_name}")

    service = payload[0].get("Service", {})
    address = service.get("Address") or payload[0].get("Node", {}).get("Address")
    port = service.get("Port")
    if not address or not port:
        raise RuntimeError(f"Consul service {service_name} is missing address or port")

    return f"http://{address}:{port}"


def load_cases(path):
    with open(path) as handle:
        payload = json.load(handle)
    if not isinstance(payload, list):
        raise ValueError("Case file must contain a JSON array")
    return payload


def evaluate_policy(policy_text, cases_path, verbose=False):
    try:
        json.loads(policy_text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Policy artifact is not valid JSON: {exc}") from exc

    with tempfile.TemporaryDirectory(prefix="ob1-graph-policy-") as temp_dir:
        policy_path = Path(temp_dir) / "graph-retrieval-policy.json"
        report_path = Path(temp_dir) / "graph-retrieval-report.json"
        policy_path.write_text(policy_text)

        load_env_file(REPO_ROOT / ".env")
        load_env_file(REPO_ROOT / ".env.open-brain-local")
        env = os.environ.copy()
        env.setdefault("OPEN_BRAIN_GRAPH_ENABLED", "true")
        eval_database = env.get("OB1_GRAPH_RETRIEVAL_EVAL_DATABASE", "").strip() or env.get("OPEN_BRAIN_GRAPH_DATABASE", "ob1-graph-stage")
        env["OPEN_BRAIN_GRAPH_DATABASE"] = eval_database
        env["OPEN_BRAIN_GRAPH_STAGING_DATABASE"] = eval_database
        env.setdefault("NEO4J_URI", "bolt://localhost:7687")
        env.setdefault("OPEN_BRAIN_RUNTIME_ROLE", "graph-projector")
        embedding_root = discover_consul_service_root(env.get("OPEN_BRAIN_EMBEDDING_SERVICE_NAME", "ob1-embedding"))
        env.setdefault("EMBEDDING_BASE_URL", f"{embedding_root}/v1")
        env.setdefault("EMBEDDING_HEALTH_URL", f"{embedding_root}/health")
        env["OPEN_BRAIN_GRAPH_RETRIEVAL_POLICY_PATH"] = str(policy_path)

        command = [
            "node",
            str(SCRIPT_PATH),
            "--cases",
            str(cases_path),
            "--database",
            eval_database,
            "--output",
            str(report_path),
        ]
        schema_variant = env.get("OB1_GRAPH_RETRIEVAL_EVAL_SCHEMA_VARIANT", "").strip()
        if schema_variant:
            command.extend(["--schema-variant", schema_variant])
        include_chat_sources = env.get("OB1_GRAPH_RETRIEVAL_EVAL_INCLUDE_CHAT_SOURCES", "").strip().lower()
        if include_chat_sources in {"1", "true", "yes", "on"}:
            command.append("--include-chat-sources")
        if verbose:
            command.append("--verbose")

        proc = subprocess.run(
            command,
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=600,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                "Graph retrieval eval failed\n"
                f"STDOUT:\n{proc.stdout}\n\nSTDERR:\n{proc.stderr}"
            )

        return json.loads(report_path.read_text())


def evaluate_prompt(export_path, cases_path, prompt_template, verbose=False):
    del export_path
    report = evaluate_policy(prompt_template, cases_path, verbose=verbose)
    mean_score = report["mean_score"]
    accepted = report["accepted"]
    results = report["results"]
    return {
        "mean_score": mean_score,
        "accepted": accepted,
        "case_count": len(results),
        "results": results,
    }


def main():
    parser = argparse.ArgumentParser(description="Evaluate graph retrieval policy against fixed retrieval cases.")
    parser.add_argument(
        "--policy-file",
        default=str(REPO_ROOT / "local/open-brain-mcp/config/graph-retrieval-policy.json"),
    )
    parser.add_argument("--cases", default=str(CASE_FILE_PATH))
    parser.add_argument("--database", help="Neo4j database override for evaluation")
    parser.add_argument("--schema-variant", help="Graph schema variant override for evaluation")
    parser.add_argument("--include-chat-sources", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    if args.database:
        os.environ["OB1_GRAPH_RETRIEVAL_EVAL_DATABASE"] = args.database
    if args.schema_variant:
        os.environ["OB1_GRAPH_RETRIEVAL_EVAL_SCHEMA_VARIANT"] = args.schema_variant
    if args.include_chat_sources:
        os.environ["OB1_GRAPH_RETRIEVAL_EVAL_INCLUDE_CHAT_SOURCES"] = "true"

    policy_text = Path(args.policy_file).read_text()
    summary = evaluate_prompt(
        export_path="unused",
        cases_path=args.cases,
        prompt_template=policy_text,
        verbose=args.verbose,
    )
    print(json.dumps(summary, indent=2))
    print()
    print(f"mean_score={summary['mean_score']:.2f}")
    print(f"accepted={summary['accepted']}/{summary['case_count']}")


if __name__ == "__main__":
    main()
