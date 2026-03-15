#!/usr/bin/env python3
"""
Open Brain — IMAP History Importer

Fetches messages from a standard IMAP mailbox, parses each RFC 822 message
locally, and ingests each email into the local OB1 service.
"""

import argparse
import getpass
import hashlib
import imaplib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses, parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path

try:
    import requests
except ImportError:
    print("Missing dependency: requests")
    print("Install with: pip install -r requirements.txt")
    sys.exit(1)


RECIPE_DIR = Path(__file__).resolve().parent
SYNC_LOG_PATH = RECIPE_DIR / "imap-sync-log.json"

LOCAL_INGEST_URL = os.environ.get("OPEN_BRAIN_INGEST_URL") or "http://127.0.0.1:8787/ingest/thought"
LOCAL_INGEST_KEY = os.environ.get("OPEN_BRAIN_INGEST_KEY") or os.environ.get("MCP_ACCESS_KEY", "")
LOCAL_LLM_BASE = os.environ.get("LLM_BASE_URL", "http://10.10.10.101:8035/v1").rstrip("/")
LOCAL_LLM_MODEL = os.environ.get("LLM_MODEL", "mlx-community/Qwen3.5-397B-A17B-nvfp4")
LOCAL_LLM_ENABLE_THINKING = os.environ.get("LLM_ENABLE_THINKING", "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

THOUGHTS_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_thoughts",
        "description": "Return durable thoughts worth storing from this email.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "required": ["thoughts"],
            "properties": {
                "thoughts": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Up to 3 durable standalone thought strings.",
                }
            },
        },
    },
}

EMAIL_THOUGHT_PROMPT = """\
You are turning an email into durable memory items for a personal knowledge base.

Capture only information that will matter later:
- decisions, commitments, requests, deadlines, or next steps
- important attachments or deliverables being sent
- project context, names, systems, or relationships
- facts that the user would want to retrieve later without reopening the email

Skip:
- routine acknowledgements
- pure forwarding boilerplate
- empty logistics with no lasting value
- low-signal transactional notices

Each thought must:
- stand alone without the original email open
- be concrete and specific
- mention people, projects, or artifacts when available
- be 1-3 sentences

Return a JSON object with exactly one key: "thoughts".
The value must be an array of 0-3 real thought strings.
If the email has no durable value, return {"thoughts": []}.
"""


class HtmlToText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in {"br", "hr"}:
            self.parts.append("\n")
        elif tag in {"p", "div", "section", "article", "tr", "li"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"p", "div", "section", "article", "tr", "li"}:
            self.parts.append("\n")

    def handle_data(self, data):
        if data:
            self.parts.append(data)

    def get_text(self):
        text = "".join(self.parts)
        text = text.replace("\xa0", " ")
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def load_sync_log():
    try:
        with open(SYNC_LOG_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"ingested_ids": {}, "last_sync": ""}


def save_sync_log(log):
    with open(SYNC_LOG_PATH, "w") as f:
        json.dump(log, f, indent=2)


def http_post_with_retry(url, headers, body, retries=2, timeout=120):
    for attempt in range(retries + 1):
        try:
            resp = requests.post(url, headers=headers, json=body, timeout=timeout)
            if resp.status_code >= 500 and attempt < retries:
                time.sleep(attempt + 1)
                continue
            return resp
        except requests.RequestException:
            if attempt < retries:
                time.sleep(attempt + 1)
                continue
            raise
    return None


def extract_json_payload(text):
    trimmed = text.strip()
    if trimmed.startswith("```json"):
        trimmed = trimmed[7:].strip()
    elif trimmed.startswith("```"):
        trimmed = trimmed[3:].strip()
    if trimmed.endswith("```"):
        trimmed = trimmed[:-3].strip()

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


