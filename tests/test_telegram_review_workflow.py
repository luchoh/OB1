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
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def install_fake_yaml_module():
    fake_yaml = types.ModuleType("yaml")
    setattr(fake_yaml, "safe_load", lambda text: json.loads(text))
    sys.modules.setdefault("yaml", fake_yaml)


def inline_callback_data(reply_markup: dict) -> list[str]:
    return [
        button.get("callback_data", "")
        for row in reply_markup.get("inline_keyboard", [])
        for button in row
        if isinstance(button, dict)
    ]


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

            setattr(bridge, "edit_message", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("Telegram edit failed")))
            setattr(bridge, "answer_callback_query", lambda *args, **kwargs: None)

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

    def test_callback_approved_thought_action_row_disappears(self):
        bridge = load_module("telegram_bridge_decided_row_test", "integrations/telegram-capture/telegram_bridge.py")
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "review-state.json"
            token = "0123456789abcdef"
            session = review_state.build_review_session(
                origin="telegram_dictation",
                kind="review",
                chat_id="123",
                message_id=456,
                source_payload={"content": "raw source", "dedupe_key": "dictation:abc"},
                thought_payloads=[
                    {"content": "First thought", "metadata": {"summary": "First thought"}},
                    {"content": "Second thought", "metadata": {"summary": "Second thought"}},
                ],
                dictation_sync={"dedupe_key": "dictation:abc", "ref_key": "minio:canonical/item.md"},
            )
            session["review_message_id"] = 999
            with review_state.locked_review_state(state_path) as payload:
                payload["pending_actions"][token] = session

            edits = []
            setattr(bridge, "answer_callback_query", lambda *args, **kwargs: None)
            setattr(bridge, "edit_message", lambda *args, **kwargs: edits.append({"args": args, "kwargs": kwargs}))

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
                    "id": "approve-callback",
                    "data": f"ob1:approve:{token}:0",
                    "from": {"id": 123},
                    "message": {"chat": {"id": 123}, "message_id": 999},
                },
            )

            self.assertEqual(result["decision"], "approved")
            callback_data = inline_callback_data(edits[-1]["kwargs"]["reply_markup"])
            self.assertNotIn(f"ob1:approve:{token}:0", callback_data)
            self.assertNotIn(f"ob1:edit:{token}:0", callback_data)
            self.assertNotIn(f"ob1:deny:{token}:0", callback_data)
            self.assertIn(f"ob1:approve:{token}:1", callback_data)
            self.assertIn(f"ob1:edit:{token}:1", callback_data)
            self.assertIn(f"ob1:deny:{token}:1", callback_data)

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
            setattr(bridge, "ingest_text_capture", lambda args, source, thoughts: ingested.append(
                {"source": source, "thoughts": thoughts}
            ))
            setattr(bridge, "answer_callback_query", lambda *args, **kwargs: (_ for _ in ()).throw(
                RuntimeError("Telegram answer failed")
            ))
            setattr(bridge, "edit_message", lambda *args, **kwargs: (_ for _ in ()).throw(
                RuntimeError("Telegram edit failed")
            ))

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

    def test_callback_last_individual_deny_resolves_review_as_ignored(self):
        bridge = load_module("telegram_bridge_last_deny_test", "integrations/telegram-capture/telegram_bridge.py")
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "review-state.json"
            token = "abcdef0123456789"
            session = review_state.build_review_session(
                origin="telegram_dictation",
                kind="review",
                chat_id="123",
                message_id=456,
                source_payload={"content": "raw source", "dedupe_key": "dictation:abc"},
                thought_payloads=[
                    {"content": "First thought", "metadata": {"summary": "First thought"}},
                    {"content": "Second thought", "metadata": {"summary": "Second thought"}},
                ],
                dictation_sync={"dedupe_key": "dictation:abc", "ref_key": "minio:canonical/item.md"},
            )
            session["review_message_id"] = 999
            with review_state.locked_review_state(state_path) as payload:
                payload["pending_actions"][token] = session

            edits = []
            setattr(bridge, "answer_callback_query", lambda *args, **kwargs: None)
            setattr(bridge, "edit_message", lambda *args, **kwargs: edits.append({"args": args, "kwargs": kwargs}))
            setattr(bridge, "ingest_text_capture", lambda *args, **kwargs: (_ for _ in ()).throw(
                AssertionError("denied review should not ingest")
            ))

            args = SimpleNamespace(
                review_state_file=state_path,
                pending_action_ttl_seconds=86400,
                telegram_token="telegram-token",
                dry_run=False,
                allowed_chat_ids=set(),
            )

            first_result = bridge.process_callback_query(
                args,
                {},
                {
                    "id": "deny-callback-0",
                    "data": f"ob1:deny:{token}:0",
                    "from": {"id": 123},
                    "message": {"chat": {"id": 123}, "message_id": 999},
                },
            )
            self.assertEqual(first_result["decision"], "denied")
            first_callback_data = inline_callback_data(edits[-1]["kwargs"]["reply_markup"])
            self.assertNotIn(f"ob1:approve:{token}:0", first_callback_data)
            self.assertNotIn(f"ob1:edit:{token}:0", first_callback_data)
            self.assertNotIn(f"ob1:deny:{token}:0", first_callback_data)
            self.assertIn(f"ob1:approve:{token}:1", first_callback_data)

            second_result = bridge.process_callback_query(
                args,
                {},
                {
                    "id": "deny-callback-1",
                    "data": f"ob1:deny:{token}:1",
                    "from": {"id": 123},
                    "message": {"chat": {"id": 123}, "message_id": 999},
                },
            )

            self.assertEqual(second_result["decision"], "denied_all")
            self.assertEqual(second_result["reason"], "all_thoughts_denied")
            self.assertEqual(edits[-1]["kwargs"]["reply_markup"], {"inline_keyboard": []})
            with review_state.locked_review_state(state_path) as payload:
                self.assertNotIn(token, payload["pending_actions"])
                self.assertEqual(payload["resolved_actions"][token]["status"], review_state.DICTATION_RESOLUTION_IGNORED)

    def test_callback_commit_with_stale_all_denied_review_resolves_as_ignored(self):
        bridge = load_module("telegram_bridge_commit_denied_test", "integrations/telegram-capture/telegram_bridge.py")
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "review-state.json"
            token = "abcdef0123456789"
            session = review_state.build_review_session(
                origin="telegram_dictation",
                kind="review",
                chat_id="123",
                message_id=456,
                source_payload={"content": "raw source", "dedupe_key": "dictation:abc"},
                thought_payloads=[
                    {"content": "First thought", "metadata": {"summary": "First thought"}},
                    {"content": "Second thought", "metadata": {"summary": "Second thought"}},
                ],
                dictation_sync={"dedupe_key": "dictation:abc", "ref_key": "minio:canonical/item.md"},
            )
            session["review_message_id"] = 999
            for thought in session["thoughts"]:
                thought["status"] = review_state.THOUGHT_STATUS_DENIED
            with review_state.locked_review_state(state_path) as payload:
                payload["pending_actions"][token] = session

            setattr(bridge, "ingest_text_capture", lambda *args, **kwargs: (_ for _ in ()).throw(
                AssertionError("denied review should not ingest")
            ))

            args = SimpleNamespace(
                review_state_file=state_path,
                pending_action_ttl_seconds=86400,
                telegram_token="",
                dry_run=False,
                allowed_chat_ids=set(),
            )

            result = bridge.process_callback_query(
                args,
                {},
                {
                    "id": "commit-callback",
                    "data": f"ob1:commit:{token}",
                    "from": {"id": 123},
                    "message": {"chat": {"id": 123}, "message_id": 999},
                },
            )

            self.assertEqual(result["decision"], "commit_ignored")
            self.assertEqual(result["reason"], "all_thoughts_denied")
            with review_state.locked_review_state(state_path) as payload:
                self.assertNotIn(token, payload["pending_actions"])
                self.assertEqual(payload["resolved_actions"][token]["status"], review_state.DICTATION_RESOLUTION_IGNORED)

    def test_single_thought_session_renders_record_edit_ignore_keyboard(self):
        session = review_state.build_review_session(
            origin="telegram_dictation",
            kind="review",
            chat_id="123",
            message_id=456,
            source_payload={"content": "raw source", "dedupe_key": "dictation:single"},
            thought_payloads=[{"content": "Sole thought", "metadata": {"summary": "Sole thought"}}],
        )
        token = "0123456789abcdef"
        callback_data = inline_callback_data(review_state.build_review_reply_markup(session, token))
        self.assertIn(f"ob1:record:{token}", callback_data)
        self.assertIn(f"ob1:edit:{token}:0", callback_data)
        self.assertIn(f"ob1:ignore:{token}", callback_data)
        self.assertIn(f"ob1:view_raw:{token}", callback_data)
        self.assertNotIn(f"ob1:approve:{token}:0", callback_data)
        self.assertNotIn(f"ob1:deny:{token}:0", callback_data)
        self.assertNotIn(f"ob1:commit:{token}", callback_data)
        self.assertNotIn(f"ob1:approve_all:{token}", callback_data)

    def test_callback_single_thought_record_ingests_thought(self):
        bridge = load_module("telegram_bridge_single_record_test", "integrations/telegram-capture/telegram_bridge.py")
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "review-state.json"
            token = "abcdef0123456789"
            source_payload = {"content": "raw source", "dedupe_key": "dictation:single-rec"}
            thought_payload = {
                "content": "Sole thought",
                "metadata": {"summary": "Sole thought"},
                "dedupe_key": "dictation:single-rec:thought:0",
            }
            session = review_state.build_review_session(
                origin="telegram_dictation",
                kind="review",
                chat_id="123",
                message_id=456,
                source_payload=source_payload,
                thought_payloads=[thought_payload],
                dictation_sync={"dedupe_key": "dictation:single-rec", "ref_key": "minio:k"},
            )
            session["review_message_id"] = 999
            with review_state.locked_review_state(state_path) as payload:
                payload["pending_actions"][token] = session

            ingested = []
            setattr(bridge, "ingest_text_capture", lambda args, source, thoughts: ingested.append(
                {"source": source, "thoughts": thoughts}
            ))
            setattr(bridge, "answer_callback_query", lambda *args, **kwargs: None)
            setattr(bridge, "edit_message", lambda *args, **kwargs: None)

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
                    "data": f"ob1:record:{token}",
                    "from": {"id": 123},
                    "message": {"chat": {"id": 123}, "message_id": 999},
                },
            )

            self.assertEqual(result["decision"], "record")
            self.assertEqual(result["thought_count"], 1)
            self.assertEqual(len(ingested), 1)
            self.assertEqual(ingested[0]["source"], source_payload)
            self.assertEqual(ingested[0]["thoughts"][0]["dedupe_key"], "dictation:single-rec:thought:0")
            with review_state.locked_review_state(state_path) as payload:
                self.assertNotIn(token, payload["pending_actions"])
                self.assertEqual(
                    payload["resolved_actions"][token]["status"],
                    review_state.DICTATION_RESOLUTION_INGESTED,
                )

    def test_callback_single_thought_ignore_resolves_as_ignored(self):
        bridge = load_module("telegram_bridge_single_ignore_test", "integrations/telegram-capture/telegram_bridge.py")
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "review-state.json"
            token = "abcdef0123456789"
            session = review_state.build_review_session(
                origin="telegram_dictation",
                kind="review",
                chat_id="123",
                message_id=456,
                source_payload={"content": "raw source", "dedupe_key": "dictation:single-ign"},
                thought_payloads=[{"content": "Sole thought", "metadata": {"summary": "Sole thought"}}],
                dictation_sync={"dedupe_key": "dictation:single-ign", "ref_key": "minio:k"},
            )
            session["review_message_id"] = 999
            with review_state.locked_review_state(state_path) as payload:
                payload["pending_actions"][token] = session

            setattr(bridge, "answer_callback_query", lambda *args, **kwargs: None)
            setattr(bridge, "edit_message", lambda *args, **kwargs: None)
            setattr(bridge, "ingest_text_capture", lambda *args, **kwargs: (_ for _ in ()).throw(
                AssertionError("ignored review should not ingest")
            ))

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
                    "data": f"ob1:ignore:{token}",
                    "from": {"id": 123},
                    "message": {"chat": {"id": 123}, "message_id": 999},
                },
            )

            self.assertEqual(result["decision"], "ignore")
            with review_state.locked_review_state(state_path) as payload:
                self.assertNotIn(token, payload["pending_actions"])
                self.assertEqual(
                    payload["resolved_actions"][token]["status"],
                    review_state.DICTATION_RESOLUTION_IGNORED,
                )

    def test_callback_duplicate_approve_is_idempotent(self):
        bridge = load_module("telegram_bridge_idem_approve_test", "integrations/telegram-capture/telegram_bridge.py")
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "review-state.json"
            token = "abcdef0123456789"
            session = review_state.build_review_session(
                origin="telegram_dictation",
                kind="review",
                chat_id="123",
                message_id=456,
                source_payload={"content": "raw source", "dedupe_key": "dictation:idem"},
                thought_payloads=[
                    {"content": "First thought", "metadata": {"summary": "First thought"}},
                    {"content": "Second thought", "metadata": {"summary": "Second thought"}},
                ],
                dictation_sync={"dedupe_key": "dictation:idem", "ref_key": "minio:k"},
            )
            session["thoughts"][0]["status"] = review_state.THOUGHT_STATUS_APPROVED
            session["review_message_id"] = 999
            with review_state.locked_review_state(state_path) as payload:
                payload["pending_actions"][token] = session

            edits = []
            ack_messages = []
            setattr(bridge, "answer_callback_query", lambda token_, callback_id, text=None: ack_messages.append(text))
            setattr(bridge, "edit_message", lambda *args, **kwargs: edits.append({"args": args, "kwargs": kwargs}))

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
                    "data": f"ob1:approve:{token}:0",
                    "from": {"id": 123},
                    "message": {"chat": {"id": 123}, "message_id": 999},
                },
            )

            self.assertEqual(result["decision"], "approved")
            self.assertEqual(result["reason"], "already_approved")
            self.assertEqual(edits, [])
            self.assertEqual(ack_messages, ["Thought 1 is already approved."])
            with review_state.locked_review_state(state_path) as payload:
                statuses = [t["status"] for t in payload["pending_actions"][token]["thoughts"]]
            self.assertEqual(
                statuses,
                [review_state.THOUGHT_STATUS_APPROVED, review_state.THOUGHT_STATUS_PENDING],
            )

    def test_callback_duplicate_deny_is_idempotent(self):
        bridge = load_module("telegram_bridge_idem_deny_test", "integrations/telegram-capture/telegram_bridge.py")
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "review-state.json"
            token = "abcdef0123456789"
            session = review_state.build_review_session(
                origin="telegram_dictation",
                kind="review",
                chat_id="123",
                message_id=456,
                source_payload={"content": "raw source", "dedupe_key": "dictation:idem-deny"},
                thought_payloads=[
                    {"content": "First thought", "metadata": {"summary": "First thought"}},
                    {"content": "Second thought", "metadata": {"summary": "Second thought"}},
                ],
                dictation_sync={"dedupe_key": "dictation:idem-deny", "ref_key": "minio:k"},
            )
            session["thoughts"][0]["status"] = review_state.THOUGHT_STATUS_DENIED
            session["review_message_id"] = 999
            with review_state.locked_review_state(state_path) as payload:
                payload["pending_actions"][token] = session

            edits = []
            ack_messages = []
            setattr(bridge, "answer_callback_query", lambda token_, callback_id, text=None: ack_messages.append(text))
            setattr(bridge, "edit_message", lambda *args, **kwargs: edits.append({"args": args, "kwargs": kwargs}))

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
                    "data": f"ob1:deny:{token}:0",
                    "from": {"id": 123},
                    "message": {"chat": {"id": 123}, "message_id": 999},
                },
            )

            self.assertEqual(result["decision"], "denied")
            self.assertEqual(result["reason"], "already_denied")
            self.assertEqual(edits, [])
            self.assertEqual(ack_messages, ["Thought 1 is already denied."])
            with review_state.locked_review_state(state_path) as payload:
                self.assertIn(token, payload["pending_actions"])
                statuses = [t["status"] for t in payload["pending_actions"][token]["thoughts"]]
            self.assertEqual(
                statuses,
                [review_state.THOUGHT_STATUS_DENIED, review_state.THOUGHT_STATUS_PENDING],
            )

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

        setattr(importer, "summarize_dictation", lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("Model did not return a tool call")))
        setattr(importer, "ingest_row", lambda base_url, access_key, payload: ingested_payloads.append(payload))
        setattr(importer, "send_reply", lambda token, chat_id, reply_to_message_id, text: status_messages.append(
            {
                "token": token,
                "chat_id": chat_id,
                "reply_to_message_id": reply_to_message_id,
                "text": text,
            }
        ))
        setattr(importer, "register_telegram_review", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("review should not be requested")))

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
