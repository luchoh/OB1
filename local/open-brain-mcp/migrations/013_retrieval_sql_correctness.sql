-- 013_retrieval_sql_correctness.sql
-- PRD docs/39, Package 1. Retrieval SQL correctness fixes ported from the
-- upstream enhanced-thoughts work, scoped to the functions in OUR migrations
-- that actually carry a defect.
--
-- Source of truth for each body below is migration 011 (the CURRENT live
-- definition), NOT 005/006/008: 011 re-emitted these bodies with the
-- `... deleted_at is null` tombstone guards added by the soft-delete sweep
-- (docs/32). Copying from the original migrations would silently regress that
-- fix. Each function is re-emitted verbatim from 011 with ONLY these deltas:
--
--   match_thoughts            VOLATILE -> STABLE
--   search_thoughts_text      VOLATILE -> STABLE
--                             `t.id NOT IN (subquery)` -> `NOT EXISTS (...)`
--                             rank fallbacks coalesce(importance,5)->3,
--                                            coalesce(quality_score,0.50)->50
--   get_thought_connections   VOLATILE -> STABLE
--   list_recent_thoughts      VOLATILE -> STABLE  (LANGUAGE sql, single SELECT)
--   thoughts_stats            VOLATILE -> STABLE  (LANGUAGE sql, single SELECT)
--
-- (LANGUAGE sql functions default to VOLATILE just like plpgsql — NOT to
-- STABLE — so these two were genuinely mismarked; STABLE is correct for a
-- read-only single SELECT and additionally lets the planner inline them.)
--
-- Non-default attributes are preserved exactly: search_thoughts_text keeps
-- `set statement_timeout = '25s'`; get_thought_connections keeps
-- `security definer` / `set search_path = public`. No signature changes.
--
-- The ONLY observable behavior change is the rank fallback: a row with NULL
-- importance / quality_score is re-ranked to match an explicit-default row
-- (importance 3, quality_score 50) instead of the old 5 / 0.50. Rows with
-- non-NULL importance/quality are unaffected. search_thoughts_text is the
-- repo's dormant/unfiltered lexical path, bounding the live blast radius.
--
-- Additive, object-level idempotent via CREATE OR REPLACE FUNCTION, and safe
-- to re-apply by hand. The CREATE OR REPLACE statements take only a brief
-- catalog lock and are safe online.

-- ============================================================
-- 1. match_thoughts (011:34-72) — vector ANN search. VOLATILE -> STABLE.
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
stable
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
-- 2. search_thoughts_text (011:220-321) — lexical search.
--    VOLATILE -> STABLE; NOT IN (subquery) -> NOT EXISTS; rank fallbacks
--    aligned to the declared column defaults (importance 3, quality_score 50).
--    statement_timeout preserved.
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
stable
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
      and not exists (select 1 from tsvector_hits th where th.hit_id = t.id)
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
        + (coalesce(t.importance, 3) / 20.0)::real
        + (coalesce(t.quality_score, 50) / 500.0)::real
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
-- 3. get_thought_connections (011:382-464) — overlap search.
--    VOLATILE -> STABLE. security definer / search_path preserved.
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
stable
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
-- 4. list_recent_thoughts (011:160-188) — newest-first listing.
--    LANGUAGE sql, single SELECT. VOLATILE -> STABLE. Brain-scoped signature
--    only (the legacy 2-arg overload is dropped in 014).
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
stable
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
-- 5. thoughts_stats (011:194-211) — per-brain counts/timestamps.
--    LANGUAGE sql, single SELECT. VOLATILE -> STABLE. Brain-scoped signature
--    only (the legacy 0-arg overload is dropped in 014).
-- ============================================================

create or replace function thoughts_stats(target_brain_id uuid)
returns table (
  total_thoughts bigint,
  embedded_thoughts bigint,
  first_capture timestamptz,
  last_capture timestamptz
)
language sql
stable
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
