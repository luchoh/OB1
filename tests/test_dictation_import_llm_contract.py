from __future__ import annotations

import importlib.util
import json
import sys
import types
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


def install_fake_yaml_module():
    fake_yaml = types.ModuleType("yaml")
    fake_yaml.safe_load = lambda text: json.loads(text)
    sys.modules.setdefault("yaml", fake_yaml)


class DictationImportLlmContractTests(unittest.TestCase):
    def test_summarize_dictation_uses_required_tool_choice_and_zero_temperature(self):
        install_fake_yaml_module()
        importer = load_module("dictation_import_llm_contract", "recipes/dictation-import/import-dictation.py")

        captured = {}

        class FakeResponse:
            def json(self):
                return {
                    "choices": [
                        {
                            "message": {
                                "tool_calls": [
                                    {
                                        "function": {
                                            "name": "submit_thoughts",
                                            "arguments": "{\"thoughts\": []}",
                                        }
                                    }
                                ]
                            }
                        }
                    ]
                }

        def fake_http_post(url, *, headers=None, json_body=None, files=None, data=None, retries=2, timeout=180):
            captured["url"] = url
            captured["headers"] = headers
            captured["json_body"] = json_body
            captured["timeout"] = timeout
            return FakeResponse()

        importer.http_post_with_retry = fake_http_post
        importer.local_llm_base_url = lambda: "http://fake-llm/v1"

        importer.summarize_dictation("Body", {"title": "Test"}, "fake-model")

        self.assertEqual(captured["json_body"]["tool_choice"], "required")
        self.assertEqual(captured["json_body"]["temperature"], 0)

    def test_review_thought_novelty_uses_required_tool_choice_and_zero_temperature(self):
        install_fake_yaml_module()
        importer = load_module("dictation_import_novelty_contract", "recipes/dictation-import/import-dictation.py")

        captured = {}

        class FakeResponse:
            def json(self):
                return {
                    "choices": [
                        {
                            "message": {
                                "tool_calls": [
                                    {
                                        "function": {
                                            "name": "submit_review",
                                            "arguments": "{\"reviews\": []}",
                                        }
                                    }
                                ]
                            }
                        }
                    ]
                }

        def fake_http_post(url, *, headers=None, json_body=None, files=None, data=None, retries=2, timeout=180):
            captured["url"] = url
            captured["headers"] = headers
            captured["json_body"] = json_body
            captured["timeout"] = timeout
            return FakeResponse()

        importer.http_post_with_retry = fake_http_post
        importer.local_llm_base_url = lambda: "http://fake-llm/v1"

        importer.review_thought_novelty(["Thought"], {"Thought": []}, "fake-model")

        self.assertEqual(captured["json_body"]["tool_choice"], "required")
        self.assertEqual(captured["json_body"]["temperature"], 0)


if __name__ == "__main__":
    unittest.main()
