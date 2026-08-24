// Thought store — the single owner of the Thought lifecycle verbs and every SQL
// statement that touches the `thoughts` and `thought_audit` tables.
//
// What this module hides behind a small interface (PRD docs/34, module 2):
//   - the lifecycle verbs: capture/upsert, metadata patch, soft-delete, restore,
//     purge, and per-brain stats;
//   - audit emission and idempotency as INTERNAL guarantees of the verbs — a
//     caller never writes a thought_audit row or checks "already deleted"
//     itself (the atomic CTEs from docs/32 M3/M5 do both in one statement);
//   - Postgres-side soft-delete invisibility, concentrated in the store's reads
//     (`deleted_at is null` lives here, not scattered across call sites).
//
// What it does NOT do:
//   - decide authorization — handlers authorize via the Access policy and hand
//     the store a ready `actor` descriptor for the audit row (the store
//     executes, never decides);
//   - speak HTTP — refusals are returned/raised as ThoughtStoreError data the
//     transport maps to a status;
//   - touch Neo4j or config — purge's Neo4j-first ordering (docs/32 D7) is kept
//     here, but the graph DETACH-DELETE is an INJECTED callback the handler
//     supplies, so this module imports neither graph.mjs nor config.mjs.
//
// Every verb takes an EXPLICIT brain identity (defense in depth: the store never
// infers scope). The store is DB-coupled by design — its tests are DB-backed
// against the dev database; this module's logic IS the SQL.

import { query, withAuditActor, formatVector } from "./db.mjs";

// Pick the executor for a mutation that the revision trigger (migration 022)
// may fire on. With an actor we run inside a transaction that announces it to
// Postgres so the trigger can attribute the revision.
//
// Without one the statement runs on a plain pooled connection where the setting
// does not exist, and the trigger REFUSES the mutation — 022 fails closed. That
// is deliberate: an unattributed edit is permanent, whereas a refused write is
// loud and fixed in minutes. A fresh INSERT is unaffected (the trigger is AFTER
// UPDATE), which is why this stays a runner choice rather than a hard argument
// check here — only an actual mutation demands an actor.
function auditedRunner(actor) {
  if (!actor) {
    return query;
  }
  return (text, values) => withAuditActor(actor, (run) => run(text, values));
}

// Refusals the store surfaces as data (the transport adapter maps kind -> HTTP).
// Not thrown for control flow elsewhere — these mark the three outcomes a caller
// must distinguish: a missing/out-of-brain thought (404), a failed purge
// confirmation (409), and the audit invariant tripping (500, a real corruption).
export const STORE_ERROR = Object.freeze({
  NOT_FOUND: "not_found",
  CONFIRMATION_MISMATCH: "confirmation_mismatch",
  AUDIT_INVARIANT: "audit_invariant",
});

export class ThoughtStoreError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "ThoughtStoreError";
    this.kind = kind;
  }
}

// The Layer C write-guard predicate (docs/45 §6.10), the single source of the
// rule used by every mutation path (capture upsert, metadata patch, soft-delete,
// restore): a cloud_bound caller may mutate a row ONLY when its tier is the
// literal 'standard'; a restricted/personal (or unknown-tier, fail-closed) row
// is invisible to it. `paramIndex` is the bind position of the caller's egress
// class; `column` lets the ON CONFLICT path qualify it as `thoughts.<col>`.
function tierGuardSql(paramIndex, column = "sensitivity_tier") {
  return `(${column} is not distinct from 'standard' or $${paramIndex} = 'local_trusted')`;
}

