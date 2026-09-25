# Performance Monitoring Team (PMT) Calendar

An interactive web calendar for the **Performance Monitoring Team of Baliwag
Water District** — the Strategic Performance Management System (SPMS) cycle
shown four ways: a month grid, a Gantt timeline, an agenda and a sortable
table.

<p align="center">
  <img src="assets/img/bwd-logo.png" alt="Baliwag Water District seal" width="110">
</p>

## What it does

| View | What it is for |
| --- | --- |
| **Month** | The familiar calendar grid. Multi-day activities run as continuous bars across the weeks, packed into lanes so nothing overlaps. |
| **Timeline** | A Gantt chart of the whole cycle. Activities are grouped into SPMS stages (or by responsible unit), with a today line, elapsed-time shading on running activities, and four zoom levels from *Fit all* down to day resolution. |
| **Agenda** | A chronological list grouped by month, with the responsible units and the expected output of each activity. Two sub-tabs: **Active** (in progress and upcoming, the default) and **Completed**. The activity running today is tinted so it reads ahead of the rest. This is what a phone opens on, since a month grid is unreadable at that width. |
| **Table** | Every field in a sortable, printable table — also the accessible fallback for the two visual views. |

Across all of them:

- **Pick a year.** The cycle runs across two calendar years, so the toolbar
  opens on the current one rather than dumping all 14 months at once. Choose the
  other year, or *Whole cycle*, from the dropdown. In the month grid the same
  dropdown jumps years, and it follows you as you page through the months.
- **Filter** by SPMS stage (the legend doubles as the filter), by responsible
  unit, and by status (running / upcoming / completed).
- **Open any activity** for its schedule, duration, responsible units, expected
  output, agenda notes, and one-click *Add to Google Calendar* or `.ics`
  download.
