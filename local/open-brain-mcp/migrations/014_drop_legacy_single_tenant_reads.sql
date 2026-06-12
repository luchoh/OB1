-- 014_drop_legacy_single_tenant_reads.sql
-- Security cleanup discovered during PRD docs/39 Package 1 implementation.
--
-- Migration 001 created single-tenant read functions with NO brain scoping and
-- NO `deleted_at` guard. Migration 005 added brain-scoped replacements, but
-- because the new signatures differ (a leading `target_brain_id uuid`), 005's
-- CREATE OR REPLACE created OVERLOADS rather than replacing the originals. The
-- legacy overloads have lingered in the catalog ever since: dead (every live
-- caller uses the brain-scoped signature — see retrieval.mjs) but a latent
-- cross-brain + tombstone leak (ADR-0003) one stray caller away from firing,
-- and still VOLATILE.
--
-- This migration DROPs exactly those three legacy overloads, addressed by their
-- precise type signature so the brain-scoped versions (uuid first arg) are
-- untouched:
--   match_thoughts(vector, double precision, integer, jsonb)   -- 001:55
--   list_recent_thoughts(integer, jsonb)                       -- 001:92
--   thoughts_stats()                                           -- 001 (0-arg)
--
-- Idempotent (`if exists`) and safe to re-run.

drop function if exists match_thoughts(vector, double precision, integer, jsonb);
drop function if exists list_recent_thoughts(integer, jsonb);
drop function if exists thoughts_stats();
