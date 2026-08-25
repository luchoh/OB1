from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from recipes.shared_docling import (
    docling_markdown_artifact,
    extract_tool_arguments,
    validate_thoughts_payload,
    vlm_result_is_better,
)


def _signals(*, hard=(), soft=(), duplicate_line_ratio=0.0):
    """Minimal quality-signals dict for vlm_result_is_better decision tests."""
    return {
        "hard_fail_reasons": list(hard),
        "soft_fail_reasons": list(soft),
        "duplicate_line_ratio": duplicate_line_ratio,
    }


class SharedDoclingTests(unittest.TestCase):
    def test_extract_tool_arguments_accepts_inline_tool_markup(self):
        response = {
            "choices": [
                {
                    "message": {
                        "content": (
                            "<function=submit_thoughts>\n"
                            "<parameter=thoughts>[\"Thought A\", \"Thought B\"]</parameter>\n"
                            "<parameter=reason>\"fallback\"</parameter>\n"
                        )
                    }
                }
            ]
        }

        payload = extract_tool_arguments(response, "submit_thoughts")

        self.assertEqual(payload["thoughts"], ["Thought A", "Thought B"])
        self.assertEqual(payload["reason"], "fallback")

    def test_extract_tool_arguments_accepts_json_content_without_tool_calls(self):
        response = {
            "choices": [
                {
                    "message": {
                        "content": "{\"thoughts\": [\"Thought A\"], \"reason\": \"json fallback\"}"
                    }
                }
            ]
        }

        payload = extract_tool_arguments(response, "submit_thoughts")

        self.assertEqual(payload["thoughts"], ["Thought A"])
        self.assertEqual(payload["reason"], "json fallback")

    def test_extract_tool_arguments_scrapes_json_embedded_in_prose(self):
        """The tolerant last resort: everything from the first "{" to the last "}".

        Everything that imports this function, checked across the whole repo
        rather than inferred:

            integrations/telegram-capture/telegram_bridge.py   2 call sites
            recipes/dictation-import/import-dictation.py       2 call sites
            recipes/email-history-import/import-imap.py        1, opted out

        plus summarize_document below, which import-documents and import-imap
        both call. Every other file naming extract_tool_arguments keeps its own
        local copy and is untouched by changes here.

        Pinned because a revision of the imap fix tightened this for all of
        them at once and nothing failed. Note telegram_bridge lives outside
        recipes/ — a search scoped to that directory misses it, which is
        exactly how this list was got wrong twice.
        """
        response = {
            "choices": [
                {"message": {"content": 'Sure! {"thoughts": ["A"]} Hope that helps.'}}
            ]
        }

        self.assertEqual(
            extract_tool_arguments(response, "submit_thoughts"), {"thoughts": ["A"]}
        )

    def test_docling_markdown_artifact_accepts_direct_convert_document_markdown(self):
        extraction = {
            "raw_payload": {
                "document": {
                    "md_content": "# Converted\n\nText from Docling direct conversion.",
                },
            },
        }

        self.assertEqual(
            docling_markdown_artifact("paper.pdf", extraction),
            "# Converted\n\nText from Docling direct conversion.",
        )



class SummarizeDocumentValidationTests(unittest.TestCase):
    """Attachment summaries go through the same shape gate as the email body.

    An earlier revision skipped the gate here, reasoning that raising would
    mark the whole message failed and re-Docling it every cycle. That was a
    misreading of the control flow: process_attachment catches this in
    import-imap.py (the `except Exception as exc: summary_error = str(exc)`
    around the summarize_document call), records the error and carries on with
    chunk ingest. message_failed is never touched, so a rejected summary costs
    one attachment's thoughts, not the message. Without the gate, a refusal or
    a malformed shape silently became zero attachment thoughts.
    """

    def _run(self, arguments_json):
        import recipes.shared_docling as sd

        class _Resp:
            status_code = 200

            def __init__(self, payload):
                self._payload = payload

            def json(self):
                return self._payload

        payload = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "tool_calls": [
                            {"function": {"name": "submit_thoughts", "arguments": arguments_json}}
                        ]
                    },
                }
            ]
        }
        original_post = sd.http_post_with_retry
        original_url = sd.local_llm_base_url
        sd.http_post_with_retry = lambda *a, **k: _Resp(payload)
        sd.local_llm_base_url = lambda *a, **k: "http://fake-llm/v1"
        try:
            return sd.summarize_document("attachment.pdf", "document text")
        finally:
            sd.http_post_with_retry = original_post
            sd.local_llm_base_url = original_url

    def test_a_valid_summary_still_succeeds(self):
        self.assertEqual(self._run('{"thoughts": ["a real summary"]}'), ["a real summary"])

    def test_a_valid_empty_summary_still_succeeds(self):
        self.assertEqual(self._run('{"thoughts": []}'), [])

    def test_a_refusal_beside_an_empty_list_is_rejected(self):
        with self.assertRaises(ValueError):
            self._run('{"thoughts": [], "error": "could not read the pdf"}')

    def test_a_non_list_thoughts_value_is_rejected(self):
        """Previously coerced to [] — a silent zero-thought summary."""
        with self.assertRaises(ValueError):
            self._run('{"thoughts": "some text"}')

    def test_a_payload_missing_the_key_is_rejected(self):
        with self.assertRaises(ValueError):
            self._run("{}")



