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
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const DASH = '—';

  let BOOK = null;          // every position
  let MODE = 'all';         // which book the panels describe
  let DIST = 'all';         // which curve is in front on the chart

  /* ── reading the tracker ─────────────────────────────────────────────────
     Headers are matched loosely, because nobody keeps a spreadsheet to someone
     else's column names. Anything genuinely missing is REPORTED rather than
     guessed at: an invented input is how these models quietly become fiction. */
  const FIELDS = [
    // deliberately FIRST, and deliberately multi-word. A bare 'deals' would be matched
    // by the 'deal' prefix under 'name' and swallow the deal-name column.
    ['deals',       ['deals in fund', 'underlying deals', 'number of deals',
                     'portfolio companies', 'positions in fund', 'deal count']],
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

  function render() {
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
      + 'while also counting the coupon would count that cash twice. A position holding more than one '
      + 'underlying deal is a <b>fund</b>, and a fund does not exit on a single date, so its proceeds are '
      + 'spread over the years around its exit rather than dropped into one. A venture fund holding '
      + Engine.CFG.fundMinDeals + '+ deals also stops being priced like a single company.</p>'
      + '<table><tr><th class="l">Deal</th><th class="l">Sleeve</th><th>Deals</th><th>Commitment</th>'
      + '<th>Uncalled</th><th>Coupon</th><th>Sponsor MOIC</th><th>Exit multiple</th><th>Exit</th></tr>'
      + book.map((b) => '<tr><td class="l">' + esc(b.name) + '</td>'
        + '<td class="l" style="color:' + (b.kind === 'venture' ? '#7B5EA7' : '#B17930') + '">'
        + (b.kind === 'venture' ? 'Venture' : esc(b.cls)) + '</td>'
        + '<td class="' + (b.isFund ? 'b' : 'z') + '">' + (b.isFund ? b.deals : '1') + '</td>'
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
    $('#out').innerHTML = h;
    $('#out').classList.remove('hidden');
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

    series.forEach((sr, k) => {
      const on = sr.key === active, t = sr.st.totals;
      const mx = X(t.p50 / t.committed);
      s += '<circle cx="' + mx + '" cy="' + (T + ih + 1) + '" r="' + (on ? 5 : 3.2) + '" fill="' + sr.raw
        + '" opacity="' + (on ? 1 : 0.5) + '"/>'
        + '<text x="' + mx + '" y="' + (T + ih - 7 - k * 13) + '" text-anchor="middle" font-size="10" '
        + 'font-weight="700" fill="' + sr.raw + '" opacity="' + (on ? 1 : 0.55) + '">'
        + mult(t.p50 / t.committed) + '</text>';
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
      ['A fund is not a big deal', 'Say how many underlying deals a position holds and it stops being treated '
        + 'as one. Funds sell down over several years rather than exiting on a date, so their proceeds are '
        + 'spread across the years around the exit. A venture fund holding ' + Engine.CFG.fundMinDeals + '+ '
        + 'companies also gets its own outcome table, because the single-deal power law carries a 30% chance '
        + 'of returning zero and a fund that size cannot do that. Leave the column blank and the position is '
        + 'treated as a single deal, which is the cautious reading.'],
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
  function load(rows, skipped) {
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
    MODE = 'all'; DIST = 'all';
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
