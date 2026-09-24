/* Exit Timing Calendar — UI.
 *
 * Reads a tracker (xlsx or csv), runs the engine, renders four panels plus a glossary.
 * Nothing leaves the browser: the file is read with FileReader and parsed in-page.
 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const money = (v) => (v < 0 ? '-$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US');
  const mult = (v) => v.toFixed(2) + 'x';
  const pct = (v) => (v * 100).toFixed(0) + '%';
  /* Quotes are escaped too, not just angle brackets. A deal card writes the name into a
     data- attribute AND reads it back to decide which card is open, so a name like
     O'Brien's "Fund" used to truncate the attribute at its first inner quote: the card
     would not open, any markup in the name rendered as real HTML, and the whole row
     broke. Somebody will name a position with an apostrophe. */
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const DASH = '—';

  let BOOK = null;          // every position
  let MODE = 'all';         // which book the panels describe
  let DIST = 'all';         // which curve is in front on the chart
  let TAB = 'dash';         // 'dash' | 'outlook' | 'about'
  let DEALIDX = null;       // the shared deal index, loaded once
  let OPEN = {};            // which deal cards are expanded

  /* The shared deal files are fetched once and cached. A failure here is not fatal:
     the tool still runs on whatever the tracker holds, which is the whole point of the
     tracker winning. */
  async function loadDealIndex() {
    if (DEALIDX !== null) return DEALIDX;
    try {
      DEALIDX = await fetch('deals/index.json').then((r) => r.json());
    } catch (e) { DEALIDX = { deals: [] }; }
    return DEALIDX;
  }
  async function enrich(rows) {
    const idx = await loadDealIndex();
    const cache = {};
    for (const r of rows) {
      const hit = Engine.matchDeal(r.name, idx);
      if (!hit) continue;
      if (!cache[hit.slug]) {
        try { cache[hit.slug] = await fetch('deals/' + hit.slug + '.json').then((x) => x.json()); }
        catch (e) { cache[hit.slug] = null; }
      }
      if (cache[hit.slug]) Object.assign(r, Engine.applyDealFile(r, cache[hit.slug]));
    }
    return rows;
  }

  /* ── reading the tracker ─────────────────────────────────────────────────
     Headers are matched loosely, because nobody keeps a spreadsheet to someone
     else's column names. Anything genuinely missing is REPORTED rather than
     guessed at: an invented input is how these models quietly become fiction. */
  const FIELDS = [
    // deliberately FIRST, and deliberately multi-word. A bare 'deals' would be matched
    // by the 'deal' prefix under 'name' and swallow the deal-name column.
    ['deals',       ['deals in fund', 'underlying deals', 'number of deals',
                     'portfolio companies', 'positions in fund', 'deal count']],
    // optional liquidity window, in FUND-YEARS from funding. A GP who says "years five
    // through eight" can say exactly that; leaving them blank uses the default rule.
    ['liqFrom',     ['liquidity from', 'payout from', 'sell-down from', 'distributions from']],
    ['liqTo',       ['liquidity to', 'payout to', 'sell-down to', 'distributions to']],
    ['name',        ['deal name', 'deal', 'name', 'investment', 'position']],
    ['assetClass',  ['asset class', 'class', 'type', 'sleeve type']],
    ['commitment',  ['commitment', 'committed', 'total commitment']],
    ['funded',      ['funded to date', 'funded', 'paid in', 'contributed']],
    ['uncalled',    ['uncalled', 'unfunded', 'remaining', 'callable']],
    ['yearFunded',  ['year funded', 'funded year', 'vintage', 'year']],
    ['hold',        ['hold', 'hold (yrs)', 'hold years', 'term', 'fund life', 'horizon']],
    ['coupon',      ['coupon', 'coupon %', 'preferred', 'pref', 'preferred return']],
    ['moic',        ['sponsor moic', 'moic', 'multiple', 'expected moic', 'target multiple']],
    ['conviction',  ['conviction', 'confidence']],
    // the holder's own words. Personal, so it lives in THEIR tracker, never in a
    // shared deal file.
    ['thesis',      ['thesis', 'why i did it', 'rationale', 'notes', 'my notes']],
    ['exitEarliest',['exit: earliest', 'earliest', 'exit earliest']],
    ['exitLikely',  ['exit: likely', 'likely', 'exit likely', 'override likely']],
    ['exitLatest',  ['exit: latest', 'latest', 'exit latest']],
  ];

  function mapHeaders(hdr) {
    const map = {};
    hdr.forEach((h, i) => {
      const k = String(h || '').trim().toLowerCase();
      if (!k) return;
      for (const [field, names] of FIELDS) {
        if (map[field] != null) continue;
        if (names.some((n) => k === n || k.startsWith(n))) { map[field] = i; return; }
      }
    });
    return map;
  }

  function rowsFromSheet(aoa) {
    // find the header row: the first row that yields a commitment column
    let hi = -1, map = null;
    for (let i = 0; i < Math.min(aoa.length, 12); i++) {
      const m = mapHeaders(aoa[i] || []);
      if (m.commitment != null && m.name != null) { hi = i; map = m; break; }
    }
    if (hi < 0) return { error: 'Could not find a header row with a deal name and a commitment column.' };
    const out = [], skipped = [];
    for (let i = hi + 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      const get = (f) => (map[f] != null ? r[map[f]] : '');
      const name = String(get('name') || '').trim();
      if (!name || /^total/i.test(name)) continue;
      const rec = {};
      FIELDS.forEach(([f]) => { rec[f] = get(f); });
      rec.name = name;
      // A real tracker has prose under the table: legends, notes, a worked-example
      // caption. Those rows have a long first cell and no commitment, and reading them
      // as positions produced six phantom "problems" on the template's own file.
      // A row with no commitment is only worth flagging if it looks like a deal.
      if (!(Engine.num(rec.commitment) > 0)) {
        if (name.length <= 40 && !/\s\w+\s\w+\s\w+\s/.test(name)) skipped.push(name);
        continue;
      }
      out.push(rec);
    }
    return { rows: out, map, skipped };
  }

  function validate(rows, skipped) {
    const problems = [];
    rows.forEach((r) => {
      const where = r.name;
      if (!Engine.num(r.moic) && !Engine.num(r.coupon))
        problems.push(where + ': no sponsor multiple and no coupon, so there is nothing to exit on');
      if (!parseInt(r.yearFunded, 10)) problems.push(where + ': no year funded');
    });
    (skipped || []).forEach((n) => problems.push(n + ': looks like a deal but has no commitment, so it was left out'));
    return problems;
  }

  /* ── panels ──────────────────────────────────────────────────────────────── */

  function subset(mode) {
    if (mode === 'venture') return BOOK.filter((b) => b.kind === 'venture');
    if (mode === 'income') return BOOK.filter((b) => b.kind === 'income');
    return BOOK;
  }

  /* ── the three tabs ───────────────────────────────────────────────────────
     Dashboard is what you hold now. Liquidity Outlook is when it comes back and how
     much. Background is the assumptions, so the other two can be argued with. */
  const TABS = [['dash', 'Private Deal Dashboard'], ['outlook', 'Liquidity Outlook'],
                ['about', 'Background']];

  function render() {
    if (!BOOK || !BOOK.length) return;
    $('#out').classList.remove('hidden');
    $('#out').innerHTML = '<div class="row tabs">'
      + TABS.map(([k, l]) => '<button data-tab="' + k + '"' + (TAB === k ? ' class="on"' : '')
          + '>' + l + '</button>').join('')
      + '</div><div id="tabbody"></div>';
    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => { TAB = b.getAttribute('data-tab'); render(); };
    });
    if (TAB === 'dash') renderDashboard();
    else if (TAB === 'about') renderBackground();
    else renderOutlook();
  }

  /* Expected proceeds for one position, on the model's own outcome table. Kept here so
     the dashboard and the cards cannot compute it two different ways. */
  function expectedOf(x) {
    let acc = 0, e = 0;
    for (const [p, v] of x.branches) { acc += p; e += p * (x.scales ? v * x.exitMult : v); }
    e += (1 - acc) * x.exitMult;
    return { mult: e, exit: x.commitment * e, pref: x.commitment * x.coupon * x.hold };
  }

  function clsColour(c) {
    return ({ 'Venture': '#7B5EA7', 'VC': '#7B5EA7', 'Real Estate': '#2E6B52',
              'Private Equity': '#2563EB', 'Private Credit': '#B17930' })[c] || '#6B7A8C';
  }

  function payWindow(x) {
    return x.spread ? (x.fy + x.liq[0]) + '–' + (x.fy + x.liq[1]) : String(x.fy + x.hold);
  }

  /* ── DASHBOARD ────────────────────────────────────────────────────────────
     Reads the same book off the same engine as the Outlook tab, so the two cannot
     describe a deal differently. */
  function renderDashboard() {
    const b = BOOK;
    const sum = (f) => b.reduce((a, x) => a + f(x), 0);
    const committed = sum((x) => x.commitment);
    const funded = sum((x) => x.funded);
    const uncalled = sum((x) => x.uncalled);
    const expExit = sum((x) => expectedOf(x).exit);
    const expPref = sum((x) => expectedOf(x).pref);
    const expTotal = expExit + expPref;
    const sponsorWt = committed > 0 ? sum((x) => x.moic * x.commitment) / committed : 0;

    let h = '<div class="card"><h2>Where you stand</h2>'
      + '<div class="kpi">'
      + kpi('Positions', b.length) + kpi('Committed', money(committed))
      + kpi('Funded', money(funded))
      + kpi('Still callable', money(uncalled), uncalled > 0 ? 'neg' : '')
      + kpi('Sponsor MOIC', mult(sponsorWt))
      + kpi('Modelled', mult(committed > 0 ? expTotal / committed : 0), 'b')
      + '</div>'
      + '<p class="note" style="margin-top:12px"><b>Two multiples, on purpose.</b> The sponsor '
      + 'figure is what these deals return <b>if they work</b>, weighted by what you committed. '
      + 'The modelled one is what they are <b>expected</b> to return once every outcome is '
      + 'weighted by how likely it is, including the ones that go nowhere. It is always the '
      + 'lower number and it is the one to plan against. Of the modelled total, '
      + money(expPref) + ' is contractual preferred return and ' + money(expExit) + ' depends '
      + 'on a sale.</p></div>';

    const byCls = {};
    b.forEach((x) => {
      const c = x.kind === 'venture' ? 'Venture' : x.cls;
      byCls[c] = (byCls[c] || 0) + x.commitment;
    });
    const entries = Object.entries(byCls).sort((p, q) => q[1] - p[1]);
    h += '<div class="card"><h2>Allocation</h2>'
      + '<p class="note">On capital <b>committed</b>, not on current value. A private mark is '
      + 'whatever the last sponsor statement said, and stale marks make a flattering pie.</p>'
      + '<div style="display:flex;height:30px;border-radius:6px;overflow:hidden;margin:14px 0 10px">'
      + entries.map(([c, v]) => '<div style="width:' + (v / committed * 100) + '%;background:'
          + clsColour(c) + ';display:flex;align-items:center;justify-content:center;color:#fff;'
          + 'font-size:12px;font-weight:700">' + (v / committed > 0.07 ? pct(v / committed) : '')
          + '</div>').join('')
      + '</div><div class="row">'
      + entries.map(([c, v]) => '<span style="display:flex;align-items:center;gap:7px;font-size:13px;'
          + 'color:var(--muted)"><span style="width:11px;height:11px;border-radius:3px;background:'
          + clsColour(c) + '"></span>' + esc(c) + ' <b style="color:var(--ink)">' + money(v)
          + '</b></span>').join('')
      + '</div></div>';

    const yrs = [];
    for (let y = Engine.CFG.yearFrom; y <= Engine.CFG.yearFrom + 9; y++) yrs.push(y);
    const calls = {}, prefs = {};
    yrs.forEach((y) => { calls[y] = 0; prefs[y] = 0; });
    b.forEach((x) => {
      if (x.uncalled > 0) {
        for (let i = 0; i < Engine.CFG.callYears; i++) {
          const y = x.fy + 1 + i;
          if (calls[y] != null) calls[y] += x.uncalled / Engine.CFG.callYears;
        }
      }
      if (x.coupon > 0) {
        for (let i = 1; i <= x.hold; i++) {
          const y = x.fy + i;
          if (prefs[y] != null) prefs[y] += x.commitment * x.coupon;
        }
      }
    });
    const peak = Math.max(1, ...yrs.map((y) => Math.max(calls[y], prefs[y])));
    h += '<div class="card"><h2>Capital calls against preferred income</h2>'
      + '<p class="note"><b>Contractual items only.</b> Money you are obliged to send, against '
      + 'money the documents promise you. Exits are not here on purpose: an exit is a hope and a '
      + 'coupon is a promise, and adding them together is how these tools mislead. Exits live on '
      + 'the Liquidity Outlook tab.</p>'
      + '<table style="margin-top:12px"><tr><th class="l">Year</th><th>Capital calls out</th>'
      + '<th>Preferred in</th><th>Net</th><th class="l" style="width:40%">&nbsp;</th></tr>'
      + yrs.filter((y) => calls[y] > 0 || prefs[y] > 0).map((y) => {
          const net = prefs[y] - calls[y];
          return '<tr><td class="l b">' + y + '</td>'
            + '<td class="' + (calls[y] ? 'neg' : 'z') + '">' + (calls[y] ? '-' + money(calls[y]) : DASH) + '</td>'
            + '<td class="' + (prefs[y] ? 'pos' : 'z') + '">' + (prefs[y] ? money(prefs[y]) : DASH) + '</td>'
            + '<td class="' + (net < 0 ? 'neg' : 'pos') + '">' + money(net) + '</td>'
            + '<td class="l"><div style="display:flex;align-items:center;gap:3px">'
            + '<div style="flex:1;display:flex;justify-content:flex-end"><div style="height:11px;width:'
            + (calls[y] / peak * 100) + '%;background:var(--red);border-radius:2px 0 0 2px"></div></div>'
            + '<div style="flex:1"><div style="height:11px;width:' + (prefs[y] / peak * 100)
            + '%;background:var(--green);border-radius:0 2px 2px 0"></div></div>'
            + '</div></td></tr>';
        }).join('')
      + '</table></div>';

    h += '<div class="card"><h2>Your deals</h2>'
      + '<p class="note">Tap a deal for its terms. Anything marked <b>shared</b> comes from a '
      + 'deal file everyone can use, so nobody retypes the same preferred rate thirteen times. '
      + 'Your own numbers always win over it.</p>'
      + b.map(dealCard).join('') + '</div>';

    $('#tabbody').innerHTML = h;
    document.querySelectorAll('[data-deal]').forEach((el) => {
      el.onclick = () => {
        const k = el.getAttribute('data-deal');
        OPEN[k] = !OPEN[k];
        renderDashboard();
      };
    });
  }

  function dealCard(x) {
    const open = !!OPEN[x.name];
    const d = x.deal;
    const e = expectedOf(x);
    const row = (l, v, cls) => '<div style="display:flex;justify-content:space-between;gap:16px;'
      + 'padding:5px 0;font-size:13px"><span style="color:var(--muted)">' + l + '</span>'
      + '<span class="' + (cls || '') + '" style="font-family:var(--mono);text-align:right">'
      + v + '</span></div>';
    let h = '<div style="border:1px solid var(--rule);border-radius:9px;margin-bottom:9px;overflow:hidden">'
      + '<div data-deal="' + esc(x.name) + '" style="display:flex;align-items:center;gap:12px;'
      + 'padding:12px 14px;cursor:pointer;background:' + (open ? '#F4F7FB' : '#fff') + '">'
      + '<span style="width:9px;height:9px;border-radius:50%;background:'
      + clsColour(x.kind === 'venture' ? 'Venture' : x.cls) + '"></span>'
      + '<b style="flex:1">' + esc(x.name) + '</b>'
      + (d ? '<span style="font-size:10px;letter-spacing:.05em;color:var(--muted);border:1px solid '
             + 'var(--rule);border-radius:999px;padding:2px 8px">SHARED</span>' : '')
      + '<span style="font-family:var(--mono);font-size:13px">' + money(x.commitment) + '</span>'
      + '<span style="font-family:var(--mono);font-size:12px;color:var(--muted);width:92px;'
      + 'text-align:right">' + payWindow(x) + '</span>'
      + '<span style="color:var(--muted)">' + (open ? '−' : '+') + '</span></div>';
    if (open) {
      h += '<div style="padding:4px 16px 16px;border-top:1px solid var(--rule)">'
        + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 28px">'
        + '<div><div class="note" style="margin:10px 0 4px"><b>Your position</b></div>'
        + row('Commitment', money(x.commitment))
        + row('Funded to date', money(x.funded))
        + row('Still callable', x.uncalled ? money(x.uncalled) : DASH, x.uncalled ? 'neg' : 'z')
        + row('Year funded', x.fy)
        + '</div><div><div class="note" style="margin:10px 0 4px"><b>What the model makes of it</b></div>'
        + row('Exits at', mult(x.exitMult) + (x.coupon ? ' residual' : ''))
        + row('Expected exit', money(e.exit) + '  ' + mult(e.mult))
        + (e.pref > 0 ? row('Preferred over the hold', money(e.pref), 'pos') : '')
        + row('Pays out', x.spread ? payWindow(x) : payWindow(x) + ' (single date)')
        + '</div></div>';
      if (d) {
        const t = d.terms || {};
        const bits = [];
        if (t.couponPct != null) bits.push(['Preferred', pct(t.couponPct)]);
        if (t.holdYears) bits.push(['Hold', t.holdYears + ' yrs']);
        if (t.equityKicker != null) bits.push(['Equity kicker', t.equityKicker]);
        if (t.sponsorMoic) bits.push(['Sponsor MOIC', mult(t.sponsorMoic)]);
        if (t.mgmtFee != null) bits.push(['Mgmt fee', pct(t.mgmtFee)]);
        if (t.carry) bits.push(['Carry', t.carry]);
        if (t.ubtiDrag != null) bits.push(['UBTI drag', pct(t.ubtiDrag)]);
        h += '<div class="note" style="margin:16px 0 6px"><b>' + esc(d.sponsor) + '</b> · '
          + esc(d.vehicle) + ' · ' + esc(d.subStrategy || d.assetClass) + '</div>'
          + '<div class="row" style="margin-bottom:8px">'
          + bits.map(([k, v]) => '<span style="font-size:12px;color:var(--muted)">' + k
              + ' <b style="color:var(--ink);font-family:var(--mono)">' + v + '</b></span>').join('')
          + '</div><p class="note">' + esc(d.structure || '') + '</p>';
        if (d.liquidity && d.liquidity.source) {
          h += '<p class="note" style="margin-top:6px">Pays out over years '
            + d.liquidity.fromYear + ' to ' + d.liquidity.toYear + ' from funding. '
            + '<span style="color:var(--muted)">' + esc(d.liquidity.source) + '.</span></p>';
        }
      }
      if (x.thesis) {
        h += '<div class="note" style="margin:16px 0 4px"><b>Why you did it</b></div>'
          + '<p class="note">' + esc(x.thesis) + '</p>';
      }
      h += '</div>';
    }
    return h + '</div>';
  }

  function renderBackground() {
    const rules = [
      ['Commitment, not funded', 'Exit proceeds run off the full commitment, because the whole '
        + 'commitment is called long before any exit lands. Using funded-to-date understated '
        + 'one real book by 48%.'],
      ['A coupon is already inside the multiple', 'A sponsor MOIC is total distributions over '
        + 'invested capital, so a preferred return paid along the way is part of it. Showing the '
        + 'coupon separately AND exiting at the full multiple counts that cash twice.'],
      ['A fund is not one big deal', 'A fund of 20 or more companies cannot return zero the way '
        + 'one company can, and it does not pay out on a single date. It gets its own outcome '
        + 'table and sells down over a window.'],
      ['Two kinds of percentile', 'Per-year percentiles rank each year separately and cannot be '
        + 'added. Cumulative percentiles add each future up first and rank once, so they can. '
        + 'Mixing them overstated one book by 69%.'],
      ['Contractual and speculative never sum', 'A coupon is promised; an exit is hoped for. They '
        + 'appear on different panels and never inside the same total.'],
    ];
    $('#tabbody').innerHTML = '<div class="card"><h2>What this does</h2>'
      + '<p class="note">Two questions about a private book, answered separately because they are '
      + 'different questions. <b>What do I hold?</b> is the dashboard, and it is mostly '
      + 'bookkeeping. <b>When does it come back, and how much?</b> is the outlook, and it is a '
      + 'projection with real uncertainty in it.</p>'
      + '<p class="note">Everything runs in your browser. Your tracker is read in the page and '
      + 'never uploaded. There is no account and no analytics. Once the page has loaded you can '
      + 'turn off your wifi and it still works.</p></div>'
      + '<div class="card"><h2>The rules it enforces</h2>'
      + rules.map(([t, v]) => '<div class="glos"><div class="t">' + t + '</div><div class="d">'
          + v + '</div></div>').join('')
      + '</div>'
      + '<div class="card"><h2>What it cannot tell you</h2>'
      + '<p class="note"><b>Whether any of this is a good investment.</b> It takes your deals as '
      + 'given and says when the money might arrive. It has no view on whether you should have '
      + 'bought them.</p>'
      + '<p class="note"><b>What anything is worth today.</b> Private marks are stale by '
      + 'construction and usually flattering. Current value is whatever the last sponsor '
      + 'statement said.</p>'
      + '<p class="note"><b>Anything precise beyond about seven years.</b> The honest answer that '
      + 'far out is that the range is wide, and a precise-looking number would be false.</p>'
      + '<p class="note"><b>What happens when everything goes wrong at once.</b> The model draws '
      + 'each deal independently. In a real downturn they move together, which makes any '
      + 'diversification benefit here look better than it probably is. The other optimistic '
      + 'assumption is that the preferred return always pays, and a sponsor can suspend one.</p>'
      + '<p class="note">Not advice. The outcome probabilities are assumptions and are meant to '
      + 'be argued with.</p></div>';
  }

  function renderOutlook() {
    const book = subset(MODE);
    const st = Engine.simulate(book, { paths: 6000 });
    if (!st) { $('#out').innerHTML = '<div class="card">No positions in this view.</div>'; return; }
    const T = st.totals;

    const vSt = Engine.simulate(subset('venture'), { paths: 3000 });
    const iSt = Engine.simulate(subset('income'), { paths: 3000 });
    const aSt = Engine.simulate(subset('all'), { paths: 3000 });
    const series = [];
    if (vSt) series.push({ key: 'venture', label: 'Venture only', col: 'var(--vc)', raw: '#7B5EA7', st: vSt });
    if (iSt) series.push({ key: 'income', label: 'Income sleeves only', col: 'var(--inc)', raw: '#B17930', st: iSt });
    if (aSt && series.length > 1) series.push({ key: 'all', label: 'Blended book', col: 'var(--all)', raw: '#2E6B52', st: aSt });
    if (!series.some((s) => s.key === DIST)) DIST = series[series.length - 1].key;

    let h = '';

    /* which book */
    h += '<div class="card"><h2>Which book</h2>'
      + '<div class="row">'
      + btn('mode', 'all', 'Blended book') + btn('mode', 'venture', 'Venture only')
      + btn('mode', 'income', 'Income sleeves only') + '</div>'
      + '<div class="kpi">'
      + kpi('Positions', book.length) + kpi('Committed', money(T.committed))
      + kpi('Funded', money(T.funded)) + kpi('Still callable', money(T.uncalled), T.uncalled > 0 ? 'neg' : '')
      + '</div></div>';

    /* distribution */
    if (series.length > 1) {
      const active = series.find((s) => s.key === DIST);
      h += '<div class="card"><h2>The shape of the book</h2>'
        + '<p class="note">Percentiles give you three points. This is the whole distribution, which is where '
        + 'the argument lives. Each curve is where 3,000 simulated futures landed, as a multiple on capital '
        + 'committed, with anything above 3x gathered into the last bar.</p>'
        + '<div class="row" style="margin-top:12px">'
        + series.map((s) => btn('dist', s.key, s.label)).join('') + '</div>'
        + distChart(series, DIST)
        + '<p class="note" style="margin-top:10px"><b>' + esc(active.label) + '</b> is in front, the others '
        + 'stay as outlines so the comparison never leaves the screen. Median '
        + mult(active.st.totals.p50 / active.st.totals.committed) + ' on '
        + money(active.st.totals.committed) + ' committed.</p></div>';
    }

    /* the positions */
    h += '<div class="card"><h2>The book, ' + book.length + ' positions</h2>'
      + '<p class="note">Exit proceeds run off the <b>commitment</b>, not off what is funded so far, because '
      + 'the whole commitment is called long before any exit lands. Anything paying a coupon exits on the '
      + '<b>residual</b> multiple: a sponsor MOIC already contains the coupon, so exiting at the full multiple '
      + 'while also counting the coupon would count that cash twice. A <b>fund</b> does not exit on a '
      + 'single date, so its proceeds are spread over its sell-down window rather than dropped into one '
      + 'year. Anything paying a coupon is assumed to be a fund unless you put 1 in the deals column to '
      + 'say it is a single company. A venture fund holding ' + Engine.CFG.fundMinDeals + '+ deals also '
      + 'stops being priced like a single company.</p>'
      + '<table><tr><th class="l">Deal</th><th class="l">Sleeve</th><th>Deals</th><th>Commitment</th>'
      + '<th>Uncalled</th><th>Coupon</th><th>Sponsor MOIC</th><th>Exit multiple</th><th>Exit</th></tr>'
      + book.map((b) => '<tr><td class="l">' + esc(b.name) + '</td>'
        + '<td class="l" style="color:' + (b.kind === 'venture' ? '#7B5EA7' : '#B17930') + '">'
        + (b.kind === 'venture' ? 'Venture' : esc(b.cls)) + '</td>'
        + '<td class="' + (b.isFund ? 'b' : 'z') + '">' + (b.isFund ? (b.deals > 1 ? b.deals : 'fund') : '1') + '</td>'
        + '<td>' + money(b.commitment) + '</td>'
        + '<td class="' + (b.uncalled > 0 ? 'neg' : 'z') + '">' + (b.uncalled > 0 ? money(b.uncalled) : DASH) + '</td>'
        + '<td class="' + (b.coupon ? 'pos' : 'z') + '">' + (b.coupon ? (b.coupon * 100).toFixed(1) + '%' : DASH) + '</td>'
        + '<td>' + mult(b.moic) + '</td>'
        + '<td class="b">' + mult(b.exitMult) + '</td>'
        + '<td>' + (b.spread
            ? (b.likely + b.spread[0][0]) + '-' + (b.likely + b.spread[b.spread.length - 1][0])
            : b.likely) + '</td></tr>').join('')
      + '</table></div>';

    /* year by year */
    const yrRows = st.byYear.filter((r) => r.p90 > 0 || r.calls > 0 || r.coupon > 0);
    h += '<div class="card"><h2>What happens IN each year</h2>'
      + '<p class="note">Each year is ranked on its own across the simulated futures, so the future sitting in '
      + 'the middle in one year is a <b>different</b> future from the middle one in another. '
      + '<span class="warn">This table cannot be added down.</span> Stacking the good-run column gives '
      + money(T.stackedP90) + ' against a real lifetime figure of ' + money(T.p90) + '. Use it to find the thin '
      + 'years, then use the next panel to plan.</p>'
      + '<table><tr><th class="l">Year</th><th>Coupon</th><th>Capital calls</th>'
      + '<th>Typical year (median)</th><th>Odds of any cash</th><th>Good run (90th pct)</th></tr>'
      + yrRows.map((r) => '<tr><td class="l b">' + r.year + '</td>'
        + '<td class="' + (r.coupon ? 'pos' : 'z') + '">' + (r.coupon ? money(r.coupon) : DASH) + '</td>'
        + '<td class="' + (r.calls ? 'neg' : 'z') + '">' + (r.calls ? '-' + money(r.calls) : DASH) + '</td>'
        + '<td class="' + (r.med > 0 ? 'b' : 'z') + '">' + money(r.med) + '</td>'
        + '<td>' + pct(r.odds) + '</td><td>' + money(r.p90) + '</td></tr>').join('')
      + '</table></div>';

    /* cumulative */
    const cumRows = st.cum.filter((r) => r.p90 > 0);
    const lastY = cumRows.length ? cumRows[cumRows.length - 1].year : null;
    h += '<div class="card"><h2>How much has arrived BY the end of each year</h2>'
      + '<p class="note">Take one simulated future and add up every dollar it produced up to that year. Do that '
      + 'for all of them, then sort. <b>This is the one to plan against</b>, because every figure is a real total '
      + 'a real future actually reached, so it is safe to read down. Subtracting one row from another is a rough '
      + 'guide rather than an exact figure, since a different future can sit in the middle in each year. '
      + (st.ties
          ? '<b class="pos">The last row ties exactly to the totals below</b>, which is the check that both '
            + 'panels came from one model.'
          : '<span class="warn">TIE-OUT FAILED against the totals below. Do not trust either panel.</span>')
      + '</p>'
      + '<table><tr><th class="l">By end of</th><th>Bad run (10th pct)</th><th>Typical (median)</th>'
      + '<th>Good run (90th pct)</th></tr>'
      + cumRows.map((r) => '<tr' + (r.year === lastY ? ' class="hi"' : '') + '><td class="l b">' + r.year + '</td>'
        + '<td>' + money(r.p10) + '</td><td class="b">' + money(r.p50) + '</td>'
        + '<td class="pos">' + money(r.p90) + '</td></tr>').join('')
      + '</table></div>';

    /* lifetime */
    const line = (lbl, v, bold) => {
      const profit = v - T.committed;
      return '<tr><td class="l' + (bold ? ' b' : '') + '">' + lbl + '</td>'
        + '<td class="' + (bold ? 'b' : '') + '">' + money(v) + '</td>'
        + '<td class="' + (profit < 0 ? 'neg' : (bold ? 'b' : '')) + '">' + money(profit) + '</td>'
        + '<td class="' + (bold ? 'b' : '') + '">' + mult(v / T.committed) + '</td></tr>';
    };
    h += '<div class="card"><h2>What this book returns over its life</h2>'
      + '<p class="note">Profit is measured against the <b>full ' + money(T.committed) + ' committed</b>, not '
      + 'against the uncalled balance. Netting only what is left to fund ignores the ' + money(T.funded)
      + ' already in, and makes a thin result look healthy. <b>Read the median, not the average.</b> One '
      + 'outsized winner drags the average above what most futures deliver, so the average describes a book you '
      + 'do not own. You get one draw.'
      + (T.coupon > 0 ? ' Of the figures below, ' + money(T.coupon) + ' is contractual coupon.' : '')
      + '</p>'
      + '<table><tr><th class="l">Scenario</th><th>Total received</th><th>Profit</th><th>Multiple</th></tr>'
      + line('Bad run (10th percentile)', T.p10, false)
      + line('Typical (median)', T.p50, true)
      + line('Average (mean)', T.mean, false)
      + line('Good run (90th percentile)', T.p90, false)
      + '</table></div>';

    h += glossary(T);
    $('#tabbody').innerHTML = h;
    wire();
  }

  function btn(group, key, label) {
    const on = (group === 'mode' ? MODE : DIST) === key;
    return '<button data-' + group + '="' + key + '"' + (on ? ' class="on"' : '') + '>' + label + '</button>';
  }
  function kpi(label, val, cls) {
    return '<div><small>' + label + '</small><span class="' + (cls || '') + '">' + val + '</span></div>';
  }

  /* the distribution chart, drawn as inline SVG so there is no chart library to load */
  function distChart(series, active) {
    const W = 880, H = 260, L = 44, R = 16, T = 14, B = 46;
    const iw = W - L - R, ih = H - T - B;
    const n = series[0].st.histBins, HI = series[0].st.histMax;
    let maxY = 0;
    series.forEach((s) => s.st.hist.forEach((v) => { if (v > maxY) maxY = v; }));
    maxY = Math.max(maxY, 0.01) * 1.14;
    const X = (m) => L + iw * (m / HI), Y = (v) => T + ih - (v / maxY) * ih;

    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" role="img">';
    for (let g = 0; g <= 6; g++) {
      const gm = g * 0.5, gx = X(gm);
      s += '<line x1="' + gx + '" y1="' + T + '" x2="' + gx + '" y2="' + (T + ih) + '" stroke="#EDF1F6"/>'
        + '<text x="' + gx + '" y="' + (H - 26) + '" text-anchor="middle" font-size="10" fill="#6B7A8C">'
        + gm.toFixed(1) + 'x' + (g === 6 ? '+' : '') + '</text>';
    }
    const area = (hist, col, op, w) => {
      let d = 'M' + X(0) + ' ' + Y(0);
      for (let i = 0; i < n; i++) {
        d += ' L' + X(i / n * HI) + ' ' + Y(hist[i]) + ' L' + X((i + 1) / n * HI) + ' ' + Y(hist[i]);
      }
      d += ' L' + X(HI) + ' ' + Y(0) + ' Z';
      return '<path d="' + d + '" fill="' + col + '" opacity="' + op + '" stroke="' + col
        + '" stroke-width="' + w + '" stroke-linejoin="round"/>';
    };
    series.forEach((sr) => { if (sr.key !== active) s += area(sr.st.hist, sr.raw, 0.07, 1.2); });
    series.forEach((sr) => { if (sr.key === active) s += area(sr.st.hist, sr.raw, 0.28, 2.4); });

    const bx = X(1.0);
    s += '<line x1="' + bx + '" y1="' + (T - 2) + '" x2="' + bx + '" y2="' + (T + ih)
      + '" stroke="#141A22" stroke-width="1.5" stroke-dasharray="4,3"/>'
      + '<text x="' + (bx + 6) + '" y="' + (T + 11) + '" font-size="11" font-weight="700" fill="#141A22">break even</text>';

    /* Medians as dots on the axis, with the NUMBERS in a corner key rather than floating
       over the curves. They used to sit above each dot, which worked while the three were
       far apart and became unreadable the moment they converged -- on a blended book they
       can land within a few hundredths of each other, on top of the tallest curve. */
    series.forEach((sr) => {
      const on = sr.key === active, t = sr.st.totals;
      const mx = X(t.p50 / t.committed);
      s += '<circle cx="' + mx + '" cy="' + (T + ih + 1) + '" r="' + (on ? 5 : 3.2) + '" fill="' + sr.raw
        + '" opacity="' + (on ? 1 : 0.5) + '"/>';
    });
    const kx = L + 12, ky = T + 14;
    s += '<text x="' + kx + '" y="' + ky + '" font-size="9" font-weight="700" fill="#6B7A8C" '
      + 'letter-spacing="0.5">TYPICAL RUN</text>';
    series.forEach((sr, k) => {
      const on = sr.key === active, t = sr.st.totals, yy = ky + 15 + k * 15;
      s += '<rect x="' + kx + '" y="' + (yy - 4) + '" width="10" height="3" rx="1.5" fill="'
        + sr.raw + '" opacity="' + (on ? 1 : 0.5) + '"/>'
        + '<text x="' + (kx + 17) + '" y="' + yy + '" font-size="11" font-weight="700" fill="'
        + sr.raw + '" opacity="' + (on ? 1 : 0.6) + '">' + mult(t.p50 / t.committed) + '</text>'
        + '<text x="' + (kx + 56) + '" y="' + yy + '" font-size="10" fill="#6B7A8C" '
        + 'opacity="' + (on ? 1 : 0.6) + '">' + esc(sr.label) + '</text>';
    });
    s += '<text x="' + L + '" y="' + (H - 8) + '" font-size="10" fill="#6B7A8C">multiple on committed capital</text>';
    for (let i = 0; i < n; i++) {
      const b0 = i / n * HI, b1 = (i + 1) / n * HI;
      let tip = b0.toFixed(1) + 'x to ' + b1.toFixed(1) + 'x';
      series.forEach((sr) => { tip += '\n' + sr.label + ' ' + (sr.st.hist[i] * 100).toFixed(1) + '%'; });
      s += '<rect x="' + X(b0) + '" y="' + T + '" width="' + (X(b1) - X(b0)) + '" height="' + ih
        + '" fill="transparent"><title>' + esc(tip) + '</title></rect>';
    }
    s += '</svg><div class="row" style="margin:8px 0 0">'
      + series.map((sr) => '<span style="display:flex;align-items:center;gap:6px;font-size:12px;color:#6B7A8C">'
        + '<span style="width:11px;height:3px;border-radius:2px;background:' + sr.raw + '"></span>'
        + esc(sr.label) + '</span>').join('') + '</div>';
    return s;
  }

  function glossary(T) {
    const G = [
      ['Typical (median)', 'Rank every simulated future and take the middle one. $0 for a year means that in '
        + 'more than half of futures, nothing at all arrives that year. The median matters more than the average '
        + 'here because one outsized winner drags an average above what most futures actually deliver.'],
      ['Odds of any cash', 'How often that year pays anything. It replaces a 10th-percentile column, which on a '
        + 'book like this reads zero in every single year and so tells you nothing.'],
      ['Good run (90th pct)', 'Better than 9 futures out of 10, for that year on its own. Large figures are real, '
        + 'because several deals can land in the same year.'],
      ['Two kinds of percentile', 'Per-year percentiles rank each year separately and CANNOT be added. Cumulative '
        + 'percentiles add each future up first and rank once, so they can. Same word, opposite behaviour, and '
        + 'mixing them is the commonest way a table like this overstates by most of its own value.'],
      ['Coupon versus multiple', 'A sponsor MOIC already contains the coupon paid along the way, so anything '
        + 'paying a coupon exits here on the residual. Otherwise that cash gets counted twice.'],
      ['A fund is not a big deal', 'Two separate things. WHEN it pays: a fund sells down over several years '
        + 'instead of exiting on a date, so its proceeds are spread across a window. Anything paying a coupon '
        + 'is treated as a fund, because most coupon-paying vehicles are one; put 1 in the deals column to say '
        + 'a position is a single company and it exits on one date instead. HOW MUCH it returns: a venture fund '
        + 'holding ' + Engine.CFG.fundMinDeals + '+ companies gets its own outcome table, because the '
        + 'single-deal power law carries a 30% chance of returning zero and a fund that size cannot do that.'],
      ['Liquidity window', 'When a fund actually sells down, in years from when you funded it. That is not the '
        + 'same as its stated life, because a fund can finish paying out and wind up afterwards. If a sponsor '
        + 'has told you "years five through eight", put 5 and 8 in the two liquidity columns. Left blank it '
        + 'runs over the back 40% of the hold, which is roughly what most sponsors describe anyway.'],
      ['What this assumes', 'That the coupon always pays, and that deals fail independently of one another. '
        + 'Both are optimistic. A sponsor can suspend a preferred return, and in a real downturn outcomes move '
        + 'together, which would make the blended picture less flattering than it looks.'],
    ];
    return '<div class="card"><h2>Reading these tables</h2>'
      + G.map(([t, d]) => '<div class="glos"><div class="t">' + t + '</div><div class="d">' + d + '</div></div>').join('')
      + '</div>';
  }

  function wire() {
    document.querySelectorAll('[data-mode]').forEach((b) =>
      b.onclick = () => { MODE = b.getAttribute('data-mode'); render(); });
    document.querySelectorAll('[data-dist]').forEach((b) =>
      b.onclick = () => { DIST = b.getAttribute('data-dist'); render(); });
  }

  /* ── intake ──────────────────────────────────────────────────────────────── */
  async function load(rows, skipped) {
    // fill blanks from the shared deal files BEFORE validating, so a term that GC already
    // knows does not get reported as something the holder failed to supply
    await enrich(rows);
    const problems = validate(rows, skipped);
    BOOK = Engine.buildBook(rows);
    if (!BOOK.length) {
      $('#intakeErr').innerHTML = '<div class="err"><b>Nothing to run.</b> No row had a usable commitment. '
        + (problems.length ? '<br>' + problems.slice(0, 6).map(esc).join('<br>') : '') + '</div>';
      return;
    }
    $('#intakeErr').innerHTML = problems.length
      ? '<div class="err"><b>Loaded ' + BOOK.length + ' positions, with ' + problems.length
        + ' thing' + (problems.length > 1 ? 's' : '') + ' worth fixing.</b> Nothing was guessed at; these rows '
        + 'are running on whatever was there.<br>' + problems.slice(0, 8).map(esc).join('<br>') + '</div>'
      : '';
    MODE = 'all'; DIST = 'all'; TAB = 'dash'; OPEN = {};
    render();
    $('#out').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function readFile(f) {
    const fr = new FileReader();
    fr.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        // the positions sheet is whichever one parses into rows
        for (const nm of wb.SheetNames) {
          const aoa = XLSX.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true });
          const res = rowsFromSheet(aoa);
          if (res.rows && res.rows.length) { load(res.rows, res.skipped); return; }
        }
        $('#intakeErr').innerHTML = '<div class="err"><b>Could not find your positions.</b> The app looks for a '
          + 'header row containing a deal name and a commitment column. The tracker template in the repository '
          + 'has the expected layout.</div>';
      } catch (err) {
        $('#intakeErr').innerHTML = '<div class="err"><b>Could not read that file.</b> '
          + esc(err.message) + '</div>';
      }
    };
    fr.readAsArrayBuffer(f);
  }

  // the badge reads the engine's own version, so the label cannot drift from the model
  (function () {
    const el = $('#ver'), mask = $('#relMask');
    if (!el) return;
    el.textContent = Engine.CFG.version + ' · ' + Engine.CFG.released;
    if (!mask) return;
    const when = $('#relWhen');
    if (when) when.textContent = 'You are on ' + Engine.CFG.version
      + ', released ' + Engine.CFG.released + '.';
    const open = () => mask.classList.remove('hidden');
    const shut = () => mask.classList.add('hidden');
    el.onclick = open;
    $('#relClose').onclick = shut;
    // clicking the backdrop closes; clicking inside the panel must not
    mask.onclick = (e) => { if (e.target === mask) shut(); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') shut(); });
  })();

  $('#pick').onclick = () => $('#file').click();
  $('#file').onchange = (e) => { if (e.target.files[0]) readFile(e.target.files[0]); };
  $('#demo').onclick = () => {
    fetch('example-book.json').then((r) => r.json()).then(load).catch(() => {
      $('#intakeErr').innerHTML = '<div class="err">Example file not found next to this page.</div>';
    });
  };
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => {
    if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
  });
})();
