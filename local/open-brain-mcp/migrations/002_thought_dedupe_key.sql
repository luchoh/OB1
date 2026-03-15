alter table thoughts
  add column if not exists dedupe_key text;

update thoughts
set dedupe_key = content_hash
where dedupe_key is null;

alter table thoughts
  alter column dedupe_key set not null;

drop index if exists thoughts_content_hash_idx;

create unique index if not exists thoughts_dedupe_key_idx
  on thoughts (dedupe_key);

create index if not exists thoughts_content_hash_idx
  on thoughts (content_hash);
