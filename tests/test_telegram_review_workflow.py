from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace

import requests


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

    def test_bridge_callback_deny_is_idempotent_when_status_unchanged(self):
        bridge = load_module("telegram_bridge_idempotent_deny", "integrations/telegram-capture/telegram_bridge.py")
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "review-state.json"
            token = "0123456789abcdef"
            session = review_state.build_review_session(
                origin="telegram_dictation",
                kind="review",
                chat_id="123",
                message_id=456,
                source_payload={"content": "raw source", "dedupe_key": "dictation:123"},
                thought_payloads=[{"content": "Original thought", "metadata": {"summary": "Original thought"}}],
                suggested_decisions={"Original thought": "duplicate"},
            )
            with review_state.locked_review_state(state_path) as payload:
                payload["pending_actions"][token] = session

            callback_texts = []

            def fail_refresh(*_args, **_kwargs):
                raise AssertionError("refresh_review_message should not run for idempotent deny")

            bridge.refresh_review_message = fail_refresh
            bridge.answer_callback_query = lambda _token, _callback_id, text=None: callback_texts.append(text)

            args = SimpleNamespace(
                allowed_chat_ids={"123"},
                review_state_file=state_path,
                pending_action_ttl_seconds=86400,
                telegram_token="test-token",
                dry_run=False,
            )
            handled = bridge.process_callback_query(
                args,
                {},
                {
                    "id": "callback-1",
                    "data": f"ob1:deny:{token}:0",
                    "from": {"id": 1},
                    "message": {"chat": {"id": 123, "type": "private"}},
                },
            )

            self.assertTrue(handled["handled"])
            self.assertEqual(handled["decision"], "denied")
            self.assertEqual(callback_texts, ["Thought 1 is already denied."])
            with review_state.locked_review_state(state_path) as payload:
                updated = payload["pending_actions"][token]
                self.assertEqual(updated["thoughts"][0]["status"], review_state.THOUGHT_STATUS_DENIED)

    def test_bridge_callback_approve_is_idempotent_when_status_unchanged(self):
        bridge = load_module("telegram_bridge_idempotent_approve", "integrations/telegram-capture/telegram_bridge.py")
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "review-state.json"
            token = "fedcba9876543210"
            session = review_state.build_review_session(
                origin="telegram_text",
                kind="review",
                chat_id="123",
                message_id=456,
                source_payload={"content": "raw source", "dedupe_key": "telegram:123:456"},
                thought_payloads=[{"content": "Original thought", "metadata": {"summary": "Original thought"}}],
                suggested_decisions={"Original thought": "record"},
            )
            with review_state.locked_review_state(state_path) as payload:
                payload["pending_actions"][token] = session

            callback_texts = []

            def fail_refresh(*_args, **_kwargs):
                raise AssertionError("refresh_review_message should not run for idempotent approve")

            bridge.refresh_review_message = fail_refresh
            bridge.answer_callback_query = lambda _token, _callback_id, text=None: callback_texts.append(text)

            args = SimpleNamespace(
                allowed_chat_ids={"123"},
                review_state_file=state_path,
                pending_action_ttl_seconds=86400,
                telegram_token="test-token",
                dry_run=False,
            )
            handled = bridge.process_callback_query(
                args,
                {},
                {
                    "id": "callback-2",
                    "data": f"ob1:approve:{token}:0",
                    "from": {"id": 1},
                    "message": {"chat": {"id": 123, "type": "private"}},
                },
            )

            self.assertTrue(handled["handled"])
            self.assertEqual(handled["decision"], "approved")
            self.assertEqual(callback_texts, ["Thought 1 is already approved."])
            with review_state.locked_review_state(state_path) as payload:
                updated = payload["pending_actions"][token]
                self.assertEqual(updated["thoughts"][0]["status"], review_state.THOUGHT_STATUS_APPROVED)

    def test_bridge_callback_approve_acknowledges_after_message_not_modified(self):
        bridge = load_module("telegram_bridge_message_not_modified", "integrations/telegram-capture/telegram_bridge.py")
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "review-state.json"
            token = "aaaabbbbccccdddd"
            session = review_state.build_review_session(
                origin="telegram_text",
                kind="review",
                chat_id="123",
                message_id=456,
                source_payload={"content": "raw source", "dedupe_key": "telegram:123:789"},
                thought_payloads=[{"content": "Original thought", "metadata": {"summary": "Original thought"}}],
                suggested_decisions={"Original thought": "uncertain"},
            )
            session["review_message_id"] = 789
            with review_state.locked_review_state(state_path) as payload:
                payload["pending_actions"][token] = session

            callback_texts = []

            class FakeResponse:
                def json(self):
                    return {"ok": False, "description": "Bad Request: message is not modified"}

            def fake_telegram_api_call(_token, method, payload=None, timeout=60):
                if method == "editMessageText":
                    error = requests.HTTPError("400 Client Error: Bad Request")
                    error.response = FakeResponse()
                    raise error
                raise AssertionError(f"unexpected telegram_api_call method {method}")

            bridge.telegram_api_call = fake_telegram_api_call
            bridge.answer_callback_query = lambda _token, _callback_id, text=None: callback_texts.append(text)

            args = SimpleNamespace(
                allowed_chat_ids={"123"},
                review_state_file=state_path,
                pending_action_ttl_seconds=86400,
                telegram_token="test-token",
                dry_run=False,
            )
            handled = bridge.process_callback_query(
                args,
                {},
                {
                    "id": "callback-3",
                    "data": f"ob1:approve:{token}:0",
                    "from": {"id": 1},
                    "message": {"chat": {"id": 123, "type": "private"}},
                },
            )

            self.assertTrue(handled["handled"])
            self.assertEqual(handled["decision"], "approved")
            self.assertEqual(callback_texts, ["Approved thought 1."])
            with review_state.locked_review_state(state_path) as payload:
                updated = payload["pending_actions"][token]
                self.assertEqual(updated["thoughts"][0]["status"], review_state.THOUGHT_STATUS_APPROVED)

    def test_single_thought_review_markup_uses_terminal_actions(self):
        session = review_state.build_review_session(
            origin="telegram_text",
            kind="review",
            chat_id="123",
            message_id=456,
            source_payload={"content": "raw source", "dedupe_key": "telegram:123:456"},
            thought_payloads=[{"content": "One thought", "metadata": {"summary": "One thought"}}],
            suggested_decisions={"One thought": "uncertain"},
        )

        markup = review_state.build_review_reply_markup(session, "0123456789abcdef")
        labels = [button["text"] for row in markup["inline_keyboard"] for button in row]

        self.assertIn("Record", labels)
        self.assertIn("Edit", labels)
        self.assertIn("Ignore", labels)
        self.assertNotIn("Approve All", labels)
        self.assertNotIn("Commit", labels)
        self.assertNotIn("Deny All", labels)

    def test_single_thought_ignore_closes_review_and_records_resolution(self):
        bridge = load_module("telegram_bridge_single_ignore", "integrations/telegram-capture/telegram_bridge.py")
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "review-state.json"
            token = "1111222233334444"
            session = review_state.build_review_session(
                origin="telegram_dictation",
                kind="review",
                chat_id="123",
                message_id=456,
                source_payload={"content": "raw source", "dedupe_key": "dictation:123"},
                thought_payloads=[{"content": "Duplicate thought", "metadata": {"summary": "Duplicate thought"}}],
                suggested_decisions={"Duplicate thought": "duplicate"},
                dictation_sync={"dedupe_key": "dictation:123", "ref_key": "minio:canonical/item.md"},
            )
            with review_state.locked_review_state(state_path) as payload:
                payload["pending_actions"][token] = session

            args = SimpleNamespace(
                allowed_chat_ids={"123"},
                review_state_file=state_path,
                pending_action_ttl_seconds=86400,
                telegram_token="",
                dry_run=False,
            )
            handled = bridge.process_callback_query(
                args,
                {},
                {
                    "id": "callback-4",
                    "data": f"ob1:ignore:{token}",
                    "from": {"id": 1},
                    "message": {"chat": {"id": 123, "type": "private"}},
                },
            )

            self.assertTrue(handled["handled"])
            self.assertEqual(handled["decision"], "ignore")
            with review_state.locked_review_state(state_path) as payload:
                self.assertNotIn(token, payload["pending_actions"])
                self.assertEqual(
                    payload["resolved_actions"][token]["status"],
                    review_state.DICTATION_RESOLUTION_IGNORED,
                )

    def test_single_thought_record_stores_thought_and_closes_review(self):
        bridge = load_module("telegram_bridge_single_record", "integrations/telegram-capture/telegram_bridge.py")
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "review-state.json"
            token = "5555666677778888"
            session = review_state.build_review_session(
                origin="telegram_dictation",
                kind="review",
                chat_id="123",
                message_id=456,
                source_payload={"content": "raw source", "dedupe_key": "dictation:456"},
                thought_payloads=[{"content": "Duplicate thought", "metadata": {"summary": "Duplicate thought"}}],
                suggested_decisions={"Duplicate thought": "duplicate"},
                dictation_sync={"dedupe_key": "dictation:456", "ref_key": "minio:canonical/item-2.md"},
            )
            with review_state.locked_review_state(state_path) as payload:
                payload["pending_actions"][token] = session

            ingests = []
            bridge.ingest_text_capture = lambda _args, source_payload, thought_payloads: ingests.append((source_payload, thought_payloads))

            args = SimpleNamespace(
                allowed_chat_ids={"123"},
                review_state_file=state_path,
                pending_action_ttl_seconds=86400,
                telegram_token="",
                dry_run=False,
            )
            handled = bridge.process_callback_query(
                args,
                {},
                {
                    "id": "callback-5",
                    "data": f"ob1:record:{token}",
                    "from": {"id": 1},
                    "message": {"chat": {"id": 123, "type": "private"}},
                },
            )

            self.assertTrue(handled["handled"])
            self.assertEqual(handled["decision"], "record")
            self.assertEqual(len(ingests), 1)
            self.assertEqual(ingests[0][0]["dedupe_key"], "dictation:456")
            self.assertEqual(len(ingests[0][1]), 1)
            self.assertEqual(ingests[0][1][0]["content"], "Duplicate thought")
            with review_state.locked_review_state(state_path) as payload:
                self.assertNotIn(token, payload["pending_actions"])
                self.assertEqual(
                    payload["resolved_actions"][token]["status"],
                    review_state.DICTATION_RESOLUTION_INGESTED,
                )

    def test_single_thought_duplicate_review_shows_evidence_and_ignore(self):
        session = review_state.build_review_session(
            origin="telegram_dictation",
            kind="review",
            chat_id="123",
            message_id=456,
            source_payload={"content": "raw source", "dedupe_key": "dictation:789"},
            thought_payloads=[{"content": "One duplicate", "metadata": {"summary": "One duplicate"}}],
            suggested_decisions={"One duplicate": "duplicate"},
            similar_matches={
                "One duplicate": [
                    {
                        "summary": "Existing memory",
                        "similarity": 0.91,
                        "source": "dictation",
                        "type": "dictation_thought",
                    }
                ]
            },
        )

        rendered = review_state.render_review_text(session)
        markup = review_state.build_review_reply_markup(session, "9999aaaabbbbcccc")
        labels = [button["text"] for row in markup["inline_keyboard"] for button in row]

        self.assertIn("Closest existing memories:", rendered)
        self.assertIn("Existing memory", rendered)
        self.assertIn("Ignore", labels)
        self.assertNotIn("Deny All", labels)
        self.assertNotIn("Deny 1", labels)

    def test_dictation_reconciliation_updates_review_pending_entries(self):
        fake_yaml = types.ModuleType("yaml")
        fake_yaml.safe_load = lambda text: {}
        sys.modules.setdefault("yaml", fake_yaml)
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
        fake_yaml = types.ModuleType("yaml")
        fake_yaml.safe_load = lambda text: {}
        sys.modules.setdefault("yaml", fake_yaml)
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


if __name__ == "__main__":
    unittest.main()
