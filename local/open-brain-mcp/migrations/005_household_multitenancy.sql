create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists households_updated_at on households;

create trigger households_updated_at
before update on households
for each row
execute function update_updated_at();

create table if not exists brains (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  slug text not null,
  display_name text not null,
  kind text not null,
  is_default_shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint brains_household_slug_key unique (household_id, slug)
);

drop trigger if exists brains_updated_at on brains;

create trigger brains_updated_at
before update on brains
for each row
execute function update_updated_at();

create table if not exists brain_principals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  slug text not null,
  display_name text not null,
  principal_type text not null,
  default_brain_id uuid references brains(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint brain_principals_household_slug_key unique (household_id, slug)
);

drop trigger if exists brain_principals_updated_at on brain_principals;

create trigger brain_principals_updated_at
before update on brain_principals
for each row
execute function update_updated_at();

create table if not exists brain_memberships (
  principal_id uuid not null references brain_principals(id) on delete cascade,
  brain_id uuid not null references brains(id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  primary key (principal_id, brain_id)
);

create table if not exists principal_identity_bindings (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null references brain_principals(id) on delete cascade,
  provider text not null,
  subject text not null,
  preferred_username text,
  email text,
  is_active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint principal_identity_bindings_provider_subject_key unique (provider, subject)
);

drop trigger if exists principal_identity_bindings_updated_at on principal_identity_bindings;

create trigger principal_identity_bindings_updated_at
before update on principal_identity_bindings
for each row
execute function update_updated_at();

create table if not exists brain_access_keys (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null references brain_principals(id) on delete cascade,
  brain_id uuid references brains(id) on delete cascade,
  key_hash text not null,
  label text not null,
  credential_type text not null,
  is_active boolean not null default true,
  is_admin boolean not null default false,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists brain_access_keys_key_hash_idx
  on brain_access_keys (key_hash);

drop trigger if exists brain_access_keys_updated_at on brain_access_keys;

create trigger brain_access_keys_updated_at
before update on brain_access_keys
for each row
execute function update_updated_at();

create table if not exists principal_capture_routes (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null references brain_principals(id) on delete cascade,
  brain_id uuid not null references brains(id) on delete cascade,
  channel text not null,
  external_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint principal_capture_routes_channel_external_subject_key unique (channel, external_subject)
);

drop trigger if exists principal_capture_routes_updated_at on principal_capture_routes;

create trigger principal_capture_routes_updated_at
before update on principal_capture_routes
for each row
execute function update_updated_at();

alter table thoughts
  add column if not exists brain_id uuid references brains(id) on delete restrict;

create index if not exists thoughts_brain_id_idx
  on thoughts (brain_id);

create index if not exists thoughts_brain_created_at_desc_idx
  on thoughts (brain_id, created_at desc);

drop index if exists thoughts_dedupe_key_idx;

create unique index if not exists thoughts_brain_dedupe_key_idx
  on thoughts (brain_id, dedupe_key);

alter table thought_graph_projection_state
  add column if not exists brain_id uuid references brains(id) on delete cascade;

create index if not exists thought_graph_projection_state_brain_id_idx
  on thought_graph_projection_state (brain_id, graph_database, last_projection_status, last_projected_at desc);

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
    and t.embedding is not null
    and t.embedding_dimension = 1536
    and 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter = '{}'::jsonb or t.metadata @> filter)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

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
    and (filter = '{}'::jsonb or t.metadata @> filter)
  order by t.created_at desc
  limit list_count;
$$;

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
  where brain_id = target_brain_id;
$$;
