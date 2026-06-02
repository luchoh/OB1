"""Resumable state for the enrichment script.

Mirrors upstream's state file at recipes/thought-enrichment/data/enrichment-state.json:
totalProcessed / totalFailed / failedIds / lastProcessedId / startedAt / updatedAt.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import tempfile
from pathlib import Path
from typing import Any


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


class EnrichmentState:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._data: dict[str, Any] = self._load()

    @classmethod
    def for_brain(cls, *, base_dir: Path, brain_id: str) -> "EnrichmentState":
        base_dir.mkdir(parents=True, exist_ok=True)
        path = base_dir / f"enrichment-state-{brain_id}.json"
        return cls(path)

    def _load(self) -> dict[str, Any]:
        if self._path.exists():
            try:
                with self._path.open("r", encoding="utf-8") as fp:
                    return json.load(fp)
            except (OSError, json.JSONDecodeError):
                print(f"state file corrupt at {self._path}, starting fresh")
        return {
            "totalProcessed": 0,
            "totalFailed": 0,
            "failedIds": [],
            "lastProcessedId": None,
            "startedAt": _now_iso(),
            "updatedAt": _now_iso(),
        }

    def save(self) -> None:
        self._data["updatedAt"] = _now_iso()
        tmp_fd, tmp_path = tempfile.mkstemp(prefix=".state-", dir=str(self._path.parent))
        try:
            with os.fdopen(tmp_fd, "w", encoding="utf-8") as fp:
                json.dump(self._data, fp, indent=2)
                fp.write("\n")
            os.replace(tmp_path, self._path)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise

    def record_success(self, thought_id: str) -> None:
        self._data["totalProcessed"] = int(self._data.get("totalProcessed", 0)) + 1
        self._data["lastProcessedId"] = thought_id
        failed_ids = self._data.setdefault("failedIds", [])
        if thought_id in failed_ids:
            failed_ids.remove(thought_id)

    def record_failure(self, thought_id: str) -> None:
        self._data["totalFailed"] = int(self._data.get("totalFailed", 0)) + 1
        self._data["lastProcessedId"] = thought_id
        failed_ids = self._data.setdefault("failedIds", [])
        if thought_id not in failed_ids:
            failed_ids.append(thought_id)

    @property
    def failed_ids(self) -> list[str]:
        return list(self._data.get("failedIds", []))

    @property
    def last_processed_id(self) -> str | None:
        return self._data.get("lastProcessedId")

    @property
    def total_processed(self) -> int:
        return int(self._data.get("totalProcessed", 0))

    @property
    def total_failed(self) -> int:
        return int(self._data.get("totalFailed", 0))

    @property
    def started_at(self) -> str:
        return str(self._data.get("startedAt", ""))

    @property
    def updated_at(self) -> str:
        return str(self._data.get("updatedAt", ""))
