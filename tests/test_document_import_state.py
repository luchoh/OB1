import importlib.util
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "recipes" / "document-import" / "import-documents.py"
SPEC = importlib.util.spec_from_file_location("document_import_module", MODULE_PATH)
DOCUMENT_IMPORT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(DOCUMENT_IMPORT)


def fake_extraction():
    chunk = {
        "text": "Section text",
        "chunk_index": 0,
        "headings": ["Example"],
        "page_numbers": [1],
        "doc_items": ["#/texts/0"],
        "metadata": {"origin": {"mimetype": "application/pdf"}},
    }
    return {
        "chunks": [chunk],
        "document_text": "Section text",
        "pipeline_used": "standard",
        "fallback_triggered": False,
        "quality_signals": {"final": {"chunk_count": 1}},
        "raw_payload": {"chunks": [chunk]},
    }


def fake_args(tmpdir, **overrides):
    defaults = {
        "artifact_root": str(Path(tmpdir) / "artifact-root"),
        "materialize_markdown": True,
        "chunker": "hierarchical",
        "dry_run": False,
        "no_summaries": True,
        "retain_artifacts": False,
        "verbose": False,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


class DocumentImportStateTests(unittest.TestCase):
    def test_load_missing_state_file_returns_empty_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state = DOCUMENT_IMPORT.load_import_state(Path(tmpdir) / "missing.json")

        self.assertEqual(state["schema_version"], DOCUMENT_IMPORT.STATE_SCHEMA_VERSION)
        self.assertEqual(state["files"], {})

    def test_should_skip_unchanged_requires_successful_matching_hash(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "example.pdf"
            path.write_text("example", encoding="utf-8")
            state = DOCUMENT_IMPORT.new_import_state()
            DOCUMENT_IMPORT.update_import_state(
                state,
                path,
                document_hash="abc123",
                status="success",
                result={"chunk_count": 2, "summary_count": 1},
            )

            self.assertTrue(DOCUMENT_IMPORT.should_skip_unchanged(state, path, "abc123"))
            self.assertFalse(DOCUMENT_IMPORT.should_skip_unchanged(state, path, "different"))

            DOCUMENT_IMPORT.update_import_state(
                state,
                path,
                document_hash="abc123",
                status="failure",
                error="boom",
            )
            self.assertFalse(DOCUMENT_IMPORT.should_skip_unchanged(state, path, "abc123"))

    def test_save_and_load_state_round_trip(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "notes.md"
            path.write_text("notes", encoding="utf-8")
            state_path = Path(tmpdir) / "state.json"
            state = DOCUMENT_IMPORT.new_import_state()
            DOCUMENT_IMPORT.update_import_state(
                state,
                path,
                document_hash="feedbeef",
                status="success",
                result={"chunk_count": 3, "summary_count": 0},
            )
            DOCUMENT_IMPORT.save_import_state(state_path, state)

            loaded = DOCUMENT_IMPORT.load_import_state(state_path)
            entry = loaded["files"][DOCUMENT_IMPORT.state_key_for_path(path)]

        self.assertEqual(entry["document_sha256"], "feedbeef")
        self.assertEqual(entry["chunk_count"], 3)
        self.assertEqual(entry["summary_count"], 0)
        self.assertEqual(entry["status"], "success")

    def test_iter_files_skips_sidecar_state_and_artifacts(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "sidecar"
            content = root / "content"
            state = root / "state"
            artifacts = root / "artifacts"
            content.mkdir(parents=True)
            state.mkdir()
            artifacts.mkdir()
            doc = content / "note.md"
            doc.write_text("content", encoding="utf-8")
            (state / "bundles.jsonl").write_text("{}", encoding="utf-8")
            (artifacts / "note.md.json").write_text("{}", encoding="utf-8")
            (root / "_failed_pdfs.txt").write_text("failed", encoding="utf-8")

            files = DOCUMENT_IMPORT.iter_files([root], recursive=True, artifact_root=root)

        self.assertEqual(files, [])

    def test_iter_files_skips_unsupported_direct_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "script.py"
            path.write_text("print('not a document')", encoding="utf-8")

            files = DOCUMENT_IMPORT.iter_files([path], recursive=False)

        self.assertEqual(files, [])

    def test_write_extraction_bundle_materializes_markdown_and_json(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            source_root = Path(tmpdir) / "source"
            source_root.mkdir()
            source = source_root / "nested" / "example.pdf"
            source.parent.mkdir()
            source.write_bytes(b"pdf bytes")
            document_hash = DOCUMENT_IMPORT.sha256_file(source)
            args = fake_args(tmpdir)
            sidecar_paths = DOCUMENT_IMPORT.sidecar_paths_for_source(
                source,
                [source_root],
                args.artifact_root,
                document_hash,
            )

            bundle = DOCUMENT_IMPORT.write_extraction_bundle(
                source,
                args,
                fake_extraction(),
                document_hash=document_hash,
                sidecar_paths=sidecar_paths,
            )

            markdown_path = Path(bundle["normalized_markdown"]["path"])
            bundle_path = Path(bundle["artifact"]["path"])

            self.assertEqual(markdown_path.name, "example.md")
            self.assertTrue(markdown_path.exists())
            self.assertTrue(bundle_path.exists())
            self.assertEqual(bundle["source"]["relative_path"], "nested/example.pdf")
            self.assertEqual(bundle["docling"]["chunker"], "hierarchical")
            self.assertEqual(bundle["normalized_markdown"]["sha256"], DOCUMENT_IMPORT.sha256_text(markdown_path.read_text()))

    def test_sidecar_paths_suffix_collisions(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            left = Path(tmpdir) / "left" / "same.pdf"
            right = Path(tmpdir) / "right" / "same.pdf"
            left.parent.mkdir()
            right.parent.mkdir()
            left.write_bytes(b"left")
            right.write_bytes(b"right")
            artifact_root = Path(tmpdir) / "artifacts"
            used = {}

            first = DOCUMENT_IMPORT.sidecar_paths_for_source(
                left,
                [left.parent, right.parent],
                artifact_root,
                DOCUMENT_IMPORT.sha256_file(left),
                used_content_paths=used,
            )
            second_hash = DOCUMENT_IMPORT.sha256_file(right)
            second = DOCUMENT_IMPORT.sidecar_paths_for_source(
                right,
                [left.parent, right.parent],
                artifact_root,
                second_hash,
                used_content_paths=used,
            )

        self.assertEqual(first["markdown_relative_path"], "content/same.md")
        self.assertIn(second_hash[:12], second["markdown_relative_path"])
        self.assertIn(second_hash[:12], second["bundle_relative_path"])

    def test_sidecar_paths_suffix_changed_source_version(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            source_root = Path(tmpdir) / "source"
            source_root.mkdir()
            source = source_root / "example.pdf"
            source.write_bytes(b"first version")
            args = fake_args(tmpdir)
            first_hash = DOCUMENT_IMPORT.sha256_file(source)
            first_paths = DOCUMENT_IMPORT.sidecar_paths_for_source(
                source,
                [source_root],
                args.artifact_root,
                first_hash,
            )
            DOCUMENT_IMPORT.write_extraction_bundle(
                source,
                args,
                fake_extraction(),
                document_hash=first_hash,
                sidecar_paths=first_paths,
            )

            source.write_bytes(b"second version")
            second_hash = DOCUMENT_IMPORT.sha256_file(source)
            second_paths = DOCUMENT_IMPORT.sidecar_paths_for_source(
                source,
                [source_root],
                args.artifact_root,
                second_hash,
            )

        self.assertEqual(first_paths["markdown_relative_path"], "content/example.md")
        self.assertIn(second_hash[:12], second_paths["markdown_relative_path"])
        self.assertIn(second_hash[:12], second_paths["bundle_relative_path"])

    def test_bundle_ingest_uses_saved_bundle_without_docling(self):
        calls = []
        original_ingest = DOCUMENT_IMPORT.ingest_thought
        original_docling_chunk = DOCUMENT_IMPORT.docling_chunk

        def fake_ingest(content, metadata, **kwargs):
            calls.append({"content": content, "metadata": metadata, "kwargs": kwargs})

        def fail_docling(*_args, **_kwargs):
            raise AssertionError("Docling should not be called for bundle ingest")

        try:
            DOCUMENT_IMPORT.ingest_thought = fake_ingest
            DOCUMENT_IMPORT.docling_chunk = fail_docling
            with tempfile.TemporaryDirectory() as tmpdir:
                source_root = Path(tmpdir) / "source"
                source_root.mkdir()
                source = source_root / "example.pdf"
                source.write_bytes(b"pdf bytes")
                document_hash = DOCUMENT_IMPORT.sha256_file(source)
                args = fake_args(tmpdir)
                sidecar_paths = DOCUMENT_IMPORT.sidecar_paths_for_source(
                    source,
                    [source_root],
                    args.artifact_root,
                    document_hash,
                )
                bundle = DOCUMENT_IMPORT.write_extraction_bundle(
                    source,
                    args,
                    fake_extraction(),
                    document_hash=document_hash,
                    sidecar_paths=sidecar_paths,
                )

                with redirect_stdout(io.StringIO()):
                    result = DOCUMENT_IMPORT.process_bundle(bundle["artifact"]["path"], args)
        finally:
            DOCUMENT_IMPORT.ingest_thought = original_ingest
            DOCUMENT_IMPORT.docling_chunk = original_docling_chunk

        self.assertEqual(result["chunk_count"], 1)
        self.assertEqual(len(calls), 1)
        metadata = calls[0]["metadata"]
        self.assertEqual(metadata["document_sha256"], document_hash)
        self.assertEqual(metadata["document_markdown_sha256"], bundle["normalized_markdown"]["sha256"])
        self.assertEqual(metadata["document_page_numbers"], [1])
        self.assertEqual(metadata["document_doc_items"], ["#/texts/0"])
        self.assertEqual(metadata["document_extraction_bundle_path"], bundle["artifact"]["path"])


if __name__ == "__main__":
    unittest.main()
