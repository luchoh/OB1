-- 011_thought_soft_delete_reads.sql
-- M2 of the thought-deletion spec (docs/32-thought-delete-decision.md, D3).
-- Scope: the read-path filter sweep. A soft-deleted thought
-- (thoughts.deleted_at IS NOT NULL) must be invisible to EVERY read.
--
-- Each SQL function below is CREATE OR REPLACE'd with its EXACT current
-- signature + body (copied from migrations 005/006/008) PLUS an added
-- `and t.deleted_at is null` (or `where deleted_at is null`) INSIDE the query,
-- before any LIMIT. plpgsql/sql copies the function body by value, so the
-- predicate must be re-issued here; it cannot be inherited from a view.
-- A JS post-filter would be wrong: it shrinks result counts below match_count
-- and lets a tombstone occupy a slot.
--
-- Also makes the HNSW embedding index PARTIAL so deleted rows leave the ANN
-- graph entirely (a WHERE filter runs *after* the ANN traversal and costs
-- recall). The current index (001:37-38) is
--   thoughts_embedding_hnsw_idx on thoughts using hnsw (embedding vector_cosine_ops)
--
-- Additive, idempotent, and safe to re-run.
--
-- PROD APPLY NOTE: the DROP + plain CREATE INDEX on the HNSW index below takes
-- an ACCESS EXCLUSIVE lock on `thoughts` for the rebuild (sub-second on dev's
-- ~6.7k rows, but an HNSW rebuild on the larger prod `ob1` table can stall
-- capture/read for noticeably longer). Apply in a low-traffic window, OR for
-- prod run the index step out-of-band with
-- `create index concurrently` (outside a txn) and verify indisvalid. The
-- CREATE OR REPLACE FUNCTION statements take only a brief catalog lock and are
-- safe online.

-- ============================================================
-- 1. match_thoughts (005:145-182) — vector ANN search
-- ============================================================

create or replace function match_thoughts(
  target_brain_id uuid,
  query_embedding vector(1536),
  match_threshold float default 0.4,
  match_count int default 10,
  filter jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  content text,
  embedding_model text,
  embedding_dimension integer,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
language plpgsql
as $$
begin
  return query
  select
    t.id,
    t.content,
    t.embedding_model,
    t.embedding_dimension,
    t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.created_at
  from thoughts t
  where t.brain_id = target_brain_id
    and t.deleted_at is null
    and t.embedding is not null
    and t.embedding_dimension = 1536
    and 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter = '{}'::jsonb or t.metadata @> filter)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- ============================================================
-- 2. match_thoughts_recency (008:29-101) — recency-boosted ANN
-- ============================================================

create or replace function match_thoughts_recency(
  target_brain_id uuid,
  query_embedding vector(1536),
  match_threshold float default 0.4,
  match_count int default 10,
  filter jsonb default '{}'::jsonb,
  recency_weight float default 0.0,
  half_life_days float default 90.0
)
returns table (
  id uuid,
  content text,
  embedding_model text,
  embedding_dimension integer,
  metadata jsonb,
  type text,
  source_type text,
  importance smallint,
  quality_score numeric(5,2),
  similarity float,
  created_at timestamptz
)
language plpgsql
stable
parallel safe
as $$
begin
  if recency_weight < 0.0 then recency_weight := 0.0; end if;
  if recency_weight > 1.0 then recency_weight := 1.0; end if;
  if half_life_days <= 0.0 then half_life_days := 90.0; end if;

  return query
  select
    t.id,
    t.content,
    t.embedding_model,
    t.embedding_dimension,
    t.metadata,
    t.type,
    t.source_type,
    t.importance,
    t.quality_score,
    (
      (1 - (t.embedding <=> query_embedding)) * (1.0 - recency_weight)
      +
      exp(
        -greatest(
          extract(epoch from (now() - t.created_at)) / 86400.0,
          0.0
        ) / half_life_days
      ) * recency_weight
    )::float as similarity,
    t.created_at
  from thoughts t
  where t.brain_id = target_brain_id
    and t.deleted_at is null
    and t.embedding is not null
    and t.embedding_dimension = 1536
    and (1 - (t.embedding <=> query_embedding)) >= match_threshold
    and (filter = '{}'::jsonb or t.metadata @> filter)
  order by
    (
      (1 - (t.embedding <=> query_embedding)) * (1.0 - recency_weight)
      +
      exp(
        -greatest(
          extract(epoch from (now() - t.created_at)) / 86400.0,
          0.0
        ) / half_life_days
      ) * recency_weight
    ) desc
  limit match_count;
end;
$$;