class ThoughtsPayloadValidationTests(unittest.TestCase):
    """Shape gate on top of the tolerant tool-argument parser.

    Regression for the 2026-08-11 imap distillation stall: 845 consecutive
    cycles failed because the request demanded a tool call the server did not
    emit. The tolerant parser accepts the content-only answer, but on its own
    it also accepts JSON scraped out of prose, so an empty result and a
    malformed one become indistinguishable. The gate keeps the first and
    rejects the second.
    """

    def _content(self, text):
        return {"choices": [{"message": {"content": text}}]}

    def test_empty_thoughts_is_a_valid_answer(self):
        payload = extract_tool_arguments(self._content('{"thoughts": []}'), "submit_thoughts")
        self.assertEqual(validate_thoughts_payload(payload), [])

    def test_thoughts_with_extra_keys_are_rejected(self):
        """The declared schema is the rule, not a blacklist.

        This test previously asserted the opposite. Tolerating extras let
        {"thoughts": [], "error": "could not read the attachment"} pass as a
        successful empty result — discarding the stated reason and retiring the
        message permanently via the sync log. The dictation and telegram
        recipes do carry a "reason" in their own tools, but they do not call
        this validator, so the tolerance bought nothing.
        """
        payload = {"thoughts": ["Thought A"], "reason": "fallback"}
        with self.assertRaises(ValueError) as ctx:
            validate_thoughts_payload(payload)
        self.assertIn("declared schema", str(ctx.exception))

    def test_an_error_key_beside_an_empty_list_is_rejected(self):
        with self.assertRaises(ValueError):
            validate_thoughts_payload({"thoughts": [], "error": "could not read it"})

    def test_tool_call_payload_passes(self):
        response = {
            "choices": [
                {
                    "message": {
                        "tool_calls": [
                            {
                                "function": {
                                    "name": "submit_thoughts",
                                    "arguments": '{"thoughts": ["Thought A", "Thought B"]}',
                                }
                            }
                        ]
                    }
                }
            ]
        }
        payload = extract_tool_arguments(response, "submit_thoughts")
        self.assertEqual(validate_thoughts_payload(payload), ["Thought A", "Thought B"])

    def test_missing_key_is_rejected(self):
        payload = extract_tool_arguments(self._content('{"summary": "nothing"}'), "submit_thoughts")
        with self.assertRaises(ValueError) as ctx:
            validate_thoughts_payload(payload)
        self.assertIn('missing the "thoughts" key', str(ctx.exception))

    def test_non_list_thoughts_is_rejected(self):
        payload = extract_tool_arguments(
            self._content('{"thoughts": "just a string"}'), "submit_thoughts"
        )
        with self.assertRaises(ValueError) as ctx:
            validate_thoughts_payload(payload)
        self.assertIn("must be a list", str(ctx.exception))

    def test_non_string_items_are_rejected(self):
        payload = extract_tool_arguments(
            self._content('{"thoughts": [{"text": "A"}, 5]}'), "submit_thoughts"
        )
        with self.assertRaises(ValueError) as ctx:
            validate_thoughts_payload(payload)
        self.assertIn("must be a string", str(ctx.exception))

    def test_bare_list_is_rejected(self):
        payload = extract_tool_arguments(self._content('["Thought A"]'), "submit_thoughts")
        with self.assertRaises(ValueError) as ctx:
            validate_thoughts_payload(payload)
        self.assertIn("Expected a thoughts object", str(ctx.exception))


