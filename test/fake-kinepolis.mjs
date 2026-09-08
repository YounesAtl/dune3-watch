#!/usr/bin/env node
/**
 * fake-kinepolis.mjs — a stand-in for the Kinepolis programmation API.
 *
 * Serves a feed built from the REAL field shapes captured off
 * kinepolisweb-programmation.kinepolis.com, but with Dune 3 sessions invented.
 * Point the watcher at this instead of the live API and you get a genuine push
 * to your phone, so you can confirm the whole chain works months before the
 * real onsale.
 *
 * Scenarios (env SCENARIO, default "70mm"):
 *   70mm    Dune 3 in IMAX 70mm at Brussels, plus 2D at Brussels, 70mm in
 *           Antwerp and 2D in Gent — exercises all four alert buckets at once.
 *   any     Dune 3 on sale but NOT in 70mm anywhere. This is the case you asked
 *           about: proves you still get pushed for ordinary formats.
 *   none    No Dune 3 at all. Should produce total silence.
 *
 *   node fake-kinepolis.mjs
 */
import http from 'node:http';

const SCENARIO = process.env.SCENARIO || '70mm';
const PORT = Number(process.env.PORT || 8732);

// Exact format objects as they appear in the live feed.
const F = {
  d70:   { name: 'IMAX 2D 70MM',   id: '20179', attributes: [{ shortName: 'IMAX W' }, { shortName: '70mm' }] },
  imax:  { name: 'IMAX 2D',        id: '16',    attributes: [{ shortName: 'IMAX W' }] },
  d2:    { name: '2D',             id: '24',    attributes: [] },
  laser: { name: 'Laser Ultra 2D', id: '5',     attributes: [] },
  scrx:  { name: 'ScreenX 2D',     id: '21',    attributes: [] },
  fdx:   { name: '4DX 2D',         id: '18',    attributes: [] },
};
const LABEL = { KBRU: 'Kinepolis Brussel', KANT: 'Kinepolis Antwerpen', GNTSNG: 'Kinepolis Gent' };

const mk = (o) => ({
  complexOperator: o.cx, mainComplex: o.cx, cinemaLabel: LABEL[o.cx] ?? o.cx,
  documentType: 'session', country: 'BE', language: 'NL',
  showtime: o.at, businessDay: o.at.slice(0, 10) + 'T05:00:00+00:00',
  hall: o.hall ?? 28, vistaSessionId: o.vid,
  rawSessionAttributes: o.f === F.d70
    ? '2D,70mm,CineK,Cl CineK,English,fr,IMAX,IMAX W,Lange film,nl'
    : '2D,English,fr,nl',
  hasSeatingPlan: true, hasSpecialSeating: false, hasCosySeating: false,
  isSoldOut: !!o.sold, isSneakPreview: false, isPublicScreening: true,
  circuit: 'KinepolisBelgium', hasConcessions: false,
  event: { isActive: false },
  film: { format: o.f, corporateId: o.cid, id: o.fid },
});

const DUNE = { cid: 36318, fid: 'HO00013472' };
const ODY  = { cid: 35300, fid: 'HO00012154' };

// Background traffic so the canary's volume checks are satisfied the way the
// real feed satisfies them (~8-10k sessions, 9 formats, KBRU well over 100).
const SPREAD = [F.d2, F.d2, F.d2, F.d2, F.imax, F.laser, F.scrx, F.fdx];
const filler = Array.from({ length: 3000 }, (_, i) =>
  mk({ cx: i % 3 === 0 ? 'KBRU' : (i % 3 === 1 ? 'KANT' : 'GNTSNG'),
       at: '2026-09-05T18:00:00+00:00', vid: 500000 + i,
       f: SPREAD[i % SPREAD.length], cid: 37992, fid: 'HO00013123', hall: 5 }));

// The Odyssey still in 70mm, as today.
const odyssey = [
  mk({ cx: 'KBRU', at: '2026-09-10T19:00:00+00:00', vid: 389701, f: F.d70, ...ODY, sold: true }),
  mk({ cx: 'KBRU', at: '2026-09-11T19:00:00+00:00', vid: 389702, f: F.d70, ...ODY }),
];

// --- the invented Dune 3 sessions ------------------------------------------
const dune = [];
if (SCENARIO === '70mm') {
  dune.push(mk({ cx: 'KBRU',   at: '2026-12-18T20:00:00+00:00', vid: 900001, f: F.d70, ...DUNE }));
  dune.push(mk({ cx: 'KBRU',   at: '2026-12-19T20:00:00+00:00', vid: 900002, f: F.d70, ...DUNE }));
  dune.push(mk({ cx: 'KBRU',   at: '2026-12-20T15:30:00+00:00', vid: 900003, f: F.d70, ...DUNE, sold: true }));
  dune.push(mk({ cx: 'KBRU',   at: '2026-12-18T17:00:00+00:00', vid: 900004, f: F.d2,  ...DUNE, hall: 12 }));
  dune.push(mk({ cx: 'KBRU',   at: '2026-12-18T21:45:00+00:00', vid: 900005, f: F.imax, ...DUNE, hall: 28 }));
  dune.push(mk({ cx: 'KANT',   at: '2026-12-18T20:00:00+00:00', vid: 900006, f: F.d70, ...DUNE }));
  dune.push(mk({ cx: 'GNTSNG', at: '2026-12-18T20:30:00+00:00', vid: 900007, f: F.d2,  ...DUNE, hall: 3 }));
}
if (SCENARIO === 'any') {
  // On sale, but nothing in 70mm anywhere in the country.
  dune.push(mk({ cx: 'KBRU',   at: '2026-12-17T20:00:00+00:00', vid: 910001, f: F.d2,    ...DUNE, hall: 12 }));
  dune.push(mk({ cx: 'KBRU',   at: '2026-12-17T21:00:00+00:00', vid: 910002, f: F.imax,  ...DUNE, hall: 28 }));
  dune.push(mk({ cx: 'GNTSNG', at: '2026-12-17T20:30:00+00:00', vid: 910003, f: F.laser, ...DUNE, hall: 3 }));
}

const films = [
  { id: 'HO00012154', title: 'The Odyssey', corporateId: 35300, releaseDate: '2026-07-17T00:00:00', showAsFutureRelease: false },
  { id: 'HO00013123', title: 'Ladies: Dirty Dancing', corporateId: 37992, releaseDate: '2017-06-06T00:00:00', showAsFutureRelease: false },
  ...Array.from({ length: 210 }, (_, i) => ({ id: `HO0009${9000 + i}`, title: `Filler ${i}`, corporateId: 1000 + i, releaseDate: '2026-01-01T00:00:00' })),
];
if (SCENARIO !== 'none') {
  films.push({ id: 'HO00013472', title: 'Dune Part Three', corporateId: 36318, releaseDate: '2026-12-16T00:00:00', showAsFutureRelease: true });
}

const sessions = [...odyssey, ...filler, ...dune];
const payload = JSON.stringify({ sessions, films, firstDateWithSessions: '2026-08-21T05:00:00+00:00' });

http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(payload);
}).listen(PORT, () => {
  console.log(`fake Kinepolis API on http://127.0.0.1:${PORT}`);
  console.log(`  scenario   : ${SCENARIO}`);
  console.log(`  sessions   : ${sessions.length}  (${dune.length} of them Dune 3)`);
  console.log(`  press Ctrl+C to stop`);
});
