import { join } from "node:path";
import * as gitOps from "./git.ts";
import type { PromiseState } from "./promises.ts";
import { proveDeps, runOnce } from "./prove.ts";
import type { ProveDeps } from "./prove.ts";
import type { Config } from "./types.ts";

/**
 * A check is proven to fail once, at lock time. `reprove` asks the same
 * question of today's code: with only this fix taken out (the removal patch
 * stored at lock time), does the check still go red? A check that stays
 * green is hollow: unchanged on disk, but no longer testing the behaviour.
 *
 * It only reports. Nothing is edited, retired or replaced: the way out of
 * a hollow check is a new proposal, and a person typing "y".
 */

export type Verdict = "proven" | "hollow" | "stale" | "broken" | "tampered" | "unreprovable" | "inconclusive";

export interface ReproveResult {
  number: number;
  sentence: string;
  check: string;
  verdict: Verdict;
  detail: string;
}

export type ReproveDeps = Pick<ProveDeps,
  "runBuild" | "startApp" | "startProxy" | "runChecks" | "snapshotCommit" | "addWorktree" | "prepareWorktree" | "removeWorktree" | "tempDir"
> & { applyRemoval: (dir: string, patchPath: string) => boolean };

export interface ReproveOptions {
  root: string;
  config: Config;
  promises: PromiseState[];
  runDir: (number: number) => string;
  /** Root-relative path → `fileHash`, "missing" for a missing file. */
  hashOf: (rel: string) => string;
  deps?: Partial<ReproveDeps>;
}

/** Exit 1 on these: each means a promise is not what the ledger says it is. */
const FAILING: Verdict[] = ["hollow", "stale", "broken", "tampered"];

export async function reprove(o: ReproveOptions): Promise<ReproveResult[]> {
  const d: ReproveDeps = { ...proveDeps, applyRemoval: gitOps.applyRemoval, ...o.deps };
  const results: ReproveResult[] = [];
  for (const p of o.promises) {
    const judged = (verdict: Verdict, detail: string) => results.push({ number: p.number, sentence: p.sentence, check: p.check, verdict, detail });
    try {
      const [verdict, detail] = await reproveOne(d, o, p);
      judged(verdict, detail);
    } catch (err) {
      judged("inconclusive", `couldn't run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return results;
}

async function reproveOne(d: ReproveDeps, o: ReproveOptions, p: PromiseState): Promise<[Verdict, string]> {
  if (o.hashOf(p.check) !== p.checkHash) return ["tampered", `${p.check} changed since it was locked`];
  const removal = p.proof?.without.removal;
  if (!removal) return ["unreprovable", "locked before reprove existed, so there's no removal patch to replay"];
  const hash = o.hashOf(removal.file);
  if (hash !== removal.hash) return ["tampered", `${removal.file} ${hash === "missing" ? "is missing" : "changed since it was locked"}`];

  const opts = { root: o.root, config: o.config, check: p.check, runDir: o.runDir(p.number) };
  const now = await runOnce(d, opts, o.root, "now", false);
  if (!now.built) return ["broken", "the current code doesn't build (the stop gate will block on this)"];
  if (!now.booted) return ["broken", `the app doesn't start (the stop gate will block on this): ${now.bootError.split("\n")[0]}`];
  if (now.outcome?.status !== "passed") {
    return ["broken", `fails on today's code (the stop gate will block on this)${now.outcome?.message ? `: ${now.outcome.message.split("\n")[0]}` : ""}`];
  }

  const dir = d.tempDir();
  try {
    d.addWorktree(o.root, d.snapshotCommit(o.root), dir);
    d.prepareWorktree(o.root, dir, o.config.copy);
    if (!d.applyRemoval(dir, join(o.root, removal.file))) {
      return ["stale", "the code under the fix has moved, so its removal patch doesn't apply cleanly"];
    }
    const w = await runOnce(d, opts, dir, "without", true);
    if (!w.built) return ["inconclusive", "doesn't build with the fix removed, and a crash proves nothing"];
    if (!w.booted) return ["inconclusive", "the app doesn't start with the fix removed, and a crash proves nothing"];
    const status = w.outcome?.status;
    if (status === "failed") return ["proven", "fails with the fix removed"];
    if (status === "passed") return ["hollow", "passes with the fix removed"];
    if (status === "flaky") return ["inconclusive", "failed once, then passed, with the fix removed"];
    return ["inconclusive", `no result with the fix removed${w.outcome?.message ? `: ${w.outcome.message.split("\n")[0]}` : ""}`];
  } finally {
    d.removeWorktree(o.root, dir);
  }
}

const LABEL: Record<Verdict, string> = {
  proven: "✔ #N still proven",
  hollow: "✘ #N hollow",
  stale: "✘ #N no longer applies",
  broken: "✘ #N currently broken",
  tampered: "✘ #N tampered",
  unreprovable: "· #N can't reprove",
  inconclusive: "? #N inconclusive"
};

export function reproveText(results: ReproveResult[]): string {
  if (!results.length) return "No active promises to reprove.";
  const lines = results.map((r) => `${LABEL[r.verdict].replace("N", String(r.number))}: ${r.detail}. "${r.sentence}"`);
  const next: string[] = [];
  for (const r of results) {
    const n = r.number;
    if (r.verdict === "hollow") {
      next.push(`#${n}: write a check that fails without the fix, then run thisisfine propose --replaces ${n} --check <new check>.`);
    } else if (r.verdict === "stale") {
      next.push(`#${n}: write a fresh patch that removes this behaviour from today's code, then run thisisfine propose --replaces ${n} --check ${r.check} --sabotage <patch>.`);
    } else if (r.verdict === "unreprovable") {
      next.push(`#${n}: to make it reprovable, run thisisfine propose --replaces ${n} --check ${r.check} --sabotage <patch>.`);
    }
  }
  if (next.length) {
    lines.push("", `Next steps (each goes to the human as a new proposal; nothing changes until they say y):`, ...next.map((s) => `  ${s}`));
  }
  return lines.join("\n");
}

export function reproveExitCode(results: ReproveResult[]): number {
  return results.some((r) => FAILING.includes(r.verdict)) ? 1 : 0;
}
