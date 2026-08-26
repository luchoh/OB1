from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from datetime import datetime, timedelta, timezone
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


class ImapImportModelFallbackTests(unittest.TestCase):
    """A memory squeeze on the inference host must not stall the mailbox.

    The host holds several models and cannot fit them all. When something large
    is resident, loading the configured model is refused with HTTP 507 — seen
    live on 2026-08-25: "projected memory 534.49GB would exceed the memory
    ceiling 464.00GB". Every distillation in the cycle fails until memory frees.
    """

    def _run(self, statuses, *, fallback="GLM-5.2-mxfp4"):
        """Drive distillation with a scripted sequence of HTTP statuses."""
        m = load_module("imap_fallback", IMAP_RECIPE)
        m.LLM_FALLBACK_MODEL = fallback
        m.local_llm_base_url = lambda: "http://fake/v1"
        asked = []
        seq = list(statuses)

        def post(url, headers=None, body=None, retries=2, timeout=120):
            asked.append(body["model"])
            status = seq.pop(0)
            if status is None:
                return None
            return FakeResponse(tool_call_response('{"thoughts": ["A"]}')) if status == 200 \
                else _StatusOnly(status)

        class _StatusOnly:
            def __init__(self, status): self.status_code = status
            def json(self): return {}

        m.http_post_with_retry = post
        record = {"content": "b", "subject": "s", "date_iso": "",
                  "metadata": {"mailbox": "INBOX", "sender": "x",
                               "attachment_names": []}}
        try:
            thoughts = m.distill_email_thoughts(record)
            return asked, thoughts, record, None
        except Exception as exc:
            return asked, None, record, exc

    def test_a_507_falls_back_to_the_smaller_model(self):
        asked, thoughts, record, exc = self._run([507, 200])
        self.assertIsNone(exc)
        self.assertEqual(asked, ["DeepSeek-V4-Flash-nvfp4", "GLM-5.2-mxfp4"])
        self.assertEqual(thoughts, ["A"])

    def test_the_model_that_answered_is_recorded(self):
        """Provenance. A fallback that silently changes what wrote a memory,
        leaving no trace, is the same shape as every other defect here."""
        _, _, record, _ = self._run([507, 200])
        self.assertEqual(record["metadata"]["distilled_by_model"], "GLM-5.2-mxfp4")

    def test_the_primary_is_recorded_when_no_fallback_happens(self):
        _, _, record, _ = self._run([200])
        self.assertEqual(record["metadata"]["distilled_by_model"],
                         "DeepSeek-V4-Flash-nvfp4")

    def test_only_507_triggers_a_fallback(self):
        """A 500 or a timeout says nothing about WHICH model was asked for.
        Retrying those against a second model doubles the load on an already
        unhealthy service."""
        for status in (500, 502, 503, None):
            with self.subTest(status=status):
                asked, _, _, exc = self._run([status, 200])
                self.assertEqual(asked, ["DeepSeek-V4-Flash-nvfp4"],
                                 "must not retry a different model")
                self.assertIsNotNone(exc)

    def test_the_recorded_model_reaches_the_stored_thought(self):
        """Provenance is only worth anything if it survives to the capture.

        Recording it on the in-memory record and never sending it would look
        exactly like this test passing while nothing downstream knew which
        model wrote the memory.
        """
        m = load_module("imap_provenance", IMAP_RECIPE)
        m.LOCAL_INGEST_KEY = "k"
        sent = {}

        def post(url, headers=None, body=None, retries=2, timeout=120):
            sent.update(body)
            return FakeResponse({"ok": True})

        m.http_post_with_retry = post
        record = {"content": "b", "subject": "s", "date_iso": "",
                  "dedupe_key": "k",
                  "metadata": {"mailbox": "INBOX", "sender": "x",
                               "attachment_names": [], "imap_uid": "1",
                               "distilled_by_model": "GLM-5.2-mxfp4"}}
        m.ingest_email_thought(record, "a thought", 0, dry_run=False)

        self.assertEqual(
            sent["metadata"].get("distilled_by_model"), "GLM-5.2-mxfp4",
            "the capture must carry which model produced it")

    def test_the_fallback_is_off_by_default(self):
        """A fallback running every cycle evicts the resident model to make room
        for its own — the harm it claims to avoid, on a timer, with no operator
        in the loop. Tests above pass one explicitly; production ships without."""
        m = load_module("imap_fallback_default", IMAP_RECIPE)
        self.assertEqual(m.LLM_FALLBACK_MODEL, "")
        self.assertEqual(m.distillation_models(), [m.LOCAL_LLM_MODEL])

    def test_a_507_is_not_retried_by_the_inner_helper(self):
        """"No memory for this model" does not become false a second later.
        Retrying repeats the load attempt against a host that already said no —
        three times, before any fallback even sees it."""
        m = load_module("imap_507", IMAP_RECIPE)
        calls = {"n": 0}

        class _Resp:
            status_code = 507
            def json(self): return {}

        def fake_post(*a, **kw):
            calls["n"] += 1
            return _Resp()

        m.requests.post = fake_post
        resp = m.http_post_with_retry("http://fake", headers={}, body={})
        self.assertEqual(resp.status_code, 507)
        self.assertEqual(calls["n"], 1, "507 must be returned, not hammered")


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
    importer, response_payload, *, uid="1", give_up=None, requeue=None,
    parse_error=None,
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
        give_up=give_up, give_up_all=False, requeue=requeue, requeue_all=False,
        list_failures=False,
    )
    importer.LOCAL_INGEST_KEY = "test-key"
    importer.connect_imap = lambda *a, **kw: (FakeImapClient(), "user@example.com")
    importer.imap_response_code = lambda client, code_name: "1"
    importer.fetch_uid_list = lambda client, args: [uid]
    importer.fetch_message_bytes = lambda client, message_uid: (b"raw", [])
    def _parse(**kwargs):
        if parse_error is not None:
            raise parse_error
        return record
    importer.parse_imap_record = _parse
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

    def _run(self, response_payload, *, cycles=1, parse_error=None):
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
                    parse_error=parse_error,
                ))
            saved = json.loads(sync_log_path.read_text())
        return outputs, saved

    REFUSAL = "I am not going to do that."

    # A mailbox that has distilled something before: the stage is corroborated,
    # so a refusal can be attributed to the message rather than to the model.
    # Corroboration is a timestamp now, not a flag: "distillation was seen
    # working recently", which is what actually licenses a poison verdict.
    # Nothing to seed any more: corroboration is per-cycle, and the harness's
    # single message never distils successfully, so a distillation refusal
    # there is correctly never retired. The dead-letter path is exercised at
    # the unit level in ImapImportFailurePolicyTests instead.

    def test_attempts_accumulate_across_cycles(self):
        outputs, saved = self._run(content_only_response(self.REFUSAL), cycles=2)
        _, out, dedupe_key = outputs[1]
        self.assertEqual(saved["failed_ids"][dedupe_key]["attempts"], 2)

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

    def test_success_clears_a_prior_failure(self):
        """One transient error must not count against a message forever."""
        with tempfile.TemporaryDirectory() as tmpdir:
            sync_log_path = Path(tmpdir) / "imap-sync-log.json"

            importer = load_module("imap_import_retry", IMAP_RECIPE)
            importer.SYNC_LOG_PATH = sync_log_path
            importer.FAILURE_BACKOFF_BASE_MINUTES = 0
            _, _, dedupe_key = run_main_cycle(
                importer, content_only_response(self.REFUSAL)
            )
            self.assertIn(dedupe_key, json.loads(sync_log_path.read_text())["failed_ids"])

            importer = load_module("imap_import_retry", IMAP_RECIPE)
            importer.SYNC_LOG_PATH = sync_log_path
            importer.FAILURE_BACKOFF_BASE_MINUTES = 0
            code, out, _ = run_main_cycle(
                importer, content_only_response('{"thoughts": ["A"]}')
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
                    importer, content_only_response(self.REFUSAL)
                ))
            saved = json.loads(sync_log_path.read_text())

        self.assertIn("failures=1", outs[0][1])
        second_code, second_out, dedupe_key = outs[1]
        self.assertIn("skipped_failure_backoff=1", second_out)
        self.assertIn("failures=0", second_out)
        self.assertEqual(second_code, 0)
        self.assertEqual(saved["failed_ids"][dedupe_key]["attempts"], 1,
                         "the deferred cycle must not count as an attempt")


