/**
 * A removal patch takes one behaviour back out of the app. It is stored at
 * lock time so `reprove` can ask, later, whether the check still notices.
 */

/** Past this many changed lines a base diff is a whole feature, not one behaviour: it rarely applies a month later. */
export const WIDE_PATCH_LINES = 300;

/** Changed lines (`+`/`-`, not the `+++`/`---` headers) and files in a git patch. */
export function patchStats(patch: string): { lines: number; files: number } {
  let lines = 0;
  let files = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) files++;
    else if ((line.startsWith("+") && !line.startsWith("+++ ")) || (line.startsWith("-") && !line.startsWith("--- "))) lines++;
  }
  return { lines, files };
}

export function wideWarning(stats: { lines: number; files: number }): string | null {
  if (stats.lines <= WIDE_PATCH_LINES) return null;
  return `The change behind this proof is ${stats.lines} lines across ${stats.files} files. Reprove will likely fail to apply it later; ` +
    "a --sabotage patch that removes just this behaviour is easier to keep proving.";
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** git's C-style quoting of a path ("caf\303\251.js"), or null if it isn't that. */
function unquote(quoted: string): string | null {
  if (!quoted.startsWith('"') || !quoted.endsWith('"') || quoted.length < 2) return null;
  const body = quoted.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[++i];
    if (next === undefined) return null;
    if (/[0-7]/.test(next)) {
      const oct = body.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(oct)) return null;
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]!);
    } else {
      return null;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The path in one `diff --git` header. Removal patches are made with --no-renames, so both sides name the same file. */
function headerPath(line: string): string | null {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
    const a = m && unquote(m[1]!);
    const b = m && unquote(m[2]!);
    return a && b && a.startsWith("a/") && b === `b/${a.slice(2)}` ? a.slice(2) : null;
  }
  if (!rest.startsWith("a/") || (rest.length - 5) % 2 !== 0) return null;
  const path = rest.slice(2, 2 + (rest.length - 5) / 2);
  return rest === `a/${path} b/${path}` ? path : null;
}

/** Every file a patch touches, or null when a header can't be read (treat that as "might touch anything"). */
export function patchFiles(patch: string): string[] | null {
  const files: string[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const path = headerPath(line);
    if (path === null) return null;
    files.push(path);
  }
  return files;
}

/**
 * Which promises a change can have hollowed out, the way Google runs
 * mutants only on the lines a change touches: a promise is reproved when
 * its removal patch touches a changed file. A patch that can't be read
 * counts as touched; a promise with no patch can't be reproved at all.
 */
export function touchedBy<P>(promises: P[], changed: string[], patchOf: (p: P) => string | null): { touched: P[]; untouched: P[]; noPatch: P[] } {
  const set = new Set(changed);
  const out = { touched: [] as P[], untouched: [] as P[], noPatch: [] as P[] };
  for (const p of promises) {
    const patch = patchOf(p);
    if (patch === null) {
      out.noPatch.push(p);
      continue;
    }
    const files = patchFiles(patch);
    (files === null || files.some((f) => set.has(f)) ? out.touched : out.untouched).push(p);
  }
  return out;
}
