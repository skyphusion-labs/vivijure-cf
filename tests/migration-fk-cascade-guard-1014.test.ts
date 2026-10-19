import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { findDeleteCascades, stripSqlComments, stripSqlLiterals } from "./sql-cascade-scan";

// cf#1014. A SCHEMA GUARD, not a schema change.
//
// WHAT IT PROTECTS. #1007 made project and render delete free their R2 objects, and the safety
// property is an ORDERING: the reclaim runs, and only then does the D1 row go. The row is the only
// index of a render's keys, so the reverse order orphans every object permanently.
//
// `ON DELETE CASCADE` on either of these columns deletes those rows INSIDE the same statement that
// deletes the parent. The handler's reclaim can never run first, so it reintroduces #1007's leak and
// cannot be fixed by being careful at the call site. And it fails in the reassuring direction: the
// DELETE succeeds, D1 looks correct and consistent, and the only evidence is bytes in R2 that
// nothing names. `r2-orphan-reconcile.ts` will not find them, because it treats every non-cast key
// as out-of-scope by design.
//
// WHY A CASCADE IS THE LIKELY NEXT CHANGE, which is the whole reason this guard exists. Conrad ruled
// on 2026-10-19 that deleting a project DOES delete its renders. The schema does not say so: both
// relations are comments (`migrations/0001_init.sql:83,86` -- `-- logical FK`), and MEASURED across
// every file in `migrations/`, this schema declares NO foreign keys at all. So "make the schema
// honest about the ruling" is a reasonable-sounding future cleanup whose obvious spelling is
// `ON DELETE CASCADE`, and it would silently undo #1007.
//
// `ON DELETE RESTRICT` was considered and rejected as the primary control. It orders the two D1
// deletes against each other and says NOTHING about R2: deleting the render rows and then the
// project row satisfies it completely and leaks every object. It would also be this schema's first
// declared FK (a full `renders` table rebuild, since SQLite has no ADD CONSTRAINT, plus a data
// migration for the stray `project_id` values that already exist), and SQLite enforces foreign keys
// only with `PRAGMA foreign_keys = ON`, which is UNMEASURED on this D1 binding. A declared-but-
// unenforced constraint is a control that cannot go red while carrying the schema's authority.
// Full reasoning on cf#1014.
//
// This test is the cheap control that guards the actual trap: it goes red the moment the cascade is
// declared, which is the moment anyone cares.

const MIGRATIONS = join(__dirname, "..", "migrations");

/** The two columns whose rows NAME R2 keys. `project_id` is the one Conrad's ruling invites a
 *  cascade on; `parent_id` is self-referential (scatter/finalize), so a cascade there would reach
 *  from a parent render through to its shards, and the survivor gate that handles that correctly
 *  lives in the handler a DB-level cascade bypasses. */
const GUARDED = ["project_id", "parent_id"];

const WHY =
  "ON DELETE CASCADE on renders.project_id or renders.parent_id deletes the rows that NAME this " +
  "render's R2 keys, inside the same statement that deletes the parent. The reclaim in " +
  "hDeleteProject / hDeleteRender can never run first, so every object is orphaned with nothing " +
  "left to find it by, and the existing orphan sweep is cast-only and will not collect it. " +
  "See cf#1014 for why RESTRICT is not a substitute, and cf#1007 for the leak this restores. " +
  "If you need the schema to express Conrad's cascade ruling, the ordering must stay in the " +
  "handler: change this guard deliberately, with that reasoning, not to make a migration pass.";

function sqlFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sqlFilesUnder(p));
    else if (entry.name.endsWith(".sql")) out.push(p);
  }
  return out;
}