// The shared-agent-brain dedupe namespace (0.8.0).
//
// WHY: dedupe_key defaults to sha256(content), so any principal that can
// READ a row can recompute its key — and the capture upsert would then rewrite
// that row IN PLACE (same id, same created_at, only updated_at moves). On a
// single-tenant brain that is the intended idempotent-import behaviour. On a
// brain shared by mutually-distrusting agents (pi runs inside an injection-
// exposed cage) it is a silent cross-principal overwrite: one agent can put
// words in another's row and the id/created_at say nothing happened.
//
// The fix is structural rather than a check: on `brains.is_shared_agent_brain`,
// each writer gets its OWN dedupe namespace, `<principal_uuid>:<key>`. Two
// principals capturing identical content can no longer collide at all, so the
// "must insert a separate row instead of overwriting" outcome falls out of the
// unique index itself — no read-then-write race, no extra round trip. The same
// principal re-capturing derives the same namespaced key, so legitimate
// idempotent re-import still upserts its own row.
//
// Cost: one PK lookup on `brains` inside the SAME statement. Non-shared brains
// (every brain today) keep the exact key they have always had.
//
// Both statements that use this CTE bind the brain id as $1.
const SHARED_BRAIN_CTE = `
      brain as (
        select coalesce(b.is_shared_agent_brain, false) as shared
        from brains b where b.id = $1::uuid
      )`;

// The effective dedupe key: caller-supplied key, else sha256(content), namespaced
// by the writing principal on a shared agent brain. `principalParam` is the bind
// position of the writer's principal id.
function dedupeKeySql(keyParam, contentParam, principalParam) {
  const raw = `coalesce($${keyParam}, encode(digest($${contentParam}, 'sha256'), 'hex'))`;
  return `case
          when (select shared from brain) and $${principalParam}::uuid is not null
            then $${principalParam}::uuid::text || ':' || ${raw}
          else ${raw}
        end`;
}

// ---------------------------------------------------------------------------
// Capture / upsert
// ---------------------------------------------------------------------------

