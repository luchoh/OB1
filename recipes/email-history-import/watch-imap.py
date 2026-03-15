#!/usr/bin/env python3
"""
Open Brain — IMAP Auto-Ingest Watcher

Runs the existing IMAP importer in a polling loop so new mail sent to the
mailbox is processed automatically without manual commands.
"""

import argparse
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


RECIPE_DIR = Path(__file__).resolve().parent
IMPORT_SCRIPT = RECIPE_DIR / "import-imap.py"


def timestamp():
    return datetime.now(tz=timezone.utc).isoformat()


def parse_args():
    parser = argparse.ArgumentParser(description="Poll an IMAP mailbox and auto-import new mail into local OB1.")
    parser.add_argument("--host", default=os.environ.get("IMAP_HOST"), help="IMAP server host.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("IMAP_PORT", "993")), help="IMAP server port.")
    parser.add_argument(
        "--username",
        default=os.environ.get("IMAP_USERNAME") or os.environ.get("IMAP_ACCOUNT"),
        help="IMAP username.",
    )
    parser.add_argument("--mailbox", default=os.environ.get("IMAP_MAILBOX", "INBOX"), help="Mailbox to watch.")
    parser.add_argument(
        "--poll-interval",
        type=int,
        default=int(os.environ.get("IMAP_POLL_INTERVAL_SECONDS", "60")),
        help="Seconds to wait between successful import cycles.",
    )
    parser.add_argument(
        "--error-backoff",
        type=int,
        default=int(os.environ.get("IMAP_ERROR_BACKOFF_SECONDS", "300")),
        help="Seconds to wait before retrying after a failed cycle.",
    )
    parser.add_argument("--once", action="store_true", help="Run a single import cycle and exit.")
    parser.add_argument("--no-ssl", action="store_true", help="Use plain IMAP instead of IMAPS.")
    parser.add_argument("--strip-quotes", action="store_true", help="Trim quoted reply sections from message bodies.")
    parser.add_argument("--skip-empty", action="store_true", help="Skip messages with no extracted body text.")
    parser.add_argument("--no-distill", action="store_true", help="Store raw email records only, without durable thought extraction.")
    parser.add_argument("--no-attachments", action="store_true", help="Skip attachment parsing and Docling-backed attachment ingest.")
    parser.add_argument("--no-attachment-summaries", action="store_true", help="Skip whole-document summary extraction for attachments.")
    parser.add_argument(
        "--attachment-chunker",
        choices=("hierarchical", "hybrid"),
        default=os.environ.get("IMAP_ATTACHMENT_CHUNKER", "hierarchical"),
        help="Docling chunker to use for attachments.",
    )
    parser.add_argument("--ignore-sync-log", action="store_true", help="Reprocess mail even if it appears in imap-sync-log.json.")
    parser.add_argument("--verbose", action="store_true", help="Print per-message and per-attachment progress.")
    return parser.parse_args()


def build_import_command(args):
    command = [
        sys.executable,
        "-u",
        str(IMPORT_SCRIPT),
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--username",
        args.username,
        "--mailbox",
        args.mailbox,
        "--attachment-chunker",
        args.attachment_chunker,
    ]

    for enabled, flag in (
        (args.no_ssl, "--no-ssl"),
        (args.strip_quotes, "--strip-quotes"),
        (args.skip_empty, "--skip-empty"),
        (args.no_distill, "--no-distill"),
        (args.no_attachments, "--no-attachments"),
        (args.no_attachment_summaries, "--no-attachment-summaries"),
        (args.ignore_sync_log, "--ignore-sync-log"),
        (args.verbose, "--verbose"),
    ):
        if enabled:
            command.append(flag)

    return command


def main():
    args = parse_args()

    if not args.host:
        print("Error: IMAP host is required. Use --host or IMAP_HOST.", file=sys.stderr)
        return 1
    if not args.username:
        print("Error: IMAP username is required. Use --username or IMAP_USERNAME.", file=sys.stderr)
        return 1
    if args.poll_interval < 1:
        print("Error: --poll-interval must be >= 1.", file=sys.stderr)
        return 1
    if args.error_backoff < 1:
        print("Error: --error-backoff must be >= 1.", file=sys.stderr)
        return 1

    command = build_import_command(args)

    print(f"watch_started_at={timestamp()}", flush=True)
    print(f"mailbox={args.mailbox}", flush=True)
    print(f"poll_interval_seconds={args.poll_interval}", flush=True)
    print(f"error_backoff_seconds={args.error_backoff}", flush=True)
    print(f"import_command={' '.join(command)}", flush=True)

    cycle = 0
    while True:
        cycle += 1
        started = time.time()
        print(f"[{timestamp()}] cycle={cycle} starting", flush=True)
        completed = subprocess.run(command, cwd=str(RECIPE_DIR), env=os.environ.copy())
        elapsed = round(time.time() - started, 2)
        print(f"[{timestamp()}] cycle={cycle} exit_code={completed.returncode} elapsed_seconds={elapsed}", flush=True)

        if args.once:
            return completed.returncode

        sleep_seconds = args.poll_interval if completed.returncode == 0 else args.error_backoff
        print(f"[{timestamp()}] cycle={cycle} sleeping_seconds={sleep_seconds}", flush=True)
        time.sleep(sleep_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
