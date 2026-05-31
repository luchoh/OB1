from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from recipes.shared_docling import extract_tool_arguments


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


if __name__ == "__main__":
    unittest.main()
