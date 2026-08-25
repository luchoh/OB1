from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from types import SimpleNamespace


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


IMAP_RECIPE = "recipes/email-history-import/import-imap.py"

RECORD = {
    "content": "Body text",
    "subject": "Subject",
    "date_iso": "2026-08-11T00:00:00+00:00",
    "metadata": {"mailbox": "INBOX", "sender": "someone@example.com", "attachment_names": []},
}


class FakeResponse:
    # import-imap.py gates on resp.status_code before parsing, unlike the
    # dictation importer — a fake without it fails for the wrong reason.
    status_code = 200

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


def tool_call_response(arguments_json: str):
    return {
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


def content_only_response(content: str):
    # The measured 2026-08-11 server breach: tool_choice "required" was sent,
    # the server answered finish_reason=stop with no tool_calls at all.
    return {"choices": [{"finish_reason": "stop", "message": {"content": content}}]}


def run_distill(response_payload, captured=None):
    importer = load_module("imap_import_llm_contract", IMAP_RECIPE)

    def fake_post(url, headers=None, body=None, retries=2, timeout=120):
        # import-imap.py's local http_post_with_retry takes `body`, not the
        # shared module's keyword-only `json_body`.
        if captured is not None:
            captured["url"] = url
            captured["headers"] = headers
            captured["body"] = body
            captured["timeout"] = timeout
        return FakeResponse(response_payload)

    importer.http_post_with_retry = fake_post
    importer.local_llm_base_url = lambda: "http://fake-llm/v1"
    return importer.distill_email_thoughts(RECORD)


class ImapImportRequestContractTests(unittest.TestCase):
    """Request contract for the email distillation call.

    tool_choice stays "required" and the prompt was rewritten to demand the
    tool call, so both halves of the request point the same way. The server
    has been observed BREACHING "required" (2026-08-11: finish_reason=stop,
    no tool_calls, 6 completion tokens), which is why the parser must not
    assume a tool call — but that is the parser's job, not the request's.
    "required" is kept because docs/08-vllm-mlx-no-thinking.md recommends it
    for this stack and it constrains decoding when honoured; note that the
    doc's truncation measurements are about `response_format`, not about
    prompt-only contracts, so this is a preference, not a measured verdict
    against "auto".
    """

    def test_request_uses_required_tool_choice_and_zero_temperature(self):
        captured = {}
        run_distill(tool_call_response('{"thoughts": []}'), captured)

        self.assertEqual(captured["body"]["tool_choice"], "required")
        self.assertEqual(captured["body"]["temperature"], 0)
        self.assertEqual(captured["body"]["tools"][0]["function"]["name"], "submit_thoughts")

    def test_prompt_demands_the_tool_call_instead_of_a_json_object(self):
        captured = {}
        run_distill(tool_call_response('{"thoughts": []}'), captured)

        system_prompt = captured["body"]["messages"][0]["content"]
        self.assertIn("submit_thoughts", system_prompt)
        self.assertNotIn("Return a JSON object", system_prompt)


class ImapImportDistillationParsingTests(unittest.TestCase):
    """Regression for the 2026-08-11 imap distillation stall.

    845 consecutive ob1-imap-watch cycles exited 1 with "distillation failed:
    Model did not return a tool call" because the divergent strict parser in
    import-imap.py rejected the content-only {"thoughts": []} the server sent
    instead of the demanded tool call. The failure path `continue`s past the
    sync-log write, so the same message was reprocessed every cycle forever.
    """

    def test_the_measured_breach_shape_succeeds(self):
        """The exact 2026-08-11 response. Must yield [] and not raise."""
        self.assertEqual(run_distill(content_only_response('{"thoughts": []}')), [])

    def test_a_normal_tool_call_still_parses(self):
        self.assertEqual(
            run_distill(tool_call_response('{"thoughts": ["Thought A", "Thought B"]}')),
            ["Thought A", "Thought B"],
        )

    def test_content_only_thoughts_parse(self):
        self.assertEqual(
            run_distill(content_only_response('{"thoughts": ["Thought A"]}')),
            ["Thought A"],
        )

    def test_missing_thoughts_key_raises(self):
        # `{}` used to become [] via result.get("thoughts", []) and retire the
        # email as "no durable content"; the tool's schema marks "thoughts"
        # required, so an absent key is a broken response, not an empty answer.
        with self.assertRaises(ValueError) as ctx:
            run_distill(tool_call_response("{}"))
        self.assertIn('missing the "thoughts" key', str(ctx.exception))

    def test_thoughts_not_a_list_raises(self):
        with self.assertRaises(ValueError) as ctx:
            run_distill(content_only_response('{"thoughts": "just a string"}'))
        self.assertIn("must be a list", str(ctx.exception))

    def test_thoughts_with_non_string_items_raises(self):
        with self.assertRaises(ValueError) as ctx:
            run_distill(content_only_response('{"thoughts": [{"text": "A"}, 5]}'))
        self.assertIn("must be a string", str(ctx.exception))

    def test_bare_json_list_raises(self):
        with self.assertRaises(ValueError) as ctx:
            run_distill(content_only_response('["Thought A", "Thought B"]'))
        self.assertIn("thoughts object", str(ctx.exception))

    def test_prose_without_json_raises(self):
        with self.assertRaises(ValueError) as ctx:
            run_distill(content_only_response("I am not going to do that."))
        self.assertIn("Model did not return a tool call", str(ctx.exception))

    def test_malformed_envelope_reports_a_diagnosis(self):
        with self.assertRaises(ValueError) as ctx:
            run_distill({"choices": []})
        self.assertIn("Model did not return a tool call", str(ctx.exception))



class FakeImapClient:
    def __init__(self):
        self.logged_out = False

    def select(self, mailbox, readonly=True):
        return "OK", None

    def logout(self):
        self.logged_out = True


def run_main_cycle(
    importer, response_payload, *, uid="1", max_attempts=5, retry_dead_lettered=False
):
    """Drive main() over one message with everything but distillation faked.

    distill_email_thoughts itself is NOT faked — the point is to run the real
    parser and watch what the loop does with its result.
    """
    record = {
        # parse_imap_record puts uid at the top level (import-imap.py) — the
        # fixture must match, or failure records silently lose the one field an
        # operator needs to find the message.
        "uid": uid,
        "content": "Body text",
        "subject": "Subject",
        "date_iso": "2026-08-11T00:00:00+00:00",
        "dedupe_key": f"imap:test:{uid}",
        "attachments": [],
        "metadata": {
            "mailbox": "INBOX",
            "sender": "someone@example.com",
            "attachment_names": [],
            "imap_uid": uid,
        },
    }

    importer.parse_args = lambda: SimpleNamespace(
        host="imap.example.com",
        port=993,
        username="user@example.com",
        password="secret",
        mailbox="INBOX",
        no_ssl=False,
        list_mailboxes=False,
        since=None,
        before=None,
        limit=None,
        dry_run=False,
        strip_quotes=False,
        ignore_sync_log=False,
        skip_empty=False,
        no_distill=False,
        no_attachments=True,
        attachments_only=False,
        attachment_names=None,
        verbose=False,
        max_attempts=max_attempts,
        retry_dead_lettered=retry_dead_lettered,
        list_failures=False,
    )
    importer.LOCAL_INGEST_KEY = "test-key"
    importer.connect_imap = lambda *a, **kw: (FakeImapClient(), "user@example.com")
    importer.imap_response_code = lambda client, code_name: "1"
    importer.fetch_uid_list = lambda client, args: [uid]
    importer.fetch_message_bytes = lambda client, message_uid: (b"raw", [])
    importer.parse_imap_record = lambda **kwargs: record
    importer.ingest_email = lambda rec, dry_run=False: {"ok": True}
    importer.ingest_email_thought = lambda *a, **kw: {"ok": True}
    importer.local_llm_base_url = lambda: "http://fake-llm/v1"
    importer.http_post_with_retry = lambda url, headers=None, body=None, retries=2, timeout=120: (
        FakeResponse(response_payload)
    )

    stdout = io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(io.StringIO()):
        exit_code = importer.main()
    return exit_code, stdout.getvalue(), record["dedupe_key"]



class ImapImportContentScrapeTests(unittest.TestCase):
    """This caller does not scrape a JSON object out of prose.

    Adopting the shared parser fixed the 845-cycle loop, but for three shapes
    it replaced the loop with something quieter and worse: prose wrapped around
    {"thoughts": []} was scraped down to a successful empty result, the model's
    stated reason thrown away, and the email retired via the sync log. The loop
    was visible and lost nothing; this loses the message.

    The scrape stays ON for import-dictation and import-documents, which can
    simply run again. Only an irreversible verdict pays for refusing.
    """

    def test_the_measured_breach_is_still_accepted(self):
        """Whole-string JSON — the actual 2026-08-11 response."""
        self.assertEqual(run_distill(content_only_response('{"thoughts": []}')), [])

    def test_code_fenced_content_is_still_accepted(self):
        """Fences are stripped before parsing, so this is JSON end to end."""
        self.assertEqual(
            run_distill(content_only_response('```json\n{"thoughts": ["A"]}\n```')), ["A"]
        )

    def test_a_refusal_wrapped_around_an_empty_object_is_refused(self):
        with self.assertRaises(ValueError) as ctx:
            run_distill(content_only_response(
                'I could not read this email. {"thoughts": []}'))
        self.assertIn("did not return a tool call", str(ctx.exception))

    def test_a_self_correcting_answer_is_refused(self):
        """The model was still thinking; the first object is not the answer."""
        with self.assertRaises(ValueError):
            run_distill(content_only_response(
                'First pass: {"thoughts": []}. But wait, the sender commits to '
                "shipping the migration by Friday, so the real answer should be"))

    def test_a_retracted_thought_is_not_ingested(self):
        """Scraping would store a thought the model explicitly takes back."""
        with self.assertRaises(ValueError):
            run_distill(content_only_response(
                '{"thoughts": ["Wrong reading of the email"]} Correction: ignore '
                "the above, the email is about"))



class ImapImportFallbackHardeningTests(unittest.TestCase):
    """The content fallback's other two doors, closed for this caller only.

    Narrowing the JSON scrape left the same defect reachable two other ways,
    both of which this recipe was NOT exposed to before it adopted the shared
    parser — it looped instead. A loop is loud and loses nothing; being
    recorded as "no durable content" retires the email via the sync log.

    Neither is gated on the tool-call path. A real tool call is the contract
    working, and that path is left alone.
    """

    def _content(self, text, finish_reason="stop"):
        return {"choices": [{"finish_reason": finish_reason, "message": {"content": text}}]}

    MARKUP = "<function=submit_thoughts><parameter=thoughts>[]</parameter></function>"

    def test_inline_markup_is_not_lifted_out_of_content(self):
        """Same "payload pulled out of text" shape as the JSON scrape."""
        with self.assertRaises(ValueError):
            run_distill(self._content(self.MARKUP))

    def test_a_refusal_wrapped_around_inline_markup_is_refused(self):
        with self.assertRaises(ValueError):
            run_distill(self._content("I could not read the attachment. " + self.MARKUP))

    def test_only_a_finished_response_is_read_as_content(self):
        # The object below is complete and well-formed in every case; only
        # finish_reason says whether the model actually got to the end.
        for finish_reason in ("length", "content_filter", "error", "tool_calls", "", None):
            with self.subTest(finish_reason=finish_reason):
                with self.assertRaises(ValueError) as ctx:
                    run_distill(self._content('{"thoughts": []}', finish_reason))
                self.assertIn("finish_reason", str(ctx.exception))

    def test_a_missing_finish_reason_is_refused_not_assumed_benign(self):
        with self.assertRaises(ValueError):
            run_distill({"choices": [{"message": {"content": '{"thoughts": []}'}}]})

    def test_the_measured_breach_still_survives_all_of_it(self):
        """finish_reason=stop, no tool_calls, whole-string JSON."""
        self.assertEqual(run_distill(self._content('{"thoughts": []}')), [])

    def test_a_tool_call_is_not_gated_on_finish_reason(self):
        """Deliberately untouched: never observed, and rejecting costs a stall."""
        payload = tool_call_response('{"thoughts": ["A"]}')
        payload["choices"][0]["finish_reason"] = "length"
        self.assertEqual(run_distill(payload), ["A"])



class ImapImportSchemaStrictnessTests(unittest.TestCase):
    """The declared schema is the rule, not a blacklist of bad keys.

    {"thoughts": [], "error": "could not read the attachment"} passed as a
    successful empty result, discarding the stated reason and retiring the
    message. Blacklisting "error" would only move the problem to whichever key
    the model reaches for next.
    """

    def test_an_error_key_beside_an_empty_list_is_refused(self):
        with self.assertRaises(ValueError) as ctx:
            run_distill(tool_call_response('{"thoughts": [], "error": "could not read it"}'))
        self.assertIn("declared schema", str(ctx.exception))

    def test_any_undeclared_key_is_refused_not_only_error(self):
        for extra in ('"reason": "none"', '"refusal": "no"', '"note": "x"'):
            with self.subTest(extra=extra):
                with self.assertRaises(ValueError):
                    run_distill(tool_call_response('{"thoughts": [], %s}' % extra))


class ImapImportSyncLogProgressTests(unittest.TestCase):
    """The load-bearing claim of the 2026-08-11 fix: the loop actually ends.

    distill_email_thoughts returning [] is only half the story. The failure
    path in main() `continue`s past the sync-log write, so if a zero-thought
    message were ever treated as a failure — or if the write were guarded on
    `if thoughts:` — the message would be reprocessed every cycle forever and
    the incident would recur with a green unit suite. These tests pin the
    whole path: parse -> [] -> sync log -> skipped next cycle.
    """

    def _run(self, response_payload, cycles=1):
        with tempfile.TemporaryDirectory() as tmpdir:
            sync_log_path = Path(tmpdir) / "imap-sync-log.json"
            outputs = []
            for _ in range(cycles):
                importer = load_module("imap_import_sync_log", IMAP_RECIPE)
                importer.SYNC_LOG_PATH = sync_log_path
                outputs.append(run_main_cycle(importer, response_payload))
            saved = (
                json.loads(sync_log_path.read_text()) if sync_log_path.exists() else None
            )
        return outputs, saved

    def test_empty_distillation_is_recorded_and_skipped_next_cycle(self):
        # The exact measured 2026-08-11 response.
        outputs, saved = self._run(content_only_response('{"thoughts": []}'), cycles=2)

        first_code, first_out, dedupe_key = outputs[0]
        self.assertEqual(first_code, 0, msg=first_out)
        self.assertIn("failures=0", first_out)
        self.assertIsNotNone(saved)
        self.assertIn(dedupe_key, saved["ingested_ids"])

        second_code, second_out, _ = outputs[1]
        self.assertEqual(second_code, 0, msg=second_out)
        self.assertIn("skipped_already_imported=1", second_out)
        self.assertIn("processed=1", second_out)
        # Nothing was re-distilled on the second cycle.
        self.assertIn("imported=0", second_out)

    def test_message_with_thoughts_is_also_recorded(self):
        outputs, saved = self._run(tool_call_response('{"thoughts": ["Thought A"]}'))

        code, out, dedupe_key = outputs[0]
        self.assertEqual(code, 0, msg=out)
        self.assertIn("distilled=1", out)
        self.assertIn(dedupe_key, saved["ingested_ids"])

    def test_a_rejection_is_never_recorded_as_ingested(self):
        """The invariant that must survive dead-lettering.

        A message that could not be processed must not land in ingested_ids —
        that is the difference between "nothing durable in it" and "we could not
        read it", and collapsing them would lose the email silently.
        """
        outputs, saved = self._run(content_only_response("I am not going to do that."))

        code, out, dedupe_key = outputs[0]
        self.assertEqual(code, 1)
        self.assertIn("failures=1", out)
        self.assertNotIn(dedupe_key, saved["ingested_ids"])
        self.assertIn(dedupe_key, saved["failed_ids"])

    def test_an_empty_distillation_is_not_recorded_as_a_failure(self):
        """"Found nothing durable" and "could not process" must not share a
        signal. Conflating them is part of why the stall was invisible."""
        outputs, saved = self._run(content_only_response('{"thoughts": []}'))

        code, out, dedupe_key = outputs[0]
        self.assertEqual(code, 0, msg=out)
        self.assertIn("failures=0", out)
        self.assertEqual(saved["failed_ids"], {})
        self.assertIn(dedupe_key, saved["ingested_ids"])


class ImapImportRetryAndDeadLetterTests(unittest.TestCase):
    """The amplifier: one bad response must not wedge the mailbox forever.

    Before this, ANY exception left the message unrecorded, so should_skip never
    skipped it and it was reprocessed every cycle. On 2026-08-11 that turned a
    single unparseable response into ~1,800 identical failed cycles across
    fourteen days, with no bound and no signal.

    Backoff is set to 0 in these tests so a "next cycle" is immediate; the real
    default deliberately outlasts one ~7-minute cycle.
    """

    def _run(self, response_payload, *, cycles=1, max_attempts=3, retry_last=False):
        with tempfile.TemporaryDirectory() as tmpdir:
            sync_log_path = Path(tmpdir) / "imap-sync-log.json"
            outputs = []
            for index in range(cycles):
                importer = load_module("imap_import_retry", IMAP_RECIPE)
                importer.SYNC_LOG_PATH = sync_log_path
                importer.FAILURE_BACKOFF_BASE_MINUTES = 0
                outputs.append(run_main_cycle(
                    importer,
                    response_payload,
                    max_attempts=max_attempts,
                    retry_dead_lettered=retry_last and index == cycles - 1,
                ))
            saved = json.loads(sync_log_path.read_text())
        return outputs, saved

    REFUSAL = "I am not going to do that."

    def test_a_failure_is_recorded_with_an_attempt_count(self):
        outputs, saved = self._run(content_only_response(self.REFUSAL))
        _, out, dedupe_key = outputs[0]

        entry = saved["failed_ids"][dedupe_key]
        self.assertEqual(entry["attempts"], 1)
        self.assertEqual(entry["stage"], "distillation")
        self.assertFalse(entry["dead_lettered"])
        self.assertIn("Model did not return a tool call", entry["last_error"])
        self.assertIn("retrying_total=1", out)

    def test_attempts_accumulate_across_cycles(self):
        outputs, saved = self._run(content_only_response(self.REFUSAL), cycles=2)
        _, out, dedupe_key = outputs[1]
        self.assertEqual(saved["failed_ids"][dedupe_key]["attempts"], 2)

    def test_the_message_is_dead_lettered_and_then_left_alone(self):
        """The whole point: retries are BOUNDED. Cycle 4 must not re-distil."""
        outputs, saved = self._run(
            content_only_response(self.REFUSAL), cycles=4, max_attempts=3
        )
        dedupe_key = outputs[0][2]

        entry = saved["failed_ids"][dedupe_key]
        self.assertEqual(entry["attempts"], 3, "must stop at max_attempts, not keep counting")
        self.assertTrue(entry["dead_lettered"])
        self.assertIsNone(entry["next_attempt_at"])

        third_code, third_out, _ = outputs[2]
        self.assertIn("dead_lettered_new=1", third_out)
        self.assertEqual(third_code, 1, "the cycle that gives up should be non-zero")

        fourth_code, fourth_out, _ = outputs[3]
        self.assertIn("skipped_dead_lettered=1", fourth_out)
        self.assertIn("failures=0", fourth_out)
        self.assertEqual(fourth_code, 0, "a dead-lettered message must not keep the cycle red")

    def test_a_dead_lettered_message_is_not_marked_ingested(self):
        """Dead-lettering must not be a rebranded silent success."""
        outputs, saved = self._run(
            content_only_response(self.REFUSAL), cycles=3, max_attempts=3
        )
        dedupe_key = outputs[0][2]
        self.assertNotIn(dedupe_key, saved["ingested_ids"])
        self.assertTrue(saved["failed_ids"][dedupe_key]["dead_lettered"])

    def test_the_failure_record_keeps_enough_to_identify_the_message(self):
        _, saved = self._run(content_only_response(self.REFUSAL))
        entry = next(iter(saved["failed_ids"].values()))
        for field in ("uid", "subject", "date_iso", "stage", "last_error",
                      "first_failed_at", "last_failed_at", "attempts"):
            self.assertIn(field, entry)
        # Not merely present — populated. A record whose uid is None cannot be
        # found in the mailbox, which defeats the point of dead-lettering it.
        self.assertEqual(entry["uid"], "1")
        self.assertEqual(entry["subject"], "Subject")

    def test_retry_dead_lettered_requeues_the_message(self):
        """Nothing is permanently lost once the cause is fixed."""
        outputs, _ = self._run(
            content_only_response(self.REFUSAL), cycles=4, max_attempts=3, retry_last=True
        )
        _, fourth_out, _ = outputs[3]
        self.assertNotIn("skipped_dead_lettered", fourth_out)
        self.assertIn("failures=1", fourth_out)

    def test_success_clears_a_prior_failure(self):
        """One transient error must not count against a message forever."""
        with tempfile.TemporaryDirectory() as tmpdir:
            sync_log_path = Path(tmpdir) / "imap-sync-log.json"

            importer = load_module("imap_import_retry", IMAP_RECIPE)
            importer.SYNC_LOG_PATH = sync_log_path
            importer.FAILURE_BACKOFF_BASE_MINUTES = 0
            _, _, dedupe_key = run_main_cycle(
                importer, content_only_response(self.REFUSAL), max_attempts=3
            )
            self.assertIn(dedupe_key, json.loads(sync_log_path.read_text())["failed_ids"])

            importer = load_module("imap_import_retry", IMAP_RECIPE)
            importer.SYNC_LOG_PATH = sync_log_path
            importer.FAILURE_BACKOFF_BASE_MINUTES = 0
            code, out, _ = run_main_cycle(
                importer, content_only_response('{"thoughts": ["A"]}'), max_attempts=3
            )

            saved = json.loads(sync_log_path.read_text())
            self.assertEqual(code, 0, msg=out)
            self.assertEqual(saved["failed_ids"], {}, "a success must clear the failure record")
            self.assertIn(dedupe_key, saved["ingested_ids"])

    def test_backoff_defers_the_retry_rather_than_burning_a_cycle(self):
        """With the real backoff, a failing message is SKIPPED next cycle — it
        does not cost another Docling+LLM round trip every ~7 minutes."""
        with tempfile.TemporaryDirectory() as tmpdir:
            sync_log_path = Path(tmpdir) / "imap-sync-log.json"
            outs = []
            for _ in range(2):
                importer = load_module("imap_import_retry", IMAP_RECIPE)
                importer.SYNC_LOG_PATH = sync_log_path
                outs.append(run_main_cycle(
                    importer, content_only_response(self.REFUSAL), max_attempts=5
                ))
            saved = json.loads(sync_log_path.read_text())

        self.assertIn("failures=1", outs[0][1])
        second_code, second_out, dedupe_key = outs[1]
        self.assertIn("skipped_failure_backoff=1", second_out)
        self.assertIn("failures=0", second_out)
        self.assertEqual(second_code, 0)
        self.assertEqual(saved["failed_ids"][dedupe_key]["attempts"], 1,
                         "the deferred cycle must not count as an attempt")


if __name__ == "__main__":
    unittest.main()
