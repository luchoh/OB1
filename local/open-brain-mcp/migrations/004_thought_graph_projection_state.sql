create table if not exists thought_graph_projection_state (
  thought_id uuid not null references thoughts(id) on delete cascade,
  graph_database text not null,
  projection_revision_hash text not null,
  last_projected_at timestamptz,
  last_projection_status text not null default 'pending',
  last_projection_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (thought_id, graph_database)
);

create index if not exists thought_graph_projection_state_status_idx
  on thought_graph_projection_state (graph_database, last_projection_status, last_projected_at desc);

drop trigger if exists thought_graph_projection_state_updated_at on thought_graph_projection_state;

create trigger thought_graph_projection_state_updated_at
before update on thought_graph_projection_state
for each row
execute function update_updated_at();
