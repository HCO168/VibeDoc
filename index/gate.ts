// Completion gate shared by `vibedoc features set done` and `vibedoc rules mark`: an item is done only when the
// comments of the functions that implement it, their index lines and the behavior sections that refer to it
// are up to date. `--skip "<原因>"` lets it through and records the reason and the open issues in the ledger.
import type { Config } from "../config.ts";
import { gateIssues, recordSkip, scan, sync, writeIndex, writeLedger } from "./fresh.ts";

export const gateOn = (cfg: Config) => !!(cfg.codemap && cfg.index?.gate);

// Throws with the list of what to update; returns the skipped issues (recorded) when --skip was given.
export function checkCompletion(root: string, cfg: Config, ids: string[], impl: string[] | undefined, skip: string | undefined) {
  if (!gateOn(cfg)) return;
  const s = scan(root, cfg);
  const open: string[] = [];
  for (const id of ids) {
    const issues = gateIssues(s, id, impl ?? s.items.get(id)?.impl ?? []);
    if (!issues.length) continue;
    if (skip?.trim()) recordSkip(s, id, skip.trim(), issues);
    else open.push(`${id}：`, ...issues.map((i) => `  - ${i}`));
  }
  if (open.length) {
    throw new Error(`还不能标记完成，先更新这些（vibedoc index check <id> 可随时复查）：\n${open.join("\n")}\n确实不需要更新时加 --skip "原因"，原因会记进 ${cfg.index!.dir}/ledger.json。`);
  }
  if (skip?.trim()) writeLedger(root, cfg, s.ledger);
}

// After the status change: record what is now current and rewrite the index and its overview.
export function afterCompletion(root: string, cfg: Config) {
  if (!gateOn(cfg)) return;
  const s = scan(root, cfg);
  sync(s);
  writeLedger(root, cfg, s.ledger);
  writeIndex(root, cfg, s);
}
