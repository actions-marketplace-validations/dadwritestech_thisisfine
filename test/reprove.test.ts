import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/config.ts";
import { reprove, reproveExitCode, reproveText } from "../src/reprove.ts";
import type { ReproveDeps } from "../src/reprove.ts";
import type { PromiseState } from "../src/promises.ts";
import type { CheckOutcome, Proof } from "../src/types.ts";
import { lock } from "./helpers.ts";

const ROOT = "/proj";
const config = { start: "node server.js", ...DEFAULTS, build: "make" };

interface Behaviour {
  now?: CheckOutcome["status"];
  without?: CheckOutcome["status"];
  applies?: boolean;
  boots?: boolean;
  builds?: boolean;
  removal?: boolean;
  patchHash?: string;
  checkHash?: string;
  throws?: boolean;
}

const promise = (number: number): PromiseState => {
  const check = `.thisisfine/checks/${number}-x.spec.ts`;
  const proof: Proof = {
    proven: true, reason: "", now: { screenshot: null },
    without: { method: "base", ref: "HEAD", note: null, booted: true, failed: true, message: "", screenshot: null, removal: { file: `.thisisfine/proofs/p${number}.patch`, hash: "h", lines: 2 } }
  };
  return { number, sentence: `promise ${number}`, check, checkHash: "c", proof, lock: lock({ number, check }), status: "active" };
};

/** The app's behaviour per promise; the worktree for promise n is `/wt/n`. */
function deps(b: Record<number, Behaviour>) {
  const calls: string[] = [];
  const of = (check: string) => b[Number(/(\d+)-x/.exec(check)![1])] ?? {};
  let current = 0;
  const d: Partial<ReproveDeps> = {
    runBuild: async (r) => ({ ok: r.cwd === ROOT || b[current]?.builds !== false, output: "boom" }),
    startApp: async (s) => {
      if (s.cwd !== ROOT && b[current]?.boots === false) throw new Error("exited with code 1");
      return { url: s.cwd === ROOT ? "http://now" : "http://without", port: 1, stop: async () => {} };
    },
    startProxy: async (target) => ({ url: target, stop: async () => {} }),
    runChecks: async (r) => {
      const check = r.checks[0]!;
      const where = r.baseUrl === "http://now" ? "now" : "without";
      calls.push(`run:${where}:${check}`);
      if (of(check).throws) throw new Error("runner exploded");
      const status = where === "now" ? (of(check).now ?? "passed") : (of(check).without ?? "failed");
      return [{ check, status, message: status === "failed" ? "expected 2, got 1" : "", screenshot: null }];
    },
    snapshotCommit: () => "snap",
    addWorktree: (_r, _s, dir) => void calls.push(`worktree:${dir}`),
    prepareWorktree: () => {},
    removeWorktree: (_r, dir) => void calls.push(`remove:${dir}`),
    tempDir: () => `/wt/${current}`,
    applyRemoval: (dir) => (calls.push(`apply:${dir}`), b[current]?.applies !== false)
  };
  const hashOf = (rel: string) => {
    const n = Number(/(\d+)[-.]/.exec(rel.replace(/.*\/p?/, ""))![1]);
    current = n;
    return rel.includes("/proofs/") ? (b[n]?.patchHash ?? "h") : (b[n]?.checkHash ?? "c");
  };
  return { d, calls, hashOf };
}

async function judge(b: Record<number, Behaviour>, promises = Object.keys(b).map((n) => promise(Number(n))), edit?: (p: PromiseState) => void) {
  const { d, calls, hashOf } = deps(b);
  promises.forEach((p) => edit?.(p));
  const results = await reprove({ root: ROOT, config, promises, runDir: (n) => `/runs/${n}`, hashOf, deps: d });
  return { results, calls };
}

test("fails with the fix removed = still proven, exit 0", async () => {
  const { results, calls } = await judge({ 1: {} });
  assert.equal(results[0]!.verdict, "proven");
  assert.ok(calls.includes("apply:/wt/1") && calls.includes("remove:/wt/1"), calls.join(" "));
  assert.equal(reproveExitCode(results), 0);
  assert.match(reproveText(results), /✔ #1 still proven/);
});

test("passes with the fix removed = hollow, exit 1, and the way back goes through a human", async () => {
  const { results } = await judge({ 1: { without: "passed" } });
  assert.equal(results[0]!.verdict, "hollow");
  assert.equal(reproveExitCode(results), 1);
  const text = reproveText(results);
  assert.match(text, /✘ #1 hollow: passes with the fix removed/);
  assert.match(text, /propose --replaces 1/);
  assert.match(text, /human/);
});

test("a patch that no longer applies is stale; nothing runs without it", async () => {
  const { results, calls } = await judge({ 1: { applies: false } });
  assert.equal(results[0]!.verdict, "stale");
  assert.match(results[0]!.detail, /doesn.t apply cleanly/);
  assert.ok(!calls.includes("run:without:.thisisfine/checks/1-x.spec.ts"));
  assert.ok(calls.includes("remove:/wt/1"), "the worktree is still cleaned up");
  assert.match(reproveText(results), /--sabotage/);
  assert.equal(reproveExitCode(results), 1);
});

test("a lock without a removal patch can't be reproved, and that's not a failure", async () => {
  const { results } = await judge({ 1: {} }, [promise(1)], (p) => delete p.proof!.without.removal);
  assert.equal(results[0]!.verdict, "unreprovable");
  assert.match(reproveText(results), /propose --replaces 1 --check .* --sabotage/);
  assert.equal(reproveExitCode(results), 0);
});

test("a changed or missing patch, or a changed check, is tampering", async () => {
  for (const b of [{ patchHash: "other" }, { patchHash: "missing" }, { checkHash: "other" }]) {
    const { results, calls } = await judge({ 1: b });
    assert.equal(results[0]!.verdict, "tampered", JSON.stringify(b));
    assert.equal(calls.length, 0, "nothing runs");
    assert.equal(reproveExitCode(results), 1);
  }
});

test("no build, no boot or no result without the fix proves nothing: inconclusive, exit 0", async () => {
  for (const b of [{ builds: false }, { boots: false }, { without: "missing" as const }, { without: "flaky" as const }]) {
    const { results } = await judge({ 1: b });
    assert.equal(results[0]!.verdict, "inconclusive", JSON.stringify(b));
    assert.equal(reproveExitCode(results), 0);
  }
});

test("an exception inside one promise is inconclusive for that promise only", async () => {
  const { results } = await judge({ 1: { throws: true }, 2: {} });
  assert.deepEqual(results.map((r) => r.verdict), ["inconclusive", "proven"]);
  assert.match(results[0]!.detail, /runner exploded/);
});

test("#2 currently broken is reported and skipped; #1 and #3 are still reproved", async () => {
  const { results, calls } = await judge({ 1: {}, 2: { now: "failed" }, 3: { without: "passed" } });
  assert.deepEqual(results.map((r) => r.verdict), ["proven", "broken", "hollow"]);
  assert.match(results[1]!.detail, /stop gate will block/);
  assert.ok(!calls.includes("apply:/wt/2"));
  assert.ok(calls.includes("apply:/wt/3"));
  assert.equal(reproveExitCode(results), 1);
});
