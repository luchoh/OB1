-- Recency-boosted variant of match_thoughts.
--
-- Adapted from upstream NateBJones-Projects/OB1
-- schemas/recency-boosted-match-thoughts. Differences from upstream:
--   - First parameter is `target_brain_id uuid` (mandatory), matching our
--     match_thoughts signature from migration 005. Without this the function
--     would walk every tenant.
--   - WHERE clause filters by brain_id and embedding_dimension = 1536, mirroring
--     match_thoughts.
--   - Returned columns add embedding_model, embedding_dimension, type,
--     source_type, importance, quality_score so callers don't need a second
--     query.
--   - Threshold default lowered from 0.7 to 0.4 to match our match_thoughts.
--   - SET search_path TO public,extensions removed (no extensions schema).
--
-- Formula:
--   recency_factor = exp(-age_days / half_life_days)
--   final_score    = similarity * (1 - recency_weight)
--                  + recency_factor * recency_weight
--
-- Defaults are backward-compatible:
--   recency_weight = 0   → final_score = similarity (same ranking as
--                          match_thoughts apart from threshold semantics)
--   half_life_days = 90  → ignored while recency_weight = 0
--
-- Threshold is gated on raw cosine similarity before the blend, so high
-- recency weights cannot surface entirely-irrelevant recent thoughts.

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
  'Recency-boosted nearest-neighbor search. Blended score = similarity * (1 - recency_weight) + exp(-age_days/half_life_days) * recency_weight. recency_weight defaults to 0 (pure similarity). half_life_days defaults to 90. Threshold is applied on raw cosine similarity before the blend. Brain-scoped via target_brain_id (first parameter).';
