-- Backfill retrieval_role so default search can prefer distilled rows
-- while preserving raw source rows for provenance and fallback retrieval.

update thoughts
set metadata = jsonb_set(
  coalesce(metadata, '{}'::jsonb),
  '{retrieval_role}',
  to_jsonb(
    case
      when coalesce(metadata->>'type', 'note') in ('email', 'document_chunk') then 'source'
      else 'distilled'
    end
  ),
  true
)
where coalesce(nullif(metadata->>'retrieval_role', ''), '') = '';
