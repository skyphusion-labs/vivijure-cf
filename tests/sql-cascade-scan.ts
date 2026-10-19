// SQL scanning for the migration FK-cascade guard (cf#1014). Pure string in, findings out, so the
// guard's own detector is testable against fixtures rather than only against the real tree.
//
// WHY THIS IS NOT A GREP. The guard has to assert the ABSENCE of something, which is the shape that
// passes vacuously, and the three ways a naive matcher gets it wrong all fail toward ABSENCE:
//
//   1. `ON DELETE CASCADE` inside a COMMENT. cf#1014 exists to tell a future author not to add one,
//      so a SQL comment saying exactly that is the likeliest thing to appear in these files. A
//      matcher that hits it reports a violation that is not there (false positive, merely annoying),
//      and the fix someone reaches for is to loosen the matcher until it misses the real thing.
//   2. `--` inside a STRING LITERAL. Stripping comments without tracking quotes truncates the rest
//      of that line, so a cascade AFTER a string containing `--` becomes invisible. Silent miss.
//   3. `ON UPDATE CASCADE`, which is not a delete cascade and must not trigger, and
//      `ON DELETE RESTRICT` / `SET NULL` / `NO ACTION`, which are the shapes we would WANT.
//
// The existing house pattern (tests/storage-quota-wiring.test.ts:142) filters lines that
// `startsWith("--")`. That is correct for its job, comparing one DDL statement to a constant, and
// insufficient here: it keeps a trailing comment on a code line and knows nothing about `/* */`.

/**
 * Remove SQL comments while PRESERVING offsets-by-line, so a finding can report a real line number.
 *
 * Tracks single- and double-quoted runs (SQLite uses `''` and `""` to escape), so a `--` inside a
 * literal is not treated as a comment. Newlines inside a block comment are kept, because dropping
 * them would shift every line number after it and send a future author to the wrong line.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1; // the newline itself is kept by the next pass
      continue;
    }

    if (c === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, sql.length);
      // Keep the block's newlines and nothing else, so line numbers survive.
      for (const ch of sql.slice(start, i)) if (ch === "\n") out += "\n";
      out += " ";
      continue;
    }

    if (c === "'" || c === '"') {
      out += c;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) { out += c + c; i += 2; continue; }
          out += c;
          i += 1;
          break;
        }
        out += sql[i];
        i += 1;
      }
      continue;
    }

    out += c;
    i += 1;
  }
  return out;
}

/**
 * Blank the CONTENTS of string literals, preserving quotes, length-in-lines and the rest of the text.
 *
 * For asking "does this schema DECLARE X", where a keyword inside a literal is prose and not SQL.
 * It is a separate pass from `stripSqlComments` on purpose: the cascade scan must KEEP literals
 * intact (a `--` inside one would otherwise swallow the rest of the line and hide a real cascade),
 * while a keyword search must drop them.
 *
 * MEASURED REASON THIS EXISTS: `migrations/demo/0001_demo_seed.sql` seeds a module manifest whose
 * JSON carries `"label":"Training references (FLUX 2 / Nano Banana)"`. A `\bREFERENCES\b` search
 * over comment-stripped SQL matches that ENGLISH WORD and reports a foreign key that is not there.
 * (A search without word boundaries is worse still: `SharedPreferences` in a comment contains
 * `references` as a substring.) Matching prose is the productive-looking direction, and a guard
 * whose premise check cries wolf is a guard someone loosens.
 */
export function stripSqlLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      out += c;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; }
          out += c;
          i += 1;
          break;
        }
        if (sql[i] === "\n") out += "\n";
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

export interface CascadeFinding {
  /** The guarded column the cascade is declared on, or null when it could not be attributed. */
  column: string | null;
  /** Line of the `ON DELETE CASCADE` token itself, which is where the author has to look. The
   *  clause HEAD is a poor answer: an inline constraint's head begins right after the previous
   *  column's comma, so it reports the line above, and a table constraint's head begins at the
   *  CREATE TABLE paren, which can be many lines up. */
  line: number;
  /** The constraint text, collapsed to one line for a readable failure message. */
  clause: string;
}

const DELETE_CASCADE = /on\s+delete\s+cascade/i;

/** 1-indexed line of an offset in the ORIGINAL (or offset-preserving stripped) text. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/** The next comma at the SAME paren depth, so `REFERENCES t(a,b) ON DELETE CASCADE` is not cut off
 *  at the comma inside `(a,b)`. Returns the end of the text when there is none. */
function clauseEnd(sql: string, from: number): number {
  let depth = 0;
  for (let i = from; i < sql.length; i += 1) {
    const c = sql[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      if (depth === 0) return i;
      depth -= 1;
    } else if (c === "," && depth === 0) return i;
  }
  return sql.length;
}

/**
 * Every `ON DELETE CASCADE` in `sql`, attributed to a guarded column where possible.
 *
 * Anchored on `REFERENCES`, because that keyword is in every foreign-key constraint in both of
 * SQLite's spellings, and the column it constrains sits immediately before it in both:
 *
 *   inline            `project_id INTEGER REFERENCES storyboard_projects(id) ON DELETE CASCADE`
 *   table constraint  `FOREIGN KEY (parent_id) REFERENCES renders(id) ON DELETE CASCADE`
 *
 * In each case the text from the nearest preceding `,` or `(` up to `REFERENCES` names the column.
 *
 * A cascade this cannot attribute to a `REFERENCES` is reported with `column: null` rather than
 * dropped. That is the direction that matters: an unrecognised shape must surface as a finding a
 * human reads, never as silence, because silence here is indistinguishable from a clean schema.
 */
export function findDeleteCascades(sql: string, guardedColumns: string[]): CascadeFinding[] {
  const clean = stripSqlComments(sql);
  const findings: CascadeFinding[] = [];
  const attributed: Array<[number, number]> = [];

  const refs = /\bREFERENCES\b/gi;
  let m: RegExpExecArray | null;
  while ((m = refs.exec(clean)) !== null) {
    const r = m.index;
    const end = clauseEnd(clean, r);
    const tail = clean.slice(r, end);
    if (!DELETE_CASCADE.test(tail)) continue;

    const headStart = Math.max(clean.lastIndexOf(",", r), clean.lastIndexOf("(", r)) + 1;
    const head = clean.slice(headStart, r);
    attributed.push([r, end]);

    const hit = guardedColumns.find((col) => new RegExp(`\\b${col}\\b`).test(head));
    if (hit) {
      const rel = tail.search(DELETE_CASCADE);
      findings.push({
        column: hit,
        line: lineOf(clean, rel >= 0 ? r + rel : headStart),
        clause: `${head}${tail}`.replace(/\s+/g, " ").trim(),
      });
    }
  }

  // Any delete cascade not inside a clause the pass above already read.
  const all = /on\s+delete\s+cascade/gi;
  while ((m = all.exec(clean)) !== null) {
    const at = m.index;
    if (attributed.some(([s, e]) => at >= s && at < e)) continue;
    findings.push({
      column: null,
      line: lineOf(clean, at),
      clause: clean.slice(Math.max(0, at - 80), at + 40).replace(/\s+/g, " ").trim(),
    });
  }

  return findings;
}