// Insert a Thought, or refresh the live row sharing its (brain_id, dedupe_key).
// docs/32 D6: the unique index is PARTIAL (`where deleted_at is null`), so the
// ON CONFLICT target carries the same predicate — a re-capture of a key whose
// only row is a tombstone inserts a NEW live row (tombstone + live coexist), and
// `do update` deliberately never clears `deleted_at`. The embedding vector and
// its model/dimension are computed by the caller (embedding service is I/O) and
// passed in; content_hash defaults to sha256(content) in SQL when no dedupe key.
export async function captureThought({
  brainId,
  content,
  embedding,
  embeddingModel,
  metadata,
  dedupeKey,
  // Egress-boundary stamp (docs/45 §6.8/§6.11), derived by deriveCaptureStamp in
  // the handler. sensitivityTier defaults to 'standard'; origin/source/review may
  // be null (= unknown = fail-closed at read time) for non-stamping callers.
  sensitivityTier = null,
  originEgressClass = null,
  sourceTrustClass = null,
  reviewState = null,
  // §6.10: a cloud_bound caller may not upsert-OVER an existing restricted row.
  // Fail-closed: absent/unknown egress class is cloud_bound.
  callerReadEgressClass = "cloud_bound",
  // Writer attribution (migration 021). Nullable on purpose: a caller with no
  // principal (legacy admin key) writes NULL rather than failing. NULL means
  // "unattributed", never "mine" — see the shared-brain guard below.
  writtenByPrincipalId = null,
  writtenByKeyId = null,
  // Audit actor for the revision trigger (022). Distinct from the writtenBy*
  // fields above: those describe who OWNS the row, this describes who performed
  // THIS mutation, and the two differ precisely in the case versioning exists
  // for — one principal overwriting another's row.
  actor = null,
}) {
  const typeValue = typeof metadata?.type === "string" && metadata.type.trim()
    ? metadata.type.trim()
    : null;

  // On a dedupe re-capture, the security labels move only toward MORE
  // restrictive (monotone): cloud_origin / untrusted stick, an existing
  // quarantine is never cleared, and the tier is preserved (a re-capture must
  // not declassify). The monotonic-taint trigger (016) also backstops origin.
  // The DO UPDATE is additionally guarded (§6.10): a cloud_bound re-capture over
  // an existing restricted row matches no conflict-update row → 0 rows → the
  // handler's preflight (or this fail-closed backstop) denies it as NOT_FOUND.
  const result = await auditedRunner(actor)(
    `
      with ${SHARED_BRAIN_CTE}
      insert into thoughts (
        brain_id,
        content,
        embedding,
        embedding_model,
        embedding_dimension,
        dedupe_key,
        metadata,
        type,
        sensitivity_tier,
        origin_egress_class,
        source_trust_class,
        review_state,
        written_by_principal_id,
        written_by_key_id
      )
      select
        $1::uuid,
        $2,
        $3::vector,
        $4,
        $5,
        ${dedupeKeySql(6, 2, 14)},
        $7::jsonb,
        $8,
        coalesce($9, 'standard'),
        $10,
        $11,
        $12,
        $14::uuid,
        $15::uuid
      from brain
      on conflict (brain_id, dedupe_key) where deleted_at is null
      do update set
        content = excluded.content,
        embedding = excluded.embedding,
        embedding_model = excluded.embedding_model,
        embedding_dimension = excluded.embedding_dimension,
        metadata = thoughts.metadata || excluded.metadata,
        type = coalesce(excluded.type, thoughts.type),
        -- tier preserved (no declassification via re-capture)
        sensitivity_tier = thoughts.sensitivity_tier,
        -- origin/source taint = worst-of (monotone; never washes)
        origin_egress_class = case
          when thoughts.origin_egress_class = 'cloud_origin'
            or excluded.origin_egress_class = 'cloud_origin' then 'cloud_origin'
          else coalesce(excluded.origin_egress_class, thoughts.origin_egress_class)
        end,
        source_trust_class = case
          when thoughts.source_trust_class = 'untrusted'
            or excluded.source_trust_class = 'untrusted' then 'untrusted'
          else coalesce(excluded.source_trust_class, thoughts.source_trust_class)
        end,
        -- an existing quarantine is never cleared by a re-capture (worst-of:
        -- 'unreviewed' is sticky, so a re-capture can never un-quarantine a row)
        review_state = case
          when thoughts.review_state = 'unreviewed' or excluded.review_state = 'unreviewed' then 'unreviewed'
          else coalesce(thoughts.review_state, excluded.review_state)
        end,
        -- attribution follows the LAST writer, but coalesce so an unattributed
        -- re-capture (legacy admin) never ERASES a known writer.
        written_by_principal_id = coalesce(excluded.written_by_principal_id, thoughts.written_by_principal_id),
        written_by_key_id = coalesce(excluded.written_by_key_id, thoughts.written_by_key_id),
        updated_at = now()
      where ${tierGuardSql(13, "thoughts.sensitivity_tier")}
        -- Shared-brain ownership backstop. The namespaced dedupe key above
        -- already makes a cross-principal collision unreachable; this makes the
        -- rule explicit and covers the residual cases — a row written before the
        -- namespace existed, and an unattributed writer (NULL principal), which
        -- owns nothing and so may overwrite nothing. 0 rows ⇒ NOT_FOUND below,
        -- the same fail-closed shape the tier guard uses (no existence oracle).
        and (
          not (select shared from brain)
          or (thoughts.written_by_principal_id is not null
              and thoughts.written_by_principal_id = excluded.written_by_principal_id)
        )
      returning
        id,
        brain_id,
        content,
        dedupe_key,
        content_hash,
        embedding_model,
        embedding_dimension,
        metadata,
        type,
        sensitivity_tier,
        origin_egress_class,
        source_trust_class,
        review_state,
        written_by_principal_id,
        written_by_key_id,
        created_at,
        updated_at
    `,
    [
      brainId,
      content,
      formatVector(embedding),
      embeddingModel,
      embedding.length,
      dedupeKey ?? null,
      JSON.stringify(metadata),
      typeValue,
      sensitivityTier,
      originEgressClass,
      sourceTrustClass,
      reviewState,
      callerReadEgressClass,
      writtenByPrincipalId,
      writtenByKeyId,
    ],
  );

  // 0 rows ⇒ one of three things, none of which we distinguish for the caller:
  // the conflict targeted an existing restricted row and the tier guard blocked
  // the DO UPDATE for a cloud_bound caller; the shared-brain ownership backstop
  // refused to overwrite another (or an unattributed) principal's row; or the
  // brain id does not exist (the `from brain` CTE yields no row). Deny without
  // confirming what exists (§6.10: no existence oracle). The handler's preflight
  // normally catches the tier case before any processor call; this is the atomic,
  // TOCTOU-safe backstop.
  if (result.rows.length === 0) {
    throw new ThoughtStoreError(STORE_ERROR.NOT_FOUND, `Thought not found: ${dedupeKey ?? "(no dedupe key)"}`);
  }

  return result.rows[0];
}

