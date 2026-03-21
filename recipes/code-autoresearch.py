#!/usr/bin/env python3
"""
Bounded code autoresearch loop.

This mutates an explicit allowlist of files inside a temporary overlay workspace,
runs fixed evaluator commands, and only writes accepted revisions back to the
real workspace when train improves without regressing guard suites.
"""

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
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


def build_revision_tool():
    return {
        "type": "function",
        "function": {
            "name": "submit_revision",
            "description": "Return changed file contents and short reasons for the revision.",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "required": ["files", "why"],
                "properties": {
                    "files": {
                        "type": "array",
                        "description": "Only the changed files. Omit unchanged files.",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["path", "content"],
                            "properties": {
                                "path": {
                                    "type": "string",
                                    "description": "Repo-relative path from the allowed target set.",
                                },
                                "content": {
                                    "type": "string",
                                    "description": "The full new file contents.",
                                },
                            },
                        },
                    },
                    "why": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Up to 5 short reasons for the revision.",
                    },
                },
            },
        },
    }


def load_research_program(program_file):
    if program_file:
        path = Path(program_file)
    else:
        path = None

    if path and path.exists():
        return path.read_text().strip()

    return textwrap.dedent(
        """
        Improve the fixed evaluation score by revising only the allowed target files.

        Hard constraints:
        - Do not change files outside the allowlist.
        - Make small, coherent edits rather than rewrites.
        - Preserve evaluator compatibility and output contracts.
        - Prefer deterministic improvements over adding heuristics that could drift or overfit.
        """
    ).strip()


def summarize_weak_cases(results, limit=4):
    def truncate_text(value, limit_chars=200):
        if not isinstance(value, str):
            value = str(value)
        value = value.strip()
        if len(value) <= limit_chars:
            return value
        return f"{value[: limit_chars - 1]}…"

    def case_label(item):
        case = item.get("case", {})
        return case.get("id") or case.get("title") or case.get("question") or "untitled-case"

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
                "score": result["judgment"]["total_score"],
                "decision": result["judgment"]["decision"],
                "notes": [truncate_text(note, 140) for note in result["judgment"].get("notes", [])[:3]],
            }
        )
        if len(weak) >= limit:
            break
    return weak


def summarize_suite(name, summary):
    return {
        "name": name,
        "mean_score": summary["mean_score"],
        "accepted": summary["accepted"],
        "case_count": summary["case_count"],
        "weak_cases": summarize_weak_cases(summary.get("results", [])),
    }


def workspace_command(command_template, workspace):
    return command_template.format(workspace=shlex.quote(str(workspace)))


def parse_report(stdout):
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        payload = extract_json_payload(stdout)
        if not isinstance(payload, dict):
            raise ValueError("Evaluator did not return a JSON object")
        return payload


def normalize_summary(report):
    if not isinstance(report, dict):
        raise ValueError("Evaluator report must be a JSON object")

    results = report.get("results")
    if not isinstance(results, list):
        raise ValueError("Evaluator report is missing results[]")

    if "mean_score" not in report or "accepted" not in report:
        raise ValueError("Evaluator report is missing mean_score or accepted")

    return {
        "mean_score": float(report["mean_score"]),
        "accepted": int(report["accepted"]),
        "case_count": int(report.get("case_count", len(results))),
        "results": results,
        "raw": report,
    }


def evaluate_command(command_template, workspace, env):
    command = workspace_command(command_template, workspace)
    proc = subprocess.run(
        command,
        cwd=workspace,
        env=env,
        shell=True,
        capture_output=True,
        text=True,
        timeout=900,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "Evaluator command failed\n"
            f"COMMAND: {command}\n"
            f"STDOUT:\n{proc.stdout}\n\nSTDERR:\n{proc.stderr}"
        )
    return normalize_summary(parse_report(proc.stdout))


def is_better(candidate, incumbent):
    if candidate["mean_score"] > incumbent["mean_score"]:
        return True
    if candidate["mean_score"] == incumbent["mean_score"] and candidate["accepted"] > incumbent["accepted"]:
        return True
    return False


def is_not_worse(candidate, baseline):
    if candidate["mean_score"] < baseline["mean_score"]:
        return False
    if candidate["accepted"] < baseline["accepted"]:
        return False
    return True


def rel_target_paths(targets):
    relative = []
    for target in targets:
        target_path = Path(target).resolve()
        try:
            relative.append(target_path.relative_to(REPO_ROOT))
        except ValueError as exc:
            raise ValueError(f"Target {target_path} is outside the repo root") from exc
    return relative


def symlink_children(repo_dir, temp_dir):
    temp_dir.mkdir(parents=True, exist_ok=True)
    for child in repo_dir.iterdir():
        target = temp_dir / child.name
        if target.exists() or target.is_symlink():
            continue
        target.symlink_to(child)


