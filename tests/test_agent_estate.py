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
import sys
import unittest
import urllib.error
import urllib.request

BASE_URL = os.environ.get("OPEN_BRAIN_BASE_URL", "http://localhost:8787").rstrip("/")

ESTATE = "zzt-acc"
ESTATE2 = "zzt-acc2"  # a second, foreign estate for ADR-0003 admin-reach deltas
P_SLUG = "zzt-acc-p"
P_ADMIN = "zzt-acc-admin"
B_DEF, B_ALLOW, B_DENY = "zzt-acc-def", "zzt-acc-allow", "zzt-acc-deny"
# ADR-0002/0003 delta fixtures: a plain viewer brain, an estate-member-only
# brain (no brain membership), an admin-self-DENY'd brain, and two foreign-estate
# brains (one the admin has a cross-estate membership on, one it does not).
B_VIEW, B_MEMBER, B_ADMINDENY = "zzt-acc-view", "zzt-acc-member", "zzt-acc-admindeny"
B_FOREIGN, B_FMEMBER = "zzt-acc2-foreign", "zzt-acc2-fmember"


def _mkkey(prefix: str):
    k = prefix + secrets.token_hex(8)
    return k, hashlib.sha256(k.encode()).hexdigest()


KEY, KEY_HASH = _mkkey("zzt-acc-")                 # zzt-acc-p, non-admin service key
KEY_ADMIN, KEY_ADMIN_HASH = _mkkey("zzt-acc-adm-")  # zzt-acc-admin, stored is_admin key
KEY_BOUND, KEY_BOUND_HASH = _mkkey("zzt-acc-bnd-")  # zzt-acc-p, brain-bound (brain_id=B_DEF)


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


