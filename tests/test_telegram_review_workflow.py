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


if __name__ == "__main__":
    unittest.main()
