#!/usr/bin/env python3
"""
Run a local PDF-to-Markdown bakeoff across Docling, Marker, and MinerU.

This script is intentionally pragmatic:
- it runs whatever converters are available locally
- it writes each converter output to disk for manual review
- it emits a compact Markdown report with structural stats and failures

It does not claim to prove semantic extraction quality by itself.
Use the generated artifacts to review the outputs on representative PDFs.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from recipes.shared_docling import discover_docling_base_url, docling_chunk, docling_markdown_artifact


def slugify(value: str) -> str:
    cleaned = "".join(char if char.isalnum() else "-" for char in value.strip().lower())
    cleaned = "-".join(part for part in cleaned.split("-") if part)
    return cleaned or "file"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def markdown_stats(text: str) -> dict:
    lines = text.splitlines()
    stripped = [line.strip() for line in lines]
    return {
        "chars": len(text),
        "lines": len(lines),
        "nonempty_lines": sum(1 for line in stripped if line),
        "heading_lines": sum(1 for line in stripped if line.startswith("#")),
        "table_lines": sum(1 for line in stripped if "|" in line),
        "list_lines": sum(1 for line in stripped if line.startswith(("- ", "* ", "1. ", "2. ", "3. "))),
        "code_fences": sum(1 for line in stripped if line.startswith("```")),
    }


def preview(text: str, line_limit: int = 12) -> str:
    lines = text.splitlines()[:line_limit]
    return "\n".join(lines).strip()


def inline_python(code: str, *args: str) -> list[str]:
    return [sys.executable, "-c", code, *args]


def docling_python_command(pdf_path: Path) -> list[str]:
    code = """
from docling.document_converter import DocumentConverter
import sys
converter = DocumentConverter()
result = converter.convert(sys.argv[1])
print(result.document.export_to_markdown())
""".strip()
    return inline_python(code, str(pdf_path))


def marker_python_command(pdf_path: Path) -> list[str]:
    code = """
