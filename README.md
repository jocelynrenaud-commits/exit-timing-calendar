# Exit Timing Calendar

Turn a private-markets tracker into a year-by-year picture of when cash might actually
arrive. It will not give you a predicted exit date, because nobody has one.

**It runs entirely in your browser.** Your spreadsheet is read in the page and never
uploaded anywhere. There is no backend, no account and no analytics. Once the page has
loaded you can turn off your wifi and it still works.

---

## Use it

1. Open the site.
2. Click **Run the example book** to see it work on a real thirteen-position portfolio.
3. Fill in `tracker-template.xlsx` with your own deals and drop it on the page.

Nothing is installed and nothing is saved.

## What your tracker needs

One row per position. Column headers are matched loosely, so your own naming will
probably work as-is.

| Column | What it is |
|---|---|
| Deal name | Anything you recognise |
| Commitment | The **full** amount you signed up for |
| Funded to date | Cash actually in so far |
| Uncalled | What is still callable. Left blank, it is worked out for you |
| Year funded | The year you first funded it |
| Hold (yrs) | Stated fund life or hold period |
| Coupon % | Preferred return or credit coupon. Blank for venture |
| Sponsor MOIC | The multiple the sponsor projects |

Anything missing is **reported, never guessed at**. An invented input is how these
models quietly become fiction.

## What it gives you back

**The shape of the book.** The whole distribution rather than three percentiles, because
shape is where the argument lives. Toggle between venture, income sleeves and blended.

**What happens IN each year.** Coupon, capital calls, the typical year, the odds of any
cash, and a good run. Most years come back empty, because each deal exits exactly once.
**This table cannot be added down**, and the page says so where you would try it.

**How much has arrived BY each year.** The planning view, and the one that is safe to read
down. Its last row ties exactly to the lifetime totals, which the page checks on every
render.

**Lifetime totals.** Bad run, typical, average and good run, with profit measured against
the full commitment rather than the uncalled balance.

## Three rules it enforces, each learned the hard way

**Commitment, not funded.** Exit proceeds run off the full commitment, because the whole
commitment is called long before any exit lands. Using funded-to-date understated one real
book by 48%.

**A coupon is already inside the multiple.** A sponsor MOIC is total distributions over
invested capital, so a preferred return paid along the way is part of it. Showing the
coupon separately *and* exiting at the full multiple counts that cash twice, which
inflated the same book by about 14%. Coupon-payers exit on the residual.

**Two kinds of percentile.** Per-year percentiles rank each year separately and cannot be
added. Cumulative percentiles add each future up first and rank once, so they can. Same
word, opposite behaviour. Stacking a per-year 90th percentile column overstated one book's
lifetime figure by 69%.

## What it assumes

The outcome splits are the biggest lever. Venture uses 30% to zero, 30% back to roughly
even, 30% modest, and 10% at the sponsor's multiple. Income sleeves use a much tighter
5 / 25 / 55 / 15 on the exit. Exit timing is skewed late, because exits slip and nothing
makes them early.

Two assumptions are optimistic and worth knowing. **The coupon always pays** — a sponsor
can suspend a preferred return. And **deals fail independently** — in a real downturn
outcomes move together, which would make the blended picture less flattering than it looks.

Not advice. Argue with the numbers.

---

## Publish it

It is a static site, so GitHub Pages hosts it for nothing. No git and no command line
needed: the browser upload works fine.

**In a browser**

1. Sign in at github.com, click **+** top right, then **New repository**.
2. Name it `exit-timing-calendar`, leave it **Public**, and do NOT tick "Add a README".
   Click **Create repository**.
3. On the empty repo page click **uploading an existing file**.
4. Drag in `index.html`, `engine.js`, `app.js`, `example-book.json`,
   `tracker-template.xlsx` and `README.md`, then click **Commit changes**.
5. Click **Add file → Upload files** again, and this time drag the whole `resources`
   folder in. Dragging a folder keeps its name, which the links rely on.

**Or with git**

```bash
git init
git add .
git commit -m "Exit Timing Calendar"
git branch -M main
git remote add origin https://github.com/<you>/exit-timing-calendar.git
git push -u origin main
```

Then **Settings → Pages → Source: deploy from a branch → main / (root)**. It will be live
at `https://<you>.github.io/exit-timing-calendar/` in a minute or two.

Pick **/ (root)**, not **/docs**. GitHub offers a `/docs` folder as a publishing source and
this repository has no such folder on purpose, precisely so that option cannot be chosen by
accident. The extra material lives in `resources/`.

To run it locally instead, any static server works:

```bash
python -m http.server 8080
```

`file://` will not work, because the browser blocks `fetch` for the example book.

## What is in here

| File | |
|---|---|
| `index.html` | The page |
| `engine.js` | The simulation. No dependencies |
| `app.js` | Reading the tracker, and the panels |
| `tracker-template.xlsx` | The input sheet, pre-filled with a worked example |
| `example-book.json` | What the demo button loads |
| `resources/` | The AI system prompt, its guide, and the Claude skill files |

The only external dependency is SheetJS, loaded from a CDN to read `.xlsx`. Everything
else is in this repository.