describe("the detector itself (positive controls first: this guard asserts an ABSENCE)", () => {
  // Every case below exists because the assertion on the real tree passes when the detector is
  // broken in exactly the same way it passes when the tree is clean. Without these, a typo in the
  // regex reads as a healthy schema forever.

  it("CATCHES an inline column constraint", () => {
    const f = findDeleteCascades(
      `CREATE TABLE renders_new (
         id INTEGER PRIMARY KEY,
         project_id INTEGER REFERENCES storyboard_projects(id) ON DELETE CASCADE,
         status TEXT NOT NULL
       );`,
      GUARDED,
    );
    expect(f.map((x) => x.column)).toEqual(["project_id"]);
    expect(f[0].line).toBe(3);
  });

  it("CATCHES a table-level FOREIGN KEY constraint, including the self-referential one", () => {
    const f = findDeleteCascades(
      `CREATE TABLE renders_new (
         id INTEGER PRIMARY KEY,
         parent_id INTEGER,
         FOREIGN KEY (parent_id) REFERENCES renders(id) ON DELETE CASCADE
       );`,
      GUARDED,
    );
    expect(f.map((x) => x.column)).toEqual(["parent_id"]);
  });

  it("CATCHES it across newlines and irregular whitespace", () => {
    // A formatter or a hand-wrapped long line must not defeat the guard.
    const f = findDeleteCascades(
      `project_id INTEGER
         REFERENCES storyboard_projects(id)
         ON   DELETE
         CASCADE,`,
      GUARDED,
    );
    expect(f.map((x) => x.column)).toEqual(["project_id"]);
  });

  it("CATCHES it when the referenced table names several columns", () => {
    // The comma inside `(a, b)` must not end the clause before the action is read.
    const f = findDeleteCascades(
      `FOREIGN KEY (project_id) REFERENCES storyboard_projects(id, slug) ON DELETE CASCADE`,
      GUARDED,
    );
    expect(f.map((x) => x.column)).toEqual(["project_id"]);
  });

  it("REPORTS an unattributable cascade rather than staying silent", () => {
    // An FK spelling this does not anchor on must surface as something a human reads. Silence here
    // is byte-identical to a clean schema, which is the one outcome that must be impossible.
    const f = findDeleteCascades(`SOMETHING UNEXPECTED ON DELETE CASCADE`, GUARDED);
    expect(f).toHaveLength(1);
    expect(f[0].column).toBeNull();
  });
});

describe("the detector does NOT fire on the shapes that are fine", () => {
  it("ignores a cascade named in a LINE COMMENT, which cf#1014 makes likely in these files", () => {
    // The single most probable false positive: a migration author documenting the prohibition.
    const f = findDeleteCascades(
      `CREATE TABLE renders_new (
         -- Never add ON DELETE CASCADE to project_id here; see cf#1014.
         project_id INTEGER REFERENCES storyboard_projects(id) ON DELETE RESTRICT
       );`,
      GUARDED,
    );
    expect(f, "a comment was read as a declaration").toEqual([]);
  });

  it("ignores a cascade named in a BLOCK COMMENT, and keeps line numbers correct after it", () => {
    const sql = `CREATE TABLE renders_new (
  /* project_id must not be
     ON DELETE CASCADE -- see cf#1014 */
  project_id INTEGER REFERENCES storyboard_projects(id) ON DELETE CASCADE
);`;
    const f = findDeleteCascades(sql, GUARDED);
    expect(f.map((x) => x.column)).toEqual(["project_id"]);
    // The real declaration is on line 4. A stripper that collapsed the block comment would report
    // line 2 and send the next author to the wrong place.
    expect(f[0].line, "block-comment newlines were not preserved").toBe(4);
  });

  it("ignores ON UPDATE CASCADE, which is not a delete cascade", () => {
    const f = findDeleteCascades(
      `project_id INTEGER REFERENCES storyboard_projects(id) ON UPDATE CASCADE`,
      GUARDED,
    );
    expect(f).toEqual([]);
  });

  it("ignores the actions we would WANT, and still catches a delete cascade beside an update one", () => {
    for (const action of ["RESTRICT", "SET NULL", "NO ACTION", "SET DEFAULT"]) {
      expect(
        findDeleteCascades(`project_id INTEGER REFERENCES p(id) ON DELETE ${action}`, GUARDED),
        `ON DELETE ${action} must be allowed`,
      ).toEqual([]);
    }
    expect(
      findDeleteCascades(
        `project_id INTEGER REFERENCES p(id) ON UPDATE CASCADE ON DELETE CASCADE`,
        GUARDED,
      ).map((x) => x.column),
    ).toEqual(["project_id"]);
  });

  it("does not attribute a cascade on some OTHER table's column to a guarded one", () => {
    const f = findDeleteCascades(
      `CREATE TABLE t (
         sub_project_id INTEGER REFERENCES other(id) ON DELETE CASCADE
       );`,
      GUARDED,
    );
    // `project_id` must not match inside `sub_project_id` (the preceding `_` is a word character,
    // so the boundary does not open). The cascade IS attributed to a REFERENCES clause, just not to
    // a guarded column, so the correct answer is NO finding at all rather than an unattributed one.
    expect(f, "a cascade on an unrelated column was reported").toEqual([]);
  });

  it("a `--` inside a STRING LITERAL does not blind the scanner to a later cascade", () => {
    // Stripping comments without tracking quotes truncates this line, and the cascade after it
    // disappears. That is a silent miss, which is the direction that cannot be allowed.
    const sql =
      `INSERT INTO t (url) VALUES ('https://x/a--b');\n` +
      `ALTER TABLE renders ADD COLUMN project_id INTEGER REFERENCES p(id) ON DELETE CASCADE;`;
    expect(stripSqlComments(sql)).toContain("a--b");
    expect(findDeleteCascades(sql, GUARDED).map((x) => x.column)).toEqual(["project_id"]);
  });
});

