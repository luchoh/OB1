"""Integration tests against the live local services.

WHY THIS FILE EXISTS
--------------------
Every other test in this repo replaces the services with hand-written fakes.
That is fast and it is where most logic belongs — but during the 2026-08 imap
retry work, four separate defects survived a full unit suite *because* the
fakes were wrong, and every one of them lived at a seam between our code and
something else:

  - `requests.Response` defines __bool__ as `status_code < 400`, so a real 4xx
    response is FALSY. The fakes were plain objects and always truthy, so
    `if not resp:` discarded the status on every error path and no test could
    see it. It survived five rounds of review.
  - `CaptureError` exposes `.status_code`; two newer exceptions expose
    `.status`. Reading only `.status` silently dropped a rejection's status.
  - A record fixture omitted the top-level `uid` that parse_imap_record sets,
    so failure records were written with `uid=None`.
  - A test supplied `max_attempts` in the dict it asserted on, so it passed
    while live output printed "poison 2/?".

A fake encodes what we BELIEVE about a service. These tests ask the service.

The model server and Docling need no credentials, so most of this runs
anywhere the services are reachable. Anything that writes needs a key and
skips without one.

Run them deliberately — they are not part of the default suite:

    OB1_INTEGRATION=1 python3 tests/integration/test_live_contracts.py -v

The model-contract tests additionally need OB1_INTEGRATION_MODEL=<name>,
because asking for a model that is not resident evicts whatever is. Everything
else is genuinely free.

or, equivalently:

    OB1_INTEGRATION=1 python3 -m unittest discover \
        -s tests/integration -t tests/integration -p 'test_*.py' -v

Note the `-t tests/integration`: this directory is deliberately not a package,
which is what keeps it out of the default suite, and unittest's discovery needs
the top-level directory to be importable.

Set OB1_INTEGRATION=1 to enable. Without it every test skips, so an accidental
run stays green and silent rather than failing on an unreachable service.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import requests  # noqa: E402

from recipes.shared_docling import (  # noqa: E402
    DoclingContentError,
    DoclingHttpError,
    discover_docling_base_url,
    docling_chunk,
    local_llm_base_url,
)

ENABLED = os.environ.get("OB1_INTEGRATION") == "1"

# Naming a model in a request is NOT a read-only act. The inference host is
# shared and memory-constrained: it holds seven models against a 464GB ceiling
# and can keep roughly one large one resident. Asking for a model that is not
# loaded EVICTS whatever is — which this suite did on 2026-08-25, throwing out
# the operator's working model to answer three test prompts.
#
# So the model tests do not run by default and do not guess. /health reports
# loaded_count and current_model_memory but does NOT name the resident model,
# so there is no way to reuse what is already there. The operator names a model
# they are content to have loaded:
#
#     OB1_INTEGRATION_MODEL=GLM-5.2-mxfp4
#
# Unset, the model tests skip. Docling and the ingest endpoint have no such
# cost and run whenever OB1_INTEGRATION=1.
INTEGRATION_MODEL = os.environ.get("OB1_INTEGRATION_MODEL")

# Dev only, always. Prod is 127.0.0.1:8788; writing probe rows into the real
# brain to learn an HTTP status is not a trade worth making.
DEV_INGEST_URL = "http://[::1]:8787/ingest/thought"
PROD_PORTS = ("8788",)

IMAP_RECIPE = REPO_ROOT / "recipes/email-history-import/import-imap.py"


def load_recipe():
    import importlib.util

    spec = importlib.util.spec_from_file_location("imap_live", IMAP_RECIPE)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


def pool_state():
    """loaded_count and resident bytes, or None if /health is unavailable.

    /health does NOT name the resident model — only how many are loaded and
    how much memory they hold — so this can report the cost of a run but
    cannot be used to avoid it. That is why the model tests are opt-in.
    """
    if not MODEL_URL:
        return None
    try:
        base = MODEL_URL.rsplit("/v1", 1)[0]
        pool = requests.get(f"{base}/health", timeout=10).json().get("engine_pool", {})
        return pool.get("loaded_count"), pool.get("current_model_memory")
    except Exception:
        return None


def reachable(fn):
    """Resolve a service URL, or return None if it cannot be reached.

    Discovery goes through Consul, so an unreachable service raises rather
    than returning a dead address.
    """
    try:
        return fn()
    except Exception:
        return None


MODEL_URL = reachable(local_llm_base_url) if ENABLED else None
DOCLING_URL = reachable(discover_docling_base_url) if ENABLED else None
INGEST_KEY = os.environ.get("OPEN_BRAIN_INGEST_KEY") or os.environ.get("MCP_ACCESS_KEY")

needs_enabled = unittest.skipUnless(ENABLED, "set OB1_INTEGRATION=1 to run live tests")
needs_model = unittest.skipUnless(MODEL_URL, "model server unreachable")
needs_docling = unittest.skipUnless(DOCLING_URL, "docling unreachable")
needs_key = unittest.skipUnless(
    INGEST_KEY, "no OPEN_BRAIN_INGEST_KEY / MCP_ACCESS_KEY in the environment"
)
needs_named_model = unittest.skipUnless(
    INTEGRATION_MODEL,
    "set OB1_INTEGRATION_MODEL=<name> to run model tests; asking for a model "
    "that is not resident evicts whatever is",
)


@needs_enabled
@needs_model
@needs_named_model
class LiveModelContractTests(unittest.TestCase):
    """Does the model server actually honour the contract we send it?

    Costs memory on a shared host — see OB1_INTEGRATION_MODEL above. Run
    deliberately, naming a model you are happy to have loaded.

    This whole retry mechanism exists because on 2026-08-11 it did not: the
    request carried tool_choice "required" and the answer came back with
    finish_reason=stop, no tool_calls, and the object in message.content. That
    was measured from a daemon log. Until this test existed, nothing checked
    whether it was still true — so we could not tell whether the content
    fallback was load-bearing today or a historical artefact.
    """

    def _distil(self, body_text):
        recipe = load_recipe()
        response = requests.post(
            MODEL_URL + "/chat/completions",
            json={
                # The operator's choice, never LOCAL_LLM_MODEL: defaulting to
                # the configured model is what evicted a resident one.
                "model": INTEGRATION_MODEL,
                "temperature": 0,
                "max_tokens": 700,
                "chat_template_kwargs": {"enable_thinking": recipe.LOCAL_LLM_ENABLE_THINKING},
                "tools": [recipe.THOUGHTS_TOOL],
                "tool_choice": "required",
                "messages": [
                    {"role": "system", "content": recipe.EMAIL_THOUGHT_PROMPT},
                    {"role": "user", "content": body_text},
                ],
            },
            timeout=120,
        )
        if response.status_code >= 500:
            # The service being unavailable is not a contract violation, and a
            # test that cannot tell those apart is worse than no test: it goes
            # red during an outage and trains people to ignore it. This is the
            # same transport-versus-poison distinction the production code
            # makes, applied to the test suite.
            self.skipTest(
                f"model server unavailable (HTTP {response.status_code}): "
                f"{response.text[:160]}"
            )
        self.assertEqual(response.status_code, 200, response.text[:200])
        return recipe, response.json()

    @classmethod
    def setUpClass(cls):
        cls._before = pool_state()
        if cls._before:
            loaded, memory = cls._before
            print(f"\n    [model pool before] loaded={loaded} "
                  f"resident={memory / 2**30:.1f}GB — asking for {INTEGRATION_MODEL!r}")

    @classmethod
    def tearDownClass(cls):
        after = pool_state()
        if cls._before and after and after != cls._before:
            print(f"    [model pool after ] loaded={after[0]} "
                  f"resident={after[1] / 2**30:.1f}GB  <- CHANGED; a model was "
                  "loaded or evicted to serve these tests")

    def test_the_live_response_is_one_our_parser_accepts(self):
        """The claim that matters: whatever it returns today, we handle it.

        Deliberately not asserting WHICH shape comes back. Both are legitimate
        — a tool call is the contract kept, and content is the breach we know
        it is capable of — and pinning one would turn a recovered service into
        a red build.

        Also reports the shape, rather than spending a second inference on a
        separate test to do it. Every request here costs memory on a shared
        host, so the suite asks as few times as it can.
        """
        recipe, payload = self._distil(
            "Subject: Q3 planning\n\nWe agreed to move the migration to Sept 30. "
            "Marcus owns the rollback plan."
        )
        choice = payload["choices"][0]
        message = choice.get("message", {})
        print(
            f"\n    live model contract: model={INTEGRATION_MODEL} "
            f"finish_reason={choice.get('finish_reason')!r} "
            f"tool_calls={bool(message.get('tool_calls'))} "
            f"content={'present' if message.get('content') else 'absent'}"
        )
        self.assertIn(choice.get("finish_reason"), ("tool_calls", "stop"))

        result = recipe.extract_tool_arguments(
            payload, "submit_thoughts", scrape_content=False
        )
        thoughts = recipe.validate_thoughts_payload(result)
        self.assertIsInstance(thoughts, list)
        for item in thoughts:
            self.assertIsInstance(item, str)

    def test_an_empty_answer_is_a_success_not_a_failure(self):
        """A message with nothing durable in it must come back as [] rather
        than as an error. Conflating those is what made the original stall
        invisible: 'found nothing' and 'could not process' shared a signal."""
        recipe, payload = self._distil("Subject: Re: lunch\n\nSounds good, see you then.")
        result = recipe.extract_tool_arguments(
            payload, "submit_thoughts", scrape_content=False
        )
        self.assertEqual(recipe.validate_thoughts_payload(result), [])


needs_docling_opt_in = unittest.skipUnless(
    os.environ.get("OB1_INTEGRATION_DOCLING") == "1",
    "set OB1_INTEGRATION_DOCLING=1 — an unreadable file yields zero chunks, "
    "which triggers the VLM fallback on the shared Docling host",
)


@needs_enabled
@needs_docling
@needs_docling_opt_in
class LiveDoclingBehaviourTests(unittest.TestCase):
    """What Docling actually does with a file it cannot read.

    The classifier distinguishes "this file is unprocessable" from "Docling is
    down", and the code carries HTTP statuses around to tell them apart. That
    machinery was built on an assumption about Docling's behaviour that was
    never checked.
    """

    def _junk(self, tmpdir, name="junk.pdf", data=b"this is definitely not a pdf"):
        path = Path(tmpdir) / name
        path.write_bytes(data)
        return path

    def test_an_unreadable_file_raises_a_content_error_not_a_status_error(self):
        """The live path for a bad attachment.

        Docling answers 200 with zero chunks rather than rejecting the file, so
        DoclingContentError is what actually fires. If this ever becomes a
        DoclingHttpError, the status-carrying code earns its keep; while it
        does not, that code is defending a case this service does not produce.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            with self.assertRaises(Exception) as ctx:
                docling_chunk(DOCLING_URL, self._junk(tmpdir), "hybrid")
        self.assertIsInstance(
            ctx.exception,
            DoclingContentError,
            f"expected a content error, got {type(ctx.exception).__name__}: "
            f"{ctx.exception}",
        )
        self.assertNotIsInstance(ctx.exception, DoclingHttpError)


    def test_docling_answers_200_for_files_it_cannot_read(self):
        """Records the behaviour the classifier depends on.

        Not a style preference: if Docling starts returning 4xx for bad files,
        the zero-chunk branch stops being the live path and this test says so
        before a stale assumption does any harm.
        """
        observed = []
        with tempfile.TemporaryDirectory() as tmpdir:
            for name, data in (("junk.pdf", b"nope"), ("empty.pdf", b"")):
                path = self._junk(tmpdir, name, data)
                with path.open("rb") as handle:
                    response = requests.post(
                        f"{DOCLING_URL}/v1/chunk/hybrid/file",
                        files={"files": (name, handle, "application/pdf")},
                        data={"convert_pipeline": "standard", "target_type": "inbody"},
                        timeout=90,
                    )
                observed.append((name, response.status_code,
                                 len(response.json().get("chunks", []))))
        print(f"\n    docling on unreadable files: {observed}")
        for name, status, chunks in observed:
            self.assertEqual(status, 200, f"{name} returned {status}")
            self.assertEqual(chunks, 0, f"{name} produced chunks unexpectedly")


