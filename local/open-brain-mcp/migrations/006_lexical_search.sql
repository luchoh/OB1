-- Lexical search for thoughts: structured columns, tsvector + trigram indexes,
-- and the search_thoughts_text / brain_stats_aggregate / get_thought_connections RPCs.
--
-- Adapted from upstream NateBJones-Projects/OB1 schemas/enhanced-thoughts and
-- schemas/text-search-trgm. Single-tenant: these RPCs read every brain's rows.
-- Migration 007 will add brain_id-scoped variants.
--
-- Skipped from upstream:
--   - upstream upsert_thought RPC (depends on content_fingerprint / status
--     columns we don't have; our ingest writes rows directly, not via RPC).
--   - PostgREST schema reload (we don't run PostgREST).
--   - GRANT EXECUTE ... TO authenticated, anon, service_role (Supabase-only
--     roles; we connect as the table owner).

create extension if not exists pg_trgm;

-- ============================================================
-- 1. STRUCTURED COLUMNS
-- ============================================================

alter table thoughts add column if not exists type text;
alter table thoughts add column if not exists sensitivity_tier text default 'standard';
alter table thoughts add column if not exists importance smallint default 3;
alter table thoughts add column if not exists quality_score numeric(5,2) default 50;
alter table thoughts add column if not exists source_type text;
alter table thoughts add column if not exists enriched boolean default false;

create index if not exists idx_thoughts_type on thoughts (type);
create index if not exists idx_thoughts_importance on thoughts (importance desc);
create index if not exists idx_thoughts_source_type on thoughts (source_type);

create index if not exists idx_thoughts_content_tsvector
  on thoughts using gin (to_tsvector('simple', coalesce(content, '')));

create index if not exists idx_thoughts_content_trgm
  on thoughts using gin (content gin_trgm_ops);

comment on index idx_thoughts_content_trgm is
  'Trigram GIN index on content for ILIKE ''%foo%'' patterns. Accelerates search_thoughts_text ILIKE fallback from ~8s to ~150ms on rare-word queries.';

-- ============================================================
-- 2. FULL-TEXT SEARCH RPC
--    websearch_to_tsquery + ILIKE fallback, paginated.
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
      and to_tsvector('simple', coalesce(t.content, '')) @@ q.ts_query
      and t.metadata @> coalesce(p_filter, '{}'::jsonb)
    limit 2000
  ),
  ilike_hits as (
    select t.id as hit_id
    from public.thoughts t
    cross join query_input q
    where q.raw_query <> ''
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
-- 3. BRAIN STATS AGGREGATE
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
  where (not p_exclude_restricted or sensitivity_tier is distinct from 'restricted');

  select coalesce(jsonb_agg(jsonb_build_object('type', t.type, 'count', t.cnt)), '[]'::jsonb)
  into v_types from (
    select type, count(*) as cnt from public.thoughts
    where created_at >= v_since
      and (not p_exclude_restricted or sensitivity_tier is distinct from 'restricted')
    group by type order by cnt desc limit 20
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object('topic', t.topic, 'count', t.cnt)), '[]'::jsonb)
  into v_topics from (
    select topic.value as topic, count(*) as cnt
    from public.thoughts,
         jsonb_array_elements_text(coalesce(metadata->'topics', '[]'::jsonb)) as topic(value)
    where created_at >= v_since
      and (not p_exclude_restricted or sensitivity_tier is distinct from 'restricted')
    group by topic.value order by cnt desc limit 20
  ) t;

  return jsonb_build_object('total', v_total, 'top_types', v_types, 'top_topics', v_topics);
end;
$$;

-- ============================================================
-- 4. THOUGHT CONNECTIONS
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
  where t.id = p_thought_id;

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
-- 5. BACKFILL FROM EXISTING METADATA
-- ============================================================

update thoughts set type = metadata->>'type'
where type is null and metadata->>'type' is not null
  and metadata->>'type' in ('idea','task','person_note','reference','decision','lesson','meeting','journal');

update thoughts set source_type = metadata->>'source'
where source_type is null and metadata->>'source' is not null;
