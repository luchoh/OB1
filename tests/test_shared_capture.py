"""Offline tests for the shared Capture client (PRD docs/34, module 4).

No network, no Telegram/LLM/MinIO. The HTTP POST is injected as a fake so the
retry policy and auth/header convention are exercised without a server. Loaded
via the house ``load_module`` pattern (REPO_ROOT on sys.path).
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


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


capture = load_module("shared_capture_under_test", "recipes/shared_capture.py")


class FakeResponse:
    def __init__(self, status_code, body=None, text="", reason=""):
        self.status_code = status_code
        self._body = body
        self.text = text
        self.reason = reason

    def json(self):
        if self._body is None:
            raise ValueError("no json body")
        return self._body


class RecordingPost:
    """Returns a queued sequence of responses (or raises queued exceptions),
    recording each call's args."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def __call__(self, url, *, headers=None, json=None, timeout=None):
        self.calls.append({"url": url, "headers": headers, "json": json, "timeout": timeout})
        nxt = self._responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


# --- Payload contract -----------------------------------------------------

class BuildPayloadTests(unittest.TestCase):
    def test_required_top_level_fields(self):
        payload = capture.build_payload(
            content="hello",
            source="telegram",
            thought_type="telegram_message",
            retrieval_role=capture.RETRIEVAL_ROLE_SOURCE,
            dedupe_key="telegram:1:2",
            summary="hello",
            topics=["telegram", "capture"],
            tags=["telegram", "capture"],
            occurred_at="2026-01-01T00:00:00+00:00",
            extract_metadata=False,
        )
        self.assertEqual(payload["content"], "hello")
        self.assertEqual(payload["source"], "telegram")
        self.assertEqual(payload["type"], "telegram_message")
        self.assertEqual(payload["tags"], ["telegram", "capture"])
        self.assertEqual(payload["dedupe_key"], "telegram:1:2")
        self.assertEqual(payload["extract_metadata"], False)
        self.assertEqual(payload["occurred_at"], "2026-01-01T00:00:00+00:00")

    def test_metadata_core_and_role_stamping(self):
        payload = capture.build_payload(
            content="x",
            source="dictation",
            thought_type="dictation_thought",
            retrieval_role=capture.RETRIEVAL_ROLE_DISTILLED,
            dedupe_key="dictation:abc:thought:0",
            summary="a summary",
            topics=["dictation"],
            tags=["dictation"],
        )
        meta = payload["metadata"]
        self.assertEqual(meta["source"], "dictation")
        self.assertEqual(meta["type"], "dictation_thought")
        self.assertEqual(meta["retrieval_role"], "distilled")
        self.assertEqual(meta["summary"], "a summary")
        self.assertEqual(meta["topics"], ["dictation"])

    def test_extra_metadata_merged_and_overrides_core(self):
        # Mirrors dictation's `**metadata` splat-last: extras win on collision.
        payload = capture.build_payload(
            content="x",
            source="dictation",
            thought_type="dictation_note",
            retrieval_role=capture.RETRIEVAL_ROLE_SOURCE,
            dedupe_key="dictation:abc",
            summary="title",
            topics=["dictation", "capture"],
            tags=["dictation", "capture"],
            metadata={"full_text": "x", "audio_sha256": "deadbeef", "type": "overridden"},
        )
        meta = payload["metadata"]
        self.assertEqual(meta["full_text"], "x")
        self.assertEqual(meta["audio_sha256"], "deadbeef")
        # extra "type" overrides the core "type" (splat-last semantics)
        self.assertEqual(meta["type"], "overridden")
        # but the top-level "type" is unaffected
        self.assertEqual(payload["type"], "dictation_note")

    def test_occurred_at_omitted_vs_explicit_none(self):
        omitted = capture.build_payload(
            content="x", source="document", thought_type="document_chunk",
            retrieval_role="source", dedupe_key="doc:1", summary=None,
            topics=[], tags=[],
        )
        self.assertNotIn("occurred_at", omitted)

        explicit_none = capture.build_payload(
            content="x", source="chatgpt", thought_type="chatgpt_conversation_record",
            retrieval_role="source", dedupe_key="chatgpt:conversation_record:h",
            summary="t", topics=["chatgpt"], tags=["chatgpt"], occurred_at=None,
        )
        self.assertIn("occurred_at", explicit_none)
        self.assertIsNone(explicit_none["occurred_at"])

    def test_topics_and_tags_default_to_empty_list(self):
        payload = capture.build_payload(
            content="x", source="s", thought_type="t",
            retrieval_role="source", dedupe_key="k", summary=None,
        )
        self.assertEqual(payload["metadata"]["topics"], [])
        self.assertEqual(payload["tags"], [])


# --- Dedupe-key conventions -----------------------------------------------