class ImapImportFailurePolicyTests(unittest.TestCase):
    """Poison content may be given up on. A broken dependency may not.

    Peer review of the first version found these; each assertion below is a
    defect that shipped and was caught before deploy.
    """

    def _mod(self):
        return load_module("imap_import_policy", IMAP_RECIPE)

    DESC = {"uid": "1", "subject": "s", "date_iso": ""}
    # "everything is working" — the usual backdrop for judging one bad message.

    def test_the_sync_log_is_written_atomically(self):
        """A truncate-in-place write leaves a corrupt log on interruption, and a
        corrupt log reads as an empty one — un-bounding every retry."""
        import os
        m = self._mod()
        with tempfile.TemporaryDirectory() as tmpdir:
            m.SYNC_LOG_PATH = Path(tmpdir) / "s.json"
            m.save_sync_log({"ingested_ids": {"a": 1}, "failed_ids": {}, "last_sync": ""})
            seen = []
            real = os.replace
            os.replace = lambda src, dst: (seen.append((str(src), str(dst))), real(src, dst))[1]
            try:
                m.save_sync_log({"ingested_ids": {"b": 2}, "failed_ids": {}, "last_sync": ""})
            finally:
                os.replace = real
            self.assertTrue(seen, "must swap a file in rather than write the live one")
            src, dst = seen[0]
            self.assertEqual(dst, str(m.SYNC_LOG_PATH))
            self.assertNotEqual(
                src, str(m.SYNC_LOG_PATH),
                "the staged write must go to a DIFFERENT path — replacing the live "
                "file with itself is a truncate-in-place with extra steps")
            self.assertEqual(
                sorted(p.name for p in Path(tmpdir).iterdir()), ["s.json"],
                "no temp file left behind")

    def test_an_unparseable_message_gets_a_key_of_its_own(self):
        """parse_imap_record mints the dedupe_key, so a parse failure has none
        and was invisible to the retry mechanism — it looped forever."""
        m = self._mod()
        key = m.unparsed_key("acct", "INBOX", "42", "7")
        self.assertIn("7", key)
        self.assertIn("42", key)
        self.assertIn("INBOX", key)
        # UIDs are unique per mailbox, so two mailboxes on the same account
        # must not share a retry record.
        self.assertNotEqual(key, m.unparsed_key("acct", "Archive", "42", "7"))
        log = {"ingested_ids": {}, "failed_ids": {}, "last_sync": ""}
        m.note_failure(log, key, self.DESC, "parse", ValueError("bad MIME"), set())
        entry = log["failed_ids"][key]
        self.assertEqual(entry["stage"], "parse")
        self.assertIn("bad MIME", entry["last_error"])
        self.assertIn(key, log["failed_ids"])

    def test_listing_failures_needs_no_credentials(self):
        """Friction here means an operator does not look."""
        m = self._mod()
        with tempfile.TemporaryDirectory() as tmpdir:
            m.SYNC_LOG_PATH = Path(tmpdir) / "s.json"
            m.save_sync_log({"ingested_ids": {}, "last_sync": "", "failed_ids": {
                "imap:1": {"uid": "7", "subject": "Broken", "date_iso": "2026-08-20",
                           "stage": "distillation", "kind": "poison", "attempts": 5,
                           "dead_lettered": True, "last_error": "no tool call",
                           "last_failed_at": "2026-08-20T10:00:00+00:00",
                           "next_attempt_at": None}}})
            m.parse_args = lambda: SimpleNamespace(list_failures=True)
            out = io.StringIO()
            with redirect_stdout(out):
                code = m.main()
        self.assertEqual(code, 0, "must not require host, username, password or ingest key")
        self.assertIn("given_up=", out.getvalue())
        self.assertIn("Broken", out.getvalue())

    def test_a_corrupt_sync_log_refuses_on_every_start_not_just_the_first(self):
        """Refusing once is not refusing.

        An earlier version moved the damaged file aside for forensics, so the
        NEXT daemon start found no sync log, treated it as a clean first run,
        and discarded every attempt count and dead-letter record — the exact
        loss the refusal exists to prevent, caused by the refusal. The test
        that missed this only checked that a sidecar file appeared; it never
        loaded a second time.
        """
        m = self._mod()
        with tempfile.TemporaryDirectory() as tmpdir:
            m.SYNC_LOG_PATH = Path(tmpdir) / "s.json"
            m.SYNC_LOG_PATH.write_text("{ this is not json")

            for attempt in (1, 2, 3):
                with self.subTest(start=attempt):
                    with self.assertRaises(m.SyncLogCorrupt) as ctx:
                        m.load_sync_log()
                    self.assertIn("Refusing to continue", str(ctx.exception))

            self.assertTrue(
                m.SYNC_LOG_PATH.exists(),
                "the damaged file must stay put — moving it aside turns the "
                "next start into a clean first run")
            self.assertEqual([p.name for p in Path(tmpdir).iterdir()], ["s.json"])

    def test_a_missing_sync_log_is_still_a_normal_first_run(self):
        """Absent is not corrupt — a first run must not be an error."""
        m = self._mod()
        with tempfile.TemporaryDirectory() as tmpdir:
            m.SYNC_LOG_PATH = Path(tmpdir) / "s.json"
            log = m.load_sync_log()
        self.assertEqual(log["ingested_ids"], {})
        self.assertEqual(log["failed_ids"], {})

    def test_every_live_failure_site_records(self):
        """A guard against the omission that has now happened twice.

        Each failure site used to repeat note_failure/save/count/print by hand,
        and a site that forgot a step failed silently — that is how message
        parsing, and later the --attachments-only attachment loop, were missed.
        Live sites must go through record_failure; dry-run sites must only
        touch the exit-code counter, never the sync log.
        """
        src = (REPO_ROOT / IMAP_RECIPE).read_text()
        self.assertNotIn(
            "\n                    failures += 1", src,
            "a bare failure counter means a site that bypasses record_failure")
        self.assertEqual(
            src.count("record_failure("), 8,
            "1 definition + 7 live sites: fetch, parse, ingest, attachment x2, "
            "distillation, thought_ingest. If this number changes, a wire was "
            "added or lost — check which.")

    def test_recovered_unparsed_state_is_persisted_before_should_skip(self):
        """The clear must hit disk BEFORE should_skip can `continue`.

        The end-of-cycle save masks this in the happy path, so the window is
        "process dies mid-cycle" — after which a stale dead-lettered unparsed
        record would skip a message that now parses perfectly well. This test
        checks the ORDERING rather than the end state, because only the
        ordering distinguishes the two.
        """
        m = self._mod()
        with tempfile.TemporaryDirectory() as tmpdir:
            m.SYNC_LOG_PATH = Path(tmpdir) / "s.json"
            # account_hash is sha256_text(f"{host}|{username}")[:16]; stub it so
            # the key the run computes is the key we seed.
            m.sha256_text = lambda v: "acct" + "0" * 60
            key = m.unparsed_key("acct" + "0" * 12, "INBOX", "1", "1")
            m.save_sync_log({
                "ingested_ids": {}, "last_sync": "",
                "failed_ids": {key: {"uid": "1", "attempts": 1, "poison_attempts": 1,
                                     "kind": "poison", "dead_lettered": False,
                                     "next_attempt_at": None, "stage": "parse",
                                     "last_error": "was broken", "subject": "",
                                     "date_iso": ""}},
            })

            on_disk_at_skip_time = {}
            real_skip = m.should_skip

            def spy(record, sync_log, args):
                saved = json.loads(m.SYNC_LOG_PATH.read_text())
                on_disk_at_skip_time["keys"] = list(saved["failed_ids"])
                return real_skip(record, sync_log, args)

            m.should_skip = spy
            run_main_cycle(m, tool_call_response('{"thoughts": []}'))

        self.assertIn("keys", on_disk_at_skip_time, "should_skip was never reached")
        self.assertNotIn(
            key, on_disk_at_skip_time["keys"],
            "the cleared unparsed record must already be on disk by the time "
            "should_skip runs — a `continue` after this point would otherwise "
            "leave stale state that can skip a message which now parses")

    def test_attachments_only_success_clears_the_failure_record(self):
        """That branch used to `continue` straight out.

        A message that had failed before and now completed kept its failure
        record forever — still counting down, possibly still dead-lettered, for
        work that had actually succeeded.
        """
        m = self._mod()
        with tempfile.TemporaryDirectory() as tmpdir:
            m.SYNC_LOG_PATH = Path(tmpdir) / "s.json"
            key = "imap:test:1"
            m.save_sync_log({"ingested_ids": {}, "last_sync": "", "failed_ids": {
                key: {"uid": "1", "attempts": 2, "poison_attempts": 1, "kind": "poison",
                      "dead_lettered": False, "subject": "", "date_iso": "",
                      "next_attempt_at": None}}})

            record = {"uid": "1", "content": "b", "subject": "s", "date_iso": "",
                      "dedupe_key": key, "attachments": [{"filename": "a.pdf"}],
                      "metadata": {"mailbox": "INBOX", "sender": "x",
                                   "attachment_names": ["a.pdf"], "imap_uid": "1"}}
            record["attachments"][0].update(
                {"index": 0, "content_type": "application/pdf", "size_bytes": 1})
            m.parse_args = lambda: SimpleNamespace(
                list_failures=False, give_up=None, give_up_all=False, requeue=None, requeue_all=False, host="h", username="u",
                password="p", list_mailboxes=False, dry_run=False, attachments_only=True,
                no_attachments=False, mailbox="INBOX", no_ssl=False, since=None,
                before=None, limit=None, strip_quotes=False, ignore_sync_log=False,
                skip_empty=False, no_distill=False, attachment_names=None, verbose=False,
                port=993, from_filter=None, subject_filter=None,
                text_filter=None, unseen=False, attachment_chunker=None,
                no_attachment_summaries=True, retain_attachment_markdown=False,
                docling_url=None, minio_endpoint=None, minio_bucket=None,
                minio_prefix=None, minio_access_key=None, minio_secret_key=None,
                minio_secure=None, minio_service_name=None)
            m.LOCAL_INGEST_KEY = "k"
            m.connect_imap = lambda *a, **kw: (FakeImapClient(), "u")
            m.imap_response_code = lambda c, n: "1"
            m.fetch_uid_list = lambda c, a: ["1"]
            m.fetch_message_bytes = lambda c, u: (b"raw", [])
            m.parse_imap_record = lambda **kw: record
            m.discover_docling_base_url = lambda *a, **kw: "http://docling"
            m.select_attachments = lambda rec, args: record["attachments"]
            m.process_attachment = lambda *a, **kw: {
                "chunk_count": 1, "summary_count": 0, "docling_pipeline_used": "std"}
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                m.main()
            saved = json.loads(m.SYNC_LOG_PATH.read_text())

        self.assertNotIn(
            key, saved["failed_ids"],
            "attachments-only completed successfully, so the stale failure "
            "record must be cleared — otherwise it keeps counting down for "
            "work that already succeeded")


    def test_docling_request_raises_with_the_status_attached(self):
        """Pins the RAISE SITE, not just the exception class. Constructing the
        error by hand in a test proves nothing about what Docling produces."""
        import recipes.shared_docling as sd

        class _Resp:
            status_code = 415
            text = "unsupported media type"

        original = sd.requests.post
        sd.requests.post = lambda *a, **kw: _Resp()
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                f = Path(tmpdir) / "a.pdf"
                f.write_bytes(b"%PDF-1.4")
                with self.assertRaises(sd.DoclingHttpError) as ctx:
                    sd.docling_request("http://docling", f, "hybrid")
        finally:
            sd.requests.post = original
        self.assertEqual(ctx.exception.status, 415,
                         "the status must be an attribute, not only in the text")

    @staticmethod
    def _real_response(status, body=b'{"error":"nope"}'):
        """A genuine requests.Response, not a stand-in.

        This is the whole point of these tests: requests.Response defines
        __bool__ as status_code < 400, so it is FALSY for every error status.
        Hand-rolled fakes are plain objects and always truthy, which is why a
        full suite of them could not see the bug.
        """
        import requests
        r = requests.models.Response()
        r.status_code = status
        r._content = body
        r.headers["Content-Type"] = "application/json"
        return r

    def test_a_real_error_response_is_falsy(self):
        """States the trap the other two tests depend on."""
        self.assertFalse(bool(self._real_response(422)))
        self.assertTrue(bool(self._real_response(200)))

    def test_docling_keeps_the_status_of_a_real_error_response(self):
        import recipes.shared_docling as sd
        original = sd.requests.post
        sd.requests.post = lambda *a, **kw: self._real_response(415, b"nope")
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                f = Path(tmpdir) / "a.pdf"
                f.write_bytes(b"%PDF-1.4")
                with self.assertRaises(sd.DoclingHttpError) as ctx:
                    sd.docling_request("http://docling", f, "hybrid")
        finally:
            sd.requests.post = original
        self.assertEqual(ctx.exception.status, 415)



