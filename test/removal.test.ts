import { test } from "node:test";
import assert from "node:assert/strict";
import { patchFiles, patchStats, touchedBy, wideWarning } from "../src/removal.ts";

const PATCH = [
  "diff --git a/app.js b/app.js",
  "index 1111111..2222222 100644",
  "--- a/app.js",
  "+++ b/app.js",
  "@@ -1,3 +1,2 @@",
  " keep",
  "-gone",
  "-also gone",
  "+new",
  "diff --git a/logo.png b/logo.png",
  "index 3333333..4444444 100644",
  "GIT binary patch",
  "literal 7",
  "OcmZQzWMXDvWB>pF2LJ&8",
  "",
  "literal 8",
  "PcmZQzWMXDvWB>pF2LJ&8",
  ""
].join("\n");

test("patchStats counts changed lines, not headers, and every file including binary ones", () => {
  assert.deepEqual(patchStats(PATCH), { lines: 3, files: 2 });
  assert.deepEqual(patchStats(""), { lines: 0, files: 0 });
});

test("the wide-diff warning appears only past 300 lines and suggests --sabotage", () => {
  assert.equal(wideWarning({ lines: 300, files: 4 }), null);
  const w = wideWarning({ lines: 301, files: 4 });
  assert.match(w!, /301 lines across 4 files/);
  assert.match(w!, /--sabotage/);
});

test("patchFiles names every file a removal patch touches, quoted paths included", () => {
  assert.deepEqual(patchFiles(PATCH), ["app.js", "logo.png"]);
  assert.deepEqual(patchFiles("diff --git a/src/my file.js b/src/my file.js\n-x\n"), ["src/my file.js"]);
  // git C-quotes paths with special bytes: "caf\303\251.js" is café.js
  assert.deepEqual(patchFiles('diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"\n-x\n'), ["café.js"]);
  assert.deepEqual(patchFiles('diff --git "a/tab\\there.js" "b/tab\\there.js"\n'), ["tab\there.js"]);
  assert.equal(patchFiles("diff --git a/one.js b/two.js\n"), null, "can't tell: the caller must assume it overlaps");
  assert.deepEqual(patchFiles(""), []);
});

test("touchedBy keeps promises whose fix lives in a changed file, and every promise it can't judge", () => {
  const patches: Record<string, string | null> = { 1: PATCH, 2: "diff --git a/other.js b/other.js\n", 3: "diff --git a/one.js b/two.js\n" };
  const ps = [1, 2, 3, 4].map((number) => ({ number }));
  const r = touchedBy(ps, ["app.js", "README.md"], (p) => (p.number === 4 ? null : patches[p.number]!));
  assert.deepEqual(r.touched.map((p) => p.number), [1, 3]);
  assert.deepEqual(r.untouched.map((p) => p.number), [2]);
  assert.deepEqual(r.noPatch.map((p) => p.number), [4]);
});