comment on function match_thoughts_recency(uuid, vector(1536), float, int, jsonb, float, float) is
  'Recency-boosted nearest-neighbor search. Blended score = similarity * (1 - recency_weight) + exp(-age_days/half_life_days) * recency_weight. recency_weight defaults to 0 (pure similarity). half_life_days defaults to 90. Threshold is applied on raw cosine similarity before the blend. Brain-scoped via target_brain_id (first parameter). Excludes soft-deleted rows (deleted_at is null).';

-- ============================================================
-- 3. list_recent_thoughts (005:184-211) — newest-first listing
-- ============================================================

create or replace function list_recent_thoughts(
  target_brain_id uuid,
  list_count int default 20,
  filter jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  content text,
  embedding_model text,
  embedding_dimension integer,
  metadata jsonb,
  created_at timestamptz
)
language sql
as $$
  select
    t.id,
    t.content,
    t.embedding_model,
    t.embedding_dimension,
    t.metadata,
    t.created_at
  from thoughts t
  where t.brain_id = target_brain_id
    and t.deleted_at is null
    and (filter = '{}'::jsonb or t.metadata @> filter)
  order by t.created_at desc
  limit list_count;
$$;

-- ============================================================
-- 4. thoughts_stats (005:213-228) — per-brain counts/timestamps
-- ============================================================

create or replace function thoughts_stats(target_brain_id uuid)
returns table (
  total_thoughts bigint,
  embedded_thoughts bigint,
  first_capture timestamptz,
  last_capture timestamptz
)
language sql
as $$
  select
    count(*) as total_thoughts,
    count(*) filter (where embedding is not null) as embedded_thoughts,
    min(created_at) as first_capture,
    max(created_at) as last_capture
  from thoughts
  where brain_id = target_brain_id
    and deleted_at is null;
$$;

-- ============================================================
-- 5. search_thoughts_text (006:46-145) — lexical search.
--    Currently dormant + unfiltered (no brain scoping). Defense-in-depth:
--    add `and t.deleted_at is null` to every `from thoughts t` read so a
--    future caller cannot reintroduce a tombstone leak.
-- ============================================================

create or replace function search_thoughts_text(
  p_query text,
  p_limit integer default 25,
  p_filter jsonb default '{}'::jsonb,
  p_offset integer default 0
)
returns table (
  id uuid,
  content text,
  type text,
  source_type text,
  importance smallint,
  quality_score numeric(5,2),
  sensitivity_tier text,
  metadata jsonb,
  created_at timestamptz,
  rank real,
  total_count bigint
)
language plpgsql
volatile
set statement_timeout = '25s'
as $$
begin
  return query
  with query_input as (
    select
      trim(coalesce(p_query, '')) as raw_query,
      websearch_to_tsquery('simple', trim(coalesce(p_query, ''))) as ts_query
  ),
  tsvector_hits as (
    select t.id as hit_id
    from public.thoughts t
    cross join query_input q
    where q.raw_query <> ''
      and t.deleted_at is null
      and to_tsvector('simple', coalesce(t.content, '')) @@ q.ts_query
      and t.metadata @> coalesce(p_filter, '{}'::jsonb)
    limit 2000
  ),
  ilike_hits as (
    select t.id as hit_id
    from public.thoughts t
    cross join query_input q
    where q.raw_query <> ''
      and t.deleted_at is null
      and (select count(*) from tsvector_hits) < (p_limit + p_offset)
      and t.content ilike '%' || q.raw_query || '%'
      and t.metadata @> coalesce(p_filter, '{}'::jsonb)
      and t.id not in (select th.hit_id from tsvector_hits th)
    limit 500
  ),
  all_hits as (
    select hit_id from tsvector_hits
    union
    select hit_id from ilike_hits
  ),
  hit_count as (
    select count(*) as cnt from all_hits
  ),
  ranked as (
    select
      t.id,
      t.content,
      t.type,
      t.source_type,
      t.importance,
      t.quality_score,
      t.sensitivity_tier,
      t.metadata,
      t.created_at,
      (
        greatest(
          ts_rank_cd(
            to_tsvector('simple', coalesce(t.content, '')),
            q.ts_query
          ),
          case
            when q.raw_query <> '' and t.content ilike '%' || q.raw_query || '%'
              then 0.35
            else 0
          end
        )
        + (coalesce(t.importance, 5) / 20.0)::real
        + (coalesce(t.quality_score, 0.50) / 500.0)::real
      )::real as rank
    from public.thoughts t
    cross join query_input q
    where t.id in (select ah.hit_id from all_hits ah)
    order by rank desc, t.created_at desc
  )
  select
    r.id, r.content, r.type, r.source_type, r.importance,
    r.quality_score, r.sensitivity_tier, r.metadata, r.created_at,
    r.rank,
    hc.cnt as total_count
  from ranked r
  cross join hit_count hc
  offset greatest(0, coalesce(p_offset, 0))
  limit greatest(1, least(coalesce(p_limit, 25), 100));
