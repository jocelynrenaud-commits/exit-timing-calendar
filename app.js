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
  /* A whole percent where the number is whole, one decimal where it is not. It printed
     Asilia's 1.3% management fee as "1%" on the same card that spelled out "1.2% and 20%"
     two lines below, so the card disagreed with itself. */
  const pct = (v) => {
    const p = v * 100;
    return (Math.abs(p - Math.round(p)) < 0.05 ? p.toFixed(0) : p.toFixed(1)) + '%';
  };
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
    // Fund or Single deal, said outright. Clearer than asking for a count, and it is
    // what people already know about their own positions.
    /* 'type' is deliberately NOT here. It was, and because `vehicle` is matched before
       `assetClass`, it took the column off it -- so a tracker predating v1.5, where a
       column headed "Type" holds "Real Estate", had its asset class read as a vehicle and
       its asset class left blank. The people most affected were the ones who had been
       using the tool longest. */
    ['vehicle',     ['fund or single', 'fund / single', 'vehicle', 'fund?', 'structure']],
    ['liqFrom',     ['liquidity from', 'payout from', 'sell-down from', 'distributions from']],
    ['liqTo',       ['liquidity to', 'payout to', 'sell-down to', 'distributions to']],
    ['name',        ['deal name', 'deal', 'name', 'investment', 'position']],
    ['assetClass',  ['asset class', 'class', 'type', 'sleeve type']],
    ['commitment',  ['commitment', 'committed', 'total commitment']],
    /* BEFORE `funded`, and it has to stay there. Matching is by prefix, so a column headed
       "Funded year" starts with "funded" and was being read as the funded AMOUNT: a year
       of 2026 became $2,026 paid in, and the position then showed a six-figure uncalled
       balance that did not exist. */
    ['yearFunded',  ['year funded', 'funded year', 'vintage', 'year']],
    ['funded',      ['funded to date', 'funded', 'paid in', 'contributed']],
    ['uncalled',    ['uncalled', 'unfunded', 'remaining', 'callable']],
    ['hold',        ['hold', 'hold (yrs)', 'hold years', 'term', 'fund life', 'horizon']],
    /* 'coupon' stays FIRST and stays supported. The community calls these preferred
       returns and the app now says so everywhere a member reads, but every tracker
       already filled in says Coupon, and breaking those to tidy up the wording would
       be the worst possible trade. */
    ['coupon',      ['coupon', 'coupon %', 'preferred return %', 'preferred return',
                     'preferred', 'pref', 'pref %']],
    /* BEFORE `moic`, and it has to stay there, for exactly the reason `yearFunded` sits
       before `funded`. Header matching is `k === n || k.startsWith(n)`, so a column headed
       "MOIC (marked up)" starts with "moic" and would be read as the SPONSOR's multiple --
       silently turning a holder's paper mark into a forecast input, which is the one thing
       this feature must never do. Listed first, the marked-up aliases win the header.
       Aliases are kept long deliberately: a bare 'mark' would capture "Market Value". */
    ['markedUpMoic', ['marked up moic', 'marked-up moic', 'markup moic', 'marked up multiple',
                      'moic (marked up)', 'moic marked up', 'current moic', 'paper moic']],
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
    LASTMAP = map;   // remembered so the age note can say whether this is an older sheet
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

  /* Which of the newer optional columns did this sheet have? Kristin's tracker stopped
     at Override likely and she had no way to know a newer one existed. The sheet carries
     its version in cell A1 of Positions, but an OLD sheet has no version to read, so the
     honest test is whether any of the newer headers were found at all. */
  function trackerAge(map) {
    const recent = ['deals', 'liqFrom', 'liqTo', 'thesis', 'vehicle'];
    const found = recent.filter((f) => map && map[f] != null);
    return { found: found.length, total: recent.length };
  }

  function validate(rows, skipped) {
    const problems = [];
    rows.forEach((r) => {
      const where = r.name;
      if (!Engine.num(r.moic) && !Engine.num(r.coupon))
        problems.push(where + ': no sponsor multiple and no preferred return, so there is nothing to exit on');
      if (!parseInt(r.yearFunded, 10)) problems.push(where + ': no year funded');
    });
    (skipped || []).forEach((n) => problems.push(n + ': looks like a deal but has no commitment, so it was left out'));
    return problems;
  }

  function ageNote(map) {
    const a = trackerAge(map);
    if (a.found > 0) return '';
    return '<div class="err" style="background:#F0F5FB;border-color:#C9D8E8;color:#2B4058">'
      + '<b>This looks like an older tracker.</b> It works, and nothing you have typed is '
      + 'wasted. A newer one adds a few optional columns: whether a position is a fund or a '
      + 'single deal, when a sponsor says it pays out, and your own note on why you did it. '
      + 'All of them can be left blank. The current tracker is marked '
      + Engine.CFG.trackerVersion + ' in the top-left cell of its Positions tab.</div>';
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
      + 'preferred return is a promise, and adding them together is how these tools mislead. Exits live on '
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
      /* Alphabetical. The book arrives in spreadsheet-row order, which is whatever order the
         holder happened to type things in and is no help at all when you are looking for one
         deal in thirteen. localeCompare so accented and punctuated names sort sensibly. */
      + b.slice().sort((p, q) => p.name.localeCompare(q.name, 'en', { sensitivity: 'base' }))
          .map(dealCard).join('') + '</div>';

    $('#tabbody').innerHTML = h;
    document.querySelectorAll('[data-deal]').forEach((el) => {
      el.onclick = () => {
        const k = el.getAttribute('data-deal');
        OPEN[k] = !OPEN[k];
        renderDashboard();
      };
    });
  }

  /* One override line can be a rate, a multiple, a count of years or a window, so the shared
     file's raw value is formatted the same way the holder's is -- otherwise 0.12 sits beside
     12% and reads as a third disagreement. */
  function ovrVal(o, v) {
    if (o.fmt === 'window') return 'years ' + v[0] + '–' + v[1];
    const n = Number(v);
    if (o.fmt === 'pct' && isFinite(n)) return pct(n);
    if (o.fmt === 'mult' && isFinite(n)) return mult(n);
    if (o.fmt === 'years' && isFinite(n)) return n + ' yrs';
    if (o.fmt === 'num' && isFinite(n)) return String(n);
    return esc(String(v));
  }

  function dealCard(x) {
    const open = !!OPEN[x.name];
    const d = x.deal;
    const e = expectedOf(x);
    const ovr = x.overrides || [];
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
      + (ovr.length ? '<span style="font-size:10px;letter-spacing:.05em;color:#9A5B14;border:1px solid '
             + '#E6C79A;background:#FDF6EE;border-radius:999px;padding:2px 8px">YOURS &times; '
             + ovr.length + '</span>' : '')
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
        + row('Exits at', mult(x.exitMult) + (x.coupon ? ' residual' : '')
          + (x.moicAssumed ? ' <span style="color:#9A5B14;font-size:10px">assumed</span>' : ''))
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
        /* A deal file whose terms are being checked says so ON THE CARD. A shared file
           that is quietly wrong is worse than no shared file, because it looks
           authoritative and nobody re-reads their own documents. */
        if (d.provisional) {
          h += '<div style="margin:14px 0 4px;padding:11px 13px;border-radius:8px;'
            + 'background:#FDF3EC;border:1px solid #F0D3BE;font-size:13px;line-height:1.6;'
            + 'color:#7A3A15"><b>These shared terms are being checked.</b> '
            + esc(d.provisionalNote || '') + '</div>';
        }
        h += '<div class="note" style="margin:16px 0 6px"><b>' + esc(d.sponsor) + '</b> · '
          + esc(d.vehicle) + ' · ' + esc(d.subStrategy || d.assetClass) + '</div>'
          + '<div class="row" style="margin-bottom:8px">'
          + bits.map(([k, v]) => '<span style="font-size:12px;color:var(--muted)">' + k
              + ' <b style="color:var(--ink);font-family:var(--mono)">' + v + '</b></span>').join('')
          + '</div>';

        /* NOT EVERY TERM IS THE SAME FOR EVERY HOLDER.
           Eephus pays 8% to Class A-1/A-2 and 6% to A-4. The file carries 6%, because that
           is the author's class -- so the shared file was quietly handing everyone the
           LOWEST tier and understating a third of the income for anyone above it. The
           tiering was written down in the file all along and nothing put it on screen,
           which is the same failure as a stale override: the information existed and the
           reader could not see it. */
        /* RESOLVED reads calmly; UNRESOLVED keeps the warning.
           Telling someone to go and work out their own share class is the tool asking the
           reader to do its job. Where the breakpoints are documented by ticket size it now
           picks the band from the commitment and says which one. Where they are not -- the
           documents give Eephus's rate PER CLASS but never say what sets the class -- it
           says so, because inventing a breakpoint is worse than admitting there is one. */
        if (x.tier) {
          const tt = x.tier.terms || {};
          const detail = [
            tt.couponPct != null ? pct(tt.couponPct) + ' preferred' : null,
            tt.mgmtFee != null ? pct(tt.mgmtFee) + ' fee' : null,
            tt.carry ? tt.carry + ' carry' : null,
          ].filter(Boolean).join(' · ');
          h += '<div style="margin:2px 0 10px;padding:10px 12px;border-radius:8px;'
            + 'background:#F1F7F3;border:1px solid #CADFD2;font-size:12.5px;line-height:1.6;'
            + 'color:#2E6B52"><b>Your commitment puts you in ' + esc(x.tier.label) + '.</b>'
            + (detail ? ' ' + esc(detail) + '.' : '')
            + ' <span style="color:var(--muted)">Set from the ' + money(x.commitment)
            + ' you committed, not from whoever wrote the shared file.</span></div>';
        } else if (d.variesByHolder && d.variesByHolder.length) {
          h += '<div style="margin:2px 0 10px;padding:10px 12px;border-radius:8px;'
            + 'background:#FDF6EE;border:1px solid #E6C79A;font-size:12.5px;line-height:1.6;'
            + 'color:#7A4A15"><b>These terms are not the same for every investor.</b> '
            + esc(d.variesNote || '') + '</div>';
        }

        /* The footnotes the terms carry: which class, what the hold really means, whether
           the preferred return compounds. Recorded since the files were written and never displayed. */
        const notes = Object.keys(t).filter((k) => /Note$/.test(k) && t[k]);
        if (notes.length) {
          const label = { couponNote: 'Preferred', holdNote: 'Hold', moicNote: 'Sponsor MOIC',
            feeNote: 'Fees', carryNote: 'Carry' };
          h += '<div style="margin-bottom:8px">'
            + notes.map((k) => '<div class="note" style="margin:2px 0"><b>'
                + esc(label[k] || k.replace(/Note$/, '')) + ':</b> ' + esc(t[k]) + '</div>').join('')
            + '</div>';
        }

        h += '<p class="note">' + esc(d.structure || '') + '</p>';

        /* WHAT THE FUND ACTUALLY HOLDS.
           A fund card that lists only terms tells you the shape of the wrapper and nothing
           about what is inside it. Where a sponsor has published its portfolio, it goes here
           -- names and a line each, never their financials. */
        const H = d.holdings;
        if (H && H.companies && H.companies.length) {
          h += '<div class="note" style="margin:16px 0 6px"><b>What it holds</b> · '
            + H.companies.length + ' companies'
            + (H.asOf ? ' as at ' + esc(H.asOf) : '') + '</div>'
            + (H.note ? '<p class="note" style="margin:0 0 8px">' + esc(H.note) + '</p>' : '')
            + H.companies.map((c) => '<div style="padding:6px 0;border-top:1px solid var(--rule);'
                + 'font-size:12.5px"><b>' + esc(c.name) + '</b>'
                + (c.stage ? ' <span style="color:var(--muted);font-size:11px">' + esc(c.stage)
                    + (c.category ? ' · ' + esc(c.category) : '') + '</span>' : '')
                + '<div class="note" style="margin:2px 0 0">' + esc(c.what || '') + '</div></div>').join('')
            + (H.source ? '<p class="note" style="margin-top:8px;color:var(--muted)">Source: '
                + esc(H.source) + '</p>' : '');
        }
        if (d.liquidity && d.liquidity.source) {
          h += '<p class="note" style="margin-top:6px">Pays out over years '
            + d.liquidity.fromYear + ' to ' + d.liquidity.toYear + ' from funding. '
            + '<span style="color:var(--muted)">' + esc(d.liquidity.source) + '.</span></p>';
        }
        /* WHERE THE SHEET AND THE FILE DISAGREE.
           Your value is the one the model ran on, and that does not change. What changes is
           that the disagreement is now visible: a deliberate haircut and a figure that went
           stale when the sponsor's terms were corrected used to look exactly alike, which is
           how a 5-to-8 window sat under a deal whose documents said 6 to 8 for a day. */
        if (ovr.length) {
          h += '<div style="margin:16px 0 4px;border:1px solid #E6C79A;background:#FDF6EE;'
            + 'border-radius:8px;padding:11px 13px">'
            + '<div style="font-size:13px;font-weight:700;color:#7A4A15;margin-bottom:2px">'
            + 'You typed over the shared file on ' + ovr.length
            + (ovr.length === 1 ? ' field' : ' fields') + '</div>'
            + '<p class="note" style="margin:0 0 8px;color:#7A4A15">Your figure is what ran. '
            + 'This is here so a number you chose on purpose does not look the same as one that '
            + 'went stale after the sponsor terms were corrected.</p>'
            + ovr.map((o) => '<div style="display:flex;justify-content:space-between;gap:16px;'
                + 'padding:4px 0;font-size:13px;border-top:1px solid #F0DFC9">'
                + '<span style="color:#7A4A15">' + esc(o.label) + '</span>'
                + '<span style="font-family:var(--mono);text-align:right;color:#7A4A15">'
                + '<b>' + ovrVal(o, o.yours) + '</b>'
                + '<span style="color:var(--muted)"> &nbsp;shared file: ' + ovrVal(o, o.shared)
                + '</span></span></div>').join('')
            + '</div>';
        }
      }
      /* A multiple nobody supplied must not look like one somebody did. */
      if (x.moicAssumed) {
        h += '<div style="margin:12px 0 4px;padding:10px 12px;border-radius:8px;'
          + 'background:#FDF6EE;border:1px solid #E6C79A;font-size:12.5px;line-height:1.6;'
          + 'color:#7A4A15"><b>Nobody has given this deal a multiple, so the tool assumed one.</b> '
          + 'It is using ' + mult(x.moic) + ', which is this tool\u2019s convention for a venture '
          + 'deal with nothing to exit on \u2014 not the sponsor\u2019s projection and not a figure '
          + 'anyone quoted. Put your own number in the Sponsor MOIC column and it will be used '
          + 'instead.</div>';
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
      ['A preferred return is already inside the multiple', 'A sponsor MOIC is total distributions over '
        + 'invested capital, so a preferred return paid along the way is part of it. Showing the '
        + 'preferred return separately AND exiting at the full multiple counts that cash twice.'],
      ['A fund is not one big deal', 'A fund of 20 or more companies cannot return zero the way '
        + 'one company can, and it does not pay out on a single date. It gets its own outcome '
        + 'table and sells down over a window.'],
      ['The year-by-year column does not add up', 'Each year there is ranked on its own, so a '
        + 'good 2030 and a good 2034 come from different futures. Adding them builds a future '
        + 'nobody had, and on a real book that overstated the total by 69%. The by-the-end-of-year '
        + 'table is the one you can read down.'],
      ['Contractual and speculative never sum', 'A preferred return is promised; an exit is hoped for. They '
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
      + '<div class="card"><h2>The numbers this tool invents, and why</h2>'
      + '<p class="note">Your commitment, your funding date and the sponsor\u2019s terms come '
      + 'from you and from the shared deal files. Everything below is the tool\u2019s own '
      + 'judgement. None of it is a finding, all of it is arguable, and it is written out here '
      + 'so you can disagree with a specific number rather than with the whole thing.</p>'

      + '<div class="glos"><div class="t">How one deal turns out</div><div class="d">'
      + 'A single venture deal is given a <b>30% chance of returning nothing</b>, a 30% chance '
      + 'of handing back roughly what you put in, a 30% chance of a modest result around 1.65x, '
      + 'and a <b>10% chance of reaching the sponsor\u2019s own number</b>. That last point is '
      + 'the one people miss: a sponsor\u2019s multiple is not the expected case here, it is '
      + 'the best one outcome in ten. A fund holding twenty or more companies gets a different '
      + 'table entirely, because a fund returning zero would need every company in it to fail '
      + 'at once, and that does not happen. An income sleeve gets a tighter table again: 5% '
      + 'written off, and most outcomes clustered near plan.</div></div>'

      + '<div class="glos"><div class="t">How much of a preferred return actually arrives</div><div class="d">'
      + 'A preferred return is contractual but not guaranteed, and a sponsor who is not earning '
      + 'can suspend one. So the tool pays <b>about a quarter</b> of the scheduled amount where '
      + 'the position writes off its equity, <b>about 70%</b> where it lands well below plan, '
      + '<b>about 90%</b> just below plan, and all of it on plan. '
      + 'The important part is that this is tied to the <b>same draw</b> as the exit rather '
      + 'than rolled separately \u2014 the fund that hands back less than plan is the same fund '
      + 'that stopped paying. Rolling them independently would let a deal lose everything while '
      + 'still paying seven years of coupon, which is not how it goes.</div></div>'

      + '<div class="glos"><div class="t">When the money shows up</div><div class="d">'
      + 'Exits slip; nothing makes them early. So timing is skewed late: <b>20%</b> earlier than '
      + 'expected, <b>50%</b> on time, <b>25%</b> two years late and <b>5%</b> four years late. '
      + 'A fund does not exit on a date at all, it sells down over several years, so its '
      + 'proceeds are spread across a window with the largest payment usually last. Staging '
      + 'only moves money between years \u2014 it never creates or destroys any, and the '
      + 'lifetime totals come out the same either way.</div></div>'

      + '<div class="glos"><div class="t">Capital calls</div><div class="d">'
      + 'Whatever you have committed but not yet funded is assumed to be called over about '
      + '<b>three years</b>, starting the year after you funded. Exit proceeds are measured '
      + 'against your <b>full commitment</b>, not against what you have paid in so far, because '
      + 'by the time a deal exits the whole commitment will have been called.</div></div>'

      + '<div class="glos"><div class="t">Where a sponsor gave no multiple</div><div class="d">'
      + 'The tool falls back to <b>5.0x</b> for a venture position, and says so on the card. '
      + '5.0x is not a neutral number, it is a strong claim, so it is labelled as the '
      + 'tool\u2019s convention rather than passed off as anybody\u2019s projection.</div></div>'

      + '<div class="glos"><div class="t">What it runs on</div><div class="d">'
      + '<b>6,000 simulated futures</b>, with a fixed starting seed, so the same book always '
      + 'produces the same answer. If a number moves, something moved it.</div></div>'
      + '</div>'

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
      + '<p class="note"><b>Anything precise beyond about seven years.</b> The range that far out '
      + 'is too wide for a single figure to mean much.</p>'
      + '<p class="note"><b>What happens when everything goes wrong at once.</b> The model draws '
      + 'each deal independently. In a real downturn they move together, which makes any '
      + 'diversification benefit here look better than it probably is. This is now the single '
      + 'most optimistic thing the model does.</p>'
      + '<p class="note"><b>The difference your fee class makes.</b> Management fees and carry '
      + 'are shown on a deal card but are <b>not modelled</b>. The model runs on the sponsor&rsquo;s '
      + 'quoted multiple, which is already stated net to the investor, so applying fees again '
      + 'would count them twice. The catch is that a sponsor quotes ONE base case, and several '
      + 'GC deals charge different fees at different ticket sizes — Asilia drops from 1.3% and '
      + '30% carry to 1.2% and 20% at $400k. If you are in the cheaper class you are keeping '
      + 'more of the same gross return than this shows. The fix is to ask the sponsor for your '
      + 'class&rsquo;s base case and type that multiple into your tracker, because what you type '
      + 'wins.</p>'
      + '<p class="note">Not advice. The outcome probabilities are assumptions and are meant to '
      + 'be argued with.</p></div>';
  }

  function renderOutlook() {
    const book = subset(MODE);
    const st = Engine.simulate(book, { paths: 6000, irr: true });
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
      h += '<div class="card"><h2>Outcome distribution</h2>'
        + '<p class="note">Where 3,000 simulated futures landed, measured as a multiple on the capital '
        + 'committed. The three percentile figures above are three points on this curve; this is the '
        + 'full shape. Anything above ' + series[0].st.histMax.toFixed(1) + 'x is gathered into the '
        + 'last bar.</p>'
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
      + 'the whole commitment is called long before any exit lands. Anything paying a preferred return exits on the '
      + '<b>residual</b> multiple: a sponsor MOIC already contains the preferred return, so exiting at the full multiple '
      + 'while also counting the preferred return would count that cash twice. A <b>fund</b> does not exit on a '
      + 'single date, so its proceeds are spread over its sell-down window rather than dropped into one '
      + 'year. Anything paying a preferred return is assumed to be a fund unless you put 1 in the deals column to '
      + 'say it is a single company. A venture fund holding ' + Engine.CFG.fundMinDeals + '+ deals also '
      + 'stops being priced like a single company.</p>'
      + '<table><tr><th class="l">Deal</th><th class="l">Sleeve</th><th>Deals</th><th>Commitment</th>'
      + '<th>Uncalled</th><th>Preferred return</th><th>Sponsor MOIC</th><th>Exit multiple</th><th>Exit</th></tr>'
      + book.slice().sort((p, q) => p.name.localeCompare(q.name, 'en', { sensitivity: 'base' }))
        .map((b) => '<tr><td class="l">' + esc(b.name) + '</td>'
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
    h += '<div class="card"><h2>Cash flow by year</h2>'
      + '<p class="note">Each year is ranked on its own across the simulated futures, so the future sitting in '
      + 'the middle in one year is a <b>different</b> future from the middle one in another. '
      + '<span class="warn">This table cannot be added down.</span> Stacking the good-run column gives '
      + money(T.stackedP90) + ' against a real lifetime figure of ' + money(T.p90) + '. Use it to find the thin '
      + 'years, then use the next panel to plan.</p>'
      + '<table><tr><th class="l">Year</th><th>Preferred return</th><th>Capital calls</th>'
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
    h += '<div class="card"><h2>Cumulative cash received</h2>'
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

    /* the same rows, as a shape */
    if (cumRows.length > 1) {
      const raw = MODE === 'venture' ? '#7B5EA7' : MODE === 'income' ? '#B17930' : '#2E6B52';
      const be = (key) => {
        const hit = cumRows.find((r) => r[key] >= T.committed);
        return hit ? hit.year : null;
      };
      const beMid = be('p50'), beGood = be('p90'), beBad = be('p10');
      const says = beMid
        ? 'The median crosses it in <b>' + beMid + '</b>'
        : 'The median never crosses it inside the calendar';
      const edges = beGood
        ? ', a good run in ' + beGood + (beBad ? ' and a bad one in ' + beBad : ' and a bad run not at all')
        : '';
      h += '<div class="card"><h2>The cone of outcomes</h2>'
        + '<p class="note">The table above, drawn. The shaded band runs from a bad future to a good '
        + 'one, with the typical future as the line through it. The band widens over time because '
        + 'less is settled in the early years. The dashed line marks the return of your capital.</p>'
        + coneChart(cumRows, T.committed, raw)
        + '<p class="note" style="margin-top:10px">' + says + edges + '. Read the band as a range of '
        + 'whole futures rather than a range for that year on its own: each simulated future was '
        + 'totalled first and the totals ranked once, so the bottom edge is one coherent bad run '
        + 'rather than a bad year stitched to a bad year.</p></div>';
    }

    /* lifetime */
    const line = (lbl, v, bold) => {
      const profit = v - T.committed;
      return '<tr><td class="l' + (bold ? ' b' : '') + '">' + lbl + '</td>'
        + '<td class="' + (bold ? 'b' : '') + '">' + money(v) + '</td>'
        + '<td class="' + (profit < 0 ? 'neg' : (bold ? 'b' : '')) + '">' + money(profit) + '</td>'
        + '<td class="' + (bold ? 'b' : '') + '">' + mult(v / T.committed) + '</td></tr>';
    };
    h += irrCard(st, book);

    h += '<div class="card"><h2>Lifetime returns</h2>'
      + '<p class="note">Profit is measured against the <b>full ' + money(T.committed) + ' committed</b>, not '
      + 'against the uncalled balance. Netting only what is left to fund ignores the ' + money(T.funded)
      + ' already in, and makes a thin result look healthy. <b>Read the median, not the average.</b> One '
      + 'outsized winner drags the average above what most futures deliver, so the average describes a book you '
      + 'do not own. You get one draw.'
      + (T.coupon > 0 ? ' <b>' + money(T.coupon) + ' of the Typical row is preferred return</b> '
        + '\u2014 rent-like payments your sponsors are contracted to make while you wait, rather '
        + 'than money from selling anything. Your documents promise '
        + money(T.couponScheduled) + ' of it. <b>The tool does not assume all of that arrives.</b> '
        + 'A sponsor who is not earning can suspend a preferred return, and the fund most likely '
        + 'to suspend one is the fund that also hands back less than plan \u2014 so the two move '
        + 'together here rather than independently. In a bad run this book collects '
        + money(T.couponP10) + '.' : '')
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

  /* THE CONE.
     The table above is exact and unreadable at a glance: seventeen rows of three columns,
     and the thing you actually want from it -- how fast the spread between a bad future and
     a good one opens up -- is a shape, not a number. Drawn from the SAME cumulative rows the
     table prints, so the two can never disagree; the band is the 10th to 90th percentile and
     the line through it is the median. Inline SVG, so there is no chart library to load.

     These are cumulative percentiles, which is the only kind that may be read down a column:
     each simulated future is totalled first and the totals are ranked once. So the bad edge
     is one coherent bad future, not a bad year stitched to a bad year. */
  /* An IRR, or an honest word instead of one. The three cases that are NOT a number all
     have to read differently: nothing invested is unanswerable, losing everything is -100%
     and not 0%, and a return faster than the solver's bracket is a bound rather than a
     figure. Printing 0% for any of them would be the worst error this panel could make. */
  function rate(v) {
    if (v == null) return '<span class="muted">n/a</span>';
    if (v <= -0.9999) return '<span class="neg">\u2212100%</span>';
    if (v >= 9.999) return '&gt;1000%';
    const t = (100 * v).toFixed(1) + '%';
    return v < 0 ? '<span class="neg">\u2212' + t.replace('-', '') + '</span>' : t;
  }

  function irrCard(st, book) {
    const R = st.irr;
    if (!R) return '';
    const band = (b) => '<td>' + rate(b.p10) + '</td><td class="b">' + rate(b.p50)
      + '</td><td>' + rate(b.p90) + '</td>';

    let h = '<div class="card"><h2>Annual rate of return</h2>';

    /* Say what the reader is looking at BEFORE the table. Two caveats matter more than any
       figure in it, and a reader who meets them afterwards has already drawn a conclusion. */
    h += '<p class="note"><b>Every figure here is a yearly rate.</b> 12% means the money grew '
      + 'at 12% a year, compounding, over the life of the position \u2014 not 12% in total. '
      + 'It is worked out the standard way a sponsor or a fund does it: the rate at which the '
      + 'deal\u2019s actual cash flows balance. <b>Nothing is assumed about what you do with '
      + 'money once it comes back to you.</b></p>';
    h += '<p class="note"><b>This counts cash, not marks.</b> Every dollar in these figures is '
      + 'money actually returned, so they will read lower than an IRR a sponsor reports \u2014 '
      + 'theirs includes what a position is currently carried at. Neither is wrong; they are '
      + 'answering different questions. <b>And a portfolio IRR is not the average of its '
      + 'deals\u2019.</b> IRR is not additive. Every figure below pools the underlying cash '
      + 'flows and solves once, which is why the book\u2019s number can sit well above the '
      + 'typical deal inside it.</p>';

    /* Commitment-weighted, because a $250,000 ten-year position says more about how long
       the sleeve is tied up than a $5,000 four-year one does. */
    const avgHold = (kind) => {
      const rows = book.filter((b) => !kind || b.kind === kind);
      const c = rows.reduce((a, b) => a + b.commitment, 0);
      return c > 0 ? rows.reduce((a, b) => a + b.hold * b.commitment, 0) / c : 0;
    };
    h += '<table><thead><tr><th class="l">Book</th><th>Typical hold</th><th>Bad run</th>'
      + '<th>Typical</th><th>Good run</th></tr></thead><tbody>';
    const CLS = [['income', 'Income sleeves'], ['venture', 'Venture']];
    for (const [k, lbl] of CLS) {
      if (R.byClass[k]) {
        h += '<tr><td class="l">' + lbl + '</td>'
          + '<td>' + avgHold(k).toFixed(1) + ' yrs</td>' + band(R.byClass[k]) + '</tr>';
      }
    }
    h += '<tr><td class="l b">Whole book</td><td class="b">' + avgHold(null).toFixed(1)
      + ' yrs</td>' + band(R.portfolio) + '</tr>';
    h += '</tbody></table>';

    /* The diversification result, which is the most useful thing this panel produces and is
       invisible unless the two rows are read against each other. Stated only when it is
       actually true of the book in front of the reader. */
    const solo = R.byDeal.filter((d) => d.kind === 'venture' && d.lossShare > 0.2);
    if (R.byClass.venture && solo.length > 2) {
      const med = solo.map((d) => d.p50).sort((a, b) => a - b)[Math.floor(solo.length / 2)];
      if (R.byClass.venture.p50 > med + 0.02) {
        h += '<p class="note"><b>Compare the two venture rows.</b> Taken one at a time, the '
          + 'typical single venture deal in this book returns ' + rate(med) + '. Held together as '
          + 'a sleeve of ' + solo.length + ', the typical outcome is '
          + rate(R.byClass.venture.p50) + '. The deals are identical in both cases; only the '
          + 'number of them differs.</p>';
      }
    }

    h += '<p class="note">Read this as a <b>range</b>, not a prediction. Out of 100 possible '
      + 'futures, about 10 come out worse than the Bad run column and about 10 come out better '
      + 'than the Good run column. The other 80 land somewhere in between.</p>';

    /* The first question anyone asks of this table, and it deserves a straight answer rather
       than being left to look like an error. Three causes, and only the third is arguable. */
    if (R.byClass.income && R.byClass.venture) {
      h += '<p class="note"><b>Why the income sleeves come out ahead of venture here, and why '
        + 'that is not a mistake.</b> Three separate reasons:<br>'
        + '<b>1. Money back sooner is worth more, and a yearly rate is built to say so.</b> Two '
        + 'deals that both return 2.26x over the same seven years score 16.8% and 12.4% if one '
        + 'pays you along the way and the other pays only at the end. Same total, same horizon. '
        + 'Venture ties your capital up for the whole hold; an income sleeve gives it back '
        + 'progressively and you have it to use.<br>'
        + '<b>2. The odds are genuinely different.</b> A single venture deal is modelled with a '
        + '30% chance of returning nothing at all and a typical outcome of just your money back. '
        + 'An income sleeve carries a 5% chance of a write-off. That is not a thumb on the '
        + 'scale, it is what the two asset classes do.<br>'
        + '<b>3. A preferred return is contractual and an exit is not.</b> One is a promise a '
        + 'sponsor has to try to keep; the other is a hope. This tool now models a preferred '
        + 'return that can fall short \u2014 see the note under the lifetime table \u2014 but '
        + 'even impaired it is a firmer claim than an exit multiple.<br>'
        + 'The honest summary: venture is where the big outcomes live, and you can see that in '
        + 'the Good run column of the by-deal table. It is a worse place to look for a '
        + '<i>rate</i>, because a rate punishes waiting.</p>';

      /* The follow-up question, which is a good one: is venture only behind because it is
         held longer? Partly. The Typical hold column is there so the reader can see the
         gap, and this says how much of the difference it accounts for. */
      h += '<p class="note"><b>Is venture only behind because it is held longer?</b> Partly, '
        + 'and the Typical hold column above is there so you can see the gap. <b>A yearly rate '
        + 'already divides by the years</b> \u2014 that is what makes a four-year deal and a '
        + 'ten-year deal comparable at all \u2014 so there is nothing further to adjust for. '
        + 'But dividing by more years is a real hurdle. On this book, holding the venture '
        + 'positions for five years instead of their actual 8 to 10 would lift the sleeve from '
        + '7.2% to 13.8% a year, and its good run from 15% to 45%. So <b>most of the good-run '
        + 'gap is the waiting</b>, and venture would win that column outright on equal terms.<br>'
        + '<b>What the waiting does not explain is the middle.</b> Even shortened to five '
        + 'years, venture\u2019s typical outcome still sits below the income sleeves, because '
        + 'the typical single venture deal returns <b>exactly your money back</b> \u2014 and '
        + '1.0x is 0% a year whether it takes four years or twenty. Duration cannot rescue a '
        + 'multiple of one. Put the other way round: to match the income sleeves\u2019 18% a '
        + 'year, a venture deal needs <b>2.3x over five years, or 5.3x over ten</b>. That is '
        + 'the real cost of the long hold, and it is why venture has to aim so high.</p>';
    }

    h += '<h3>By deal</h3>';
    h += '<p class="note"><b>Three columns, three different questions.</b><br>'
      + '<b>Sponsor case</b> is their own multiple turned into a yearly rate. Rorra at 4.3x '
      + 'over four years is 44% a year, because 4.3x IS 44% compounded four times. It is what '
      + 'the sponsor is claiming, not a prediction.<br>'
      + '<b>Typical</b> is what this tool expects once the chance of failure is counted. For a '
      + 'single deal the gap is usually huge, because a sponsor\u2019s number only happens in '
      + 'the best one outcome in ten.<br>'
      + '<b>Chance of losing it all</b> is the odds, not an amount. 31% means that in 31 of '
      + 'every 100 futures that deal pays back nothing at all. It is a positive number because '
      + 'it counts how often, not how much.</p>';
    h += '<table><thead><tr><th class="l">Deal</th><th>Hold</th><th>Sponsor MOIC</th>'
      + '<th>Sponsor case</th><th>Typical</th><th>Good run</th>'
      + '<th>Chance of losing it all</th></tr></thead><tbody>';
    for (const d of R.byDeal.slice().sort((a, b) => (b.sponsorCase || -9) - (a.sponsorCase || -9))) {
      h += '<tr><td class="l">' + esc(d.name) + '</td>'
        + '<td>' + d.hold + ' yrs</td>'
        + '<td>' + mult(d.sponsorMoic) + '</td>'
        + '<td>' + rate(d.sponsorCase) + '</td>'
        + '<td class="b">' + rate(d.p50) + '</td>'
        + '<td>' + rate(d.p90) + '</td>'
        + '<td>' + (d.lossShare > 0.005 ? Math.round(100 * d.lossShare) + '%'
          : '<span class="muted">\u2014</span>') + '</td></tr>';
    }
    h += '</tbody></table>';

    /* The paper track. Shown only when the holder has actually marked something up, and
       separated from everything above by saying plainly that it is not in any of it. */
    const P = R.paper;
    if (P && P.marked > 0) {
      h += '<h3>What you believe it is worth now</h3>';
      h += '<p class="note"><b>None of this is in any figure above, and none of it is cash.</b> '
        + 'You have marked up ' + P.marked + ' of ' + P.positions + ' position'
        + (P.positions === 1 ? '' : 's') + '. A markup records a valuation you have been told '
        + 'about; it is not a liquidity event, it cannot be spent, and a private mark is set by '
        + 'the person holding the asset and is rarely revised downward. It is here because '
        + 'waiting five to seven years with no signal at all is worse.</p>';
      h += '<table><tbody>'
        + '<tr><td class="l">Cost basis, funded to date</td><td>' + money(P.cost) + '</td></tr>'
        + '<tr><td class="l">Marked-up value</td><td>' + money(P.nav) + '</td></tr>'
        + '<tr><td class="l b">Paper gain</td><td class="' + (P.gain < 0 ? 'neg' : 'b') + '">'
        + money(P.gain) + '</td></tr>'
        + '<tr><td class="l">On paper</td><td>' + mult(P.multiple) + '</td></tr>'
        + '</tbody></table>';
    }

    h += '</div>';
    return h;
  }

  function coneChart(rows, committed, raw) {
    const W = 880, H = 320, L = 70, R = 104, T = 22, B = 48;
    const iw = W - L - R, ih = H - T - B;
    const y0 = rows[0].year, y1 = rows[rows.length - 1].year;
    const span = Math.max(1, y1 - y0);
    /* Round gridlines. Scaling the tallest value by 1.08 and quartering it gives ticks at
       $456k and $913k, which are numbers nobody thinks in. Snap the step to 1, 2, 2.5 or 5
       times a power of ten and let the top of the axis follow from it. */
    const want = Math.max(rows[rows.length - 1].p90, committed) * 1.08;
    const mag = Math.pow(10, Math.floor(Math.log10(want / 4)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v * 4 >= want) || mag * 10;
    const ticks = Math.ceil(want / step);
    const top = step * ticks;
    const X = (yr) => L + iw * ((yr - y0) / span);
    const Y = (v) => T + ih - (v / top) * ih;
    /* A 2,500 step printed as "$3k" while the gridline sat at 2,500, which is a chart
       lying about its own axis. One decimal where the number needs it, none where it does
       not. */
    const shortMoney = (v) => (
      v >= 1e6 ? '$' + (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1) + 'M'
      : v >= 1e3 ? '$' + (v / 1e3).toFixed(v < 1e4 && v % 1e3 !== 0 ? 1 : 0) + 'k'
      : '$' + Math.round(v));

    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" '
      + 'role="img" aria-label="Cumulative proceeds by year, 10th to 90th percentile band">';

    for (let g = 0; g <= ticks; g++) {
      const gv = step * g, gy = Y(gv);
      s += '<line x1="' + L + '" y1="' + gy + '" x2="' + (L + iw) + '" y2="' + gy + '" stroke="#EDF1F6"/>'
        + '<text x="' + (L - 8) + '" y="' + (gy + 3.5) + '" text-anchor="end" font-size="10" '
        + 'fill="#6B7A8C">' + shortMoney(gv) + '</text>';
    }

    const every = span > 12 ? 2 : 1;
    rows.forEach((r, i) => {
      if (i % every && i !== rows.length - 1) return;
      s += '<text x="' + X(r.year) + '" y="' + (H - 26) + '" text-anchor="middle" font-size="10" '
        + 'fill="#6B7A8C">' + r.year + '</text>';
    });

    /* the band: out along the good edge, back along the bad one */
    let d = 'M' + X(rows[0].year) + ' ' + Y(rows[0].p90);
    rows.forEach((r) => { d += ' L' + X(r.year) + ' ' + Y(r.p90); });
    for (let i = rows.length - 1; i >= 0; i--) d += ' L' + X(rows[i].year) + ' ' + Y(rows[i].p10);
    s += '<path d="' + d + ' Z" fill="' + raw + '" opacity="0.13"/>';

    const line = (key, w, op, dash) => {
      let q = '';
      rows.forEach((r, i) => { q += (i ? ' L' : 'M') + X(r.year) + ' ' + Y(r[key]); });
      return '<path d="' + q + '" fill="none" stroke="' + raw + '" stroke-width="' + w
        + '" opacity="' + op + '" stroke-linejoin="round" stroke-linecap="round"'
        + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>';
    };
    s += line('p90', 1.6, 0.55) + line('p10', 1.6, 0.55) + line('p50', 2.4, 1);

    /* money back, which is the line the cone has to clear before any of this is a return */
    const cy = Y(committed);
    s += '<line x1="' + L + '" y1="' + cy + '" x2="' + (L + iw) + '" y2="' + cy
      + '" stroke="#141A22" stroke-width="1.5" stroke-dasharray="4,3"/>'
      + '<text x="' + (L + 6) + '" y="' + (cy - 6) + '" font-size="11" font-weight="700" '
      + 'fill="#141A22">money back &middot; ' + shortMoney(committed) + '</text>';

    /* direct labels at the open end, so the three edges are never colour-alone */
    const last = rows[rows.length - 1];
    const lab = [['Good run', last.p90], ['Typical', last.p50], ['Bad run', last.p10]];
    let prevY = -99;
    lab.forEach(([txt, v]) => {
      let ly = Y(v) + 3.5;
      if (ly - prevY < 26) ly = prevY + 26;
      prevY = ly;
      s += '<circle cx="' + X(last.year) + '" cy="' + Y(v) + '" r="3.6" fill="' + raw + '"/>'
        + '<text x="' + (L + iw + 8) + '" y="' + (ly - 6) + '" font-size="10" fill="#6B7A8C">'
        + txt + '</text>'
        + '<text x="' + (L + iw + 8) + '" y="' + (ly + 6) + '" font-size="12" font-weight="700" '
        + 'fill="' + raw + '">' + shortMoney(v) + '</text>';
    });

    /* a hit target per year, wider than the marks */
    rows.forEach((r, i) => {
      const x = X(r.year), w = iw / Math.max(1, rows.length - 1);
      s += '<rect x="' + (x - w / 2) + '" y="' + T + '" width="' + w + '" height="' + ih
        + '" fill="transparent"><title>' + esc('By end of ' + r.year + '\n'
          + 'Good run   ' + money(r.p90) + '\n'
          + 'Typical    ' + money(r.p50) + '\n'
          + 'Bad run    ' + money(r.p10)) + '</title></rect>';
    });

    s += '<text x="' + L + '" y="' + (H - 8) + '" font-size="10" fill="#6B7A8C">'
      + 'total cash returned by the end of that year</text></svg>';

    const key = [['Bad run (10th pct)', 0.55], ['Typical (median)', 1], ['Good run (90th pct)', 0.55]];
    return s + '<div class="row" style="margin:8px 0 0">'
      + key.map(([t, op]) => '<span style="display:flex;align-items:center;gap:6px;font-size:12px;'
        + 'color:#6B7A8C"><span style="width:11px;height:3px;border-radius:2px;background:' + raw
        + ';opacity:' + op + '"></span>' + t + '</span>').join('') + '</div>';
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
    /* Gridlines derived from the range rather than fixed at six half-steps, so the axis
       cannot silently disagree with the data when the range changes. */
    const gstep = HI > 3.5 ? 1.0 : 0.5, gcount = Math.round(HI / gstep);
    for (let g = 0; g <= gcount; g++) {
      const gm = g * gstep, gx = X(gm);
      s += '<line x1="' + gx + '" y1="' + T + '" x2="' + gx + '" y2="' + (T + ih) + '" stroke="#EDF1F6"/>'
        + '<text x="' + gx + '" y="' + (H - 26) + '" text-anchor="middle" font-size="10" fill="#6B7A8C">'
        + gm.toFixed(1) + 'x' + (g === gcount ? '+' : '') + '</text>';
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
      ['Typical', 'The tool plays your book out 6,000 times. Line those futures up from worst to best '
        + 'and this is the one in the middle. If a year shows $0, it means more than half the time nothing '
        + 'arrives that year at all. Use this rather than the average: one big winner pulls an average up '
        + 'above what most futures actually pay you, and you only get one future.'],
      ['Odds of any cash', 'How often that year pays anything at all. It is here instead of a bad-run column, '
        + 'which on a book like this reads $0 in every single year and tells you nothing.'],
      ['Good run', 'Out of 100 futures, only 10 do better than this in that year. Big numbers here are real: '
        + 'several deals can happen to land in the same year.'],
      ['Why you cannot add the year-by-year column down', 'The two tables count differently, and this is the '
        + 'one thing worth getting right. In the year-by-year table each year is ranked on its own, so the '
        + 'good run in 2030 and the good run in 2034 are different futures. Adding them builds a future '
        + 'nobody had. On a real book that overstated the lifetime figure by 69%. The by-the-end-of-year '
        + 'table adds each future up FIRST and ranks once, so every number there is a real total that one '
        + 'real future reached. That one you can read straight down.'],
      ['Why a preferred return is taken out of the exit', 'When a sponsor quotes a multiple, that '
        + 'number already includes the preferred return they pay you along the way. So if the tool paid you '
        + 'the preferred return AND then sold at the full multiple, it would be paying you the same money '
        + 'twice. The exit here is the multiple with those payments taken back out.'],
      ['A fund is not a big deal', 'Two separate things. WHEN it pays: a fund sells down over several years '
        + 'instead of exiting on a date, so its proceeds are spread across a window. Anything paying a preferred return '
        + 'is treated as a fund, because most vehicles that pay one are funds; put 1 in the deals column to say '
        + 'a position is a single company and it exits on one date instead. HOW MUCH it returns: a venture fund '
        + 'holding ' + Engine.CFG.fundMinDeals + '+ companies gets its own outcome table, because the '
        + 'single-deal power law carries a 30% chance of returning zero and a fund that size cannot do that.'],
      ['Liquidity window', 'When a fund actually sells down, in years from when you funded it. That is not the '
        + 'same as its stated life, because a fund can finish paying out and wind up afterwards. If a sponsor '
        + 'has told you "years five through eight", put 5 and 8 in the two liquidity columns. Left blank it '
        + 'runs over the back 40% of the hold, which is roughly what most sponsors describe anyway.'],
      ['What a yearly return means here',
        'A multiple tells you how much came back. A yearly return tells you how fast. If you '
        + 'put in $100 and got $226 back after seven years, the multiple is 2.26x and the '
        + 'yearly return is about 12%: $100 growing at 12% a year for seven years lands at $226. '
        + 'It is worked out from the actual dates money moved, the same way a sponsor works out '
        + 'the figure in their own documents. Nothing is assumed about what you do with the cash '
        + 'once it is back in your hands.'],
      ['Why two deals with the same multiple can have very different yearly returns',
        'Because a yearly return counts the waiting. Telly is modelled at 5.0x over ten years '
        + 'and Rorra at 4.3x over four. Rorra has the smaller multiple and roughly three times '
        + 'the yearly return, because your money is only tied up for four years and then you '
        + 'have it back to do something else with. If you care about total dollars, read the '
        + 'multiple. If you care about how hard your money is working while it sits there, read '
        + 'the yearly return. They answer different questions and they will often disagree.'],
      ['Sponsor case, and why it is usually far above Typical',
        'Sponsor case is the sponsor\u2019s own target multiple, expressed as a yearly rate. '
        + 'Typical is what this tool expects once the chance of things going wrong is counted. '
        + 'The gap is not the tool calling anyone dishonest. It is that a sponsor\u2019s number '
        + 'is what happens if the plan works, and the tool puts that outcome in the best one in '
        + 'ten. The other nine futures are what makes Typical lower.'],
      ['Chance of losing it all',
        'The odds, not an amount. 31% means that in 31 of every 100 simulated futures, that deal '
        + 'pays back nothing at all. It is a positive number because it counts how OFTEN, not '
        + 'how much. A single early-stage company really does fail about a third of the time; a '
        + 'fund holding twenty of them essentially never goes to zero, which is why funds and '
        + 'single deals are priced differently here.'],
      ['Committed, funded, and still callable',
        'Committed is what you signed up for. Funded is what has actually left your account. '
        + 'Still callable is the difference, and it is a binding obligation, not an option \u2014 '
        + 'the sponsor can ask for it and you have to pay. It matters for planning, because a '
        + 'capital call landing in a year with no incoming cash is the most useful thing this '
        + 'calendar can show you. Every return figure here is measured against the FULL '
        + 'commitment, not just what you have paid in so far, because by the time a deal exits '
        + 'the whole commitment will have been called.'],
      ['A preferred return is not guaranteed, and the tool no longer pretends it is',
        'Until v1.17 the model paid every preferred return in full in every single future, which '
        + 'made the income sleeves look steadier than they are. It does not any more. How much '
        + 'arrives is tied to how the deal turned out, using the SAME draw as the exit rather '
        + 'than a separate one \u2014 because the fund that hands back less than plan is the same '
        + 'fund that stopped paying. A position that writes off its equity pays about a quarter '
        + 'of its scheduled preferred return; one that lands well below plan pays about 70%; '
        + 'one near plan pays about 90%. Those shares are judgements, not findings, and they are '
        + 'in one place in the code so they can be argued with.'],
      ['What this still assumes', 'That deals fail independently of one another. That is '
        + 'optimistic: in a real downturn outcomes move together, which would make the blended '
        + 'picture less flattering than it looks here. It is the biggest remaining hole in the '
        + 'model and it is a harder one to fix honestly.'],
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
  let LASTMAP = null;      // the header map from the sheet just read, for the age note

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
    const age = ageNote(LASTMAP);
    $('#intakeErr').innerHTML = age + (problems.length
      ? '<div class="err"><b>Loaded ' + BOOK.length + ' positions, with ' + problems.length
        + ' thing' + (problems.length > 1 ? 's' : '') + ' worth fixing.</b> Nothing was guessed at; these rows '
        + 'are running on whatever was there.<br>' + problems.slice(0, 8).map(esc).join('<br>') + '</div>'
      : '');
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