class ChatEnvelopeTests(unittest.TestCase):
    """Malformed envelopes must surface as a diagnosis, not a raw traceback.

    An unguarded response_json["choices"][0]["message"] raises IndexError /
    AttributeError, which the imap daemon prints as its only diagnostic. In a
    change whose whole premise is that the server's envelope cannot be
    trusted, these have to normalise to the same ValueError as any other
    missing tool call.
    """

    def test_empty_choices_raises_value_error(self):
        with self.assertRaises(ValueError) as ctx:
            extract_tool_arguments({"choices": []}, "submit_thoughts")
        self.assertIn("Model did not return a tool call", str(ctx.exception))

    def test_null_message_raises_value_error(self):
        with self.assertRaises(ValueError) as ctx:
            extract_tool_arguments({"choices": [{"message": None}]}, "submit_thoughts")
        self.assertIn("Model did not return a tool call", str(ctx.exception))

    def test_missing_choices_raises_value_error(self):
        with self.assertRaises(ValueError) as ctx:
            extract_tool_arguments({}, "submit_thoughts")
        self.assertIn("Model did not return a tool call", str(ctx.exception))

    def test_non_dict_response_raises_value_error(self):
        with self.assertRaises(ValueError) as ctx:
            extract_tool_arguments([], "submit_thoughts")
        self.assertIn("Model did not return a tool call", str(ctx.exception))

class VlmResultIsBetterTests(unittest.TestCase):
    """Decision table for the VLM-fallback acceptance guard.

    Regression for the 2026-03-15 imap incident: the granite VLM fallback's
    mojibake repetition-loop output was accepted unconditionally even though
    its own quality signals were strictly worse than the standard pipeline's.
    """

    def test_incident_shape_vlm_worse_on_its_own_signals_is_rejected(self):
        # The exact 2026-03-15 shape: standard double-soft-failed (which is
        # what TRIGGERED the fallback), VLM had the same soft fails and a
        # WORSE duplicate-line ratio (0.708 vs 0.564). Must keep standard.
        standard = _signals(
            soft=["duplicate_line_ratio_high", "lexical_variety_low"],
            duplicate_line_ratio=0.564,
        )
        vlm = _signals(
            soft=["duplicate_line_ratio_high", "lexical_variety_low"],
            duplicate_line_ratio=0.708,
        )
        self.assertFalse(vlm_result_is_better(standard, vlm))

    def test_vlm_with_hard_fails_never_wins(self):
        standard = _signals(soft=["text_too_short", "alnum_ratio_low"])
        vlm = _signals(hard=["empty_text"])
        self.assertFalse(vlm_result_is_better(standard, vlm))

    def test_vlm_beats_hard_failed_standard(self):
        # Something beats nothing: standard produced no usable text at all.
        standard = _signals(hard=["zero_chunks"])
        vlm = _signals(soft=["text_too_short"])
        self.assertTrue(vlm_result_is_better(standard, vlm))

    def test_vlm_with_fewer_soft_fails_wins(self):
        standard = _signals(
            soft=["duplicate_line_ratio_high", "lexical_variety_low"],
            duplicate_line_ratio=0.564,
        )
        vlm = _signals(soft=[], duplicate_line_ratio=0.05)
        self.assertTrue(vlm_result_is_better(standard, vlm))

    def test_vlm_with_equal_soft_fails_is_rejected(self):
        standard = _signals(soft=["text_too_short"])
        vlm = _signals(soft=["alnum_ratio_low"])
        self.assertFalse(vlm_result_is_better(standard, vlm))

    def test_vlm_fewer_fails_but_regressed_duplicate_ratio_is_rejected(self):
        # VLM clears more soft-fail categories yet loops harder than standard
        # while above the configured duplicate-line threshold: still rejected.
        standard = _signals(
            soft=["duplicate_line_ratio_high", "lexical_variety_low"],
            duplicate_line_ratio=0.40,
        )
        vlm = _signals(
            soft=["duplicate_line_ratio_high"],
            duplicate_line_ratio=0.75,
        )
        self.assertFalse(vlm_result_is_better(standard, vlm))


if __name__ == "__main__":
    unittest.main()