def create_overlay_workspace(repo_root, relative_targets):
    temp_dir = tempfile.TemporaryDirectory(prefix="ob1-code-autoresearch-")
    workspace = Path(temp_dir.name) / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)

    for child in repo_root.iterdir():
        if child.name == ".git":
            continue
        (workspace / child.name).symlink_to(child)

    for rel_path in relative_targets:
        repo_path = repo_root / rel_path
        current_repo = repo_root
        current_workspace = workspace

        for part in rel_path.parts[:-1]:
            current_repo = current_repo / part
            current_workspace = current_workspace / part
            if current_workspace.is_symlink():
                current_workspace.unlink()
                symlink_children(current_repo, current_workspace)
            elif not current_workspace.exists():
                current_workspace.mkdir(parents=True, exist_ok=True)

        target_path = workspace / rel_path
        if target_path.exists() or target_path.is_symlink():
            target_path.unlink()
        shutil.copy2(repo_path, target_path)

    return temp_dir, workspace


def file_bundle(relative_targets):
    chunks = []
    for rel_path in relative_targets:
        content = (REPO_ROOT / rel_path).read_text()
        chunks.append(
            f"=== FILE: {rel_path.as_posix()} ===\n"
            f"{content}"
        )
    return "\n\n".join(chunks)


def proposal_user_content(target_paths, current_files, train_summary, guard_summaries, attempt_index):
    weak_lines = []
    for case in summarize_weak_cases(train_summary.get("results", [])):
        weak_lines.append(f"- {case['title']}: score={case['score']} decision={case['decision']}")
        if case.get("question"):
            weak_lines.append(f"  question: {case['question']}")
        if case.get("notes"):
            weak_lines.append(f"  notes: {'; '.join(case['notes'])}")

    weak_text = "\n".join(weak_lines) if weak_lines else "- none"
    guard_text = "\n".join(
        f"- {item['name']}: mean={item['mean_score']} accepted={item['accepted']}/{item['case_count']}"
        for item in guard_summaries
    ) if guard_summaries else "- none"

    target_list = "\n".join(f"- {path.as_posix()}" for path in target_paths)
    return textwrap.dedent(
        f"""
        Attempt index: {attempt_index}

        Allowed target files:
        {target_list}

        Current train score: {train_summary['mean_score']}
        Current train accepted: {train_summary['accepted']}/{train_summary['case_count']}

        Guard suites:
        {guard_text}

        Weak train cases:
        {weak_text}

        Current target file contents:
        {current_files}
        """
    ).strip()


def validate_revision(proposal, allowed_paths):
    files = proposal.get("files", [])
    if not isinstance(files, list):
        raise ValueError("Revision files must be an array")

    allowed_set = {path.as_posix() for path in allowed_paths}
    seen = set()
    normalized = []
    for entry in files:
        if not isinstance(entry, dict):
            raise ValueError("Each revision file must be an object")
        path_value = entry.get("path")
        content_value = entry.get("content")
        if not isinstance(path_value, str) or not path_value.strip():
            raise ValueError("Revision file path was empty")
        if path_value not in allowed_set:
            raise ValueError(f"Revision touched disallowed path: {path_value}")
        if path_value in seen:
            raise ValueError(f"Revision duplicated path: {path_value}")
        if not isinstance(content_value, str) or not content_value:
            raise ValueError(f"Revision content was empty for {path_value}")
        seen.add(path_value)
        normalized.append(
            {
                "path": Path(path_value),
                "content": content_value,
            }
        )

    why = proposal.get("why", [])
    if not isinstance(why, list):
        why = []

    return {
        "files": normalized,
        "why": why[:5],
    }


def propose_revision(
    current_files,
    target_paths,
    train_summary,
    guard_summaries,
    attempt_index,
    research_program,
    proposal_temperature,
):
    system_prompt = textwrap.dedent(
        f"""
        {research_program}

        You must return exactly one submit_revision tool call.
        Do not answer in prose.
        Only change the allowed target files.
        Omit unchanged files from files[].
        Each changed file must contain the full replacement content.
        Put short reasons in why.
        """
    ).strip()

    user_content = proposal_user_content(
        target_paths,
        current_files,
        train_summary,
        guard_summaries,
        attempt_index,
    )

    response = requests.post(
        f"{local_llm_base_url()}/chat/completions",
        headers={"Content-Type": "application/json"},
        json={
            "model": LOCAL_LLM_MODEL,
            "temperature": proposal_temperature,
            "max_tokens": 10000,
            "chat_template_kwargs": {
                "enable_thinking": LOCAL_LLM_ENABLE_THINKING,
            },
            "tools": [build_revision_tool()],
            "tool_choice": build_named_tool_choice("submit_revision"),
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
        },
        timeout=600,
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"{response.status_code} {response.reason}: {normalize_chat_content(response.text)}"
        )

    proposal = extract_tool_arguments(response.json(), "submit_revision")
    return validate_revision(proposal, target_paths)