// Preflight (docs/45 §6.10 + Codex v3 F1 / v4 F3): the sensitivity tier of the
// existing LIVE row a capture with this dedupe_key would upsert OVER, or
// `undefined` when there is no such row (a fresh insert). The handler calls this
// BEFORE the embedding/LLM processors so a cloud_bound upsert over a restricted
// row is denied before any content leaves the box. Returns `null` for an
// existing row whose tier is NULL (fail-closed → treat as non-standard).
// `writtenByPrincipalId` must be the SAME principal the capture will pass, or the
// peek looks at a different key than the capture will conflict on for a shared
// agent brain (see SHARED_BRAIN_CTE).
export async function peekCaptureConflictTier({ brainId, dedupeKey, writtenByPrincipalId = null }) {
  if (!dedupeKey) {
    return undefined;
  }
  const r = await query(
    `with ${SHARED_BRAIN_CTE}
     select t.sensitivity_tier from brain, thoughts t
       where t.brain_id = $1::uuid
         and t.dedupe_key = case
           when (select shared from brain) and $3::uuid is not null
             then $3::uuid::text || ':' || $2
           else $2
         end
         and t.deleted_at is null`,
    [brainId, dedupeKey, writtenByPrincipalId],
  );
  return r.rowCount === 0 ? undefined : (r.rows[0].sensitivity_tier ?? null);
}

// The egress_class of a brain, or `null` if unknown (fail-closed). The capture
// handler calls this BEFORE the processors so a restricted capture into a brain
// that cannot hold restricted content (anything but private_local /
// quarantine_review) is rejected before any content reaches the embedding/LLM
// services (docs/45 §6.5; the enforce_restricted_brain_isolation trigger would
// also reject it, but only AFTER the content egressed).
export async function peekBrainEgressClass({ brainId }) {
  const r = await query(`select egress_class from brains where id = $1::uuid`, [brainId]);
  return r.rowCount === 0 ? null : (r.rows[0].egress_class ?? null);
}

// docs/45 Layer-B (runbook §10 per-row clamp): resolve the per-row egress facts a
// read handler needs to run `effectiveEgress` over retrieved rows — the row's
// tier/taint columns plus its owning brain's egress_class, keyed by id. Returns a
// Map<lowercased-uuid, {sensitivity_tier, origin_egress_class, source_trust_class,
// review_state, brain_egress_class}>. A row absent from the map (vanished between
// retrieval and this lookup) is the caller's cue to drop it fail-closed. Only the
// confined read path (enforce + cloud_bound) calls this, so it costs one indexed
// round-trip and nothing on the unconfined path.
export async function fetchRowEgressById(ids) {
  const list = [...new Set((ids ?? []).filter(Boolean).map((x) => String(x)))];
  if (list.length === 0) {
    return new Map();
  }
  const { rows } = await query(
    `select t.id,
            t.sensitivity_tier,
            t.origin_egress_class,
            t.source_trust_class,
            t.review_state,
            b.egress_class as brain_egress_class
       from thoughts t
       join brains b on b.id = t.brain_id
      where t.id = any($1::uuid[])
        and t.deleted_at is null`,
    [list],
  );
  return new Map(rows.map((r) => [String(r.id).toLowerCase(), r]));
}

