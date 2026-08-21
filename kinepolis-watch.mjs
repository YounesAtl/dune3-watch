#!/usr/bin/env node
/**
 * kinepolis-watch.mjs — IMAX 70mm session watcher for Kinepolis Brussel.
 *
 * No Playwright. No headless browser. No bot wall.
 *
 * The showtime data does NOT come from kinepolis.be (which is the thing behind
 * bot protection). It comes from a separate, wide-open programmation API:
 *
 *   https://kinepolisweb-programmation.kinepolis.com/api/Programmation/BE/NL/WWW
 *
 * That returns EVERY session in Belgium (~10k sessions, ~13.8 MB) as plain JSON.
 * Verified: works with no cookies, no auth, no referer, no User-Agent games.
 * Response is Cache-Control: max-age=300, so polling faster than 5 min is wasted.
 *
 * Requires Node 18+ (built-in fetch). Zero dependencies.
 *
 *   node kinepolis-watch.mjs              # normal poll
 *   node kinepolis-watch.mjs --selftest   # prove the pipeline works TODAY
 *   node kinepolis-watch.mjs --dump       # print current 70mm sessions and exit
 */

import { readFile, writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const FEED = process.env.FEED_URL || 'https://kinepolisweb-programmation.kinepolis.com/api/Programmation/BE/NL/WWW';

const COMPLEX = 'KBRU';          // Kinepolis Brussel. The ONLY BE venue with 70mm.
const STATE_FILE = process.env.STATE_FILE || './seen.json';

// Primary key for Dune 3, read off the live site:
//   https://kinepolis.be/nl/movies/detail/36318/HO00013472/0/dune-part-three
//                                        ^corporateId  ^film id
const TARGET = {
  filmId: 'HO00013472',
  corporateId: 36318,
  // Fallback in case Kinepolis re-issues the film under a new HO code — which
  // does happen when a distributor resubmits a title. Matching on id ALONE is
  // the single most likely way this watcher silently misses the thing.
  titleRe: /dune/i,
  titlePartRe: /(part\s*)?(three|3|iii|drie)/i,
};

// ---------------------------------------------------------------------------
// 70mm DETECTION
// ---------------------------------------------------------------------------
// The feed marks 70mm in three independent places. Any one of them is enough.
// Checking all three means a schema tweak in one spot doesn't blind the watcher.
//
//   1. film.format            → { name: "IMAX 2D 70MM", id: "20179" }
//   2. film.format.attributes → [ { shortName: "70mm" }, { shortName: "IMAX W" } ]
//   3. rawSessionAttributes   → "2D,70mm,CineK,Cl CineK,English,fr,IMAX,IMAX W,..."
//
// NOTE: format id 16 is "IMAX 2D" — ordinary IMAX laser, NOT 70mm. Do not match
// on /imax/ alone or you will get paged for the wrong screenings.
const SEVENTY_MM = /\b70\s*-?\s*mm\b/i;

function is70mm(s) {
  const f = s.film?.format ?? {};
  if (SEVENTY_MM.test(f.name ?? '')) return true;
  if (Array.isArray(f.attributes) && f.attributes.some((a) => SEVENTY_MM.test(a?.shortName ?? ''))) return true;
  if ((s.rawSessionAttributes ?? '').split(',').some((t) => SEVENTY_MM.test(t.trim()))) return true;
  return false;
}

const atBrussels = (s) => s.mainComplex === COMPLEX || s.complexOperator === COMPLEX;

function isTarget(session, filmsById) {
  const f = session.film ?? {};
  if (f.id === TARGET.filmId) return true;
  if (f.corporateId === TARGET.corporateId) return true;
  const title = filmsById[f.id]?.title ?? '';
  return TARGET.titleRe.test(title) && TARGET.titlePartRe.test(title);
}

// ---------------------------------------------------------------------------
// FETCH + PARSE
// ---------------------------------------------------------------------------
async function fetchFeed() {
  const ctl = AbortSignal.timeout(90_000);
  const res = await fetch(FEED, {
    signal: ctl,
    headers: {
      // Not evasion — just being a polite, identifiable client.
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': 'kinepolis-70mm-watch/1.0 (personal showtime alert)',
    },
  });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json?.sessions)) throw new Error('feed shape changed: no .sessions array');
  return json;
}