end;
$$;

-- ============================================================
-- 6. brain_stats_aggregate (006:151-194) — dormant aggregate stats.
--    Defense-in-depth: exclude soft-deleted rows from every count.
-- ============================================================

create or replace function brain_stats_aggregate(
  p_since_days integer default 30,
  p_exclude_restricted boolean default true
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_total bigint;
  v_types jsonb;
  v_topics jsonb;
  v_since timestamptz;
begin
  if p_since_days > 0 then
    v_since := now() - (p_since_days || ' days')::interval;
  else
    v_since := '-infinity'::timestamptz;
  end if;

  select count(*) into v_total
  from public.thoughts
  where deleted_at is null
    and (not p_exclude_restricted or sensitivity_tier is distinct from 'restricted');

  select coalesce(jsonb_agg(jsonb_build_object('type', t.type, 'count', t.cnt)), '[]'::jsonb)
  into v_types from (
    select type, count(*) as cnt from public.thoughts
    where deleted_at is null
      and created_at >= v_since
      and (not p_exclude_restricted or sensitivity_tier is distinct from 'restricted')
    group by type order by cnt desc limit 20
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object('topic', t.topic, 'count', t.cnt)), '[]'::jsonb)
  into v_topics from (
    select topic.value as topic, count(*) as cnt
    from public.thoughts,
         jsonb_array_elements_text(coalesce(metadata->'topics', '[]'::jsonb)) as topic(value)
    where deleted_at is null
      and created_at >= v_since
      and (not p_exclude_restricted or sensitivity_tier is distinct from 'restricted')
    group by topic.value order by cnt desc limit 20
  ) t;

  return jsonb_build_object('total', v_total, 'top_types', v_types, 'top_topics', v_topics);
end;
$$;

-- ============================================================
-- 7. get_thought_connections (006:200-280) — dormant overlap search.
--    Defense-in-depth: exclude soft-deleted rows from both the source
--    lookup and the candidate scan.
-- ============================================================

create or replace function get_thought_connections(
  p_thought_id uuid,
  p_limit int default 20,
  p_exclude_restricted boolean default true
)
returns table (
  id uuid,
  type text,
  importance smallint,
  preview text,
  created_at timestamptz,
  shared_topics text[],
  shared_people text[],
  overlap_count int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  source_topics text[];
  source_people text[];
begin
  select
    coalesce(
      (select array_agg(val) from jsonb_array_elements_text(t.metadata->'topics') val),
      '{}'::text[]
    ),
    coalesce(
      (select array_agg(val) from jsonb_array_elements_text(t.metadata->'people') val),
      '{}'::text[]
    )
  into source_topics, source_people
  from thoughts t
  where t.id = p_thought_id
    and t.deleted_at is null;

  if source_topics = '{}'::text[] and source_people = '{}'::text[] then
    return;
  end if;

  return query
  with candidates as (
    select
      bt.id,
      bt.type,
      bt.importance,
      left(bt.content, 200) as preview,
      bt.created_at,
      coalesce(
        (select array_agg(val) from jsonb_array_elements_text(bt.metadata->'topics') val
         where val = any(source_topics)),
        '{}'::text[]
      ) as shared_topics,
      coalesce(
        (select array_agg(val) from jsonb_array_elements_text(bt.metadata->'people') val
         where val = any(source_people)),
        '{}'::text[]
      ) as shared_people
    from thoughts bt
    where bt.id != p_thought_id
      and bt.deleted_at is null
      and (not p_exclude_restricted or bt.sensitivity_tier is distinct from 'restricted')
      and (
        exists (
          select 1 from jsonb_array_elements_text(bt.metadata->'topics') val
          where val = any(source_topics)
        )
        or exists (
          select 1 from jsonb_array_elements_text(bt.metadata->'people') val
          where val = any(source_people)
        )
      )
  )
  select
    c.id, c.type, c.importance, c.preview, c.created_at,
    c.shared_topics, c.shared_people,
    (coalesce(array_length(c.shared_topics, 1), 0) + coalesce(array_length(c.shared_people, 1), 0))::int as overlap_count
  from candidates c
  order by overlap_count desc, c.created_at desc
  limit p_limit;
end;
$$;

-- ============================================================
-- 8. Partial HNSW embedding index (001:37-38).
--    Make the ANN graph exclude soft-deleted rows so they leave the index
--    traversal entirely (a post-traversal WHERE filter costs recall).
-- ============================================================

drop index if exists thoughts_embedding_hnsw_idx;

create index thoughts_embedding_hnsw_idx
  on thoughts using hnsw (embedding vector_cosine_ops)
  where deleted_at is null;
