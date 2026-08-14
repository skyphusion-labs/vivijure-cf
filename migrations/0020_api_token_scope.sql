-- cf#520: per-route authorization. `api_tokens` said WHO a credential belongs to and nothing about
-- WHAT it may do, so every named token was operator-equivalent -- a consumer token could call
-- POST /api/storage/reconcile, which rewrites an estate-wide ledger (cf#516).
--
-- SCHEMA migration, NOT a data migration. Nothing is in production; all four live tokens are
-- reissued with an explicit scope, so this column does not have to arrive at a safe state by
-- inference. The DEFAULT exists only because SQLite requires a non-NULL default when ADD COLUMN
-- carries NOT NULL -- it is not a compatibility affordance and nothing should be built on it.
--
-- ITS VALUE IS DELIBERATE AND IT HAS A CONSEQUENCE THE OPERATOR MUST SEQUENCE: 'consumer' is the
-- least privilege, so applying this migration DOWNGRADES every existing named token to consumer
-- until it is reissued. That is the safe direction (a consumer token that needed more 401s loudly;
-- an operator default would leave the hole open under a new name), but it means the reissue has to
-- happen with the tag that applies this migration, not after it. Migrations apply in the DEPLOY
-- job on a version tag, so merging this is inert -- tagging is the moment it lands.
--
-- The CHECK constraint is not retroactive: SQLite does not re-evaluate it for rows that predate
-- the ALTER. src/auth-gate.ts therefore re-validates every value it reads and fails CLOSED on
-- anything outside the union, which is the guard that actually holds.
ALTER TABLE api_tokens
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'consumer'
  CHECK (scope IN ('operator', 'consumer'));