describe("the real migrations declare no delete cascade on a key-naming column", () => {
  const files = sqlFilesUnder(MIGRATIONS);

  // THE DENOMINATOR. "No violations" over zero files is the same result as a clean schema, so the
  // scan must prove it read the tree before its verdict means anything. A wrong path, a renamed
  // directory or a changed extension all land here instead of reporting success.
  it("read the migration tree at all", () => {
    expect(files.length, `scanned ${files.length} .sql files under ${MIGRATIONS}`).toBeGreaterThan(15);
    const corpus = files.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(corpus, "the renders table was not in the scanned corpus").toMatch(
      /CREATE TABLE IF NOT EXISTS renders\b/,
    );
    expect(corpus).toMatch(/storyboard_projects/);
  });

  it("THE GUARD: no ON DELETE CASCADE on renders.project_id or renders.parent_id", () => {
    const violations = files.flatMap((file) =>
      findDeleteCascades(readFileSync(file, "utf8"), GUARDED).map((f) => ({ file, ...f })),
    );
    const report = violations
      .map((v) => `  ${v.file.replace(MIGRATIONS, "migrations")}:${v.line}  [${v.column ?? "UNATTRIBUTED"}]  ${v.clause}`)
      .join("\n");
    expect(violations, violations.length ? `\n${report}\n\n${WHY}\n` : "").toEqual([]);
  });

  it("and the schema still declares no foreign keys at all, which is the premise above", () => {
    // Recorded as a MEASUREMENT, not an assumption: the cf#1014 reasoning rests on this schema
    // having zero DECLARED foreign keys, so if that stops being true the reasoning needs re-reading
    // rather than silently carrying on.
    //
    // COMMENTS AND LITERALS BOTH HAVE TO GO, and finding that out is why this assertion exists in
    // this form. Over comment-stripped SQL alone it goes RED on
    // `migrations/demo/0001_demo_seed.sql`, whose seeded module manifest contains the English words
    // "Training references". That is a keyword matching PROSE, which is the productive-looking
    // direction, and it is the same class of error as a word-boundary-free search matching
    // `references` inside `SharedPreferences` in a comment.
    const corpus = stripSqlLiterals(stripSqlComments(files.map((f) => readFileSync(f, "utf8")).join("\n")));
    expect(corpus, "a REFERENCES clause appeared; re-read the cf#1014 reasoning").not.toMatch(/\bREFERENCES\b/i);
    expect(corpus).not.toMatch(/\bFOREIGN\s+KEY\b/i);
    expect(corpus, "a foreign_keys pragma appeared; FK enforcement is no longer unmeasured").not.toMatch(/foreign_keys/i);
  });

  it("the premise instrument can tell a DECLARATION from the same word in prose", () => {
    // The positive control for the check above. Without it, "no REFERENCES found" is equally
    // consistent with a stripper that blanked the whole corpus.
    const declared = `CREATE TABLE t (a INTEGER REFERENCES other(id));`;
    expect(stripSqlLiterals(stripSqlComments(declared))).toMatch(/\bREFERENCES\b/i);
    const prose = `INSERT INTO t (j) VALUES ('{"label":"Training references (FLUX 2)"}');`;
    expect(stripSqlLiterals(stripSqlComments(prose)), "prose inside a literal still matched").not.toMatch(
      /\bREFERENCES\b/i,
    );
    // And the literal stripper must not eat the SQL around it.
    expect(stripSqlLiterals(stripSqlComments(prose))).toMatch(/INSERT INTO t \(j\) VALUES/);
  });
});
