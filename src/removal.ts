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
