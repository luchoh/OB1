-- Workflow Status Tracking
-- Adds status columns to the thoughts table for kanban-style workflow
-- management on rows where type IN ('task', 'idea').
--
-- Adapted from upstream NateBJones-Projects/OB1 schemas/workflow-status.
-- Differences:
--   - Backfill predicate uses our promoted `type` column instead of
--     metadata->>'type' (faster, index-friendly, and migration 006 added it).
--   - No GRANTs / RLS / NOTIFY pgrst (upstream's migration didn't have any).

alter table thoughts add column if not exists status text default null;
alter table thoughts add column if not exists status_updated_at timestamptz default now();

create index if not exists idx_thoughts_status
  on thoughts (status)
  where status is not null;

update thoughts
set status = 'new', status_updated_at = now()
where type in ('task', 'idea') and status is null;