class ImapImportOperatorTerminationTests(unittest.TestCase):
    """Giving up is a decision a person makes, not one the code infers.

    A single cycle of a poller cannot tell "this attachment is corrupt" from
    "Docling is down" — the evidence is not inside the process. Five proxies
    for that judgement were tried (exception type, HTTP status, historical
    stamps, same-cycle corroboration, "this stage is local") and each failed in
    the direction that strands mail. So --list-failures shows a human the
    stage, status and error, and --give-up records what they decide.
    """

    SEED = {"ingested_ids": {}, "last_sync": "", "failed_ids": {
        "k1": {"uid": "1", "attempts": 9, "stage": "attachment",
               "last_error": "zero chunks", "subject": "a", "date_iso": "",
               "next_attempt_at": None},
        "k2": {"uid": "2", "attempts": 3, "stage": "distillation",
               "last_error": "no tool call", "subject": "b", "date_iso": "",
               "next_attempt_at": None}}}

    def _args(self, **overrides):
        base = dict(
            list_failures=False, give_up=None, give_up_all=False, requeue=None,
            requeue_all=False, host="h", username="u", password="p",
            list_mailboxes=False, dry_run=False, attachments_only=False,
            no_attachments=True, mailbox="INBOX", no_ssl=False, since=None,
            before=None, limit=None, strip_quotes=False, ignore_sync_log=False,
            skip_empty=False, no_distill=True, attachment_names=None,
            verbose=False, port=993, from_filter=None, subject_filter=None,
            text_filter=None, unseen=False, attachment_chunker=None,
            no_attachment_summaries=True, retain_attachment_markdown=False)
        base.update(overrides)
        return SimpleNamespace(**base)

    def _run(self, seed, **overrides):
        m = load_module("imap_giveup", IMAP_RECIPE)
        with tempfile.TemporaryDirectory() as tmpdir:
            m.SYNC_LOG_PATH = Path(tmpdir) / "s.json"
            m.save_sync_log(seed)
            m.parse_args = lambda: self._args(**overrides)
            m.LOCAL_INGEST_KEY = "k"
            m.connect_imap = lambda *a, **kw: (FakeImapClient(), "u")
            m.imap_response_code = lambda c, n: "1"
            m.fetch_uid_list = lambda c, a: []
            out = io.StringIO()
            with redirect_stdout(out), redirect_stderr(io.StringIO()):
                m.main()
            return m, out.getvalue(), json.loads(m.SYNC_LOG_PATH.read_text())

    def test_nothing_is_given_up_unless_asked(self):
        """The whole point. No inference, ever."""
        _, _, saved = self._run(self.SEED)
        for key in ("k1", "k2"):
            self.assertNotIn("given_up", saved["failed_ids"][key])

    def test_attempts_alone_never_cause_a_give_up(self):
        """The invariant this redesign exists for.

        Five proxies for "the message is at fault" were tried and each failed
        toward stranding mail. If anything ever starts inferring a terminal
        state from attempt count — or from anything else — this fails.
        """
        m = load_module("imap_no_inference", IMAP_RECIPE)
        log = {"ingested_ids": {}, "failed_ids": {}, "last_sync": ""}
        desc = {"uid": "1", "subject": "s", "date_iso": ""}
        for _ in range(50):
            m.note_failure(log, "k", desc, "distillation",
                           ValueError("no tool call"), set())
        entry = log["failed_ids"]["k"]
        self.assertEqual(entry["attempts"], 50)
        self.assertNotIn("given_up", entry)
        self.assertEqual(
            m.should_skip({"dedupe_key": "k", "date_iso": "", "content": "x"},
                          log, self._args()),
            "failure_backoff",
            "fifty failures earn a wait, never a verdict")

    def test_one_attempt_per_cycle_however_many_raises(self):
        """A message with five bad attachments raises five times in one pass.
        A count that rises with raises measures nothing."""
        m = load_module("imap_per_cycle", IMAP_RECIPE)
        log = {"ingested_ids": {}, "failed_ids": {}, "last_sync": ""}
        desc = {"uid": "1", "subject": "s", "date_iso": ""}
        counted = set()
        for i in range(5):
            m.note_failure(log, "k", desc, "attachment",
                           RuntimeError(f"att {i}"), counted)
        self.assertEqual(log["failed_ids"]["k"]["attempts"], 1)

    def test_a_real_error_response_keeps_its_status_on_the_record(self):
        """requests.Response is FALSY for 4xx, so `if not resp` discarded the
        status on every error path — invisible to fakes, which are plain
        objects and always truthy. The status is no longer classified, but it
        is what an operator reads in --list-failures."""
        import requests as _requests
        m = load_module("imap_truthiness", IMAP_RECIPE)
        m.LOCAL_INGEST_KEY = "k"
        real = _requests.models.Response()
        real.status_code = 422
        real._content = b'{"error":"nope"}'
        real.headers["Content-Type"] = "application/json"
        self.assertFalse(bool(real), "a real 4xx response is falsy")
        m.http_post_with_retry = lambda *a, **kw: real
        result = m.ingest_email(
            {"content": "b", "metadata": {"flags": []}, "date_iso": "",
             "dedupe_key": "k", "subject": "s"}, dry_run=False)
        self.assertEqual(result.get("status"), 422,
                         "the status must survive to the failure record")

    def test_the_controls_never_touch_imap_or_docling(self):
        """--give-up edits a local JSON file. It has no business validating
        credentials, discovering Docling, opening a mailbox or running an
        import cycle — and it did all four, which is the same defect already
        fixed once for --list-failures."""
        m = load_module("imap_standalone", IMAP_RECIPE)
        touched = []
        for name in ("connect_imap", "discover_docling_base_url", "fetch_uid_list",
                     "http_post_with_retry"):
            setattr(m, name, lambda *a, _n=name, **kw: touched.append(_n))

        with tempfile.TemporaryDirectory() as tmpdir:
            m.SYNC_LOG_PATH = Path(tmpdir) / "s.json"
            m.save_sync_log(self.SEED)
            # No host, no username, no password, no ingest key.
            m.LOCAL_INGEST_KEY = ""
            m.parse_args = lambda: self._args(give_up=["k1"], host=None,
                                              username=None, password=None)
            out = io.StringIO()
            with redirect_stdout(out), redirect_stderr(io.StringIO()):
                code = m.main()
            saved = json.loads(m.SYNC_LOG_PATH.read_text())

        self.assertEqual(code, 0, "must succeed with no credentials at all")
        self.assertEqual(touched, [], f"touched live services: {touched}")
        self.assertTrue(saved["failed_ids"]["k1"]["given_up"])

    def test_a_dry_run_changes_nothing(self):
        _, out, saved = self._run(self.SEED, give_up=["k1"], dry_run=True)
        self.assertIn("would change 1", out)
        self.assertNotIn("given_up", saved["failed_ids"]["k1"])

    def test_requeue_is_a_no_op_on_a_message_that_was_never_given_up(self):
        """Named for what it tests. Two earlier tests carried 'requeue' in
        their names while firing give_up_all at fixtures the code ignores."""
        _, out, saved = self._run(self.SEED, requeue=["k1"])
        self.assertIn("failure_records_changed=0", out)
        self.assertNotIn("given_up", saved["failed_ids"]["k1"])

    def test_give_up_marks_only_the_named_message(self):
        _, out, saved = self._run(self.SEED, give_up=["k1"])
        self.assertTrue(saved["failed_ids"]["k1"]["given_up"])
        self.assertIn("given_up_at", saved["failed_ids"]["k1"])
        self.assertNotIn("given_up", saved["failed_ids"]["k2"])
        self.assertIn("failure_records_changed=1", out)

    def test_a_given_up_message_is_skipped(self):
        m = load_module("imap_giveup_skip", IMAP_RECIPE)
        log = {"ingested_ids": {}, "last_sync": "", "failed_ids": {
            "k": {"given_up": True, "attempts": 4}}}
        record = {"dedupe_key": "k", "date_iso": "", "content": "x"}
        self.assertEqual(m.should_skip(record, log, self._args()), "given_up")

    def test_requeue_undoes_it_and_tries_on_the_next_cycle(self):
        _, _, saved = self._run(
            {"ingested_ids": {}, "last_sync": "", "failed_ids": {
                "k1": {"uid": "1", "attempts": 9, "given_up": True,
                       "given_up_at": "2026-08-25T00:00:00+00:00"}}},
            requeue=["k1"])
        self.assertNotIn("given_up", saved["failed_ids"]["k1"])
        self.assertIsNone(saved["failed_ids"]["k1"]["next_attempt_at"])

    def test_give_up_all_after_looking(self):
        _, _, saved = self._run(self.SEED, give_up_all=True)
        for key in ("k1", "k2"):
            self.assertTrue(saved["failed_ids"][key]["given_up"])

    def test_the_listing_shows_what_a_human_needs_and_no_verdict(self):
        """An operator reading stage=attachment, error=zero chunks does not
        need a verdict from us — and a kind= stamp that has been wrong four
        times would be trusted."""
        m = load_module("imap_listing", IMAP_RECIPE)
        line = m.format_failure_line("k1", self.SEED["failed_ids"]["k1"])
        self.assertIn("attachment", line)
        self.assertIn("zero chunks", line)
        self.assertIn("attempts=9", line)
        for banned in ("poison", "transport", "kind"):
            self.assertNotIn(banned, line)


if __name__ == "__main__":
    unittest.main()
