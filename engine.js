/* Exit Timing Calendar — simulation engine.
 *
 * Ported from the APEX Retirement Simulator's Private Book tab. Deliberately plain
 * JavaScript with no dependencies, so the whole app can be a static page that runs
 * entirely in the browser and never sends anybody's book anywhere.
 *
 * Every rule in here was learned by getting it wrong first. They are commented where
 * they sit, because each one is an error this model used to make.
 */

/* Seeded RNG (mulberry32). Seeded on purpose: the same book must never produce two
   different answers on two reads. An unstable number is worse than no number. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CFG = {
  /* Venture: the ten-deal power law. The last branch, 10%, is the sponsor's own
     projected multiple. That number is what the deal returns IF IT WORKS; using it as
     the expected value is the single commonest way these models become fiction. */
  venture: [[0.30, 0.00], [0.30, 1.00], [0.30, 1.65]],

  /* Income sleeves: stabilized RE / PE / credit. A far tighter spread, and the branches
     SCALE the exit multiple rather than replacing it. Last branch, 15%, is the full
     exit. */
  income: [[0.05, 0.00], [0.25, 0.60], [0.55, 0.75]],

  /* Exits slip and nothing makes them early, so the window is skewed late. The final
     5% rung is not padding: funds extend, and leaving it out is how a calendar quietly
     turns optimistic. */
  timing: [[0.20, -3], [0.50, 0], [0.25, 2], [0.05, 4]],

  callYears: 3,        // an uncalled commitment is drawn down over roughly this long
  paths: 6000,
  histBins: 30,
  histMax: 3.0,        // multiple on committed; anything above gathers into the last bin
  yearFrom: 2026,
  yearTo: 2042,
};

/* ── Building the book ──────────────────────────────────────────────────────
   One row in, one position out. Two rules do most of the work here.

   COMMITMENT IS THE BASIS. Exit proceeds are commitment x multiple, never
   funded-to-date x multiple, because the whole commitment is called long before any
   exit lands. On one real book, using funded understated the position by 48%.

   A COUPON IS ALREADY INSIDE THE MULTIPLE. A sponsor MOIC is total distributions over
   invested capital, so any preferred return paid along the way is part of it. Showing
   the coupon as its own row AND exiting at the full multiple counts that cash twice.
   Coupon-payers therefore exit on the RESIDUAL. */
function buildBook(rows) {
  const out = [];
  for (const r of rows) {
    const commitment = num(r.commitment);
    if (!(commitment > 0)) continue;
    const funded = Math.min(num(r.funded), commitment);
    const uncalled = r.uncalled != null && r.uncalled !== ''
      ? Math.max(0, num(r.uncalled))
      : Math.max(0, commitment - funded);
    const hold = num(r.hold) || 10;
    const fy = parseInt(r.yearFunded, 10) || CFG.yearFrom;
    const coupon = num(r.coupon);
    const moic = num(r.moic) || (coupon ? 1 + coupon * hold : 5);

    // residual exit multiple, so the coupon is never double counted
    let exitMult = moic;
    if (coupon > 0) exitMult = Math.max(0.2, moic - coupon * hold);

    const likely = parseInt(r.exitLikely, 10) || (fy + hold);
    out.push({
      name: String(r.name || 'Unnamed'),
      kind: coupon > 0 ? 'income' : 'venture',
      cls: String(r.assetClass || (coupon > 0 ? 'Income' : 'VC')),
      commitment, funded, uncalled, coupon, hold, fy, moic,
      exitMult,
      earliest: parseInt(r.exitEarliest, 10) || (likely - Math.min(3, Math.max(1, Math.round(hold * 0.3)))),
      likely,
      latest: parseInt(r.exitLatest, 10) || (likely + 2),
      conviction: String(r.conviction || 'Medium'),
    });
  }
  return out;
}

function num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[$,%\s]/g, ''));
  return isFinite(n) ? n : 0;
}

/* Capital calls are contractual, so they are deterministic and never simulated.
   They are also the only movement on this whole calendar you actually KNOW about. */
function callSchedule(book, years) {
  const out = {};
  for (const y of years) out[y] = 0;
  for (const b of book) {
    if (b.uncalled <= 0) continue;
    for (let k = 0; k < CFG.callYears; k++) {
      const y = b.fy + 1 + k;
      if (out[y] != null) out[y] += b.uncalled / CFG.callYears;
    }
  }
  return out;
}

/* Preferred returns, also deterministic. This is the most optimistic assumption in the
   model and the app says so on screen: a sponsor CAN suspend a coupon, and if that is
   on the table the income sleeve's floor is softer than it looks here. */
