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
function canary(feed) {
  const problems = [];
  const S = feed.sessions;

  if (S.length < 2000) problems.push(`only ${S.length} sessions in feed (expected ~10k) — feed may be truncated`);
  if (!Array.isArray(feed.films) || feed.films.length < 50) problems.push(`films array is ${feed.films?.length} entries — expected 200+`);

  const bru = S.filter(atBrussels);
  if (bru.length < 100) problems.push(`only ${bru.length} sessions at ${COMPLEX} — complex code may have changed`);

  // As of Aug 2026 there are ~104 IMAX 70mm sessions at KBRU (The Odyssey).
  // If this ever hits zero across all of Belgium, either 70mm genuinely stopped
  // being programmed, or — far more likely — the format field was renamed.
  const anywhere70 = S.filter(is70mm);
  if (anywhere70.length === 0) {
    problems.push('ZERO 70mm sessions anywhere in Belgium — format field likely renamed. Detection is probably blind.');
  }

  const formats = new Set(S.map((s) => s.film?.format?.name).filter(Boolean));
  if (formats.size < 3) problems.push(`only ${formats.size} distinct formats — format field may have collapsed`);

  return { ok: problems.length === 0, problems, stats: { sessions: S.length, films: feed.films?.length, brussels: bru.length, seventyMmBE: anywhere70.length, formats: [...formats].sort() } };
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

  const feed = await fetchFeed();
  const filmsById = Object.fromEntries((feed.films ?? []).map((f) => [f.id, f]));
  const health = canary(feed);

  if (mode === '--dump' || mode === '--selftest') {
    const all70 = feed.sessions.filter(is70mm);
    console.log('--- CANARY ---');
    console.log(JSON.stringify(health.stats, null, 2));
    health.problems.forEach((p) => console.log('  ⚠ ' + p));
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
      const pass = health.ok && all70.length > 0;
      console.log(`\nSELFTEST: ${pass ? 'PASS — the pipeline finds 70mm sessions today, so it will find Dune 3 when they appear.' : 'FAIL — see canary warnings above.'}`);
      process.exit(pass ? 0 : 1);
    }
    return;
  }

  const state = await loadState();
  const seen = new Set(state.seenSessionIds);
  const alerts = [];

  // Push-only setup: every alert goes to the phone, but PRIORITY does the
  // triage so the channel stays meaningful.
  //
  //   urgent  → bypasses Do Not Disturb, full buzz.   Only the real thing.
  //   default → normal notification with sound.       Watcher looks broken.
  //   low     → appears silently in the app.          Informational.
  //
  // Net effect: your phone genuinely wakes you exactly once, and that once means
  // tickets. Everything else is there when you look.

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

  // Tier 2 — the thing you actually want.
  const targetSessions = feed.sessions.filter((s) => isTarget(s, filmsById));
  const wanted = targetSessions.filter((s) => atBrussels(s) && is70mm(s));
  const fresh = wanted.filter((s) => !seen.has(String(s.vistaSessionId)));

  if (fresh.length) {
    alerts.push({
      tier: 'sessions',
      push: true,
      priority: 'urgent',   // ← the only thing that overrides Do Not Disturb
      tags: 'clapper,fire',
      subject: `${fresh.length} new IMAX 70mm session${fresh.length > 1 ? 's' : ''} for Dune 3 at Kinepolis Brussel`,
      body: fresh.map((s) => fmtSession(s, filmsById)).join('\n')
            + `\n\nBook: https://kinepolis.be/nl/movies/detail/${TARGET.corporateId}/${TARGET.filmId}/0/dune-part-three`,
    });
  }

  // Tier 3 — Dune 3 is on sale in Brussels but NOT in 70mm. Worth knowing:
  // sometimes the 2D listings go up first and 70mm follows a day later.
  const bruAny = targetSessions.filter(atBrussels);
  if (bruAny.length && !wanted.length && !state.notified2DOnly) {
    alerts.push({ tier: '2d-only', push: true, priority: 'low', tags: 'information_source', subject: 'Dune 3 on sale at Brussels - no 70mm yet', body: `${bruAny.length} session(s) in: ${[...new Set(bruAny.map((s) => s.film?.format?.name))].join(', ')}\n70mm listings often appear a day or two later. Still watching.` });
    state.notified2DOnly = true;
  }

  // --- phone push, BEFORE we record anything as seen -------------------------
  // Order matters. If we marked these sessions seen and the push then failed,
  // the next run would consider them old and never alert again — a dropped
  // notification would become a permanently missed one. So: push first, and
  // only commit to the seen list once the alert actually got out.
  const pushes = alerts.filter((a) => a.push);
  const pushResults = [];
  for (const a of pushes) pushResults.push(await sendNtfy(a));

  // Only the 'sessions' push gates the seen list. If a low-priority
  // informational push fails we don't want to replay the 70mm alert forever.
  const pushOk = pushResults.filter((r) => r.tier === 'sessions').every((r) => r.ok);

  if (pushOk) {
    for (const s of wanted) seen.add(String(s.vistaSessionId));
    state.seenSessionIds = [...seen];
  } else {
    console.error('push failed — NOT marking sessions as seen, will retry next poll');
  }
  state.lastRunISO = new Date().toISOString();
  state.lastCanaryOk = health.ok;
  await saveState(state);

  // Emit for the email step in the workflow (email gets EVERY alert, not just pushes).
  const result = { alerts: alerts.map(({ tier, push, subject }) => ({ tier, push, subject })), pushResults, health: health.stats, canaryProblems: health.problems, targetSessionCount: targetSessions.length, newCount: fresh.length };
  console.log(JSON.stringify(result, null, 2));

  // A push that failed to send is as bad as no alert at all. Fail the job so the
  // workflow's dead-man's-switch email fires and you find out the same day.
  if (pushResults.some((r) => !r.ok)) {
    console.error('PUSH FAILED — ' + JSON.stringify(pushResults.filter((r) => !r.ok)));
    process.exitCode = 1;
  }

  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT,
      `has_alerts=${alerts.length > 0}\n` +
      `subject=${alerts[0]?.subject ?? ''}\n` +
      `body<<EOF\n${alerts.map((a) => a.subject + '\n' + a.body).join('\n\n')}\nEOF\n`, { flag: 'a' });
  }
}

main().catch((e) => {
  // A thrown error must be loud. Silent failure for four months is the enemy.
  console.error(JSON.stringify({ fatal: String(e?.message ?? e) }));
  process.exit(1);
});
