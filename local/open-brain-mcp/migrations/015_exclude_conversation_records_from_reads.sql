-- 015_exclude_conversation_records_from_reads.sql
-- Corpus-quality fix (2026-06-13). Exclude content-free chat-export RECORD
-- thoughts from the five RANKED read functions.
--
-- WHAT THESE ARE: legacy "source-first-chat" import artifacts. Per conversation
-- the retired schema created a `*_conversation_record` thought whose `content`
-- is a ~150-char pointer ("[X Export Record: title | date] Canonical raw export
-- record for conversation <uuid>") while its `user_metadata.raw_export_json`
-- carries the full raw conversation (avg ~222 KB). The record/source key
-- helpers in shared_capture.py now have ZERO callers and the active graph
-- schema is provenance-v1 (the source-first Message-node projection is dormant),
-- so no new ones are created. 1,587 exist in prod (860 chatgpt + 727 claude).
--
-- THE BUG: the pointer `content` is embedded and tagged retrieval_role='source',
-- so these contentless pointers leak into vector/lexical/recent retrieval. They
-- score 0.97-0.998 against each other on shared boilerplate (which sank PRD-39
-- cosine reconciliation) AND pollute ask-brain/search today.
--
-- THE FIX: exclude `metadata->>'type' in
-- ('chatgpt_conversation_record','claude_conversation_record')` from the ranked
-- read paths. The ROWS ARE KEPT — their raw_export_json is the only lossless
-- copy of the raw conversations (irreplaceable provenance), so this is
-- exclude-from-retrieval, NOT delete. Count/stats functions (thoughts_stats,
-- brain_stats_aggregate) deliberately keep counting them — they still exist.
--
-- Type lives in metadata->>'type' (the `type` column is null for ~all rows).
-- Bodies copied verbatim from the live migration 013 (match_thoughts,
-- search_thoughts_text, get_thought_connections, list_recent_thoughts) and 011
-- (match_thoughts_recency), preserving every marking (STABLE, parallel safe,
-- statement_timeout, security definer / search_path) — the ONLY delta is the
-- added record-exclusion predicate. Object-idempotent (CREATE OR REPLACE).
--
-- NOTE ON NUMBERING: docs/39 tentatively reserved 015 for a reconciliation
-- schema, but Package 3 reconciliation is shelved pending the eval-harness
-- re-measure; this corpus-quality migration takes 015.

-- ============================================================
-- 1. match_thoughts — vector ANN search (013 body + record exclusion).
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
    and coalesce(t.metadata->>'type', '') not in ('chatgpt_conversation_record', 'claude_conversation_record')
    and 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter = '{}'::jsonb or t.metadata @> filter)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- ============================================================
-- 2. match_thoughts_recency — recency-boosted ANN (011 body, STABLE PARALLEL
--    SAFE preserved, + record exclusion).
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
    and coalesce(t.metadata->>'type', '') not in ('chatgpt_conversation_record', 'claude_conversation_record')
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

-- ============================================================
-- 3. search_thoughts_text — lexical search (013 body + record exclusion on
--    both hit CTEs). STABLE / statement_timeout preserved.
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
      and coalesce(t.metadata->>'type', '') not in ('chatgpt_conversation_record', 'claude_conversation_record')
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
      and coalesce(t.metadata->>'type', '') not in ('chatgpt_conversation_record', 'claude_conversation_record')
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
-- 4. list_recent_thoughts — newest-first listing (013 body + record exclusion).
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
    and coalesce(t.metadata->>'type', '') not in ('chatgpt_conversation_record', 'claude_conversation_record')
    and (filter = '{}'::jsonb or t.metadata @> filter)
  order by t.created_at desc
  limit list_count;
$$;

-- ============================================================
-- 5. get_thought_connections — overlap search (013 body + record exclusion on
--    the source lookup AND the candidate scan). security definer preserved.
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
      and coalesce(bt.metadata->>'type', '') not in ('chatgpt_conversation_record', 'claude_conversation_record')
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