// ---------------------------------------------------------------------------
// Metadata patch (a WRITE)
// ---------------------------------------------------------------------------

// Patch a live Thought's metadata bundle and/or structured columns, scoped by
// `id AND brain_id`. A soft-deleted row is invisible to this write (the
// `deleted_at is null` predicate), so patching a tombstoned or out-of-brain
// thought is NOT_FOUND — never a silent 0-row success.
export async function patchThoughtMetadata({
  brainId,
  thoughtId,
  metadataPatch,
  type,
  sourceType,
  importance,
  qualityScore,
  enriched,
  status,
  // docs/45 §6.10: a cloud-bound caller may not mutate an existing restricted
  // row. Fail-closed: absent/unknown egress class is treated as cloud_bound.
  callerReadEgressClass = "cloud_bound",
  // Audit actor for the revision trigger (022). Before this, the metadata route
  // was the only mutation path in the store that left no trace at all.
  actor = null,
}) {
  const setClauses = [];
  const params = [thoughtId, brainId];
  let paramIndex = 3;

  if (metadataPatch !== undefined) {
    params.push(JSON.stringify(metadataPatch));
    setClauses.push(`metadata = (
      thoughts.metadata
      || ($${paramIndex}::jsonb - 'user_metadata')
      || case
        when $${paramIndex}::jsonb ? 'user_metadata' then jsonb_build_object(
          'user_metadata',
          coalesce(thoughts.metadata->'user_metadata', '{}'::jsonb)
          || coalesce($${paramIndex}::jsonb->'user_metadata', '{}'::jsonb)
        )
        else '{}'::jsonb
      end
    )`);
    paramIndex++;
  }

  // sensitivity_tier is NOT patchable here (docs/45 §6.7): the generic metadata
  // route is not a declassification path. Tier transitions go through a dedicated
  // local-trusted capability (a later slice).
  const structured = [
    ["type", type, "text"],
    ["source_type", sourceType, "text"],
    ["importance", importance, "smallint"],
    ["quality_score", qualityScore, "numeric(5,2)"],
    ["enriched", enriched, "boolean"],
    ["status", status, "text"],
  ];

  for (const [column, value, cast] of structured) {
    if (value === undefined) {
      continue;
    }
    params.push(value);
    setClauses.push(`${column} = $${paramIndex}::${cast}`);
    paramIndex++;
  }

  if (status !== undefined) {
    setClauses.push("status_updated_at = now()");
  }
  setClauses.push("updated_at = now()");

  params.push(callerReadEgressClass);
  const egressIdx = params.length;

  const result = await auditedRunner(actor)(
    `
      update thoughts
      set ${setClauses.join(",\n        ")}
      where id = $1::uuid
        and brain_id = $2::uuid
        and deleted_at is null
        -- §6.10 Layer C: a cloud_bound caller mutates only a 'standard' row;
        -- a restricted (or unknown-tier, fail-closed) row matches 0 rows → NOT_FOUND
        and ${tierGuardSql(egressIdx)}
      returning
        id,
        metadata,
        type,
        source_type,
        sensitivity_tier,
        importance,
        quality_score,
        enriched,
        status,
        updated_at
    `,
    params,
  );

  if (result.rowCount !== 1) {
    throw new ThoughtStoreError(STORE_ERROR.NOT_FOUND, `Thought not found: ${thoughtId}`);
  }

  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Soft-delete / restore (atomic mutation + audit)
// ---------------------------------------------------------------------------

// docs/32 D6/D7: soft-delete is atomic in a single-statement CTE (db.mjs exposes
// no transaction helper). Keyed on (thought_id, brain_id) — NEVER dedupe_key (a
// tombstone + a live row may share a key). Idempotent: a second delete returns
// `already_deleted` and writes NO new audit row. Audit emission is internal and
// invariant-checked (one audit row per state change).
export async function softDeleteThought({ brainId, thoughtId, actor, callerReadEgressClass = "cloud_bound" }) {
  // §6.10 Layer C: a cloud_bound caller cannot delete a restricted row. The
  // guard scopes BOTH `target` (existence) and `upd` (mutation), so a restricted
  // row reads as NOT_FOUND to a cloud_bound caller — no existence oracle.
  const result = await query(
    `
      with target as (
        select id, deleted_at from thoughts
        where id = $1::uuid and brain_id = $2::uuid
          and ${tierGuardSql(4)}
      ),
      upd as (
        update thoughts set deleted_at = now(), updated_at = now()
        where id = $1::uuid and brain_id = $2::uuid and deleted_at is null
          and ${tierGuardSql(4)}
        returning id
      ),
      aud as (
        insert into thought_audit (thought_id, brain_id, actor, action, old_state)
        select $1::uuid, $2::uuid, $3::jsonb, 'delete', jsonb_build_object('deleted_at', null)
        from upd
        returning thought_id
      )
      select
        (select count(*) from target) as existed,
        (select count(*) from upd) as changed,
        (select count(*) from aud) as audited
    `,
    [thoughtId, brainId, JSON.stringify(actor), callerReadEgressClass],
  );

  const { existed, changed, audited } = result.rows[0];
  if (Number(existed) === 0) {
    throw new ThoughtStoreError(STORE_ERROR.NOT_FOUND, `Thought not found: ${thoughtId}`);
  }
  if (Number(audited) !== Number(changed)) {
    throw new ThoughtStoreError(
      STORE_ERROR.AUDIT_INVARIANT,
      `Audit invariant violated: audited=${audited} changed=${changed}`,
    );
  }
  return {
    thoughtId,
    outcome: Number(changed) === 0 ? "already_deleted" : "deleted",
  };
}

// docs/32 D7: restore is the symmetric atomic CTE — clears `deleted_at`,
// snapshots the prior tombstone time into old_state, writes an action='restore'
// audit row. Idempotent: restoring a live thought is `already_live`, no audit row.
export async function restoreThought({ brainId, thoughtId, actor, callerReadEgressClass = "cloud_bound" }) {
  // §6.10 Layer C: a cloud_bound caller cannot restore a restricted row (it
  // reads as NOT_FOUND). Guard scopes both `target` and `upd`.
  const result = await query(
    `
      with target as (
        select id, deleted_at from thoughts
        where id = $1::uuid and brain_id = $2::uuid
          and ${tierGuardSql(4)}
      ),
      upd as (
        update thoughts set deleted_at = null, updated_at = now()
        where id = $1::uuid and brain_id = $2::uuid and deleted_at is not null
          and ${tierGuardSql(4)}
        returning id
      ),
      aud as (
        insert into thought_audit (thought_id, brain_id, actor, action, old_state)
        select $1::uuid, $2::uuid, $3::jsonb, 'restore',
          jsonb_build_object('deleted_at', (select deleted_at from target))
        from upd
        returning thought_id
      )
      select
        (select count(*) from target) as existed,
        (select count(*) from upd) as changed,
        (select count(*) from aud) as audited
    `,
    [thoughtId, brainId, JSON.stringify(actor), callerReadEgressClass],
  );

  const { existed, changed, audited } = result.rows[0];
  if (Number(existed) === 0) {
    throw new ThoughtStoreError(STORE_ERROR.NOT_FOUND, `Thought not found: ${thoughtId}`);
  }
  if (Number(audited) !== Number(changed)) {
    throw new ThoughtStoreError(
      STORE_ERROR.AUDIT_INVARIANT,
      `Audit invariant violated: audited=${audited} changed=${changed}`,
    );
  }
  return {
    thoughtId,
    outcome: Number(changed) === 0 ? "already_live" : "restored",
  };
}

// ---------------------------------------------------------------------------
// Purge (hard erasure, Neo4j-first)
// ---------------------------------------------------------------------------

// docs/32 D5/D7: purge is the deliberate hard erasure. The Neo4j-FIRST ordering
// invariant lives here, in one place: a graph outage aborts BEFORE the PG row
// (the only pointer to the node) is destroyed. The graph DETACH-DELETE is the
// injected `purgeGraphNode(canonicalId)` callback — the store owns the ordering,
// the handler owns the Neo4j driver + graph database name.
//
//   a. Load the row (id AND brain_id scoped).
//   b. Found: fail-closed confirmation check, then `purgeGraphNode`, then ONLY on
//      success the atomic PG delete + 'purge' audit (projection_state FK cascade
//      clears in the same txn). A graph failure rejects with the PG row intact.
//   c. Not found (PG row already gone — re-run / past raw-delete orphan): do NOT
//      404. But canonical_id is GLOBAL, so re-check globally first and 404 if the
//      thought is merely in another brain (wrong-brain call), never nuking a live
//      node. Only a genuinely PG-gone id reaches the graph residue cleanup.
export async function purgeThought({
  brainId,
  thoughtId,
  expectedContentHash,
  expectedDedupeKey,
  actor,
  purgeGraphNode,
}) {
  if (typeof purgeGraphNode !== "function") {
    throw new TypeError("purgeThought requires a purgeGraphNode(canonicalId) callback");
  }
  const canonicalId = `thought:${thoughtId}`;

  const loaded = await query(
    `select id, brain_id, content_hash, dedupe_key, content, metadata, deleted_at
       from thoughts where id = $1::uuid and brain_id = $2::uuid`,
    [thoughtId, brainId],
  );
  const row = loaded.rows[0];

  // c. Orphan path: no live PG pointer in this brain.
  if (!row) {
    const anyBrain = await query(
      `select 1 from thoughts where id = $1::uuid limit 1`,
      [thoughtId],
    );
    if (anyBrain.rows[0]) {
      // Lives in another brain — a wrong-brain call, not an orphan. Fail closed.
      throw new ThoughtStoreError(STORE_ERROR.NOT_FOUND, `Thought not found: ${thoughtId}`);
    }
    await purgeGraphNode(canonicalId);
    const orphanState = JSON.stringify({
      orphan: true,
      note: "no postgres row; graph residue purged",
    });
    await query(
      `insert into thought_audit (thought_id, brain_id, actor, action, old_state)
         values ($1::uuid, $2::uuid, $3::jsonb, 'purge', $4::jsonb)`,
      [thoughtId, brainId, JSON.stringify(actor), orphanState],
    );
    return { thoughtId, outcome: "graph_only" };
  }

  // b. Confirmation — fail closed before any delete.
  if (expectedContentHash !== undefined && expectedContentHash !== row.content_hash) {
    throw new ThoughtStoreError(STORE_ERROR.CONFIRMATION_MISMATCH, "Confirmation mismatch");
  }
  if (expectedDedupeKey !== undefined && expectedDedupeKey !== row.dedupe_key) {
    throw new ThoughtStoreError(STORE_ERROR.CONFIRMATION_MISMATCH, "Confirmation mismatch");
  }

  // Neo4j FIRST. If this rejects (graph unreachable) it propagates with the PG
  // row untouched — the pointer survives. Do NOT catch-and-continue.
  await purgeGraphNode(canonicalId);

  // old_state snapshots enough to support recovery (D5): content + metadata +
  // hashes + tombstone time.
  const oldState = JSON.stringify({
    content: row.content,
    metadata: row.metadata,
    content_hash: row.content_hash,
    dedupe_key: row.dedupe_key,
    deleted_at: row.deleted_at,
  });

  const result = await query(
    `
      with del as (
        delete from thoughts where id = $1::uuid and brain_id = $2::uuid
        returning id
      ),
      aud as (
        insert into thought_audit (thought_id, brain_id, actor, action, old_state)
        select $1::uuid, $2::uuid, $3::jsonb, 'purge', $4::jsonb
        from del
        returning thought_id
      )
      select
        (select count(*) from del) as deleted,
        (select count(*) from aud) as audited
    `,
    [thoughtId, brainId, JSON.stringify(actor), oldState],
  );

  const { deleted, audited } = result.rows[0];
  if (Number(audited) !== Number(deleted)) {
    throw new ThoughtStoreError(
      STORE_ERROR.AUDIT_INVARIANT,
      `Audit invariant violated: audited=${audited} deleted=${deleted}`,
    );
  }

  return { thoughtId, outcome: "purged" };
}

// ---------------------------------------------------------------------------
// Reads (soft-delete invisibility concentrated here)
// ---------------------------------------------------------------------------

// Re-hydrate live Thought rows for a set of ids within one brain, in the order
// the ids were given. docs/32 D3 "#1 must-not-miss" read site: the `deleted_at
// is null` predicate is the tombstone guard for graph-neighbor / expand-context
// re-hydration. With `embedding`, each row carries cosine similarity to it;
// without, similarity is null. `filter` is a metadata containment (`@>`) narrow.
export async function readThoughtRowsByIds({ brainId, ids, filter, embedding }) {
  if (!brainId) {
    throw new Error("brainId is required for readThoughtRowsByIds");
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }

  const filterJson = JSON.stringify(filter ?? {});
  let result;
  if (Array.isArray(embedding) && embedding.length > 0) {
    result = await query(
      `
        select
          t.id,
          t.content,
          t.embedding_model,
          t.embedding_dimension,
          t.metadata,
          (1 - (t.embedding <=> $3::vector))::float as similarity,
          t.created_at,
          t.updated_at
        from thoughts t
        where t.id = any($1::uuid[])
          and t.brain_id = $2::uuid
          and t.deleted_at is null
          and ($4::jsonb = '{}'::jsonb or t.metadata @> $4::jsonb)
      `,
      [ids, brainId, formatVector(embedding), filterJson],
    );
  } else {
    result = await query(
      `
        select
          t.id,
          t.content,
          t.embedding_model,
          t.embedding_dimension,
          t.metadata,
          null::float as similarity,
          t.created_at,
          t.updated_at
        from thoughts t
        where t.id = any($1::uuid[])
          and t.brain_id = $2::uuid
          and t.deleted_at is null
          and ($3::jsonb = '{}'::jsonb or t.metadata @> $3::jsonb)
      `,
      [ids, brainId, filterJson],
    );
  }

  const byId = new Map(result.rows.map((rowItem) => [rowItem.id, rowItem]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// Per-brain stats. The `thoughts_stats` RPC enforces `deleted_at is null`
// in-database (migration 011); the inline source/type/people aggregates re-state
// the same predicate so tombstones never inflate a count. Multi-brain merge is
// the caller's concern (fanout), parallel to list/search.
export async function brainStats(brainId) {
  const [overviewResult, sourceCounts, typeCounts, peopleCounts] = await Promise.all([
    query("select * from thoughts_stats($1::uuid)", [brainId]),
    query(`
      select
        coalesce(metadata->>'source', 'unknown') as source,
        count(*)::bigint as count
      from thoughts
      where brain_id = $1::uuid
        and deleted_at is null
      group by 1
      order by count desc, source asc
      limit 10
    `, [brainId]),
    query(`
      select
        coalesce(metadata->>'type', 'unknown') as type,
        count(*)::bigint as count
      from thoughts
      where brain_id = $1::uuid
        and deleted_at is null
      group by 1
      order by count desc, type asc
      limit 10
    `, [brainId]),
    query(`
      select
        person,
        count(*)::bigint as count
      from (
        select jsonb_array_elements_text(coalesce(metadata->'people', '[]'::jsonb)) as person
        from thoughts
        where brain_id = $1::uuid
          and deleted_at is null
      ) people
      group by person
      order by count desc, person asc
      limit 10
    `, [brainId]),
  ]);

  return {
    overview: overviewResult.rows[0] ?? null,
    top_sources: sourceCounts.rows,
    top_types: typeCounts.rows,
    top_people: peopleCounts.rows,
  };
}