// ---------------------------------------------------------------------------
// CANARY — the part that matters most
// ---------------------------------------------------------------------------
// Dune 3 opens 16 Dec 2026. Between now and then this script will run ~7,000
// times and correctly find nothing. "Found nothing" and "quietly broken" look
// IDENTICAL from the outside. So on every run we assert that things we KNOW are
// true right now are still true. If they stop being true, the feed changed and
// the watcher needs attention — that is itself an alert-worthy event.
function canary(feed, state = {}) {
  const problems = [];
  const notes = [];
  const S = feed.sessions;

  if (S.length < 2000) problems.push(`only ${S.length} sessions in feed (expected ~9k) — feed may be truncated`);
  if (!Array.isArray(feed.films) || feed.films.length < 50) problems.push(`films array is ${feed.films?.length} entries — expected 200+`);

  const bru = S.filter(atBrussels);
  if (bru.length < 100) problems.push(`only ${bru.length} sessions at ${COMPLEX} — complex code may have changed`);

  const formats = [...new Set(S.map((s) => s.film?.format?.name).filter(Boolean))].sort();
  if (formats.length < 3) problems.push(`only ${formats.length} distinct formats — format field may have collapsed`);

  // --- the interesting one -------------------------------------------------
  // "No 70mm sessions in the feed" has TWO possible causes, and they demand
  // opposite responses:
  //
  //   (a) nothing is currently programmed in 70mm — completely normal. The
  //       Odyssey's run ends 22 Sep 2026 and there may then be no 70mm title
  //       in Belgium until Dune 3. Alerting on this would cry wolf for weeks
  //       and teach you to ignore the channel, which defeats the whole point.
  //   (b) the format was RENAMED, so our matcher is blind — actually urgent.
  //
  // A count alone can't tell these apart. But a rename leaves a fingerprint: a
  // format name we have never seen before appears in the same run that 70mm
  // vanishes. So we keep a running vocabulary of every format name ever
  // observed, and only shout when 70mm is missing AND something unfamiliar
  // showed up to replace it.
  const anywhere70 = S.filter(is70mm);
  const known = new Set(state.knownFormats ?? []);
  const unfamiliar = formats.filter((f) => !known.has(f));

  if (anywhere70.length === 0) {
    if (unfamiliar.length) {
      problems.push(
        `no 70mm sessions anywhere, AND new unrecognised format(s) appeared: ${unfamiliar.join(', ')}. ` +
        `The format was probably renamed and 70mm detection is now blind — check is70mm().`
      );
    } else {
      notes.push(
        'no 70mm sessions in Belgium right now, but no new format names either — ' +
        'reads like a genuine programming gap, not a broken matcher. Staying quiet.'
      );
    }
  } else if (unfamiliar.length) {
    // 70mm still detected, so nothing is broken — just log the new vocabulary.
    notes.push(`new format name(s) seen: ${unfamiliar.join(', ')}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    notes,
    formats,
    stats: { sessions: S.length, films: feed.films?.length, brussels: bru.length, seventyMmBE: anywhere70.length, formats },
  };
}

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------
async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch { return { seenSessionIds: [], targetSeenInFilms: false, lastRunISO: null, lastCanaryOk: true }; }
}
const saveState = (s) => writeFile(STATE_FILE, JSON.stringify(s, null, 2));

// ---------------------------------------------------------------------------
// PUSH NOTIFICATION (ntfy.sh)
// ---------------------------------------------------------------------------
// ntfy needs no account and no API key. You subscribe the phone app to a topic
// name; anyone who knows that name can publish to it. So the topic name IS the
// password — keep it long and random, and set it as a repo SECRET, not inline
// in the YAML (a public repo would leak it and you'd get spammed).
//
// Retries three times: a single 5xx from a free public service should not be
// the reason you miss an onsale.
const asciiHeader = (s) =>
  String(s).replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim() || 'Kinepolis watcher';

async function sendNtfy(alert) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return { ok: false, error: 'NTFY_TOPIC not set — no push was sent' };
  // NTFY_BASE lets you point at a self-hosted ntfy instance (or a stub, in tests).
  const url = `${process.env.NTFY_BASE || 'https://ntfy.sh'}/${topic}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          // HTTP headers are latin-1 only. An emoji here throws
          // "Cannot convert argument to a ByteString" and the push never sends —
          // so the title is stripped to ASCII. The emoji survive in the body and
          // in the email subject, which have no such limit.
          'Title': asciiHeader(alert.subject),
          'Priority': alert.priority || 'default',
          // ntfy renders these tag names as emoji in the notification itself,
          // which is how we get 🎬 in the title without putting a non-latin-1
          // byte in a header.
          'Tags': alert.tags || 'clapper',
          'Click': `https://kinepolis.be/nl/movies/detail/${TARGET.corporateId}/${TARGET.filmId}/0/dune-part-three`,
        },
        body: alert.body,
      });
      if (res.ok) return { ok: true, tier: alert.tier, attempt };
      if (attempt === 3) return { ok: false, tier: alert.tier, status: res.status };
    } catch (e) {
      if (attempt === 3) return { ok: false, tier: alert.tier, error: String(e?.message ?? e) };
    }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  return { ok: false, tier: alert.tier, error: 'unreachable' };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
