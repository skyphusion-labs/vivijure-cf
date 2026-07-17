// The studio migrations the provisioner applies to a fresh tenant D1 (#53 step d1_migrate).
//
// EXPLICIT imports, not a glob: a Worker cannot read a directory, so the set is spelled out and a
// guard test (tests/control-plane/studio-migrations.test.ts) compares this list to the files on
// disk. Adding migrations/00NN_x.sql without adding it here fails CI instead of silently
// provisioning new tenants with a stale schema, which is the drift this file would otherwise invent.
//
// SCOPE mirrors the live-verified e2e chain exactly: top-level migrations/*.sql only.
// migrations/manual/ is operator-run by design and migrations/demo/ is demo-studio seed data;
// neither belongs in a tenant D1.
//
// VERSIONING CAVEAT, stated rather than hidden: these ride the CONTROL PLANE's deploy commit, while
// the studio bundle is the pinned release. Additive-only migrations make that safe in practice, but
// the honest end state is the release manifest carrying its own migrations; tracked in the
// provisioner follow-up issue rather than silently assumed away.

import m0001 from "../../migrations/0001_init.sql";
import m0002 from "../../migrations/0002_user_prefs.sql";
import m0003 from "../../migrations/0003_cast_voice.sql";
import m0005 from "../../migrations/0005_operator_module_config.sql";
import m0006 from "../../migrations/0006_installed_modules.sql";
import m0007 from "../../migrations/0007_film_advance_lease.sql";
import m0008 from "../../migrations/0008_spend_counter.sql";
import m0009 from "../../migrations/0009_api_tokens.sql";
import m0010 from "../../migrations/0010_public_ids.sql";
import m0011 from "../../migrations/0011_advance_lease_token.sql";

/** Filenames, for the disk-parity guard test. Order is the apply order. */
export const STUDIO_MIGRATION_FILES = [
  "0001_init.sql",
  "0002_user_prefs.sql",
  "0003_cast_voice.sql",
  "0005_operator_module_config.sql",
  "0006_installed_modules.sql",
  "0007_film_advance_lease.sql",
  "0008_spend_counter.sql",
  "0009_api_tokens.sql",
  "0010_public_ids.sql",
  "0011_advance_lease_token.sql",
] as const;

/** One multi-statement string, the same single-call shape the live e2e proved D1 accepts. */
export const STUDIO_MIGRATIONS = [m0001, m0002, m0003, m0005, m0006, m0007, m0008, m0009, m0010, m0011].join("\n");