@needs_enabled
@needs_docling
class LiveResponseSemanticsTests(unittest.TestCase):
    """The trap that no fake in this repo reproduced."""

    def test_a_real_error_response_is_falsy(self):
        """`requests.Response.__bool__` is `status_code < 400`.

        Five review rounds passed over `if not resp:` because every fake was a
        plain object and therefore truthy. One request to a real endpoint shows
        it immediately.
        """
        response = requests.post(f"{DOCLING_URL}/v1/chunk/nonexistent/file",
                                 files={"files": ("a.pdf", b"x")}, timeout=30)
        self.assertGreaterEqual(response.status_code, 400)
        self.assertFalse(
            bool(response),
            "a real error response is falsy — code must test `resp is None`, "
            "never `not resp`, or it discards the status it needs",
        )



@needs_enabled
@needs_key
class LiveIngestRejectionTests(unittest.TestCase):
    """Which statuses OB1 returns when it refuses a capture.

    Nothing classifies these any more — a rejection is recorded and retried
    like any other failure. What the status still does is reach the failure
    record, where an operator reads it in --list-failures and decides.

    Dev only. A probe that writes rows into the real brain to learn a status
    code is not a trade worth making.
    """

    def setUp(self):
        self.assertFalse(
            any(port in DEV_INGEST_URL for port in PROD_PORTS),
            "refusing to probe the production ingest endpoint",
        )
        self.recipe = load_recipe()
        self.headers = {
            "Content-Type": "application/json",
            "x-access-key": INGEST_KEY,
            "x-ingest-key": INGEST_KEY,
        }

    def _post(self, body):
        return requests.post(
            DEV_INGEST_URL,
            data=body if isinstance(body, str) else json.dumps(body),
            headers=self.headers,
            timeout=20,
        )

    def test_report_the_real_rejection_statuses(self):
        """A record, so the allowlist can be checked against reality."""
        observed = {}
        for label, body in (
            ("missing content", {"metadata": {}, "source": "integration-probe"}),
            ("content wrong type", {"content": 12345, "metadata": {},
                                    "source": "integration-probe"}),
            ("malformed json", "this is not json"),
        ):
            response = self._post(body)
            observed[label] = response.status_code
        print(f"\n    ob1 ingest rejections: {observed}")
        for label, status in observed.items():
            with self.subTest(case=label):
                self.assertGreaterEqual(status, 400, f"{label} was accepted")



if __name__ == "__main__":
    unittest.main()