// showtime looks like "2026-12-18T20:00:00+00:00". That +00:00 is REAL UTC, not
// a local time with a bogus offset — verified because businessDay is 04:00Z in
// August (CEST) and 05:00Z in late October (CET), i.e. 06:00 Brussels in both.
// The offset tracks DST, so plain Date parsing + a Europe/Brussels format is
// correct. Do not "fix" this by stripping the offset.
const fmtSession = (s, filmsById) => {
  const t = new Date(s.showtime);
  const when = t.toLocaleString('nl-BE', { timeZone: 'Europe/Brussels', dateStyle: 'full', timeStyle: 'short' });
  const title = filmsById[s.film?.id]?.title ?? s.film?.id ?? '?';
  return `${title} — ${when} — ${s.film?.format?.name} — zaal ${s.hall} — ${s.cinemaLabel}${s.isSoldOut ? ' — SOLD OUT' : ''} (vistaSessionId ${s.vistaSessionId})`;
};

async function main() {
  const mode = process.argv[2];

  // Prove the phone actually buzzes — TODAY, not in December. Run this once
  // after subscribing the ntfy app. If no notification arrives, the topic name
  // is wrong or the app isn't subscribed, and you want to know that now.
  if (mode === '--testpush') {
    const r = await sendNtfy({
      tier: 'test',
      subject: '🎬 TEST — Dune 3 IMAX 70mm watcher',
      body: 'If you can read this on your phone, the alert path works.\nThis is a test; no sessions have been found.',
    });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  // State is loaded before the canary runs, because the canary needs the
  // history of format names it has seen before to tell a rename from a gap.
  const state = await loadState();
  const feed = await fetchFeed();
  const filmsById = Object.fromEntries((feed.films ?? []).map((f) => [f.id, f]));
  const health = canary(feed, state);

  // Grow the known-format vocabulary. Union, never replace — a format that
  // disappears for a season must stay "known" so its return isn't misread as new.
  state.knownFormats = [...new Set([...(state.knownFormats ?? []), ...health.formats])].sort();

  if (mode === '--dump' || mode === '--selftest') {
    const all70 = feed.sessions.filter(is70mm);
    console.log('--- CANARY ---');
    console.log(JSON.stringify(health.stats, null, 2));
    health.problems.forEach((p) => console.log('  ⚠ ' + p));
    health.notes.forEach((n) => console.log('  · ' + n));
    console.log(`\n--- ALL ${all70.length} IMAX 70mm SESSIONS IN BELGIUM ---`);
    const byFilm = {};
    for (const s of all70) (byFilm[filmsById[s.film.id]?.title ?? s.film.id] ??= []).push(s);
    for (const [title, list] of Object.entries(byFilm)) {
      console.log(`\n  ${title} @ ${list[0].cinemaLabel} — ${list.length} sessions`);
      list.slice(0, 5).forEach((s) => console.log('    ' + fmtSession(s, filmsById)));
      if (list.length > 5) console.log(`    … +${list.length - 5} more`);
    }
    const dune = feed.sessions.filter((s) => isTarget(s, filmsById));
    console.log(`\n--- TARGET (Dune 3) ---`);
    console.log(`  sessions anywhere in BE : ${dune.length}`);
    console.log(`  present in films array  : ${!!filmsById[TARGET.filmId]}`);
    if (mode === '--selftest') {
      // Pass/fail is driven by the canary, NOT by "did we find 70mm sessions".
      // A legitimate gap in 70mm programming (very likely between The Odyssey
      // ending on 22 Sep and Dune 3 in December) must not turn this red — a
      // selftest that cries wolf for two months is worse than no selftest.
      const pass = health.ok;
      console.log(`\nSELFTEST: ${pass ? 'PASS' : 'FAIL'}`);
      if (all70.length) {
        console.log(`  Strong pass: ${all70.length} live 70mm sessions matched, so the matcher demonstrably works.`);
      } else {
        console.log('  Weak pass: no 70mm sessions currently programmed in Belgium, so the');
        console.log('  matcher could not be exercised end to end. Format vocabulary is unchanged,');
        console.log('  which is the evidence that nothing was renamed.');
      }
      health.problems.forEach((p) => console.log('  FAIL: ' + p));
      await saveState(state);   // persist the format vocabulary even in selftest
      process.exit(pass ? 0 : 1);
    }
    await saveState(state);
    return;
  }

  const seen = new Set(state.seenSessionIds);
  const alerts = [];

  // Push-only setup: every alert goes to the phone, but PRIORITY does the
  // triage so the channel stays meaningful.
  //
  //   urgent  → bypasses Do Not Disturb, full buzz.
  //   high    → normal notification, buzzes.
  //   default → normal notification.
  //   low     → appears silently in the app.
  //
  // Net effect: your phone only truly *wakes* you for 70mm at Brussels, but no
  // Dune 3 screening anywhere in Belgium goes unreported.

  // Tier 0 — the watcher itself is unwell.
  if (!health.ok && state.lastCanaryOk !== false) {
    alerts.push({ tier: 'canary', push: true, priority: 'default', tags: 'warning', subject: 'Kinepolis watcher may be broken', body: health.problems.join('\n') + '\n\n' + JSON.stringify(health.stats, null, 2) });
  }

  // Tier 1 — early warning: film enters the catalogue before any session exists.
  const inFilms = !!filmsById[TARGET.filmId] || Object.values(filmsById).some((f) => TARGET.titleRe.test(f.title ?? '') && TARGET.titlePartRe.test(f.title ?? ''));
  if (inFilms && !state.targetSeenInFilms) {
    alerts.push({ tier: 'catalogue', push: true, priority: 'low', tags: 'eyes', subject: 'Dune 3 just entered the Kinepolis feed', body: 'No sessions yet, but the film is now in the catalogue — showtimes usually follow within days. Watch for presales.' });
    state.targetSeenInFilms = true;
  }

  // Tier 2 — ANY Dune 3 screening, bucketed by how much you care.
  //
  // Buckets are ordered and EXCLUSIVE: each new session is assigned to the first
  // one it matches, so a 70mm screening at Brussels produces exactly one urgent
  // push rather than three notifications about the same show. Nothing is
  // dropped — the last bucket matches everything left over.
  const BUCKETS = [
    { key: '70mm-kbru', priority: 'urgent', tags: 'clapper,fire',
      match: (s) => atBrussels(s) && is70mm(s),
      title: (n) => `${n} new IMAX 70mm session${n > 1 ? 's' : ''} for Dune 3 at Kinepolis Brussel` },

    { key: '70mm-elsewhere', priority: 'high', tags: 'clapper',
      match: (s) => is70mm(s),
      title: (n) => `Dune 3 in IMAX 70mm outside Brussels (${n} session${n > 1 ? 's' : ''})` },

    { key: 'any-kbru', priority: 'high', tags: 'ticket',
      match: (s) => atBrussels(s),
      title: (n) => `${n} new Dune 3 session${n > 1 ? 's' : ''} at Kinepolis Brussel` },

    { key: 'any-be', priority: 'default', tags: 'ticket',
      match: () => true,
      title: (n) => `Dune 3 tickets live in Belgium (${n} session${n > 1 ? 's' : ''})` },
  ];

  const targetSessions = feed.sessions.filter((s) => isTarget(s, filmsById));
  const freshAll = targetSessions.filter((s) => !seen.has(String(s.vistaSessionId)));

  const buckets = new Map(BUCKETS.map((b) => [b.key, []]));
  for (const s of freshAll) {
    const b = BUCKETS.find((b) => b.match(s));
    buckets.get(b.key).push(s);
  }

  for (const b of BUCKETS) {
    const list = buckets.get(b.key);
    if (!list.length) continue;
    alerts.push({
      tier: b.key,
      push: true,
      gatesSeen: true,          // a failed push here must be retried, not lost
      priority: b.priority,
      tags: b.tags,
      subject: b.title(list.length),
      body: list.slice(0, 12).map((s) => fmtSession(s, filmsById)).join('\n')
            + (list.length > 12 ? `\n… +${list.length - 12} more` : '')
            + `\n\nBook: https://kinepolis.be/nl/movies/detail/${TARGET.corporateId}/${TARGET.filmId}/0/dune-part-three`,
    });
  }

  // --- phone push, BEFORE we record anything as seen -------------------------
  // Order matters. If we marked these sessions seen and the push then failed,
  // the next run would consider them old and never alert again — a dropped
  // notification would become a permanently missed one. So: push first, and
  // only commit to the seen list once the alert actually got out.
  const pushes = alerts.filter((a) => a.push);
  const pushResults = [];
  for (const a of pushes) pushResults.push(await sendNtfy(a));

  // Mark sessions seen PER BUCKET, and only for buckets whose push actually
  // landed. If the 70mm push fails but the any-BE push succeeds, we retry only
  // the 70mm sessions next poll instead of losing them or spamming everything.
  const failedTiers = new Set(pushResults.filter((r) => !r.ok).map((r) => r.tier));
  let retried = 0;
  for (const b of BUCKETS) {
    const list = buckets.get(b.key);
    if (!list.length) continue;
    if (failedTiers.has(b.key)) { retried += list.length; continue; }
    for (const s of list) seen.add(String(s.vistaSessionId));
  }
  state.seenSessionIds = [...seen];
  if (retried) console.error(`push failed for ${retried} session(s) — not marked seen, will retry next poll`);
  state.lastRunISO = new Date().toISOString();
  state.lastCanaryOk = health.ok;
  await saveState(state);

  const result = {
    alerts: alerts.map(({ tier, priority, subject }) => ({ tier, priority, subject })),
    pushResults,
    health: health.stats,
    canaryProblems: health.problems,
    canaryNotes: health.notes,
    targetSessionCount: targetSessions.length,
    newCount: freshAll.length,
    newByBucket: Object.fromEntries([...buckets].map(([k, v]) => [k, v.length])),
  };
  console.log(JSON.stringify(result, null, 2));

  // A push that failed to send is as bad as no alert at all. Fail the job so the
  // workflow's dead-man's switch fires and you find out the same day.
  if (pushResults.some((r) => !r.ok)) {
    console.error('PUSH FAILED — ' + JSON.stringify(pushResults.filter((r) => !r.ok)));
    process.exitCode = 1;
  }

  // Simple flags for the workflow. No multi-line body needed any more — the push
  // itself carries the detail, so there's nothing to hand to a mail step.
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT,
      `has_alerts=${alerts.length > 0}\n` +
      `new_sessions=${freshAll.length}\n`, { flag: 'a' });
  }
}

main().catch((e) => {
  // A thrown error must be loud. Silent failure for four months is the enemy.
  console.error(JSON.stringify({ fatal: String(e?.message ?? e) }));
  process.exit(1);
});
