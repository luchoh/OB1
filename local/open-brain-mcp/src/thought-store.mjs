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

import { query, formatVector } from "./db.mjs";

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
export async function captureThought({ brainId, content, embedding, embeddingModel, metadata, dedupeKey }) {
  const typeValue = typeof metadata?.type === "string" && metadata.type.trim()
    ? metadata.type.trim()
    : null;

  const result = await query(
    `
      insert into thoughts (
        brain_id,
        content,
        embedding,
        embedding_model,
        embedding_dimension,
        dedupe_key,
        metadata,
        type
      )
      values (
        $1::uuid,
        $2,
        $3::vector,
        $4,
        $5,
        coalesce($6, encode(digest($2, 'sha256'), 'hex')),
        $7::jsonb,
        $8
      )
      on conflict (brain_id, dedupe_key) where deleted_at is null
      do update set
        content = excluded.content,
        embedding = excluded.embedding,
        embedding_model = excluded.embedding_model,
        embedding_dimension = excluded.embedding_dimension,
        metadata = thoughts.metadata || excluded.metadata,
        type = coalesce(excluded.type, thoughts.type),
        updated_at = now()
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
    ],
  );

  return result.rows[0];
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
  sensitivityTier,
  importance,
  qualityScore,
  enriched,
  status,
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

  const structured = [
    ["type", type, "text"],
    ["source_type", sourceType, "text"],
    ["sensitivity_tier", sensitivityTier, "text"],
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

  const result = await query(
    `
      update thoughts
      set ${setClauses.join(",\n        ")}
      where id = $1::uuid
        and brain_id = $2::uuid
        and deleted_at is null
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
export async function softDeleteThought({ brainId, thoughtId, actor }) {
  const result = await query(
    `
      with target as (
        select id, deleted_at from thoughts
        where id = $1::uuid and brain_id = $2::uuid
      ),
      upd as (
        update thoughts set deleted_at = now(), updated_at = now()
        where id = $1::uuid and brain_id = $2::uuid and deleted_at is null
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
    [thoughtId, brainId, JSON.stringify(actor)],
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
export async function restoreThought({ brainId, thoughtId, actor }) {
  const result = await query(
    `
      with target as (
        select id, deleted_at from thoughts
        where id = $1::uuid and brain_id = $2::uuid
      ),
      upd as (
        update thoughts set deleted_at = null, updated_at = now()
        where id = $1::uuid and brain_id = $2::uuid and deleted_at is not null
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
    [thoughtId, brainId, JSON.stringify(actor)],
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