- **Refresh** re-reads the published schedule without reloading the page, and
  says what changed — or that nothing did. See
  [Refreshing the schedule](#refreshing-the-schedule) for what it can and
  cannot reach.
- **Add any activity to your own calendar** from its detail panel, as a Google
  Calendar link or an `.ics` download.
- **Share a link.** The view, month, zoom, grouping and every filter live in the
  URL hash, so `#view=timeline&zoom=weeks&cat=targets` is a bookmarkable link.
- **Install it** on a phone, tablet or desktop and use it offline — see
  [Installing it](#installing-it).
- **One light theme.** The site renders light whatever the device is set to;
  there is no dark mode and no theme switch.
- **Keyboard shortcuts** and a layout that works from phone width upward.
- **The page tracks the window.** Content runs to the full width of the screen,
  with a gutter that grows with the viewport, and only stops widening past
  2280px where a full-bleed row stops being readable. A short month leaves the
  footer pinned to the bottom of the window rather than stranded mid-screen.
- **On a phone**, swipe the month grid left or right to change month; the arrows
  and the year dropdown sit at the top of the toolbar, within thumb reach.

### Keyboard

| Key | Action |
| --- | --- |
| <kbd>1</kbd> … <kbd>4</kbd> | Month / Timeline / Agenda / Table |
| <kbd>←</kbd> <kbd>→</kbd> | Previous / next month |
| <kbd>T</kbd> | Jump to today |
| <kbd>Esc</kbd> | Close the activity panel |

## Installing it

The site is a progressive web app, so it installs from the browser on every
platform without an app store.

A first-time visitor is offered it once, in a dialog at the centre of the
screen. **It never appears to someone already running the installed app** —
`display-mode: standalone` and `navigator.standalone` are both checked before
any of the install code runs. Dismissing it is remembered for 30 days, and the
**Install** button stays in the header either way.

What the dialog offers depends on the device:

| Platform | What the dialog does |
| --- | --- |
| **Android** (Chrome, Edge, Samsung Internet) | A real **Install** button, wired to the browser's own prompt |
| **Windows / ChromeOS** (Chrome, Edge) | The same **Install** button |
| **Android** (Firefox) | No install API, so it shows the steps: **⋮ → Install** |
| **iPhone / iPad** (Safari) | Likewise: **Share → Add to Home Screen** |
| **macOS** (Safari 17+) | Likewise: **File → Add to Dock** |
| **Desktop Firefox, in-app browsers** | Nothing — they cannot install, and an offer that cannot be acted on is worse than none |

Detection leans on the browser wherever it can: on Chromium the offer appears
only once `beforeinstallprompt` has fired, which is the browser telling us the
site really is installable, rather than us guessing from the user agent. That
event can fire before the ES modules have run and cannot be replayed, so a
small inline script in `<head>` catches it and hands it on — without that, the
offer was lost on a fast connection, which on Android is the common case.

The user agent is consulted only for browsers that fire no such event and can
still install by hand: Safari on iOS and macOS, and Firefox on Android.
Desktop Firefox is excluded by name because it cannot install a web app at all.
iPadOS needs particular care — since version 13 it reports a *Mac* user agent
by default, so an iPad and a Mac are indistinguishable by string alone;
`navigator.maxTouchPoints` is what separates them.

Installed, it opens in its own window with the district seal as its icon and
without browser chrome, and it carries shortcuts straight to the timeline, the
agenda and this month.

`sw.js` caches the app and the schedule, so an installed copy opens and stays
usable with no connection — showing the last schedule it managed to read. When
the device is offline the **Refresh** button says so plainly rather than passing
the saved copy off as current.

A service worker needs HTTPS, which GitHub Pages provides. Over plain `http://`
it is skipped, except on `localhost`, so local development behaves normally.

## Running it locally

The site is plain HTML, CSS and ES modules — no build step, no dependencies.
It does need to be served over HTTP, because browsers block `fetch` on
`file://` URLs:

```sh
npx http-server -p 8080 .
# or
python3 -m http.server 8080
```

Then open <http://localhost:8080/>.

## Where the data comes from

The schedule is the public **Performance Monitoring Team (PMT) Calendar** on
Google Calendar. Google's iCalendar endpoint sends no CORS headers, so the page
cannot read it directly from the browser. Instead the feed is mirrored into this
repository:

```sh
node scripts/build-data.mjs             # read the live feed, rewrite the snapshot
node scripts/build-data.mjs --offline    # re-parse data/pmt-calendar.ics only
```

That script:

1. fetches the `.ics` feed and caches it at `data/pmt-calendar.ics`;
2. unfolds and parses it, converting every date to an **inclusive** calendar
   date in `Asia/Manila` (Google's `DTEND` is exclusive for all-day events);
3. pulls `Unit/Person Responsible` and `Output` out of each description and
   folds naming variants onto one label, so "CPD" and "Corporate Planning
   Department" are the same entry in the unit filter;
4. classifies each activity into one of six SPMS stages by keyword;
5. writes `data/events.json`, which is the only thing the site reads.

`.github/workflows/refresh-calendar.yml` runs this twice a day and commits the
snapshot when the calendar changes, so the published site follows the Google
Calendar without anyone touching the code.

### Refreshing the schedule

There are two different refreshes, and it is worth keeping them apart:

| | What it does | How to run it |
| --- | --- | --- |
| **Refresh** (in the page) | Re-reads `data/events.json` past any browser or CDN cache, re-renders the current view, and reports what changed — or, offline, that it served the saved copy. It does **not** talk to Google. | The **Refresh** button in the toolbar |
| **Google → snapshot** | Re-reads the Google Calendar feed, commits a new `data/events.json` **and publishes it**. | Automatic, hourly; or **Actions → Refresh calendar data → Run workflow** to do it now |

So: after editing the Google Calendar, wait for the next hourly run (or run the
workflow yourself), then hit **Refresh** in the page to pick it up without
reloading. Hitting Refresh on its own tells you the published snapshot has not
moved, which is the honest answer — the browser cannot read the Google feed
directly, because that endpoint sends no CORS headers.

**Why the refresh workflow publishes the site itself.** GitHub will not start a
workflow from a push made with the default `GITHUB_TOKEN`:

> When you use the repository's `GITHUB_TOKEN` to perform tasks, events
> triggered by the `GITHUB_TOKEN` will not create a new workflow run.

So `refresh-calendar.yml` committing a snapshot never triggered
`deploy-pages.yml`, and for six days every refresh landed in the repository
without reaching the live site. The refresh workflow now has its own `publish`
job that deploys the commit it just made. The two deploy paths are deliberately
kept in step rather than shared: a reusable workflow would check out the
caller's SHA, which predates the refresh commit.

**The build is idempotent.** Google returns the feed in an unstable order, and
two activities can share a date, a time and a title, so events are sorted with
the id as a final tiebreaker and the payload carries a `contentHash`. An
unchanged calendar rewrites nothing, which is what stops an hourly job
committing — and deploying — for ever.

The in-page refresh keeps your current view, month, zoom and search, and drops
only a stage or unit filter whose value no longer exists in the new data, so a
removed activity cannot leave you staring at an empty calendar. If the fetch
fails, the schedule on screen is left exactly as it was and the page says so.

### Adding or changing activities

Edit the Google Calendar — do not edit `data/events.json` by hand; the refresh
job would overwrite it. Put the supporting detail in the event description, in
the shape the calendar already uses:

```
Unit/Person Responsible: Division Managers, AGMs, CPD
Output: PAPs/PMMP/Workforce Plan/L&D Plan
```

Anything else in the description becomes the activity's **agenda notes**, and
those are shown in the agenda list, the table and the month-grid tooltip — not
just in the detail panel. That matters when several activities share a title and
differ only in who attends, as the CY 2027 planning meetings do.

**Half-day sessions.** Give the event a real start and end time in Google
Calendar and the site reports the true length — an 08:00–12:00 entry reads as
"4 hours", not "1 day" — and tags it `AM` or `PM`. An activity that spans both
halves gets no tag. An all-day event has no clock to read, so it stays "1 day"
however the description describes it.

## Deployment

`.github/workflows/deploy-pages.yml` publishes the repository root to GitHub
Pages on every push to the repository's **default branch** — whatever it is
called. It reads the default branch at run time rather than hard-coding `main`,
so renaming the branch, or later promoting a different one, does not break the
deploy.

**One-time setup:** in the repository settings, set
**Pages → Build and deployment → Source** to **GitHub Actions**. Nothing else to
configure; `.nojekyll` keeps Pages from reprocessing the files.

**To redeploy:** push to the default branch. If nothing changed but you want to
republish anyway, go to **Actions → Deploy to GitHub Pages → Run workflow**.
Each deploy stamps the service worker with the commit SHA, so installed copies
land in a fresh cache instead of serving the old shell; anyone with the page
already open gets a "A new version is ready" notice and reloads into it.

## How it is put together

```
index.html                     page shell and static chrome
manifest.webmanifest           web app manifest — name, icons, shortcuts
sw.js                          service worker: offline shell and schedule
assets/css/styles.css          design tokens, components, print styles
assets/fonts/                  the two self-hosted variable typefaces
assets/js/main.js              state, URL-hash routing, filters, KPI strip
assets/js/pwa.js               install prompt and service-worker lifecycle
assets/js/store.js             data loading, filtering, lane packing, exports
assets/js/dates.js             calendar-date arithmetic and formatting
assets/js/detail.js            the activity panel (modal, focus trap)
assets/js/views/month.js       month grid
assets/js/views/gantt.js       Gantt timeline
assets/js/views/list.js        agenda and table
scripts/build-data.mjs         iCalendar feed → data/events.json
data/events.json               the published schedule (generated)
data/pmt-calendar.ics          raw feed snapshot (generated)
```

### A note on the design

**Type.** Two variable faces, self-hosted from `assets/fonts/` rather than
pulled from a font CDN: **Archivo** for the masthead, headings and figures, and
**Public Sans** — the typeface of the US Web Design System — for running text.
Both are SIL OFL 1.1. One file covers every weight, 60 KB for the pair, so there
is no third-party request on page load and the type survives offline without the
service worker having to special-case a CDN.

**Stage colour and its ink.** Each stage publishes both its colour and the ink
that reads on it, computed at build time by `inkFor()` in
`scripts/build-data.mjs` — white or near-black, whichever clears 4.5:1. That is
what lets a bar, a chip or a stage pill be filled with solid stage colour
instead of a pale tint and still carry a legible label. The pair is always set
together through `paintStage()` / `stageStyle()` in `assets/js/store.js`; a mark
given the colour without the ink falls back to body ink and goes unreadable on
the darker stages.

**Hierarchy.** Elevation is spent by role rather than stamped on every block:
the calendar is the page's subject, so it is the only surface that is lifted.
The figures along the top are one continuous ribbon divided by hairlines, the
controls sit flat on the page under a rule, and the stage key reads as a caption
beneath the calendar. Gold — the seal's yellow — is reserved for *now*: the
activity running today and today's cell in the grid, and nothing else.

### A note on the colours

The brand colours are taken from the district seal: navy `#183C90` and yellow
`#EDE424`. The six SPMS stage colours live in `scripts/build-data.mjs` and are
published through `data/events.json`, which the page turns into `--cat-*` CSS
variables at load.

The palette was checked with a validator on the **all-pairs** comparison against
the exact chart surface this site uses (`#F4F7FC`). Every stage colour clears
the lightness band, the chroma floor, 3:1 contrast against its surface, and —
the point of the exercise — stays separable under protanopia and deuteranopia
(worst pair ΔE 10.1 against a target of 8; worst normal-vision pair 17.8 against
a floor of 15).

`build-data.mjs` still computes a dark variant of each stage colour and
publishes it in `data/events.json`. Nothing reads it now that dark mode is gone;
it is left in place so the palette could be brought back without redoing the
validation.

Because colour alone should never carry meaning, the stage is also named in the
legend, in the timeline's row labels, in the table and on the activity panel.
Timeline bars carry their dates in body ink beside the mark rather than on it,
and upcoming activities are hatched as well as coloured. **Re-run the validator
before changing any stage colour.**

---

Baliwag Water District · Performance Monitoring Team · Baliwag City, Bulacan