def normalize_text(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def strip_html(html):
    parser = HtmlToText()
    parser.feed(html)
    return normalize_text(parser.get_text())


def strip_quoted_reply(text):
    patterns = [
        r"^\s*On .+ wrote:\s*$",
        r"^\s*From:\s+.+$",
        r"^\s*Sent:\s+.+$",
        r"^\s*-----Original Message-----\s*$",
    ]
    lines = text.splitlines()
    kept = []
    for line in lines:
        if any(re.match(pattern, line, flags=re.IGNORECASE) for pattern in patterns):
            break
        if line.lstrip().startswith(">"):
            break
        kept.append(line)
    stripped = "\n".join(kept).strip()
    return stripped or text


def extract_body(message, strip_quotes=False):
    plain_parts = []
    html_parts = []

    for part in message.walk():
        if part.is_multipart():
            continue

        disposition = (part.get_content_disposition() or "").lower()
        if disposition == "attachment":
            continue

        content_type = part.get_content_type()
        payload = part.get_payload(decode=True)
        if payload is None:
            continue

        charset = part.get_content_charset() or "utf-8"
        try:
            text = payload.decode(charset, errors="replace")
        except LookupError:
            text = payload.decode("utf-8", errors="replace")

        if content_type == "text/plain":
            plain_parts.append(text)
        elif content_type == "text/html":
            html_parts.append(text)

    if plain_parts:
        body = normalize_text("\n\n".join(plain_parts))
    elif html_parts:
        body = strip_html("\n\n".join(html_parts))
    else:
        body = ""

    if strip_quotes and body:
        body = strip_quoted_reply(body)

    return body


def header_value(message, name):
    value = message.get(name)
    return str(value).strip() if value else ""


def parse_addresses(header_text):
    if not header_text:
        return []

    results = []
    for name, address in getaddresses([header_text]):
        if not address:
            continue
        entry = {"email": address}
        if name:
            entry["name"] = name
        results.append(entry)
    return results


def iso_date_from_email(message):
    raw_date = header_value(message, "Date")
    if not raw_date:
        return None

    try:
        parsed = parsedate_to_datetime(raw_date)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def build_content(subject, sender, recipients, date_iso, mailbox, flags, body):
    lines = [
        f"Subject: {subject or '(no subject)'}",
        f"From: {sender or '(unknown)'}",
        f"To: {', '.join(recipients) if recipients else '(none)'}",
        f"Date: {date_iso or '(unknown)'}",
        f"Mailbox: {mailbox}",
        f"Flags: {', '.join(flags) if flags else '(none)'}",
        "",
        body or "(empty body)",
    ]
    return "\n".join(lines).strip()


def imap_key(account_hash, mailbox, uidvalidity, uid):
    return f"imap:{account_hash}:{mailbox}:{uidvalidity}:{uid}"


def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def connect_imap(host, port, username, password, use_ssl=True):
    usernames = []
    for candidate in [username, username.split("@", 1)[0] if "@" in username else ""]:
        if candidate and candidate not in usernames:
            usernames.append(candidate)

    last_error = None
    for candidate in usernames:
        try:
            if use_ssl:
                client = imaplib.IMAP4_SSL(host, port)
            else:
                client = imaplib.IMAP4(host, port)
            client.login(candidate, password)
            return client, candidate
        except Exception as exc:
            last_error = exc
            try:
                client.logout()
            except Exception:
                pass

    raise last_error


def imap_response_code(client, code_name):
    response = client.response(code_name)
    if not response or len(response) < 2 or not response[1]:
        return None
    value = response[1][0]
    if isinstance(value, bytes):
        return value.decode()
    return str(value)


def search_criteria(args):
    criteria = ["ALL"]
    if args.since:
        criteria.extend(["SINCE", args.since.strftime("%d-%b-%Y")])
    if args.before:
        criteria.extend(["BEFORE", args.before.strftime("%d-%b-%Y")])
    if args.unseen:
        criteria.append("UNSEEN")
    if args.from_filter:
        criteria.extend(["FROM", args.from_filter])
    if args.subject_filter:
        criteria.extend(["SUBJECT", args.subject_filter])
    if args.text_filter:
        criteria.extend(["TEXT", args.text_filter])
    return criteria


def fetch_uid_list(client, args):
    criteria = search_criteria(args)
    status, data = client.uid("SEARCH", None, *criteria)
    if status != "OK":
        raise RuntimeError(f"IMAP SEARCH failed: {data}")

    raw = data[0].decode().strip() if data and data[0] else ""
    if not raw:
        return []
    uids = raw.split()
    if args.limit:
        uids = uids[-args.limit :]
    return uids


def list_mailboxes(client):
    status, data = client.list()
    if status != "OK":
        raise RuntimeError(f"IMAP LIST failed: {data}")

    mailboxes = []
    for item in data or []:
        if not isinstance(item, bytes):
            continue
        text = item.decode(errors="replace")
        parts = text.rsplit(' "', 1)
        if len(parts) == 2:
            name = parts[1].rstrip('"')
        else:
            name = text
        mailboxes.append(name)
    return mailboxes


def fetch_message_bytes(client, uid):
    status, data = client.uid("FETCH", uid, "(RFC822 FLAGS)")
    if status != "OK" or not data:
        raise RuntimeError(f"IMAP FETCH failed for UID {uid}: {data}")

    message_bytes = None
    flags = []
    for item in data:
        if not item or not isinstance(item, tuple):
            continue
        header, payload = item
        if isinstance(payload, bytes):
            message_bytes = payload
        if isinstance(header, bytes):
            header_text = header.decode(errors="replace")
            match = re.search(r"FLAGS \((.*?)\)", header_text)
            if match:
                flags = [flag for flag in match.group(1).split() if flag]
    if message_bytes is None:
        raise RuntimeError(f"IMAP FETCH returned no RFC822 payload for UID {uid}")
    return message_bytes, flags


def parse_imap_record(uid, raw_bytes, mailbox, flags, uidvalidity, account_hash, strip_quotes=False):
    message = BytesParser(policy=policy.default).parsebytes(raw_bytes)

    sender_addresses = parse_addresses(header_value(message, "From"))
    to_addresses = parse_addresses(header_value(message, "To"))
    cc_addresses = parse_addresses(header_value(message, "Cc"))
    bcc_addresses = parse_addresses(header_value(message, "Bcc"))

    sender_email = sender_addresses[0]["email"] if sender_addresses else ""
    sender_name = sender_addresses[0].get("name", "") if sender_addresses else ""
    recipient_emails = [entry["email"] for entry in to_addresses]
    cc_emails = [entry["email"] for entry in cc_addresses]
    bcc_emails = [entry["email"] for entry in bcc_addresses]

    subject = header_value(message, "Subject")
    rfc822_message_id = header_value(message, "Message-ID")
    in_reply_to = header_value(message, "In-Reply-To")
    references = header_value(message, "References")
    date_iso = iso_date_from_email(message)
    body = extract_body(message, strip_quotes=strip_quotes)
    dedupe_key = imap_key(account_hash, mailbox, uidvalidity or "unknown", uid)

    content = build_content(
        subject=subject,
        sender=sender_email or header_value(message, "From"),
        recipients=recipient_emails,
        date_iso=date_iso,
        mailbox=mailbox,
        flags=flags,
        body=body,
    )

    summary = subject or (normalize_text(body).split("\n", 1)[0] if body else "(no subject)")
    summary = summary[:280]

    metadata = {
        "source": "imap",
        "type": "email",
        "summary": summary,
        "topics": [mailbox, *flags],
        "sender": sender_email or None,
        "sender_name": sender_name or None,
        "recipients": recipient_emails,
        "cc": cc_emails,
        "bcc": bcc_emails,
        "subject": subject or None,
        "date": date_iso,
        "mailbox": mailbox,
        "flags": flags,
        "imap_uid": uid,
        "imap_uidvalidity": uidvalidity,
        "imap_account_hash": account_hash,
        "rfc822_message_id": rfc822_message_id or None,
        "in_reply_to": in_reply_to or None,
        "references": references or None
    }

    return {
        "uid": uid,
        "date_iso": date_iso,
        "content": content,
        "metadata": metadata,
        "subject": subject,
        "dedupe_key": dedupe_key
    }


def ingest_email(record, dry_run=False):
    if dry_run:
        return {"ok": True, "dry_run": True}

    resp = http_post_with_retry(
        LOCAL_INGEST_URL,
        headers={
            "Content-Type": "application/json",
            "x-access-key": LOCAL_INGEST_KEY,
            "x-ingest-key": LOCAL_INGEST_KEY
        },
        body={
            "content": record["content"],
            "metadata": record["metadata"],
            "source": "imap",
            "type": "email",
            "tags": record["metadata"].get("flags", []),
            "occurred_at": record["date_iso"],
            "dedupe_key": record["dedupe_key"],
            "extract_metadata": False
        },
        timeout=240
    )

    if not resp:
        return {"ok": False, "error": "No response from local OB1"}

    try:
        payload = resp.json()
    except json.JSONDecodeError:
        payload = {"raw_response": resp.text[:500]}

    if resp.status_code not in (200, 201):
        return {"ok": False, "status": resp.status_code, "error": payload.get("error") or payload}

    return {"ok": True, "payload": payload}


def distill_email_thoughts(record):
    body_preview = record["content"][:12000]
    resp = http_post_with_retry(
        f"{LOCAL_LLM_BASE}/chat/completions",
        headers={"Content-Type": "application/json"},
        body={
            "model": LOCAL_LLM_MODEL,
            "temperature": 0,
            "max_tokens": 700,
            "chat_template_kwargs": {
                "enable_thinking": LOCAL_LLM_ENABLE_THINKING,
            },
            "tools": [THOUGHTS_TOOL],
            "tool_choice": "required",
            "messages": [
                {"role": "system", "content": EMAIL_THOUGHT_PROMPT},
                {
                    "role": "user",
                    "content": "\n".join([
                        f"Mailbox: {record['metadata'].get('mailbox') or '(unknown)'}",
                        f"Sender: {record['metadata'].get('sender') or '(unknown)'}",
                        f"Subject: {record['subject'] or '(no subject)'}",
                        f"Date: {record['date_iso'] or '(unknown)'}",
                        "",
                        "Email content:",
                        body_preview,
                    ]),
                },
            ],
        },
        timeout=240,
    )

    if not resp or resp.status_code != 200:
        status = resp.status_code if resp else "no response"
        raise RuntimeError(f"Local email distillation failed ({status})")

    result = extract_tool_arguments(resp.json(), "submit_thoughts")
    thoughts = result.get("thoughts", [])
    return [item.strip() for item in thoughts if isinstance(item, str) and item.strip()][:3]


def ingest_email_thought(record, thought_text, index, dry_run=False):
    if dry_run:
        return {"ok": True, "dry_run": True}

    resp = http_post_with_retry(
        LOCAL_INGEST_URL,
        headers={
            "Content-Type": "application/json",
            "x-access-key": LOCAL_INGEST_KEY,
            "x-ingest-key": LOCAL_INGEST_KEY,
        },
        body={
            "content": thought_text,
            "metadata": {
                "source": "imap",
                "type": "email_thought",
                "summary": thought_text[:280],
                "topics": [record["metadata"].get("mailbox", "INBOX")],
                "sender": record["metadata"].get("sender"),
                "subject": record["metadata"].get("subject"),
                "mailbox": record["metadata"].get("mailbox"),
                "imap_uid": record["metadata"].get("imap_uid"),
                "email_dedupe_key": record["dedupe_key"],
                "thought_index": index,
            },
            "source": "imap",
            "type": "email_thought",
            "occurred_at": record["date_iso"],
            "dedupe_key": f"{record['dedupe_key']}:thought:{index}",
            "extract_metadata": False,
        },
        timeout=240,
    )

    if not resp:
        return {"ok": False, "error": "No response from local OB1"}

    try:
        payload = resp.json()
    except json.JSONDecodeError:
        payload = {"raw_response": resp.text[:500]}

    if resp.status_code not in (200, 201):
        return {"ok": False, "status": resp.status_code, "error": payload.get("error") or payload}

    return {"ok": True, "payload": payload}


def parse_date_arg(value):
    return datetime.strptime(value, "%Y-%m-%d").date()


def should_skip(record, sync_log, args):
    if not args.ignore_sync_log and record["dedupe_key"] in sync_log["ingested_ids"]:
        return "already_imported"

    if args.since and record["date_iso"]:
        record_date = datetime.fromisoformat(record["date_iso"]).date()
        if record_date < args.since:
            return "before_date_filter"

    if args.before and record["date_iso"]:
        record_date = datetime.fromisoformat(record["date_iso"]).date()
        if record_date >= args.before:
            return "after_date_filter"

    if args.skip_empty and record["content"].endswith("(empty body)"):
        return "empty_body"

    return None


def parse_args():
    parser = argparse.ArgumentParser(description="Import an IMAP mailbox into local OB1.")
    parser.add_argument("--host", default=os.environ.get("IMAP_HOST"), help="IMAP server host.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("IMAP_PORT", "993")), help="IMAP server port.")
    parser.add_argument("--username", default=os.environ.get("IMAP_USERNAME"), help="IMAP username.")
    parser.add_argument("--password", default=os.environ.get("IMAP_PASSWORD"), help="IMAP password. If omitted, prompt securely.")
    parser.add_argument("--mailbox", default=os.environ.get("IMAP_MAILBOX", "INBOX"), help="Mailbox to import.")
    parser.add_argument("--no-ssl", action="store_true", help="Use plain IMAP instead of IMAPS.")
    parser.add_argument("--list-mailboxes", action="store_true", help="List available mailboxes and exit.")
    parser.add_argument("--since", type=parse_date_arg, help="Only keep messages on or after YYYY-MM-DD.")
    parser.add_argument("--before", type=parse_date_arg, help="Only keep messages before YYYY-MM-DD.")
    parser.add_argument("--from", dest="from_filter", help="IMAP FROM search filter.")
    parser.add_argument("--subject", dest="subject_filter", help="IMAP SUBJECT search filter.")
    parser.add_argument("--text", dest="text_filter", help="IMAP TEXT search filter.")
    parser.add_argument("--unseen", action="store_true", help="Only search unseen messages.")
    parser.add_argument("--limit", type=int, help="Maximum number of messages to process.")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and parse, but do not ingest.")
    parser.add_argument("--strip-quotes", action="store_true", help="Trim quoted reply sections from message bodies.")
    parser.add_argument("--ignore-sync-log", action="store_true", help="Process messages even if they appear in imap-sync-log.json.")
    parser.add_argument("--skip-empty", action="store_true", help="Skip messages with no extracted body text.")
    parser.add_argument("--no-distill", action="store_true", help="Store raw email records only, without durable thought extraction.")
    parser.add_argument("--verbose", action="store_true", help="Print sender and subject for each imported message.")
    return parser.parse_args()


def main():
    args = parse_args()

    if not args.host:
        print("Error: IMAP host is required. Use --host or IMAP_HOST.", file=sys.stderr)
        return 1
    if not args.username:
        print("Error: IMAP username is required. Use --username or IMAP_USERNAME.", file=sys.stderr)
        return 1
    if not args.password:
        args.password = getpass.getpass("IMAP password: ")
    if not args.dry_run and not args.list_mailboxes and not LOCAL_INGEST_KEY:
        print("Error: OPEN_BRAIN_INGEST_KEY or MCP_ACCESS_KEY is required for live ingest.", file=sys.stderr)
        return 1

    sync_log = load_sync_log()
    account_hash = sha256_text(f"{args.host}|{args.username}")[:16]

    print(f"host={args.host}")
    print(f"port={args.port}")
    print(f"mailbox={args.mailbox}")
    print(f"ingest_url={LOCAL_INGEST_URL}")
    print(f"dry_run={args.dry_run}")

    processed = 0
    imported = 0
    distilled = 0
    skipped = {}
    failures = 0

    try:
        client, effective_username = connect_imap(args.host, args.port, args.username, args.password, use_ssl=not args.no_ssl)
        try:
            print(f"effective_username={effective_username}")

            if args.list_mailboxes:
                for mailbox in list_mailboxes(client):
                    print(mailbox)
                return 0

            status, _ = client.select(args.mailbox, readonly=True)
            if status != "OK":
                raise RuntimeError(f"Failed to select mailbox {args.mailbox}")

            uidvalidity = imap_response_code(client, "UIDVALIDITY")
            uids = fetch_uid_list(client, args)

            for uid in uids:
                processed += 1
                try:
                    raw_bytes, flags = fetch_message_bytes(client, uid)
                    record = parse_imap_record(
                        uid=uid,
                        raw_bytes=raw_bytes,
                        mailbox=args.mailbox,
                        flags=flags,
                        uidvalidity=uidvalidity,
                        account_hash=account_hash,
                        strip_quotes=args.strip_quotes
                    )
                except Exception as exc:
                    failures += 1
                    print(f"ERROR UID {uid}: failed to parse message: {exc}", file=sys.stderr)
                    continue

                reason = should_skip(record, sync_log, args)
                if reason:
                    skipped[reason] = skipped.get(reason, 0) + 1
                    continue

                if args.verbose:
                    sender = record["metadata"].get("sender") or "(unknown)"
                    subject = record["subject"] or "(no subject)"
                    print(f"- UID {uid} | {sender} | {subject}")

                result = ingest_email(record, dry_run=args.dry_run)
                if not result["ok"]:
                    failures += 1
                    print(f"ERROR UID {uid}: {result.get('error')}", file=sys.stderr)
                    continue

                if args.dry_run:
                    if not args.no_distill:
                        try:
                            thoughts = distill_email_thoughts(record)
                            print(f"  distilled_thoughts={len(thoughts)}")
                            if args.verbose:
                                for index, thought in enumerate(thoughts):
                                    print(f"    thought[{index}] {thought}")
                        except Exception as exc:
                            failures += 1
                            print(f"ERROR UID {uid}: distillation failed: {exc}", file=sys.stderr)
                    continue

                imported += 1
                sync_log["ingested_ids"][record["dedupe_key"]] = record["date_iso"] or ""

                if args.no_distill:
                    continue

                try:
                    thoughts = distill_email_thoughts(record)
                except Exception as exc:
                    failures += 1
                    print(f"ERROR UID {uid}: distillation failed: {exc}", file=sys.stderr)
                    continue

                if args.verbose:
                    print(f"  distilled_thoughts={len(thoughts)}")
                    for index, thought in enumerate(thoughts):
                        print(f"    thought[{index}] {thought}")

                for index, thought in enumerate(thoughts):
                    result = ingest_email_thought(record, thought, index, dry_run=False)
                    if not result["ok"]:
                        failures += 1
                        print(f"ERROR UID {uid}: thought ingest failed: {result.get('error')}", file=sys.stderr)
                        continue
                    distilled += 1
        finally:
            try:
                client.logout()
            except Exception:
                pass
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if not args.dry_run:
        sync_log["last_sync"] = datetime.now(tz=timezone.utc).isoformat()
        save_sync_log(sync_log)

    print("\n== Result ==")
    print(f"processed={processed}")
    print(f"imported={imported}")
    print(f"distilled={distilled}")
    print(f"failures={failures}")
    for key in sorted(skipped):
        print(f"skipped_{key}={skipped[key]}")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
