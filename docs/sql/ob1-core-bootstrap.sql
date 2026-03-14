-- Open Brain Local bootstrap schema
--
-- Target:
--   PostgreSQL 16 + pgvector
--   ob1 database
--
-- Default embedding shape:
--   Qwen3-Embedding-8B reduced to 1536 dimensions
--
-- Runtime note:
--   The current ob1-embedding service returns 4096 values and ignores the
--   `dimensions` request parameter. The application should currently truncate
--   to the first 1536 dimensions before insert and search.
--
-- If you change embedding dimensionality, update:
--   1. the embedding column type
--   2. the match_thoughts() function signature
--   3. application config
--   4. all stored embeddings

create extension if not exists vector;
create extension if not exists pgcrypto;

create table if not exists thoughts (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding vector(1536),
  embedding_model text not null default 'mlx-community/Qwen3-Embedding-8B-mxfp8',
  embedding_dimension integer not null default 1536,
  metadata jsonb not null default '{}'::jsonb,
  content_hash text generated always as (encode(digest(content, 'sha256'), 'hex')) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint thoughts_embedding_dimension_check check (embedding_dimension = 1536)
);

create unique index if not exists thoughts_content_hash_idx
  on thoughts (content_hash);

create index if not exists thoughts_metadata_gin_idx
  on thoughts using gin (metadata);

create index if not exists thoughts_created_at_desc_idx
  on thoughts (created_at desc);

create index if not exists thoughts_embedding_hnsw_idx
  on thoughts using hnsw (embedding vector_cosine_ops);

create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists thoughts_updated_at on thoughts;

create trigger thoughts_updated_at
before update on thoughts
for each row
execute function update_updated_at();

create or replace function match_thoughts(
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
  where t.embedding is not null
    and t.embedding_dimension = 1536
    and 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter = '{}'::jsonb or t.metadata @> filter)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

create or replace function list_recent_thoughts(
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
  where filter = '{}'::jsonb or t.metadata @> filter
  order by t.created_at desc
  limit list_count;
$$;

create or replace function thoughts_stats()
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
  from thoughts;
$$;
