"""Payload-equivalence tests for the Capture-client adapters (PRD docs/34, module 4 Stage 2).

The GOLDEN_JSON below was machine-captured from the ORIGINAL hand-rolled payload
builders (before they were rewired onto recipes/shared_capture.py), on the
representative inputs reconstructed in each test. Each test calls the builder by
name and asserts it still produces the byte-identical payload. Run before the
refactor these pass against the old builders; run after, they prove the
client-based adapters are field-for-field equivalent — the Python analog of the
function-diff used on modules 2 and 3.

Deliberate inequalities (NOT payload-shape; behavior at the HTTP layer only):
  * the four pipelines' capture POSTs now share one retry policy
    (2 retries on 5xx/connection-error; ratified) and timeout (300s; was 240
    for document import) — not observable in the payload, so not asserted here.
  * shared_docling's ingest_thought error message and direct resp.json() are
    replaced by the client's CaptureError / wrapped-body behavior — message
    wording only; not a payload field.

Fully offline: no network, no Telegram/LLM/MinIO.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from datetime import datetime, timezone
from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def load_module(module_name: str, relative_path: str):
    module_path = REPO_ROOT / relative_path
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


def install_fake_yaml_module():
    fake_yaml = types.ModuleType("yaml")
    fake_yaml.safe_load = lambda text: json.loads(text)
    sys.modules.setdefault("yaml", fake_yaml)


GOLDEN = json.loads(r"""
{
  "tg_source": {
    "content": "Remember to buy milk",
    "metadata": {
      "source": "telegram", "type": "telegram_message", "retrieval_role": "source",
      "summary": "Remember to buy milk", "topics": ["telegram", "capture"],
      "telegram_update_id": 7, "telegram_chat_id": "555", "telegram_chat_type": "private",
      "telegram_message_id": 42, "telegram_user_id": 99, "telegram_username": "alice",
      "telegram_message_date": "2023-11-14T22:13:20+00:00", "telegram_media_type": "text",
      "full_text": "Remember to buy milk"
    },
    "source": "telegram", "type": "telegram_message", "tags": ["telegram", "capture"],
    "occurred_at": "2023-11-14T22:13:20+00:00", "dedupe_key": "telegram:555:42",
    "extract_metadata": false
  },
  "tg_thought": {
    "content": "Buy milk tomorrow",
    "metadata": {
      "source": "telegram", "type": "telegram_thought", "retrieval_role": "distilled",
      "summary": "Buy milk tomorrow", "topics": ["telegram"],
      "telegram_chat_id": "555", "telegram_message_id": 42, "telegram_user_id": 99,
      "telegram_username": "alice", "source_dedupe_key": "telegram:555:42"
    },
    "source": "telegram", "type": "telegram_thought", "tags": ["telegram"],
    "occurred_at": "2023-11-14T22:13:20+00:00", "dedupe_key": "telegram:555:42:thought:0",
    "extract_metadata": true
  },
  "di_source": {
    "content": "the body",
    "metadata": {
      "source": "dictation", "type": "dictation_note", "retrieval_role": "source",
      "summary": "Voice note", "topics": ["dictation", "capture"],
      "artifact_id": "art-1", "audio_sha256": "aud-1", "audio_filename": "a.wav",
      "cleanup_mode": "clean", "dictation_storage_backend": "minio",
      "dictation_object_key": "k", "dictation_bucket": "b", "full_text": "the body",
      "title": "Voice note", "created_at": "2026-01-01"
    },
    "source": "dictation", "type": "dictation_note", "tags": ["dictation", "capture"],
    "occurred_at": "2026-01-01", "dedupe_key": "dictation:aud-1", "extract_metadata": false
  },
  "di_thought": {
    "content": "a distilled thought",
    "metadata": {
      "source": "dictation", "type": "dictation_thought", "retrieval_role": "distilled",
      "summary": "a distilled thought", "topics": ["dictation"],
      "artifact_id": "art-1", "audio_sha256": "aud-1", "source_dedupe_key": "dictation:aud-1",
      "source_created_at": "2026-01-01", "dictation_storage_backend": "minio",
      "dictation_object_key": "k", "dictation_bucket": "b"
    },
    "source": "dictation", "type": "dictation_thought", "tags": ["dictation"],
    "occurred_at": "2026-01-01", "dedupe_key": "dictation:aud-1:thought:0",
    "extract_metadata": false
  },
  "chatgpt_record": {
    "content": "[ChatGPT Export Record: My Chat | 2026-01-02] Canonical raw export record for conversation conv-id-1.",
    "metadata": {
      "source": "chatgpt", "type": "chatgpt_conversation_record", "retrieval_role": "source",
      "summary": "My Chat", "topics": ["chatgpt", "conversation", "record"],
      "source_record_origin": "chatgpt_export_direct", "content_format": "chatgpt_export_json",
      "raw_json_sha256": "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
      "raw_export_json": "{\n  \"a\": 1\n}", "normalized_transcript_available": true,
      "chatgpt_title": "My Chat", "chatgpt_create_time": "2026-01-02",
      "chatgpt_conversation_hash": "hash123", "chatgpt_conversation_id": "conv-id-1",
      "chatgpt_conversation_url": "https://chatgpt.com/c/conv-id-1",
      "chatgpt_message_count": 2, "chatgpt_user_word_count": 1
    },
    "source": "chatgpt", "type": "chatgpt_conversation_record",
    "tags": ["chatgpt", "conversation", "record"], "occurred_at": "2026-01-02",
    "dedupe_key": "chatgpt:conversation_record:hash123", "extract_metadata": false
  },
  "chatgpt_source": {
    "content": "User:\nHello\n---\nAssistant:\nHi",
    "metadata": {
      "source": "chatgpt", "type": "chatgpt_conversation_source", "retrieval_role": "source",
      "summary": "My Chat", "topics": ["chatgpt", "conversation", "source"],
      "source_record_origin": "chatgpt_export_direct", "content_format": "normalized_visible_transcript",
      "full_text": "User:\nHello\n---\nAssistant:\nHi", "user_text": "Hello",
      "source_record_dedupe_key": "chatgpt:conversation_record:hash123",
      "chatgpt_title": "My Chat", "chatgpt_create_time": "2026-01-02",
      "chatgpt_conversation_hash": "hash123", "chatgpt_conversation_id": "conv-id-1",
      "chatgpt_conversation_url": "https://chatgpt.com/c/conv-id-1",
      "chatgpt_message_count": 2, "chatgpt_user_word_count": 1
    },
    "source": "chatgpt", "type": "chatgpt_conversation_source",
    "tags": ["chatgpt", "conversation", "source"], "occurred_at": "2026-01-02",
    "dedupe_key": "chatgpt:conversation_source:hash123", "extract_metadata": false
  },
  "claude_record": {
    "content": "[Claude Export Record: My Chat | 2026-01-02] Canonical raw export record for conversation conv-id-1.",
    "metadata": {
      "source": "claude", "type": "claude_conversation_record", "retrieval_role": "source",
      "summary": "My Chat", "topics": ["claude", "conversation", "record"],
      "source_record_origin": "claude_export_direct", "content_format": "claude_export_json",
      "raw_json_sha256": "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
      "raw_export_json": "{\n  \"a\": 1\n}", "normalized_transcript_available": true,
      "claude_title": "My Chat", "claude_create_time": "2026-01-02",
      "claude_conversation_hash": "hash123", "claude_conversation_id": "conv-id-1",
      "claude_message_count": 2, "claude_user_word_count": 1
    },
    "source": "claude", "type": "claude_conversation_record",
    "tags": ["claude", "conversation", "record"], "occurred_at": "2026-01-02",
    "dedupe_key": "claude:conversation_record:hash123", "extract_metadata": false
  },
  "claude_source": {
    "content": "User:\nHello\n---\nAssistant:\nHi",
    "metadata": {
      "source": "claude", "type": "claude_conversation_source", "retrieval_role": "source",
      "summary": "My Chat", "topics": ["claude", "conversation", "source"],
      "source_record_origin": "claude_export_direct", "content_format": "normalized_visible_transcript",
      "full_text": "User:\nHello\n---\nAssistant:\nHi", "user_text": "Hello",
      "source_record_dedupe_key": "claude:conversation_record:hash123",
      "claude_title": "My Chat", "claude_create_time": "2026-01-02",
      "claude_conversation_hash": "hash123", "claude_conversation_id": "conv-id-1",
      "claude_message_count": 2, "claude_user_word_count": 1
    },
    "source": "claude", "type": "claude_conversation_source",
    "tags": ["claude", "conversation", "source"], "occurred_at": "2026-01-02",
    "dedupe_key": "claude:conversation_source:hash123", "extract_metadata": false
  }
}
""")


def _telegram_message():
    return {
        "chat": {"id": 555, "type": "private"},
        "from": {"id": 99, "username": "alice"},
        "message_id": 42,
        "date": 1700000000,
        "_ob1_update_id": 7,
    }


def _dictation_meta():
    return {
        "title": "Voice note", "artifact_id": "art-1", "audio_sha256": "aud-1",
        "audio_filename": "a.wav", "cleanup_mode": "clean", "created_at": "2026-01-01",
    }


def _dictation_artifact_ref():
    return {"storage_backend": "minio", "object_key": "k", "bucket": "b"}


class TelegramAdapterEquivalence(unittest.TestCase):
    def setUp(self):
        self.tg = load_module("tg_adapter_equiv", "integrations/telegram-capture/telegram_bridge.py")

    def test_source_payload(self):
        self.assertEqual(
            self.tg.build_text_source_payload(_telegram_message(), "Remember to buy milk"),
            GOLDEN["tg_source"],
        )

    def test_thought_payload(self):
        self.assertEqual(
            self.tg.build_text_thought_payload(_telegram_message(), "Buy milk tomorrow", "telegram:555:42", 0),
            GOLDEN["tg_thought"],
        )


class DictationAdapterEquivalence(unittest.TestCase):
    def setUp(self):
        install_fake_yaml_module()
        self.di = load_module("di_adapter_equiv", "recipes/dictation-import/import-dictation.py")

    def test_source_payload(self):
        self.assertEqual(
            self.di.build_source_payload(
                "the body", _dictation_meta(),
                occurred_at="2026-01-01", dedupe_key="dictation:aud-1",
                artifact_ref=_dictation_artifact_ref(),
            ),
            GOLDEN["di_source"],
        )

    def test_thought_payload(self):
        self.assertEqual(
            self.di.build_thought_payload(
                "a distilled thought", _dictation_meta(),
                occurred_at="2026-01-01", source_dedupe_key="dictation:aud-1",
                thought_index=0, artifact_ref=_dictation_artifact_ref(),
            ),
            GOLDEN["di_thought"],
        )


class ChatExportAdapterEquivalence(unittest.TestCase):
    def setUp(self):
        self.chat = load_module("chat_adapter_equiv", "scripts/ingest-chat-export-sources.py")

    def _patch(self, mod_attr_owner, prefix):
        chat = self.chat
        owner = getattr(chat, mod_attr_owner)
        owner.extract_user_text = lambda m: "Hello"
        owner.conversation_title = lambda c: "My Chat"
        owner.conversation_created_at = lambda c: datetime(2026, 1, 2, tzinfo=timezone.utc)
        owner.conversation_hash = lambda c: "hash123"
        owner.conversation_id = lambda c: "conv-id-1"
        owner.count_messages = lambda m: 2
        setattr(chat, f"{prefix}_messages", lambda c: ["m1", "m2"])
        setattr(chat, f"{prefix}_transcript", lambda m: "User:\nHello\n---\nAssistant:\nHi")

    def test_chatgpt_items(self):
        self._patch("CHATGPT", "chatgpt")
        group = self.chat.chatgpt_build_items({"a": 1})
        self.assertEqual(group["items"][0]["payload"], GOLDEN["chatgpt_record"])
        self.assertEqual(group["items"][1]["payload"], GOLDEN["chatgpt_source"])

    def test_claude_items(self):
        self._patch("CLAUDE", "claude")
        group = self.chat.claude_build_items({"a": 1})
        self.assertEqual(group["items"][0]["payload"], GOLDEN["claude_record"])
        self.assertEqual(group["items"][1]["payload"], GOLDEN["claude_source"])


if __name__ == "__main__":
    unittest.main()
