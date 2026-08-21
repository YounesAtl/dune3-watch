#!/usr/bin/env node
/**
 * merge-state.mjs <ours.json> <target.json>
 *
 * Union-merges two watcher state files and writes the result to <target.json>.
 *
 * Why this exists: seen.json is machine-written state that only ever GROWS —
 * seenSessionIds and knownFormats are sets. Two runs can therefore never truly
 * conflict; the correct resolution is always "keep both". Handing that to
 * `git pull --rebase` instead produces a textual merge conflict, a detached
 * HEAD, and a failed job — which is exactly what happened on run #1.
 *
 * Losing an entry from seenSessionIds is not dangerous (you'd get one duplicate
 * notification). Losing knownFormats IS mildly dangerous, because a format the
 * watcher has forgotten looks "new" and could trip a false rename alarm. So both
 * are unioned rather than overwritten.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [oursPath, targetPath] = process.argv.slice(2);
if (!oursPath || !targetPath) {
  console.error('usage: merge-state.mjs <ours.json> <target.json>');
  process.exit(2);
}

const read = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return {}; }        // missing or malformed → treat as empty
};

const ours = read(oursPath);      // freshly computed by this run
const theirs = read(targetPath);  // whatever is currently on the branch

const union = (a, b) => [...new Set([...(a ?? []), ...(b ?? [])])];

const merged = {
  ...theirs,
  ...ours,                        // scalars: this run's values win
  seenSessionIds: union(theirs.seenSessionIds, ours.seenSessionIds),
  knownFormats: union(theirs.knownFormats, ours.knownFormats).sort(),
  // Sticky one-shot flags: once true anywhere, stay true, so a state race can't
  // resurrect an already-sent "Dune 3 entered the catalogue" notification.
  targetSeenInFilms: Boolean(theirs.targetSeenInFilms || ours.targetSeenInFilms),
};

writeFileSync(targetPath, JSON.stringify(merged, null, 2) + '\n');
console.log(
  `merged state: ${merged.seenSessionIds.length} seen session(s), ` +
  `${merged.knownFormats.length} known format(s)`
);
