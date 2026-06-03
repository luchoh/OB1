"""Integration acceptance tests for the v24 agent-estate brain selector.

Exercises the live Open Brain MCP HTTP surface (capture / metadata / ask /
similar) against ob1_dev, seeding fixtures directly in Postgres. Unlike the
other tests in this directory (pure unittest mocks), these require:
  - the local runtime listening on OPEN_BRAIN_BASE_URL (default localhost:8787),
  - DB credentials in the environment (.env.open-brain-local), and
  - psql available (we shell out via `nix shell nixpkgs#postgresql_16`).
They self-skip if the runtime or DB is unreachable, so the unit suite stays green
in environments without them.

Fixture estate/brain/principal slugs are prefixed `zzt-acc-` and torn down.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import subprocess
import unittest
import urllib.error
import urllib.request

BASE_URL = os.environ.get("OPEN_BRAIN_BASE_URL", "http://localhost:8787").rstrip("/")

ESTATE = "zzt-acc"
P_SLUG = "zzt-acc-p"
B_DEF, B_ALLOW, B_DENY = "zzt-acc-def", "zzt-acc-allow", "zzt-acc-deny"
KEY = "zzt-acc-" + secrets.token_hex(8)
KEY_HASH = hashlib.sha256(KEY.encode()).hexdigest()


def _pg_conn():
    host = os.environ.get("PGHOST")
    port = os.environ.get("PGPORT")
    force = (os.environ.get("CONSUL_FORCE_DISCOVERY") or "").strip().lower() in {"1", "true", "yes"}
    if not host or not port or force:
        addr = os.environ.get("CONSUL_HTTP_ADDR")
        if not addr:
            raise unittest.SkipTest("no PGHOST/PGPORT and no CONSUL_HTTP_ADDR")
        svc = os.environ.get("CONSUL_POSTGRES_SERVICE", "postgresql")
        headers = {}
        tok = os.environ.get("CONSUL_HTTP_TOKEN")
        if tok:
            headers["X-Consul-Token"] = tok
        req = urllib.request.Request(f"{addr.rstrip('/')}/v1/health/service/{svc}?passing=true", headers=headers)
        data = json.loads(urllib.request.urlopen(req, timeout=5).read())
        if not data:
            raise unittest.SkipTest(f"no passing Consul instances for {svc}")
        s = data[0]["Service"]
        host = s.get("Address") or data[0]["Node"]["Address"]
        port = str(s["Port"])
    return {
        "host": host,
        "port": port,
        "db": os.environ.get("PGDATABASE", "ob1"),
        "user": os.environ.get("PGUSER", "postgres"),
        "password": os.environ.get("PGPASSWORD"),
    }


def _psql(sql: str, *, capture: bool = False) -> str:
    c = _pg_conn()
    if not c["password"]:
        raise unittest.SkipTest("PGPASSWORD not set")
    conn = f"host={c['host']} port={c['port']} dbname={c['db']} user={c['user']}"
    cmd = ["nix", "shell", "nixpkgs#postgresql_16", "--command", "psql", conn, "-v", "ON_ERROR_STOP=1"]
    cmd += (["-Atq", "-c", sql] if capture else ["-q", "-c", sql])
    env = {**os.environ, "PGPASSWORD": c["password"]}
    out = subprocess.run(cmd, env=env, check=True, capture_output=True, text=True)
    return out.stdout.strip()


def _post(path: str, payload: dict, *, query: str = ""):
    url = f"{BASE_URL}{path}{query}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"content-type": "application/json", "x-access-key": KEY},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body or b"{}")
        except json.JSONDecodeError:
            return e.code, {}


class AgentEstateAcceptance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # skip cleanly if the runtime isn't up
        try:
            urllib.request.urlopen(f"{BASE_URL}/health", timeout=5)
        except Exception as exc:  # noqa: BLE001
            raise unittest.SkipTest(f"runtime not reachable at {BASE_URL}: {exc}")
        _psql(f"delete from households where slug = '{ESTATE}'")
        _psql(
            f"""
            insert into households(slug,display_name) values ('{ESTATE}','acc');
            insert into brains(household_id,slug,display_name,kind)
              select id,'{B_DEF}','d','personal' from households where slug='{ESTATE}';
            insert into brains(household_id,slug,display_name,kind)
              select id,'{B_ALLOW}','a','personal' from households where slug='{ESTATE}';
            insert into brains(household_id,slug,display_name,kind)
              select id,'{B_DENY}','y','personal' from households where slug='{ESTATE}';
            insert into brain_principals(household_id,slug,display_name,principal_type,default_brain_id)
              select h.id,'{P_SLUG}','p','agent',b.id from households h
              join brains b on b.household_id=h.id and b.slug='{B_DEF}' where h.slug='{ESTATE}';
            insert into brain_memberships(principal_id,brain_id,role,is_deny)
              select p.id,b.id,'owner',false from brain_principals p
              join households h on h.id=p.household_id join brains b on b.household_id=h.id and b.slug='{B_DEF}'
              where h.slug='{ESTATE}' and p.slug='{P_SLUG}';
            insert into brain_memberships(principal_id,brain_id,role,is_deny)
              select p.id,b.id,'editor',false from brain_principals p
              join households h on h.id=p.household_id join brains b on b.household_id=h.id and b.slug='{B_ALLOW}'
              where h.slug='{ESTATE}' and p.slug='{P_SLUG}';
            insert into brain_memberships(principal_id,brain_id,role,is_deny)
              select p.id,b.id,'viewer',true from brain_principals p
              join households h on h.id=p.household_id join brains b on b.household_id=h.id and b.slug='{B_DENY}'
              where h.slug='{ESTATE}' and p.slug='{P_SLUG}';
            insert into estate_memberships(principal_id,estate_id,role,is_deny)
              select p.id,h.id,'member',false from brain_principals p
              join households h on h.id=p.household_id where h.slug='{ESTATE}' and p.slug='{P_SLUG}';
            insert into brain_access_keys(principal_id,brain_id,is_admin,key_hash,is_active,label,credential_type)
              select p.id,null,false,'{KEY_HASH}',true,'acc','service_key' from brain_principals p
              join households h on h.id=p.household_id where h.slug='{ESTATE}' and p.slug='{P_SLUG}';
            """
        )

    @classmethod
    def tearDownClass(cls):
        try:
            _psql(
                f"delete from thoughts where brain_id in (select id from brains b join households h "
                f"on h.id=b.household_id where h.slug='{ESTATE}'); "
                f"delete from brain_access_keys where key_hash='{KEY_HASH}'; "
                f"delete from households where slug='{ESTATE}'"
            )
        except Exception:  # noqa: BLE001
            pass

    def _brain_of(self, thought_id: str) -> str:
        return _psql(
            f"select b.slug from thoughts t join brains b on b.id=t.brain_id where t.id='{thought_id}'",
            capture=True,
        )

    # --- Phase 2/3: write resolution + access (D2/D3/D4) ---
    def test_capture_explicit_brain_lands_there(self):
        status, body = _post("/ingest/thought", {"content": "acc one", "extract_metadata": False, "brain": B_ALLOW})
        self.assertEqual(status, 201)
        self.assertEqual(self._brain_of(body["thought"]["id"]), B_ALLOW)

    def test_capture_omitted_uses_default_brain(self):
        status, body = _post("/ingest/thought", {"content": "acc two", "extract_metadata": False})
        self.assertEqual(status, 201)
        self.assertEqual(self._brain_of(body["thought"]["id"]), B_DEF)

    def test_capture_denied_brain_403(self):
        status, _ = _post("/ingest/thought", {"content": "x", "extract_metadata": False, "brain": B_DENY})
        self.assertEqual(status, 403)

    def test_capture_unreachable_brain_404(self):
        status, _ = _post("/ingest/thought", {"content": "x", "extract_metadata": False, "brain": "zzt-acc-nope"})
        self.assertEqual(status, 404)

    def test_capture_l1_vs_body_conflict_400(self):
        status, _ = _post(
            "/ingest/thought",
            {"content": "x", "extract_metadata": False, "brain": B_DEF},
            query=f"?brain={B_ALLOW}",
        )
        self.assertEqual(status, 400)

    def test_metadata_cross_brain_is_404_not_500(self):
        _, body = _post("/ingest/thought", {"content": "meta target", "extract_metadata": False, "brain": B_ALLOW})
        tid = body["thought"]["id"]
        ok, _ = _post("/admin/thought/metadata", {"thought_id": tid, "brain": B_ALLOW, "metadata_patch": {"k": 1}})
        self.assertEqual(ok, 200)
        miss, _ = _post("/admin/thought/metadata", {"thought_id": tid, "brain": B_DEF, "metadata_patch": {"k": 2}})
        self.assertEqual(miss, 404)

    def test_ask_denied_brain_403(self):
        status, _ = _post("/ask", {"question": "anything?", "brain": B_DENY})
        self.assertEqual(status, 403)

    # --- Phase 4: read fan-out (similar is the HTTP-reachable read) ---
    def test_similar_fans_out_and_tags_origin(self):
        _post("/ingest/thought", {"content": "shared phrase about kestrels", "extract_metadata": False, "brain": B_ALLOW})
        _post("/ingest/thought", {"content": "shared phrase about kestrels", "extract_metadata": False, "brain": B_DEF})
        status, body = _post(
            "/admin/thought/similar",
            {"queries": ["shared phrase about kestrels"], "match_threshold": 0.4, "match_count": 10},
        )
        self.assertEqual(status, 200)
        matches = body["results"][0]["matches"]
        self.assertTrue(matches, "expected at least one similar match")
        self.assertTrue(all(m.get("brain_id") and m.get("brain_slug") for m in matches), "matches must be brain-tagged")
        slugs = {m["brain_slug"] for m in matches}
        self.assertIn(B_ALLOW, slugs)
        self.assertIn(B_DEF, slugs)


if __name__ == "__main__":
    unittest.main()
