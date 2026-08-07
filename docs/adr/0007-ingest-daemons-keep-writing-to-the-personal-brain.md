---
status: accepted
date: 2026-08-07
---

# Ingest daemons move to scoped keys but keep writing to the personal brain

The telegram, imap and dictation daemons authenticate as global admin today. They move
to scoped, non-admin stored keys as part of the withdrawal (ADR-0004).

None of the ingest clients ever sends a brain selector — `shared_capture.py:32-33`
records it as future work, and `telegram_bridge.py:585-589` and the dictation import
build payloads without one. As legacy admin they land wherever
`resolveDefaultAdminBrain()` points (`auth.mjs:159-172`): the earliest **person**
principal's default brain, i.e. the operator's personal brain. Once they are scoped
keys that fallback no longer applies and the key's `default_brain_id` decides.

Decision: **keep the destination unchanged.** Each ingest key gets
`default_brain_id` = the personal brain and `editor` membership on it. Nothing moves,
existing content stays coherent with new content, and searches behave identically.

## Considered options

- **A dedicated ingest brain** (captures land somewhere separate, reachable through
  membership and fan-out): rejected by the operator despite being the safer shape. It
  would have meant a leaked ingest key reached only ingested content — content whose
  sender already had it. The cost that decided it: "my dictation notes are in my
  brain" becomes "they are in a brain I can reach", new content diverges from the
  ~915 existing imap rows and prior dictation content, and anything assuming one brain
  would notice.

## Consequences

- The role ladder is `viewer` (read) ⊂ `editor` (read+write) ⊂ `owner` (ADR-0002).
  There is **no write-only role**, so each ingest key necessarily gains **read** access
  to the whole personal brain — including the imap key, which processes mail, the most
  attacker-reachable input in the system. Accepted knowingly.
- Two prerequisites, both OB1-side, both currently broken:
  - `provision-ingest-key.sh:121` instructs the operator to set
    `OPEN_BRAIN_INGEST_KEY`, but `telegram_bridge.py:77` and
    `recipes/dictation-import/import-dictation.py:67` read only `MCP_ACCESS_KEY` /
    `OPEN_BRAIN_ACCESS_KEY`. Following the script's own instructions silently fails to
    migrate those two daemons. Both must learn to read `OPEN_BRAIN_INGEST_KEY` first.
  - Each daemon exists as a prod and a dev instance reading the **same** key file while
    talking to different databases (`ob1` vs `ob1_dev`), and
    `provision-ingest-key.sh:85-86` generates its own key with no `--key-hash` input.
    One plaintext value cannot currently be registered in both databases; the flag
    pattern already exists at `agent_estate/provision.sh:145-160`.
