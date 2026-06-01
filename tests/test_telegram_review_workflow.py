from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from recipes import shared_telegram_review_state as review_state


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


class TelegramReviewWorkflowTests(unittest.TestCase):
    def test_build_review_session_uses_suggested_decisions(self):
        source_payload = {"content": "raw source", "dedupe_key": "telegram:1:2"}
        thought_payloads = [
            {"content": "Thought A", "metadata": {"summary": "Thought A"}},
            {"content": "Thought B", "metadata": {"summary": "Thought B"}},
            {"content": "Thought C", "metadata": {"summary": "Thought C"}},
        ]
        session = review_state.build_review_session(
            origin="telegram_text",
            kind="review",
            chat_id="123",
            message_id=456,
            source_payload=source_payload,
            thought_payloads=thought_payloads,
            suggested_decisions={
                "Thought A": "record",
                "Thought B": "duplicate",
                "Thought C": "uncertain",
            },
        )
        statuses = [item["status"] for item in session["thoughts"]]
        self.assertEqual(
            statuses,
            [
                review_state.THOUGHT_STATUS_APPROVED,
                review_state.THOUGHT_STATUS_DENIED,
                review_state.THOUGHT_STATUS_PENDING,
            ],
        )

    def test_render_review_text_shows_closest_existing_memories(self):
        session = review_state.build_review_session(
            origin="telegram_dictation",
            kind="review",
            chat_id="123",
            message_id=456,
            source_payload={"content": "raw source", "dedupe_key": "dictation:1"},
            thought_payloads=[{"content": "Reality is the training context for humans.", "metadata": {"summary": "Reality is the training context for humans."}}],
            suggested_decisions={"Reality is the training context for humans.": "duplicate"},
            similar_matches={
                "Reality is the training context for humans.": [
                    {
                        "summary": "Humans can be conceptualized as neural networks currently in training.",
                        "similarity": 0.8419,
                        "source": "dictation",
                        "type": "dictation_thought",
                    }
                ]
            },
            prompt_text="This voice transcript looks like it may already be recorded. Record it anyway or ignore it?",
        )

        rendered = review_state.render_review_text(session)
        self.assertIn("Closest existing memories:", rendered)
        self.assertIn("similarity=0.84", rendered)
        self.assertIn("Humans can be conceptualized as neural networks currently in training.", rendered)

    def test_parse_callback_data(self):
        parsed = review_state.parse_callback_data("ob1:approve:0123456789abcdef:2")
        self.assertEqual(
            parsed,
            {"action": "approve", "token": "0123456789abcdef", "index": 2},
        )
        self.assertEqual(
            review_state.parse_callback_data("ob1:commit:0123456789abcdef"),
            {"action": "commit", "token": "0123456789abcdef", "index": None},
        )
        self.assertIsNone(review_state.parse_callback_data("ob1:approve:not-a-token:2"))

    def test_edit_reply_requires_matching_prompt_message(self):
        session = review_state.build_review_session(
            origin="telegram_text",
            kind="review",
            chat_id="123",
            message_id=456,
            source_payload={"content": "raw source", "dedupe_key": "telegram:1:2"},
            thought_payloads=[{"content": "Original thought", "metadata": {"summary": "Original thought"}}],
        )
        payload = review_state.review_state_payload_default()
        token = "0123456789abcdef"
        payload["pending_actions"][token] = session
        review_state.start_edit_prompt(payload, token, 0, 999)

        found_token, found_session = review_state.find_edit_session(payload, "123", 999)
        self.assertEqual(found_token, token)
        self.assertIs(found_session, session)
        self.assertEqual(review_state.find_edit_session(payload, "123", 111), (None, None))

        self.assertTrue(review_state.apply_edit_reply(session, "Edited thought"))
        self.assertEqual(session["thoughts"][0]["content"], "Edited thought")
        self.assertEqual(session["thoughts"][0]["status"], review_state.THOUGHT_STATUS_EDITED)

    def test_prune_pending_actions_records_dictation_expiry(self):
        session = review_state.build_review_session(
            origin="telegram_dictation",
            kind="review",
            chat_id="123",
            message_id=456,
            source_payload={"content": "raw source", "dedupe_key": "dictation:abc"},
            thought_payloads=[{"content": "Thought", "metadata": {"summary": "Thought"}}],
            dictation_sync={"dedupe_key": "dictation:abc", "ref_key": "minio:key"},
        )
        session["created_at"] = "2000-01-01T00:00:00+00:00"
        payload = review_state.review_state_payload_default()
        token = "fedcba9876543210"
        payload["pending_actions"][token] = session

        expired = review_state.prune_pending_actions(payload, 1)
        self.assertEqual(len(expired), 1)
        self.assertNotIn(token, payload["pending_actions"])
        self.assertEqual(
            payload["resolved_actions"][token]["status"],
            review_state.DICTATION_RESOLUTION_EXPIRED,
        )

    def test_bridge_process_edit_reply_message_uses_reply_to_prompt(self):
        bridge = load_module("telegram_bridge_test", "integrations/telegram-capture/telegram_bridge.py")
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "review-state.json"
            session = review_state.build_review_session(
                origin="telegram_text",
                kind="review",
                chat_id="123",
                message_id=456,
                source_payload={"content": "raw source", "dedupe_key": "telegram:123:456"},
                thought_payloads=[{"content": "Original thought", "metadata": {"summary": "Original thought"}}],
            )
            with review_state.locked_review_state(state_path) as payload:
                payload["pending_actions"]["0123456789abcdef"] = session
                review_state.start_edit_prompt(payload, "0123456789abcdef", 0, 777)

            args = SimpleNamespace(
                review_state_file=state_path,
                pending_action_ttl_seconds=86400,
                telegram_token="",
                dry_run=True,
            )
            handled = bridge.process_edit_reply_message(
                args,
                {
                    "chat": {"id": 123, "type": "private"},
                    "message_id": 900,
                    "text": "Edited from reply",
                    "reply_to_message": {"message_id": 777},
                },
            )
            self.assertEqual(handled["decision"], "edited")
            with review_state.locked_review_state(state_path) as payload:
                updated = payload["pending_actions"]["0123456789abcdef"]
                self.assertEqual(updated["thoughts"][0]["content"], "Edited from reply")
                self.assertEqual(updated["thoughts"][0]["status"], review_state.THOUGHT_STATUS_EDITED)

            not_an_edit = bridge.process_edit_reply_message(
                args,
                {
                    "chat": {"id": 123, "type": "private"},
                    "message_id": 901,
                    "text": "This should be a new capture",
                },
            )
            self.assertIsNone(not_an_edit)

    def test_callback_approve_all_persists_when_review_message_refresh_fails(self):
        bridge = load_module("telegram_bridge_approve_all_test", "integrations/telegram-capture/telegram_bridge.py")
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "review-state.json"
            token = "0123456789abcdef"
            session = review_state.build_review_session(
                origin="telegram_text",
                kind="review",
                chat_id="123",
                message_id=456,
                source_payload={"content": "raw source", "dedupe_key": "telegram:123:456"},
                thought_payloads=[
                    {"content": "First thought", "metadata": {"summary": "First thought"}},
                    {"content": "Second thought", "metadata": {"summary": "Second thought"}},
                ],
            )
            session["review_message_id"] = 999
            with review_state.locked_review_state(state_path) as payload:
                payload["pending_actions"][token] = session

            bridge.edit_message = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("Telegram edit failed"))
            bridge.answer_callback_query = lambda *args, **kwargs: None

            args = SimpleNamespace(
                review_state_file=state_path,
                pending_action_ttl_seconds=86400,
                telegram_token="telegram-token",
                dry_run=False,
                allowed_chat_ids=set(),
            )
            result = bridge.process_callback_query(
                args,
                {},
                {
                    "id": "callback-id",
                    "data": f"ob1:approve_all:{token}",
                    "from": {"id": 123},
                    "message": {"chat": {"id": 123}, "message_id": 999},
                },
            )

            self.assertEqual(result["decision"], "approved_all")
            with review_state.locked_review_state(state_path) as payload:
                thoughts = payload["pending_actions"][token]["thoughts"]
            self.assertEqual(
                [thought["status"] for thought in thoughts],
                [review_state.THOUGHT_STATUS_APPROVED, review_state.THOUGHT_STATUS_APPROVED],
            )

    def test_callback_commit_persists_when_telegram_ui_calls_fail(self):
        bridge = load_module("telegram_bridge_commit_test", "integrations/telegram-capture/telegram_bridge.py")
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "review-state.json"
            token = "fedcba9876543210"
            source_payload = {"content": "raw source", "dedupe_key": "dictation:abc"}
            thought_payload = {
                "content": "Approved thought",
                "metadata": {"summary": "Approved thought"},
                "dedupe_key": "dictation:abc:thought:0",
            }
            session = review_state.build_review_session(
                origin="telegram_dictation",
                kind="review",
                chat_id="123",
                message_id=456,
                source_payload=source_payload,
                thought_payloads=[thought_payload],
                suggested_decisions={"Approved thought": "record"},
                dictation_sync={"dedupe_key": "dictation:abc", "ref_key": "minio:canonical/item.md"},
            )
            session["review_message_id"] = 999
            with review_state.locked_review_state(state_path) as payload:
                payload["pending_actions"][token] = session

            ingested = []
            bridge.ingest_text_capture = lambda args, source, thoughts: ingested.append(
                {"source": source, "thoughts": thoughts}
            )
            bridge.answer_callback_query = lambda *args, **kwargs: (_ for _ in ()).throw(
                RuntimeError("Telegram answer failed")
            )
            bridge.edit_message = lambda *args, **kwargs: (_ for _ in ()).throw(
                RuntimeError("Telegram edit failed")
            )

            args = SimpleNamespace(
                review_state_file=state_path,
                pending_action_ttl_seconds=86400,
                telegram_token="telegram-token",
                dry_run=False,
                allowed_chat_ids=set(),
            )
            result = bridge.process_callback_query(
                args,
                {},
                {
                    "id": "callback-id",
                    "data": f"ob1:commit:{token}",
                    "from": {"id": 123},
                    "message": {"chat": {"id": 123}, "message_id": 999},
                },
            )

            self.assertEqual(result["decision"], "commit")
            self.assertEqual(len(ingested), 1)
            self.assertEqual(ingested[0]["source"], source_payload)
            self.assertEqual(ingested[0]["thoughts"][0]["dedupe_key"], "dictation:abc:thought:0")
            with review_state.locked_review_state(state_path) as payload:
                self.assertNotIn(token, payload["pending_actions"])
                self.assertEqual(payload["resolved_actions"][token]["status"], review_state.DICTATION_RESOLUTION_INGESTED)

    def test_dictation_reconciliation_updates_review_pending_entries(self):
        install_fake_yaml_module()
        importer = load_module("dictation_import_test", "recipes/dictation-import/import-dictation.py")

        with tempfile.TemporaryDirectory() as tmpdir:
            review_state_path = Path(tmpdir) / "telegram-review-state.json"
            token = "0011223344556677"
            payload = review_state.review_state_payload_default()
            payload["resolved_actions"][token] = {
                "resolved_at": "2026-03-25T00:00:00+00:00",
                "status": review_state.DICTATION_RESOLUTION_IGNORED,
                "dictation_sync": {
                    "dedupe_key": "dictation:abc",
                    "ref_key": "minio:canonical/item.md",
                },
            }
            review_state_path.write_text(json.dumps(payload), encoding="utf-8")

            log = {
                "schema_version": 1,
                "processed": {
                    "dictation:abc": {"status": "review_pending", "action_token": token},
                    "minio:canonical/item.md": {"status": "review_pending", "action_token": token},
                },
            }
            args = SimpleNamespace(
                dry_run=False,
                telegram_review_state_file=review_state_path,
                telegram_pending_action_ttl_seconds=86400,
            )
            reconciled = importer.reconcile_telegram_review_resolutions(args, log)
            self.assertEqual(reconciled, 1)
            self.assertEqual(log["processed"]["dictation:abc"]["status"], review_state.DICTATION_RESOLUTION_IGNORED)
            self.assertEqual(
                log["processed"]["minio:canonical/item.md"]["status"],
                review_state.DICTATION_RESOLUTION_IGNORED,
            )
            persisted = json.loads(review_state_path.read_text(encoding="utf-8"))
            self.assertEqual(persisted["resolved_actions"], {})

    def test_dictation_reconciliation_updates_review_pending_entries_to_ingested(self):
        install_fake_yaml_module()
        importer = load_module("dictation_import_test_record", "recipes/dictation-import/import-dictation.py")

        with tempfile.TemporaryDirectory() as tmpdir:
            review_state_path = Path(tmpdir) / "telegram-review-state.json"
            token = "0011223344556677"
            payload = review_state.review_state_payload_default()
            payload["resolved_actions"][token] = {
                "resolved_at": "2026-03-26T00:00:00+00:00",
                "status": review_state.DICTATION_RESOLUTION_INGESTED,
                "dictation_sync": {
                    "dedupe_key": "dictation:def",
                    "ref_key": "minio:canonical/other-item.md",
                },
            }
            review_state_path.write_text(json.dumps(payload), encoding="utf-8")

            log = {
                "schema_version": 1,
                "processed": {
                    "dictation:def": {"status": "review_pending", "action_token": token},
                    "minio:canonical/other-item.md": {"status": "review_pending", "action_token": token},
                },
            }
            args = SimpleNamespace(
                dry_run=False,
                telegram_review_state_file=review_state_path,
                telegram_pending_action_ttl_seconds=86400,
            )
            reconciled = importer.reconcile_telegram_review_resolutions(args, log)
            self.assertEqual(reconciled, 1)
            self.assertEqual(log["processed"]["dictation:def"]["status"], review_state.DICTATION_RESOLUTION_INGESTED)
            self.assertEqual(
                log["processed"]["minio:canonical/other-item.md"]["status"],
                review_state.DICTATION_RESOLUTION_INGESTED,
            )
            persisted = json.loads(review_state_path.read_text(encoding="utf-8"))
            self.assertEqual(persisted["resolved_actions"], {})

    def test_dictation_import_ingests_source_row_when_thought_extraction_fails(self):
        install_fake_yaml_module()
        importer = load_module("dictation_import_source_only", "recipes/dictation-import/import-dictation.py")

        ingested_payloads = []
        status_messages = []

        importer.summarize_dictation = lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("Model did not return a tool call"))
        importer.ingest_row = lambda base_url, access_key, payload: ingested_payloads.append(payload)
        importer.send_reply = lambda token, chat_id, reply_to_message_id, text: status_messages.append(
            {
                "token": token,
                "chat_id": chat_id,
                "reply_to_message_id": reply_to_message_id,
                "text": text,
            }
        )
        importer.register_telegram_review = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("review should not be requested"))

        args = SimpleNamespace(
            dry_run=False,
            base_url="http://127.0.0.1:8788",
            access_key="test-key",
            llm_model="DeepSeek-V4-Flash-nvfp4",
            telegram_bot_token="telegram-token",
            telegram_review_match_threshold=0.78,
            telegram_review_match_count=3,
            telegram_review_mode=review_state.REVIEW_MODE_FULL,
        )
        log = {"schema_version": 1, "processed": {}}
        artifact_text = """---
{"title":"Epic voice note","created_at":"2026-05-31T19:32:07+00:00","artifact_id":"artifact-123","audio_sha256":"audio-123","audio_filename":"voice.oga","capture_channel":"telegram","telegram_chat_id":"8795344081","telegram_message_id":100}
---

This is the raw dictated note body.
"""

        result = importer.process_artifact(
            args,
            log,
            artifact_text=artifact_text,
            artifact_ref={
                "storage_backend": "minio",
                "bucket": "dictation-artifacts",
                "object_key": "canonical/2026/05/31/artifact-123.md",
                "path": None,
            },
        )

        self.assertTrue(result["source_only"])
        self.assertEqual(result["thoughts"], [])
        self.assertEqual(len(ingested_payloads), 1)
        self.assertEqual(ingested_payloads[0]["type"], "dictation_note")
        self.assertEqual(ingested_payloads[0]["dedupe_key"], "dictation:audio-123")
        self.assertEqual(len(status_messages), 1)
        self.assertIn("Stored 1 source row and 0 thought rows", status_messages[0]["text"])
        self.assertEqual(log["processed"]["dictation:audio-123"]["status"], "ingested")
        self.assertEqual(
            log["processed"]["minio:canonical/2026/05/31/artifact-123.md"]["status"],
            "ingested",
        )


if __name__ == "__main__":
    unittest.main()