class DedupeKeyTests(unittest.TestCase):
    def test_telegram_message_key(self):
        self.assertEqual(capture.telegram_message_key("123", 456), "telegram:123:456")

    def test_conversation_keys(self):
        self.assertEqual(
            capture.conversation_record_key("chatgpt", "abc"),
            "chatgpt:conversation_record:abc",
        )
        self.assertEqual(
            capture.conversation_source_key("claude", "abc"),
            "claude:conversation_source:abc",
        )

    def test_derived_thought_key(self):
        self.assertEqual(
            capture.derived_thought_key("telegram:1:2", 0),
            "telegram:1:2:thought:0",
        )

    def test_dictation_source_key_precedence(self):
        self.assertEqual(
            capture.dictation_source_key(audio_sha256="aaa", artifact_id="bbb"),
            "dictation:aaa",
        )
        self.assertEqual(
            capture.dictation_source_key(artifact_id="bbb"),
            "dictation:bbb",
        )
        self.assertEqual(
            capture.dictation_source_key(source_host="host", created_at="2026", cleaned_text_hash="hh"),
            "dictation:host:2026:hh",
        )

    def test_dictation_source_key_unknown_fallbacks(self):
        self.assertEqual(
            capture.dictation_source_key(),
            "dictation:unknown:unknown:unknown",
        )


# --- Retry / auth behavior ------------------------------------------------

class CaptureClientTests(unittest.TestCase):
    def _client(self, responses):
        post = RecordingPost(responses)
        sleeps = []
        client = capture.CaptureClient(
            "http://fake-runtime:8787/",
            "secret-key",
            retries=2,
            post=post,
            sleep=lambda s: sleeps.append(s),
        )
        return client, post, sleeps

    def test_success_returns_parsed_body_single_attempt(self):
        client, post, sleeps = self._client([FakeResponse(200, body={"id": "t1"})])
        result = client.capture({"content": "x"})
        self.assertEqual(result, {"id": "t1"})
        self.assertEqual(len(post.calls), 1)
        self.assertEqual(sleeps, [])

    def test_url_headers_and_body_passed_through(self):
        client, post, _ = self._client([FakeResponse(201, body={})])
        client.capture({"content": "x"})
        call = post.calls[0]
        self.assertEqual(call["url"], "http://fake-runtime:8787/ingest/thought")
        self.assertEqual(call["headers"]["x-access-key"], "secret-key")
        self.assertEqual(call["headers"]["x-ingest-key"], "secret-key")
        self.assertEqual(call["headers"]["Content-Type"], "application/json")
        self.assertEqual(call["json"], {"content": "x"})
        self.assertEqual(call["timeout"], capture.DEFAULT_TIMEOUT)

    def test_4xx_fails_fast_without_retry(self):
        client, post, sleeps = self._client([FakeResponse(400, text="bad payload", reason="Bad Request")])
        with self.assertRaises(capture.CaptureError) as ctx:
            client.capture({"content": "x"})
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(len(post.calls), 1)
        self.assertEqual(sleeps, [])

    def test_5xx_retries_then_raises_after_exhaustion(self):
        client, post, sleeps = self._client([
            FakeResponse(503, text="down"),
            FakeResponse(503, text="down"),
            FakeResponse(503, text="down"),
        ])
        with self.assertRaises(capture.CaptureError) as ctx:
            client.capture({"content": "x"})
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(len(post.calls), 3)  # 1 + 2 retries
        self.assertEqual(sleeps, [1, 2])  # linear backoff attempt+1

    def test_5xx_then_success_recovers(self):
        client, post, sleeps = self._client([
            FakeResponse(500, text="oops"),
            FakeResponse(200, body={"id": "t2"}),
        ])
        result = client.capture({"content": "x"})
        self.assertEqual(result, {"id": "t2"})
        self.assertEqual(len(post.calls), 2)
        self.assertEqual(sleeps, [1])

    def test_connection_error_retried_then_reraised(self):
        import requests
        client, post, sleeps = self._client([
            requests.ConnectionError("conn reset"),
            requests.ConnectionError("conn reset"),
            requests.ConnectionError("conn reset"),
        ])
        with self.assertRaises(requests.RequestException):
            client.capture({"content": "x"})
        self.assertEqual(len(post.calls), 3)
        self.assertEqual(sleeps, [1, 2])

    def test_connection_error_then_success(self):
        import requests
        client, post, sleeps = self._client([
            requests.ConnectionError("conn reset"),
            FakeResponse(200, body={"ok": True}),
        ])
        result = client.capture({"content": "x"})
        self.assertEqual(result, {"ok": True})
        self.assertEqual(len(post.calls), 2)

    def test_non_json_2xx_body_wrapped(self):
        client, post, _ = self._client([FakeResponse(200, body=None, text="plain ok")])
        result = client.capture({"content": "x"})
        self.assertEqual(result, {"raw_response": "plain ok"})

    def test_capture_built_composes_build_and_post(self):
        client, post, _ = self._client([FakeResponse(200, body={"id": "t3"})])
        result = client.capture_built(
            content="hello",
            source="telegram",
            thought_type="telegram_message",
            retrieval_role="source",
            dedupe_key="telegram:1:2",
            summary="hello",
            topics=["telegram"],
            tags=["telegram"],
        )
        self.assertEqual(result, {"id": "t3"})
        sent = post.calls[0]["json"]
        self.assertEqual(sent["dedupe_key"], "telegram:1:2")
        self.assertEqual(sent["metadata"]["retrieval_role"], "source")


if __name__ == "__main__":
    unittest.main()