def apply_revision(workspace, revision):
    for file_entry in revision["files"]:
        path = workspace / file_entry["path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(file_entry["content"])


def write_back_revision(repo_root, revision):
    for file_entry in revision["files"]:
        destination = repo_root / file_entry["path"]
        destination.write_text(file_entry["content"])


def parse_args():
    parser = argparse.ArgumentParser(description="Run a bounded code autoresearch loop over explicit target files.")
    parser.add_argument("--targets", nargs="+", required=True, help="Repo-relative or absolute file paths allowed to change")
    parser.add_argument("--train-command", required=True, help="Shell command that evaluates the candidate in {workspace} and prints JSON")
    parser.add_argument("--guard-command", action="append", default=[], help="Optional additional evaluator commands; candidate must not regress any of them")
    parser.add_argument("--program-file", help="Optional research program markdown")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--candidates", type=int, default=2)
    parser.add_argument("--proposal-temperature", type=float, default=0.3)
    parser.add_argument("--report", help="Optional JSON report path")
    parser.add_argument("--no-write-back", action="store_true", help="Evaluate candidates but do not apply accepted revisions to the real repo")
    return parser.parse_args()


def main():
    args = parse_args()
    relative_targets = rel_target_paths(args.targets)
    research_program = load_research_program(args.program_file)
    current_files = file_bundle(relative_targets)
    env = os.environ.copy()

    baseline_train = evaluate_command(args.train_command, REPO_ROOT, env)
    baseline_guards = [
        {
            "command": command,
            "summary": evaluate_command(command, REPO_ROOT, env),
        }
        for command in args.guard_command
    ]

    best_train = baseline_train
    best_files = {path.as_posix(): (REPO_ROOT / path).read_text() for path in relative_targets}

    history = [
        {
            "round": 0,
            "candidate": "baseline",
            "train": summarize_suite("train", baseline_train),
            "guards": [summarize_suite(item["command"], item["summary"]) for item in baseline_guards],
        }
    ]

    print("baseline")

    for round_index in range(1, args.rounds + 1):
        print("=" * 60)
        print(f"round {round_index}")
        improved = False

        for candidate_index in range(1, args.candidates + 1):
            attempt_index = (round_index - 1) * args.candidates + candidate_index
            try:
                revision = propose_revision(
                    current_files,
                    relative_targets,
                    best_train,
                    [summarize_suite(item["command"], item["summary"]) for item in baseline_guards],
                    attempt_index,
                    research_program,
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

            if not revision["files"]:
                print(f"candidate {candidate_index}: identical, skipped")
                history.append(
                    {
                        "round": round_index,
                        "candidate": candidate_index,
                        "stage": "proposal",
                        "decision": "identical",
                        "why": revision["why"],
                    }
                )
                continue

            temp_dir, workspace = create_overlay_workspace(REPO_ROOT, relative_targets)
            try:
                apply_revision(workspace, revision)
                train_summary = evaluate_command(args.train_command, workspace, env)
                guard_summaries = [
                    {
                        "command": item["command"],
                        "summary": evaluate_command(item["command"], workspace, env),
                    }
                    for item in baseline_guards
                ]
            except Exception as exc:
                temp_dir.cleanup()
                print(f"candidate {candidate_index}: eval failed")
                print(f"  {exc}")
                history.append(
                    {
                        "round": round_index,
                        "candidate": candidate_index,
                        "stage": "eval",
                        "error": str(exc),
                        "why": revision["why"],
                    }
                )
                continue
            finally:
                temp_dir.cleanup()

            guard_ok = all(
                is_not_worse(candidate["summary"], baseline["summary"])
                for candidate, baseline in zip(guard_summaries, baseline_guards)
            )

            entry = {
                "round": round_index,
                "candidate": candidate_index,
                "train": summarize_suite("train", train_summary),
                "guards": [summarize_suite(item["command"], item["summary"]) for item in guard_summaries],
                "why": revision["why"],
                "changed_paths": [item["path"].as_posix() for item in revision["files"]],
            }

            if is_better(train_summary, best_train) and guard_ok:
                print(
                    f"candidate {candidate_index}: improved "
                    f"{train_summary['mean_score']:.2f} ({train_summary['accepted']}/{train_summary['case_count']})"
                )
                improved = True
                best_train = train_summary
                for item in revision["files"]:
                    best_files[item["path"].as_posix()] = item["content"]
                current_files = "\n\n".join(
                    f"=== FILE: {path.as_posix()} ===\n{best_files[path.as_posix()]}"
                    for path in relative_targets
                )
                if not args.no_write_back:
                    write_back_revision(REPO_ROOT, revision)
                entry["decision"] = "accepted"
                history.append(entry)
            else:
                print(
                    f"candidate {candidate_index}: rejected "
                    f"{train_summary['mean_score']:.2f} ({train_summary['accepted']}/{train_summary['case_count']})"
                )
                entry["decision"] = "rejected"
                entry["guard_ok"] = guard_ok
                history.append(entry)

        if not improved:
            print("plateau")
            break

    report = {
        "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "targets": [path.as_posix() for path in relative_targets],
        "best": {
            "mean_score": best_train["mean_score"],
            "accepted": best_train["accepted"],
            "case_count": best_train["case_count"],
        },
        "history": history,
    }

    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2))

    print("=" * 60)
    print(f"final mean_score: {best_train['mean_score']:.2f}")
    print(f"final accepted: {best_train['accepted']}/{best_train['case_count']}")
    print(f"targets: {', '.join(path.as_posix() for path in relative_targets)}")
    if args.report:
        print(f"report: {args.report}")


if __name__ == "__main__":
    main()
