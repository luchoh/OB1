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