from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.output import text_from_rendered
import sys
converter = PdfConverter(artifact_dict=create_model_dict())
rendered = converter(sys.argv[1])
text, _, _ = text_from_rendered(rendered)
print(text)
""".strip()
    return inline_python(code, str(pdf_path))


def run_command(command: list[str], *, cwd: Path | None = None, timeout: int = 1800) -> subprocess.CompletedProcess:
    return subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def discover_single_markdown(root: Path, preferred_stem: str) -> Path:
    candidates = sorted(root.rglob("*.md"))
    if not candidates:
        raise RuntimeError(f"No Markdown output found under {root}")

    stem_matches = [path for path in candidates if path.stem == preferred_stem]
    if stem_matches:
        return max(stem_matches, key=lambda path: path.stat().st_size)
    return max(candidates, key=lambda path: path.stat().st_size)


@dataclass
class RunResult:
    converter: str
    source_pdf: str
    ok: bool
    duration_sec: float
    markdown_path: str | None
    stdout_log: str | None
    stderr_log: str | None
    error: str | None
    stats: dict


def run_docling_package(pdf_path: Path, output_dir: Path, timeout: int) -> RunResult:
    started = time.monotonic()
    completed = run_command(docling_python_command(pdf_path), timeout=timeout)
    duration = time.monotonic() - started

    stdout_path = output_dir / "docling.stdout.log"
    stderr_path = output_dir / "docling.stderr.log"
    write_text(stdout_path, completed.stdout)
    write_text(stderr_path, completed.stderr)

    if completed.returncode != 0:
        return RunResult(
            converter="docling",
            source_pdf=str(pdf_path),
            ok=False,
            duration_sec=duration,
            markdown_path=None,
            stdout_log=str(stdout_path),
            stderr_log=str(stderr_path),
            error=f"Docling package failed with exit code {completed.returncode}",
            stats={},
        )

    markdown_path = output_dir / "docling.md"
    write_text(markdown_path, completed.stdout)
    return RunResult(
        converter="docling",
        source_pdf=str(pdf_path),
        ok=True,
        duration_sec=duration,
        markdown_path=str(markdown_path),
        stdout_log=str(stdout_path),
        stderr_log=str(stderr_path),
        error=None,
        stats=markdown_stats(completed.stdout),
    )


def run_docling_service(pdf_path: Path, output_dir: Path, chunker: str, docling_url: str | None) -> RunResult:
    started = time.monotonic()
    try:
        base_url = discover_docling_base_url(docling_url)
        extraction = docling_chunk(base_url, pdf_path, chunker)
        markdown_text = docling_markdown_artifact(pdf_path.name, extraction)
        duration = time.monotonic() - started
        markdown_path = output_dir / "docling-service.md"
        write_text(markdown_path, markdown_text)
        return RunResult(
            converter="docling-service",
            source_pdf=str(pdf_path),
            ok=True,
            duration_sec=duration,
            markdown_path=str(markdown_path),
            stdout_log=None,
            stderr_log=None,
            error=None,
            stats=markdown_stats(markdown_text),
        )
    except Exception as exc:
        duration = time.monotonic() - started
        return RunResult(
            converter="docling-service",
            source_pdf=str(pdf_path),
            ok=False,
            duration_sec=duration,
            markdown_path=None,
            stdout_log=None,
            stderr_log=None,
            error=str(exc),
            stats={},
        )


def run_marker(pdf_path: Path, output_dir: Path, timeout: int) -> RunResult:
    started = time.monotonic()
    completed = run_command(marker_python_command(pdf_path), timeout=timeout)
    duration = time.monotonic() - started

    stdout_path = output_dir / "marker.stdout.log"
    stderr_path = output_dir / "marker.stderr.log"
    write_text(stdout_path, completed.stdout)
    write_text(stderr_path, completed.stderr)

    if completed.returncode != 0:
        return RunResult(
            converter="marker",
            source_pdf=str(pdf_path),
            ok=False,
            duration_sec=duration,
            markdown_path=None,
            stdout_log=str(stdout_path),
            stderr_log=str(stderr_path),
            error=f"Marker package failed with exit code {completed.returncode}",
            stats={},
        )

    markdown_path = output_dir / "marker.md"
    write_text(markdown_path, completed.stdout)
    return RunResult(
        converter="marker",
        source_pdf=str(pdf_path),
        ok=True,
        duration_sec=duration,
        markdown_path=str(markdown_path),
        stdout_log=str(stdout_path),
        stderr_log=str(stderr_path),
        error=None,
        stats=markdown_stats(completed.stdout),
    )


def run_mineru(pdf_path: Path, output_dir: Path, timeout: int) -> RunResult:
    if shutil.which("mineru") is None:
        return RunResult(
            converter="mineru",
            source_pdf=str(pdf_path),
            ok=False,
            duration_sec=0.0,
            markdown_path=None,
            stdout_log=None,
            stderr_log=None,
            error="mineru CLI not found in PATH",
            stats={},
        )

    work_dir = output_dir / "mineru-work"
    work_dir.mkdir(parents=True, exist_ok=True)

    started = time.monotonic()
    completed = run_command(["mineru", "-p", str(pdf_path), "-o", str(work_dir)], timeout=timeout)
    duration = time.monotonic() - started

    stdout_path = output_dir / "mineru.stdout.log"
    stderr_path = output_dir / "mineru.stderr.log"
    write_text(stdout_path, completed.stdout)
    write_text(stderr_path, completed.stderr)

    if completed.returncode != 0:
        return RunResult(
            converter="mineru",
            source_pdf=str(pdf_path),
            ok=False,
            duration_sec=duration,
            markdown_path=None,
            stdout_log=str(stdout_path),
            stderr_log=str(stderr_path),
            error=f"MinerU failed with exit code {completed.returncode}",
            stats={},
        )

    markdown_path = discover_single_markdown(work_dir, pdf_path.stem)
    text = read_text(markdown_path)
    copied_path = output_dir / "mineru.md"
    write_text(copied_path, text)
    return RunResult(
        converter="mineru",
        source_pdf=str(pdf_path),
        ok=True,
        duration_sec=duration,
        markdown_path=str(copied_path),
        stdout_log=str(stdout_path),
        stderr_log=str(stderr_path),
        error=None,
        stats=markdown_stats(text),
    )


def pairwise_similarity(results_for_pdf: list[RunResult]) -> list[dict]:
    successes = [result for result in results_for_pdf if result.ok and result.markdown_path]
    similarities = []
    for index, left in enumerate(successes):
        left_text = read_text(Path(left.markdown_path))
        for right in successes[index + 1:]:
            right_text = read_text(Path(right.markdown_path))
            ratio = SequenceMatcher(None, left_text, right_text).ratio()
            similarities.append(
                {
                    "left": left.converter,
                    "right": right.converter,
                    "ratio": round(ratio, 4),
                }
            )
    return similarities


def parse_args():
    parser = argparse.ArgumentParser(description="Benchmark local PDF-to-Markdown converters on representative PDFs.")
    parser.add_argument("paths", nargs="+", help="One or more PDF files or directories.")
    parser.add_argument("--recursive", action="store_true", help="Walk directories recursively.")
    parser.add_argument("--limit", type=int, help="Maximum number of PDFs to process.")
    parser.add_argument(
        "--converters",
        nargs="+",
        choices=("docling", "docling-service", "marker", "mineru"),
        default=["docling", "marker", "mineru"],
        help="Converters to run. docling uses the local Python package; docling-service uses the existing LAN service.",
    )
    parser.add_argument("--docling-url", help="Override the Docling service base URL for the docling-service adapter.")
    parser.add_argument("--chunker", choices=("hierarchical", "hybrid"), default="hierarchical", help="Docling service chunker.")
    parser.add_argument("--timeout", type=int, default=1800, help="Per-converter timeout in seconds.")
    parser.add_argument(
        "--output-dir",
        default=str(Path(__file__).resolve().parent / "bakeoff-output"),
        help="Directory for generated Markdown outputs and reports.",
    )
    return parser.parse_args()


def iter_pdfs(paths: list[str], recursive: bool) -> list[Path]:
    discovered = []
    for raw in paths:
        path = Path(raw).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"Path does not exist: {path}")
        if path.is_file():
            if path.suffix.lower() == ".pdf":
                discovered.append(path)
            continue
        iterator = path.rglob("*") if recursive else path.iterdir()
        discovered.extend(sorted(item for item in iterator if item.is_file() and item.suffix.lower() == ".pdf"))

    unique = []
    seen = set()
    for path in discovered:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    return unique


def converter_runner(name: str):
    if name == "docling":
        return run_docling_package
    if name == "docling-service":
        return run_docling_service
    if name == "marker":
        return run_marker
    if name == "mineru":
        return run_mineru
    raise ValueError(f"Unsupported converter: {name}")


def render_report(results: list[RunResult], output_dir: Path) -> str:
    grouped = {}
    for result in results:
        grouped.setdefault(result.source_pdf, []).append(result)

    lines = [
        "# PDF Converter Bakeoff",
        "",
        f"Artifacts directory: `{output_dir}`",
        "",
    ]

    for source_pdf in sorted(grouped):
        pdf_path = Path(source_pdf)
        lines.append(f"## {pdf_path.name}")
        lines.append("")
        lines.append("| Converter | Status | Seconds | Chars | Lines | Headings | Tables | Markdown |")
        lines.append("| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |")
        for result in sorted(grouped[source_pdf], key=lambda item: item.converter):
            markdown_link = f"`{result.markdown_path}`" if result.markdown_path else "n/a"
            status = "ok" if result.ok else f"failed: {result.error}"
            lines.append(
                "| "
                f"{result.converter} | {status} | {result.duration_sec:.2f} | "
                f"{result.stats.get('chars', 0)} | {result.stats.get('lines', 0)} | "
                f"{result.stats.get('heading_lines', 0)} | {result.stats.get('table_lines', 0)} | "
                f"{markdown_link} |"
            )
        lines.append("")

        similarities = pairwise_similarity(grouped[source_pdf])
        if similarities:
            lines.append("Pairwise similarity:")
            for similarity in similarities:
                lines.append(
                    f"- `{similarity['left']}` vs `{similarity['right']}`: {similarity['ratio']:.4f}"
                )
            lines.append("")

        for result in sorted(grouped[source_pdf], key=lambda item: item.converter):
            if not result.ok or not result.markdown_path:
                continue
            snippet = preview(read_text(Path(result.markdown_path)))
            lines.append(f"### {result.converter} Preview")
            lines.append("")
            lines.append("```md")
            lines.append(snippet or "<empty>")
            lines.append("```")
            lines.append("")

    return "\n".join(lines).strip() + "\n"


def main():
    args = parse_args()
    try:
        pdfs = iter_pdfs(args.paths, args.recursive)
    except FileNotFoundError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if args.limit is not None:
        pdfs = pdfs[: args.limit]

    if not pdfs:
        print("Error: no PDF files found.", file=sys.stderr)
        return 1

    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    results = []
    for pdf_path in pdfs:
        pdf_output_dir = output_dir / slugify(pdf_path.stem)
        pdf_output_dir.mkdir(parents=True, exist_ok=True)
        print(f"\n== {pdf_path}")
        for converter in args.converters:
            converter_output_dir = pdf_output_dir / converter
            converter_output_dir.mkdir(parents=True, exist_ok=True)
            print(f"converter={converter}")
            runner = converter_runner(converter)
            if converter == "docling":
                result = runner(pdf_path, converter_output_dir, args.timeout)
            elif converter == "docling-service":
                result = runner(pdf_path, converter_output_dir, args.chunker, args.docling_url)
            else:
                result = runner(pdf_path, converter_output_dir, args.timeout)
            print(f"status={'ok' if result.ok else 'failed'}")
            if result.error:
                print(f"error={result.error}")
            results.append(result)

    report_path = output_dir / "converter-bakeoff-report.md"
    json_path = output_dir / "converter-bakeoff-results.json"
    report = render_report(results, output_dir)
    write_text(report_path, report)
    write_text(json_path, json.dumps([result.__dict__ for result in results], indent=2, sort_keys=True))

    print("\n== Result ==")
    print(f"pdfs={len(pdfs)}")
    print(f"converters={','.join(args.converters)}")
    print(f"report={report_path}")
    print(f"results_json={json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
