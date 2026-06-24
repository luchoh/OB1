-- 017_key_read_egress_class.sql
-- Caller read-egress class on stored access keys (docs/45 Rev 8 §6.2). This is
-- the v1 PREREQUISITE for Layer-A read enforcement: deriveScope excludes
-- private_local / quarantine_review brains from a cloud_bound caller (§6.13).
--
-- PESSIMISTIC + STAGED (Codex v8 F4): the column is nullable and NULL means
-- cloud_bound (fail-closed). Existing keys are NOT silently trusted — only a key
-- the operator deliberately marks 'local_trusted' (pi's transport) is trusted.
-- Enforcement itself is gated by config OB1_EGRESS_ENFORCE (off|observe|enforce,
-- default observe) so adding this column changes no behavior until the operator
-- has classified brains + marked pi's key and flips to enforce.
--
-- read_egress_class is a READ-confidentiality attribute, NOT authority: it never
-- grants approve/downgrade/purge/export capability (§6.2 / Codex v7 F7).

alter table brain_access_keys
  add column if not exists read_egress_class text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'brain_access_keys_read_egress_class_check'
  ) then
    alter table brain_access_keys
      add constraint brain_access_keys_read_egress_class_check
      check (read_egress_class is null or read_egress_class in ('local_trusted', 'cloud_bound'));
  end if;
end $$;