function couponSchedule(book, years) {
  const out = {};
  for (const y of years) out[y] = 0;
  for (const b of book) {
    if (!(b.coupon > 0)) continue;
    for (let k = 1; k <= b.hold; k++) {
      const y = b.fy + k;
      if (out[y] != null) out[y] += b.commitment * b.coupon;
    }
  }
  return out;
}

function pick(rnd, branches, fallback) {
  const r = rnd();
  let acc = 0;
  for (const [p, v] of branches) {
    acc += p;
    if (r <= acc) return v;
  }
  return fallback;      // the top branch, which the table deliberately leaves implicit
}

/* ── The simulation ─────────────────────────────────────────────────────────
   Each trial plays one complete future: every position draws an exit YEAR and an
   OUTCOME, and the cash lands in that year. Then the whole future is summed.

   That ordering is the important part. Percentiles taken per YEAR rank each year
   separately, so the future sitting in the middle in one year is a different future
   from the middle one in another, and those columns CANNOT be added. Percentiles taken
   on the CUMULATIVE totals rank whole futures once, so those can. Same word, opposite
   behaviour. */
function simulate(book, opts) {
  opts = opts || {};
  const paths = opts.paths || CFG.paths;
  const years = [];
  for (let y = CFG.yearFrom; y <= CFG.yearTo; y++) years.push(y);
  if (!book.length) return null;

  const coupon = couponSchedule(book, years);
  const calls = callSchedule(book, years);
  const per = {}, cum = {};
  for (const y of years) { per[y] = []; cum[y] = []; }
  const totals = [];
  const rnd = makeRng(20260922);

  for (let p = 0; p < paths; p++) {
    const yr = {};
    for (const y of years) yr[y] = 0;
    for (const b of book) {
      const off = pick(rnd, CFG.timing, 4);
      const ey = b.likely + off;
      const branches = b.kind === 'income' ? CFG.income : CFG.venture;
      let m = pick(rnd, branches, null);
      if (m === null) m = b.exitMult;                 // top branch: the full exit
      else if (b.kind === 'income') m = m * b.exitMult; // tight branches scale it
      if (m > 0 && yr[ey] != null) yr[ey] += b.commitment * m;
    }
    let run = 0, tot = 0;
    for (const y of years) {
      const v = yr[y] + coupon[y];
      per[y].push(v);
      run += v; cum[y].push(run);
      tot += v;
    }
    totals.push(tot);
  }

  const q = (arr, p) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(p * (s.length - 1))];
  };
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);

  const committed = book.reduce((a, b) => a + b.commitment, 0);
  const funded = book.reduce((a, b) => a + b.funded, 0);
  const uncalled = book.reduce((a, b) => a + b.uncalled, 0);

  const byYear = years.map((y) => ({
    year: y,
    coupon: coupon[y],
    calls: calls[y],
    med: q(per[y], 0.50),
    odds: per[y].filter((v) => v > 0).length / per[y].length,
    p90: q(per[y], 0.90),
  }));
  const cumRows = years.map((y) => ({
    year: y, p10: q(cum[y], 0.10), p50: q(cum[y], 0.50), p90: q(cum[y], 0.90),
  }));

  // distribution SHAPE. Three percentiles cannot show it, and shape is the argument.
  const hist = new Array(CFG.histBins).fill(0);
  for (const t of totals) {
    let bin = Math.floor((t / committed) / CFG.histMax * CFG.histBins);
    if (bin < 0) bin = 0;
    if (bin >= CFG.histBins) bin = CFG.histBins - 1;
    hist[bin]++;
  }
  for (let i = 0; i < hist.length; i++) hist[i] /= totals.length;

  const out = {
    years, byYear, cum: cumRows, hist,
    histBins: CFG.histBins, histMax: CFG.histMax,
    totals: {
      committed, funded, uncalled,
      coupon: years.reduce((a, y) => a + coupon[y], 0),
      calls: years.reduce((a, y) => a + calls[y], 0),
      p10: q(totals, 0.10), p50: q(totals, 0.50),
      mean: mean(totals), p90: q(totals, 0.90),
      stackedP90: byYear.reduce((a, r) => a + r.p90, 0),
      shareAbove3x: hist[CFG.histBins - 1],
    },
  };
  // the tie-out that proves the cumulative panel and the totals are one model
  out.ties = Math.abs(cumRows[cumRows.length - 1].p50 - out.totals.p50) < 0.01;
  return out;
}

const Engine = { CFG, buildBook, simulate, makeRng, num };
if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
