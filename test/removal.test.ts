import { test } from "node:test";
import assert from "node:assert/strict";
import { patchStats, wideWarning } from "../src/removal.ts";

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