def _post(path: str, payload: dict, *, query: str = "", key: str = KEY):
    url = f"{BASE_URL}{path}{query}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"content-type": "application/json", "x-access-key": key},
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
        _psql(
            f"delete from thoughts where brain_id in (select b.id from brains b "
            f"join households h on h.id=b.household_id where h.slug in ('{ESTATE}','{ESTATE2}')); "
            f"delete from households where slug in ('{ESTATE}','{ESTATE2}')"
        )
        _psql(
            f"""
            -- Home estate (zzt-acc) and its brains.
            insert into households(slug,display_name) values ('{ESTATE}','acc');
            insert into brains(household_id,slug,display_name,kind)
              select id,'{B_DEF}','d','personal' from households where slug='{ESTATE}';
            insert into brains(household_id,slug,display_name,kind)
              select id,'{B_ALLOW}','a','personal' from households where slug='{ESTATE}';
            insert into brains(household_id,slug,display_name,kind)
              select id,'{B_DENY}','y','personal' from households where slug='{ESTATE}';
            insert into brains(household_id,slug,display_name,kind)
              select id,'{B_VIEW}','v','personal' from households where slug='{ESTATE}';
            insert into brains(household_id,slug,display_name,kind)
              select id,'{B_MEMBER}','m','personal' from households where slug='{ESTATE}';
            insert into brains(household_id,slug,display_name,kind)
              select id,'{B_ADMINDENY}','ad','personal' from households where slug='{ESTATE}';
            -- Foreign estate (zzt-acc2) and its brains.
            insert into households(slug,display_name) values ('{ESTATE2}','acc2');
            insert into brains(household_id,slug,display_name,kind)
              select id,'{B_FOREIGN}','f','personal' from households where slug='{ESTATE2}';
            insert into brains(household_id,slug,display_name,kind)
              select id,'{B_FMEMBER}','fm','personal' from households where slug='{ESTATE2}';

            -- Principal zzt-acc-p: owner(def), editor(allow), viewer+DENY(deny),
            -- viewer(view), no membership on (member) -> estate-member read only.
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
            insert into brain_memberships(principal_id,brain_id,role,is_deny)
              select p.id,b.id,'viewer',false from brain_principals p
              join households h on h.id=p.household_id join brains b on b.household_id=h.id and b.slug='{B_VIEW}'
              where h.slug='{ESTATE}' and p.slug='{P_SLUG}';
            insert into estate_memberships(principal_id,estate_id,role,is_deny)
              select p.id,h.id,'member',false from brain_principals p
              join households h on h.id=p.household_id where h.slug='{ESTATE}' and p.slug='{P_SLUG}';
            insert into brain_access_keys(principal_id,brain_id,is_admin,key_hash,is_active,label,credential_type)
              select p.id,null,false,'{KEY_HASH}',true,'acc','service_key' from brain_principals p
              join households h on h.id=p.household_id where h.slug='{ESTATE}' and p.slug='{P_SLUG}';
            -- Brain-bound key (brain_id=B_DEF): ADR-0003 retires the naming clamp.
            insert into brain_access_keys(principal_id,brain_id,is_admin,key_hash,is_active,label,credential_type)
              select p.id,b.id,false,'{KEY_BOUND_HASH}',true,'acc-bound','service_key' from brain_principals p
              join households h on h.id=p.household_id join brains b on b.household_id=h.id and b.slug='{B_DEF}'
              where h.slug='{ESTATE}' and p.slug='{P_SLUG}';

            -- Admin principal zzt-acc-admin (home estate = zzt-acc): a stored
            -- is_admin key, a cross-estate membership on B_FMEMBER, and an
            -- owner+DENY on B_ADMINDENY (to prove DENY clamps even an admin key).
            insert into brain_principals(household_id,slug,display_name,principal_type,default_brain_id)
              select h.id,'{P_ADMIN}','pa','agent',b.id from households h
              join brains b on b.household_id=h.id and b.slug='{B_DEF}' where h.slug='{ESTATE}';
            insert into brain_memberships(principal_id,brain_id,role,is_deny)
              select pa.id,bf.id,'owner',false from brain_principals pa
              join households h on h.id=pa.household_id and h.slug='{ESTATE}'
              join brains bf on bf.slug='{B_FMEMBER}' where pa.slug='{P_ADMIN}';
            insert into brain_memberships(principal_id,brain_id,role,is_deny)
              select pa.id,b.id,'owner',true from brain_principals pa
              join households h on h.id=pa.household_id and h.slug='{ESTATE}'
              join brains b on b.household_id=h.id and b.slug='{B_ADMINDENY}' where pa.slug='{P_ADMIN}';
            insert into brain_access_keys(principal_id,brain_id,is_admin,key_hash,is_active,label,credential_type)
              select pa.id,null,true,'{KEY_ADMIN_HASH}',true,'acc-admin','service_key' from brain_principals pa
              join households h on h.id=pa.household_id where h.slug='{ESTATE}' and pa.slug='{P_ADMIN}';
            """
        )

    @classmethod
    def tearDownClass(cls):
        # thoughts first (brain_id is ON DELETE RESTRICT), then the household
        # cascade removes brains / principal / memberships / key. `b.id` MUST be
        # qualified — `id` is ambiguous across the brains/households join.
        try:
            _psql(
                f"delete from thoughts where brain_id in (select b.id from brains b "
                f"join households h on h.id=b.household_id where h.slug in ('{ESTATE}','{ESTATE2}')); "
                f"delete from households where slug in ('{ESTATE}','{ESTATE2}')"
            )
        except Exception as exc:  # noqa: BLE001
            # A failed cleanup must be LOUD — leftover fixtures in a shared/prod
            # DB are worse than a noisy teardown.
            print(
                f"\nWARNING: agent-estate test cleanup FAILED; '{ESTATE}'/'{ESTATE2}' "
                f"fixtures may remain in the DB: {exc}",
                file=sys.stderr,
            )

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

    # --- ADR-0002/0003 behavior deltas vs the pre-policy auth.mjs ---
    # Each test pins exactly one place where the old runtime and the ADRs
    # disagreed. The handback maps delta -> test.

    # D-editor (preserved, regression guard): editor CAN write. Already covered
    # by test_capture_explicit_brain_lands_there (B_ALLOW is editor -> 201).

    def test_delta_viewer_cannot_write_403(self):
        # ADR-0002: viewer is read-only. Old auth.mjs had no write gate -> 201.
        status, _ = _post("/ingest/thought", {"content": "v", "extract_metadata": False, "brain": B_VIEW})
        self.assertEqual(status, 403)

    def test_delta_viewer_can_still_read_200(self):
        # The 403 above must be a capability denial, not a scope denial: the
        # viewer brain is readable. (Also proves the 403 is not a masked 404.)
        status, _ = _post(
            "/admin/thought/similar",
            {"queries": ["anything"], "match_threshold": 0.4, "match_count": 5, "brain": B_VIEW},
        )
        self.assertEqual(status, 200)

    def test_delta_estate_member_cannot_write_403(self):
        # ADR-0002: estate `member` is read-only. Old auth.mjs treated any
        # accessible (incl. estate-member) brain as writable -> 201.
        status, _ = _post("/ingest/thought", {"content": "m", "extract_metadata": False, "brain": B_MEMBER})
        self.assertEqual(status, 403)

    def test_delta_estate_member_can_still_read_200(self):
        status, _ = _post(
            "/admin/thought/similar",
            {"queries": ["anything"], "match_threshold": 0.4, "match_count": 5, "brain": B_MEMBER},
        )
        self.assertEqual(status, 200)

    def test_delta_viewer_cannot_patch_metadata_403(self):
        # ADR-0002: a metadata patch is a WRITE. A viewer-role principal must not
        # mutate via the metadata path either. The write gate runs before the
        # thought lookup, so this is a 403 (capability), not a 404 (missing id) —
        # a dummy thought_id is sufficient to pin it.
        status, _ = _post(
            "/admin/thought/metadata",
            {"thought_id": "00000000-0000-4000-8000-000000000000", "brain": B_VIEW, "metadata_patch": {"k": 1}},
        )
        self.assertEqual(status, 403)

    def test_delta_bound_key_can_name_other_in_scope_brain(self):
        # ADR-0003: a key's brain_id is a default hint, not a naming clamp. Old
        # auth.mjs 403'd a bound key naming any brain != its bound brain.
        status, body = _post(
            "/ingest/thought",
            {"content": "bound names allow", "extract_metadata": False, "brain": B_ALLOW},
            key=KEY_BOUND,
        )
        self.assertEqual(status, 201)
        self.assertEqual(self._brain_of(body["thought"]["id"]), B_ALLOW)

    def test_delta_admin_foreign_brain_body_unreachable_404(self):
        # ADR-0003: a stored admin key's body-arg reach is bounded to home
        # estate ∪ memberships. Old auth.mjs resolved admin body args GLOBALLY,
        # so a foreign-estate brain it had no membership on resolved (and acted).
        status, _ = _post(
            "/ingest/thought",
            {"content": "x", "extract_metadata": False, "brain": B_FOREIGN},
            key=KEY_ADMIN,
        )
        self.assertEqual(status, 404)

    def test_delta_admin_cross_estate_membership_l1_nameable(self):
        # ADR-0003: an admin key's L1 (query/header) reach WIDENS to its
        # membership-derived cross-estate brains. Old auth.mjs resolved admin L1
        # selectors household-wide only, so a cross-estate membership brain 404'd.
        status, body = _post(
            "/ingest/thought",
            {"content": "admin cross-estate", "extract_metadata": False},
            query=f"?brain={B_FMEMBER}",
            key=KEY_ADMIN,
        )
        self.assertEqual(status, 201)
        self.assertEqual(self._brain_of(body["thought"]["id"]), B_FMEMBER)

    def test_delta_admin_reaches_home_estate_without_membership_201(self):
        # Preserved ADR-0003 behavior (regression guard): an admin key reaches
        # every brain in its home estate even without a brain membership row.
        status, body = _post(
            "/ingest/thought",
            {"content": "admin home reach", "extract_metadata": False, "brain": B_ALLOW},
            key=KEY_ADMIN,
        )
        self.assertEqual(status, 201)
        self.assertEqual(self._brain_of(body["thought"]["id"]), B_ALLOW)

    def test_delta_brain_deny_overrides_admin_key_403(self):
        # ADR-0002 (ratified): brain-level DENY overrides EVERYTHING, including a
        # stored admin key on its own principal. Old auth.mjs short-circuited on
        # is_admin before any deny check, so the admin acted regardless.
        status, _ = _post(
            "/ingest/thought",
            {"content": "x", "extract_metadata": False, "brain": B_ADMINDENY},
            key=KEY_ADMIN,
        )
        self.assertEqual(status, 403)

    # --- module-2 Stage-2: pin the Thought-store rewire's wire shapes end-to-end.
    # The store returns {thoughtId, outcome}; the handlers must reproduce the exact
    # legacy responses. These endpoints were previously uncovered by acceptance.

    def test_delete_restore_wire_shapes_and_idempotency(self):
        _, body = _post("/ingest/thought", {"content": "del-restore target", "extract_metadata": False, "brain": B_DEF})
        tid = body["thought"]["id"]

        s, b = _post("/admin/thought/delete", {"thought_id": tid, "brain": B_DEF})
        self.assertEqual(s, 200)
        self.assertEqual(b.get("deleted"), True)

        s, b = _post("/admin/thought/delete", {"thought_id": tid, "brain": B_DEF})
        self.assertEqual(s, 200)
        self.assertEqual(b.get("already_deleted"), True, "idempotent second delete")

        s, b = _post("/admin/thought/restore", {"thought_id": tid, "brain": B_DEF})
        self.assertEqual(s, 200)
        self.assertEqual(b.get("restored"), True)

        s, b = _post("/admin/thought/restore", {"thought_id": tid, "brain": B_DEF})
        self.assertEqual(s, 200)
        self.assertEqual(b.get("already_live"), True, "idempotent second restore")

    def test_purge_wire_shape(self):
        # Purge needs a named admin service key (KEY_ADMIN) + a confirmation arg.
        # Capture via the admin (home-estate write reach), then purge it.
        _, body = _post(
            "/ingest/thought",
            {"content": "purge target zzt", "extract_metadata": False, "brain": B_DEF},
            key=KEY_ADMIN,
        )
        tid = body["thought"]["id"]
        chash = body["thought"]["content_hash"]
        s, b = _post(
            "/admin/thought/purge",
            {"thought_id": tid, "brain": B_DEF, "expected_content_hash": chash},
            key=KEY_ADMIN,
        )
        self.assertEqual(s, 200)
        self.assertEqual(b.get("purged"), True)
        self.assertEqual(b.get("graph_purged"), True)

    def test_purge_confirmation_mismatch_409(self):
        _, body = _post(
            "/ingest/thought",
            {"content": "purge mismatch zzt", "extract_metadata": False, "brain": B_DEF},
            key=KEY_ADMIN,
        )
        tid = body["thought"]["id"]
        s, _ = _post(
            "/admin/thought/purge",
            {"thought_id": tid, "brain": B_DEF, "expected_content_hash": "definitely-wrong"},
            key=KEY_ADMIN,
        )
        self.assertEqual(s, 409, "ThoughtStoreError.confirmation_mismatch -> 409")


if __name__ == "__main__":
    unittest.main()
