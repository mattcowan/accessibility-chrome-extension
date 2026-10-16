# CLAUDE.md

Chrome MV3 extension for accessibility testing (CDP emulation modes + WCAG checkers +
CSV report with run-over-run diff), plus a standalone Playwright keyboard-trap scanner
in `tools/keyboard-trap-scan/`. Plain HTML/CSS/JS everywhere — **no build step, no
bundler, no TypeScript**. Loaded unpacked from the repo root.

## Architecture (who owns what)

- `background/service-worker.js` — message router + lifecycle events ONLY. All
  debugger/CDP logic lives in `background/debugger-manager.js`. The SW owns nothing
  else; checkers are run by the popup, not the SW. The one injection path it has is
  the `exec` route (`handleExec`): the popup's every `chrome.scripting` call is made
  here, after a one-task wait, so the page never gets the click's user activation
  (#15 — see the gotcha below). It is still routing: the popup decides what runs.
- `background/debugger-manager.js` — chrome.debugger attach/detach + emulation state.
  **Every state mutation writes through to `chrome.storage.session` (`tab:${tabId}`)**
  because the MV3 SW dies after ~30s idle while the debugger attachment survives
  browser-side. Never hold state in SW memory. All-off → detach (removes the yellow
  infobar). Emulation is re-applied on `tabs.onUpdated` (cross-process navigation
  persistence is not trusted).
- `popup/popup.js` — the integration hub: emulation controls (via `chrome.runtime`
  messages to the SW), checker injection (under **activeTab** — no host_permissions
  in the real manifest, keep it that way — and always through the SW's `exec` route
  via `inject`/`pageCall`/`callChecker`; popup.js must contain no `chrome.scripting`
  call), findings store, diff, CSV. The popup's own small page operations (reveal,
  highlight all, clear overlays, read the stateful tools' DOM markers) live in
  `checkers/lib/ops.js` (`__a11yOps`), because `exec` can only call a named method
  on an allowed global (`__a11yCheckers`, `__a11yHover`, `__a11yOps`).
  Run-button checkers are declared in the `CHECKERS` registry (drives both the
  per-row buttons and the sequential "Run selected" batch; `data-batch-id` in
  popup.html must match `CHECKERS[].id` — hand-synced, init warns on mismatch).
  Batch order = registry order, deliberately: auto-update watches first (focus,
  styles and the hover probe can change content or pause a carousel; it is
  `batchDefault: false`, as it adds its watch time); text-spacing analyze applies its
  override stylesheet as a side effect, so it runs after target-size/reflow and a
  `batchCleanup` removes the overrides (batch only — the individual button leaves
  them applied); the slow hover probe runs last. The same popup.html also serves as
  the **Chrome side panel** — the SW registers `popup/popup.html?context=panel` via
  `sidePanel.setOptions` at top level, and `IS_PANEL` in popup.js switches on
  tab-tracking listeners (`tabs.onActivated`/`onUpdated` → `refreshForActiveTab()`)
  and panel-specific error wording. The `tabs` permission exists solely so the panel
  can read `tab.url` across tab switches; activeTab still gates checker injection
  per-tab (after navigating, the toolbar icon must be clicked to re-grant).
- `checkers/*.js` — injected as CLASSIC scripts (not modules) into the page's isolated
  world. Injection order: `checkers/lib/selector.js`, `checkers/lib/findings.js`,
  (optional `overlay.js` / `accname.js` / `mechanism.js` / `table.js` / `forms.js` / `live.js`), then the checker file.
  `checkers/lib/resolve.js` (`__a11yResolve`) is the exact inverse of selector.js's
  `" >>> "` shadow-path format — used by the popup's click-a-finding reveal /
  highlight-all; keep the two formats consistent. `checkers/live-regions.js` is a
  stateful monitor (accname-inspector pattern: `start|stop|status|export`); its
  popup-open re-sync probe is the `document.documentElement.dataset.a11yLiveMonitor`
  DOM marker, its log entries live page-side in the checker closure and are
  **intentionally outside** the findings schema/diff (events, not defects — only the
  one-review-finding-per-region summary goes through `storeToolFindings`).
- `checkers/lib/focus-style.js` (`__a11yFocusStyle`) — the focus-indicator style
  diff (`snap`/`diffKind`/`deepActiveElement`) shared by `focus-walker.js` (2.4.7,
  synthetic focus) and `focus-locator.js`.
- `checkers/focus-locator.js` — stateful toggle (`start|stop|status`, DOM marker
  `data-a11y-focus-locator`), top frame only. It never focuses/blurs/presses keys: a
  rAF loop reads the deep active element through open shadow roots and into
  same-origin iframes (`contentDocument`) and draws on its OWN fixed layer
  (`#__a11y-focus-locator`, put in the top layer via `popover="manual"` so it shows
  above modal dialogs; a `<style>` inside the layer neutralizes the page's
  `::backdrop` rules, which would otherwise dim the page) — not overlay.js, whose
  layer is static-positioned and wiped by
  **Clear overlays**. The 4.D verdict diffs the real-focus computed style against an
  unfocused baseline taken at start, on insertion (a MutationObserver per watched
  document — it does not see into shadow roots attached later), and on every
  `focusout`; real Tab focus matches
  `:focus-visible`, so no CSSOM fallback is needed here. Every verdict on an element
  says "Focus is here" — that is the whole point (4.D ≠ 4.A). The layer exposes
  `data-verdict`/`data-target`/`data-stop` for E2E.
- `checkers/keyboard-access.js` (2.1.1 / TT 4.A, always `review`) — registry
  `kind: 'keyboard'`: `execKeyboardAccess` first sends `clickListeners` (the SW reads
  `DOMDebugger.getEventListeners` depth −1/pierce and returns child-index paths, −1 =
  enter shadow root, top document only), then runs the checker allFrames with
  `{listenerPaths}`. Listeners on html/body are ignored (delegation), and so is a
  candidate whose ONLY signal is a listener when it holds a tabbable element (React
  17+ root, jQuery containers — decided 2026-10-07; cursor/onclick/role still report
  cards). If the SW call
  fails (DevTools open), one `(page)` review says what was not covered.
- `checkers/lib/mechanism.js` (`__a11yMechanism`, needs `accname.js`) — finds a
  pause/stop/hide/volume control for auto-playing content and applies the Trusted
  Tester location rule: 2.A = first three elements only; 2.B (and later 2.C) = first
  three OR within three elements before/after. "Element" is counted in reading order
  (controls, media, alt-text images, text runs); the tab-stop position is reported
  alongside. Shared by `motion-check.js` (video, 2.2.2), `audio-check.js` (1.4.2)
  and `auto-update.js` (2.C). 2.A/2.B: a candidate is a control whose name matches
  the verbs anywhere, or whose `aria-controls` names the target's id (exact id only —
  widening it to "an element holding the target" made an accordion button over a
  video count as its pause control; reverted after review 2026-10-09). 2.C is
  stricter (`nameMatches`, `maxWords`, `requireName`, `skipLinksInside`): the name must
  START with the verb (incl. "Start/Stop", "Auto rotate") and be ≤4 words, links inside
  the updating content are never candidates (a headline can start "Stop the …"), no close/dismiss, and aria-controls alone never makes a
  candidate — the updating content is full of links ("Markets close higher", "Bus
  stop moved") and its Previous/Next buttons point at it but pause nothing. The best
  is: location rank, then name match over aria-controls-only, then distance. Any
  control with a matching name anywhere on the page is a candidate (the helper
  cannot tell what a button controls), so a far-away "Pause" turns "no control" into
  "control elsewhere" — both are `warn` in the 2.C checker.
  `<audio>` is deliberately NOT in the motion checker — sound is 1.4.2, not motion.
- `checkers/audio-check.js` returns `{findings, playing}`, not an array — the popup's
  `execAudio` (registry `kind: 'audio'`) merges frames and adds a `(page)` review when
  `chrome.tabs.get(tab).audible` is true but no frame found unmuted media playing.
  **Reload and record**: the SW (`recordAudio` message) installs
  `background/audio-hook.js` via `Page.addScriptToEvaluateOnNewDocument`, reloads the
  tab, waits for load, removes the script and `detachIfIdle`s — the whole cycle is in
  the SW so a closing popup can't leave the script installed. The hook (main world)
  answers the checker (isolated world) over DOM events: the checker dispatches
  `__a11y-audio-query`; the hook first answers with a `{kind:'hook'}` sentinel (so the
  checker's `hooked` result separates "no recorder" from "nothing recorded" — the
  popup warns instead of showing a silent empty pass), then dispatches one `__a11y-audio-rec` per record ON the
  media element (the event target crosses worlds; the detail is a JSON string, since
  only primitives cross).
- `checkers/auto-update.js` (2.2.2 / TT 2.C and 4.1.2 / TT 2.D, registry
  `kind: 'auto-update'`, top frame only, watch-only) — `{action: start|collect|
  status}`. `start` installs a MutationObserver (text, child list, and `class`/
  `style`/`hidden`/`aria-hidden`/`src`/`open`, with old-value checks so a re-set
  attribute or re-rendered text is no change; document + open shadow roots present
  at start), a 200 ms scroll-position sampler over overflow containers (scrollLeft
  carousels fire no mutations), trusted-input listeners and a focusin log; the
  watch ends itself after N s. The popup's `execAutoUpdate` waits with a visible
  countdown (`#auto-update-progress`), then `collect` (awaits the end) reports —
  never one long executeScript. The DOM marker `data-a11y-auto-update` is
  `watching`/`done` until collected: the action popup closes when the tester
  clicks the page (killing its countdown), so `refreshForActiveTab` →
  `resumeAutoUpdate` resumes the countdown or collects the finished watch (PR #26
  review). `status` → `{active, finished, seconds, remainingMs}`. Time the tab
  spent hidden (`visibilitychange`) ≥1 s adds a page note: hidden tabs throttle
  timers and many carousels pause. Playwright keeps every page visible, so E2E
  fakes it with an isolated-world `document.hidden` own property. Changes within 1 s after trusted input are dropped.
  Grouping: each change's nearest box-making ancestor (display not none/contents/
  inline; never body/html), then same-tag siblings merge into their parent (slides)
  and a block merges into its PARENT when the parent changed too (parent only: a
  one-time insertion into a page wrapper such as #root a few levels up used to swallow
  the carousel inside it — review 2026-10-09); a region qualifies with
  ≥2 updates (bursts split by 300 ms gaps) or one update ≥2 s long; nested
  qualifying regions merge into the outer. Per region: one 2.2.2 finding
  (mechanism 2.C: review / warn / warn) and one 4.1.2 finding (`notification()`):
  `review` if every change was in a live region; or a live region in scope (an
  ancestor ≤3 levels up) changed within 1 s of ≥ half the silent updates AND about
  as often (±1 — a carousel's "Slide 2 of 4" status; a live counter beside the
  content on its own schedule fails this, one on the very same ticks cannot be told
  apart and stays review); or focus moved into it; or a dialog OPENED (`noteDialog`
  tracks open transitions, so restyling an open dialog is not a new one) near an
  update and holds the region or is inside it (no "next to" scope for dialogs: scope can
  climb to a page wrapper that holds every dialog), or dialogs opened near ≥3 updates
  and ≥80% of them (two unrelated one-time dialogs must not qualify). The live-region
  scope can also reach a wrapper; the ±1 frequency test is what guards it. A silent
  block on the SAME ticks as a live neighbor stays `review` (decided by Matt
  2026-10-09: it cannot be told from a carousel slide status). Else `fail` — except a region whose changes are ALL inline `style`
  writes (rAF/GSAP animation, progress bar, transform carousel), which is `review`:
  decoration and information cannot be told apart (the "never upgrade uncertain to
  fail" contract outranks #14's "none → fail"). Same-tag siblings never merge when
  one is all-live and the other is not. Dialogs shown by a class on a wrapper
  ancestor are not seen. A `(page)` review appears ONLY when reduced motion was on,
  input happened, the tab was hidden ≥1 s, or there were more than 200 scrolling containers (the rest are not
  sampled), so a static page has zero findings. The
  watch time (`#auto-update-seconds`, `parseWatchSeconds`: whole seconds, default
  10, max 300) is kept in `chrome.storage.local` `autoUpdateSeconds`.
- `checkers/lib/live.js` (`__a11yLive`: `REGION_SELECTOR`, `politenessFor`,
  `regionOf`) — live-region detection shared by `live-regions.js`, `error-capture.js`,
  `input-watcher.js` and `auto-update.js`. `checkers/lib/forms.js` (`__a11yForms`, needs `accname.js`
  and `table.js`) — field selector, radio/checkbox group members, group label (fieldset
  legend or named group/radiogroup holding every member), table headers (delegated to
  `table.js`, mapped to the old `{row, col, viaHeaders, complex}` shape), a field's own
  container and the visible text near it. Shared by the three TT section 5 tools.
- `checkers/lib/table.js` (`__a11yTable`) — the table model: HTML "forming a table"
  (row groups in tree order with tfoot LAST, colgroups, rowspan=0, slot grid capped at
  20000) and the spec's "algorithm for assigning header cells" (headers attr first,
  else the left/up scan with opaque blocks, plus rowgroup/colgroup headers). One
  deliberate deviation: deciding if an auto-scope th heads its row or column ignores
  EMPTY data cells (an empty td corner must not turn the row headers off). ARIA tables
  (role table/grid/treegrid on a non-table) use row index + cell order, as Chrome does.
  Shared by `tables.js` and `forms.js`. `headersOf(m, cell, {wholeLine: true})` adds
  every row header of the cell's rows and column header of its columns at ANY position
  (`lineHeaders`; Chrome gives screen readers headers this way): the spec scan only looks
  left/up, so a bulk-select checkbox named by the row th to its RIGHT got no header and
  Form labels turned review into fail (peer review 2026-10-15). Use wholeLine for "does
  it have a header" questions (forms.js, the no-header rule); the plain call is the spec
  result (the `headers` action, E2E `data-expect-headers`). Per-model indexes (`byEl`,
  `rowHeadsAt`/`colHeadsAt`, group-header maps) keep per-cell lookups linear: the first
  version rebuilt them per cell (O(cells²): 2000×10 with headers attrs took 78 s).
  `cellOf(el, cache)` takes a Map the CALLER owns for one run (Form labels makes one per
  `formLabels()` call; never a long-lived cache — the stateful tools would read stale
  models). A cell past the MAX_SLOTS cap returns `{cell: null, truncated: true}`, and
  forms.js reports it as `unknown`: Form labels then gives `review`, never `fail`
  (PR #28 review: a bulk-select group past the cap read as "not in a table" → fail).
- `checkers/tables.js` (1.3.1 / TT section 14, registry `kind: 'tables'`, allFrames,
  batchable) — `{action: scan|show|hide|status|headers}`. `execTables` first sends
  `tableAX` (Chrome's role per top-document table), then calls the checker with
  `{axTables, axError, overrides}`. The guess (data/layout/unsure) is a weighted score
  of markup, visual and Chrome signs (`role=presentation` → layout and an ARIA table
  role → data, before scoring). The tester's choice lives in `chrome.storage.local`
  `tableClass:${normUrl}` = `{"${page}|${selector}": 'data'|'layout'}` (page = the
  frame's own origin+path+search, so frame selectors do not collide); a rule whose
  result depends on the classification is `fail` only for a CHOSEN class, `review` for
  a guess. One finding per table (all issues merged). Run draws the overlay (own layer
  `#__a11y-tables`, marker `data-a11y-tables`, redrawn on scroll/resize, NOT cleared by
  Clear overlays); a batch run and a changed choice only scan (scan redraws an overlay
  that is on). The popup keeps the last list in session `tables:${tabId}` (with a
  `stamp`, so the side panel re-renders a list the popup stored but not its own — that
  would drop focus from the radio just changed).
- `checkers/css-position.js` (1.3.2 / TT 15.B, registry `kind: 'css-position'`,
  allFrames, batchable, #29) — `{action: scan|show|hide|linearize|status}`. Moved =
  absolute/fixed, relative with a used offset ≥1px, float; reordering container =
  flex `-reverse`/`wrap-reverse`, or in-flow items with `order` or explicit grid
  placement (C27 — ANDI's linearize misses these). Content = text runs plus named
  images/fields/media in flat-tree order; a moved element with none, or visually
  hidden (clip, `inset(50%)`, 1×1 clipping box, outside the document), is skipped
  and its content is never used as a neighbor. A moved element is compared with
  its nearest seen neighbors outside its subtree (prev's LAST line vs its first,
  its last vs next's FIRST: above/below wins, then the inline direction, RTL
  aware; overlap = "covers"); a container compares its items pairwise by FIRST
  line only (a tall grid item beside short ones must not read as "after") and
  gives ONE finding. Fixed (decided by Matt 2026-10-16): center in the top half of
  the window → its rects are shifted by −scroll and compared as at scroll 0 (a
  header coded last); lower → no order check, `review` only when it holds a visible
  control (`pinned`), else outline only; content inside a fixed element is never a
  neighbor. Always `review`. Why not trust ANDI: Chrome returns used px,
  never `auto`, for top/left/bottom/right on relative/absolute/fixed elements with
  no offset (verified 2026-10-16, Chromium 149), so ANDI's offset filter marks
  every one of them; and its glow is a box-shadow on the element's own box, which a
  zero-height wrapper or an `overflow:hidden` ancestor hides. The overlay
  (`#__a11y-css-position`, marker `data-a11y-css-position`, NOT cleared by Clear
  overlays) outlines the union of the element and its content, re-measured at each
  draw; badges = reading-order number, placed left of the outline. Linearize
  (marker `data-a11y-linearize`) sets inline `!important` (beats the page's own
  inline `!important`) and restores the saved inline values newest-first; a scan
  while linearized undoes it, measures, and re-applies; hide ends it.
- `checkers/form-labels.js` (1.3.1 / TT 5.C, registry `kind: 'simple'`, allFrames,
  batchable) — group with no group label is `fail`, `review` when a member has
  aria-describedby, every member has table headers (bulk select), or a member's
  aria-labelledby joins 2+ elements (decided 2026-10-08, the last two after the PR
  review); required-cue mismatch and repeated names are
  `review`. One element can hit several rules, and the fingerprint is
  `tool|wcag|selector`, so results are merged per element into ONE finding (max
  severity, details joined). Repeated names: one finding per set, on its first field,
  listing each field's headers/group label (context, never part of the name).
- `checkers/error-capture.js` (3.3.1 / TT 5.F; quotes text for 3.3.3 / TT 5.G) —
  stateful toggle (`start|stop|status|collect`, marker
  `data-a11y-error-capture`, plus `data-a11y-error-captures=<n>` for E2E), top frame
  only, watch-only. Baseline per field at start; every snapshot records `focused`
  (= `document.hasFocus()` AND deep active element — verified 2026-10-08: while the
  tester is in the popup/panel the field keeps activeElement but `:focus` stops
  matching) and `settling` (a CSSTransition running on the field), and colors are
  compared only between snapshots with the SAME focus state and no transition (the
  baseline, else the window-open snapshot) — a focus style can change border and
  background (Bootstrap), not just outline/shadow, and a 0.15 s fade snapshot is
  neither look. A focused baseline is replaced on
  focusout (no window open) or at the next window open (the capture listener runs
  before the page's handlers, so that snapshot is still pre-submit). The focus cue
  counts only a focusin INSIDE the window: Enter in a field leaves focus where it
  was, which is not a move. A click on a button (any input device), Enter in a
  field, `submit` or `invalid` opens a window that closes when the DOM is quiet. A field
  keeps its earlier result unless the new window changed it (otherwise submitting
  form B would erase form A's announcement cue). Color-only (no text) = `warn`, all
  else `review`. Results live page-side; after each window the page posts
  `{type:'errorCaptureUpdate', findings}` (the SW ignores it via `PAGE_NOTICES`; the
  popup/panel stores it); a popup opened later reads them with `collect`.
- `checkers/input-watcher.js` (3.2.2 / TT 5.D and 4.1.2 / TT 5.E) — stateful toggle,
  marker `data-a11y-input-watcher`, top frame only, watch-only, never attaches the
  debugger (no listener read). A navigation ends the page script, so the LOG LIVES IN
  THE SW's `chrome.storage.session` key `watch:${tabId}`
  (`{active, startedAt, last, events, seq}` — `seq` counts every event ever logged
  and keeps growing at the 300-event cap; listeners watch it, not the length): the
  page sends `inputWatch` `mark` on each field input/change, `unmark` on a press or
  `click` on a non-field (click also covers Enter/Space on a button, which never
  fires pointerdown) or Enter — TRUSTED events only: a change handler's
  `submitBtn.click()` is the 3.2.2 case, not a user action — and `event` for what it sees itself (script focus
  move = focusin with no Tab in 150 ms — arrow-type keys count only in a radio group
  or roving-focus widget, since on a closed `<select>` ArrowDown changes the value —
  and not the clicked element or its label's control; content shown = not rendered at the
  field's focusin, rendered at window end; submit with no Enter/submit click). The SW
  logs `navigation` (`tabs.onUpdated` loading) and `new-tab` (`tabs.onCreated`
  `openerTabId`) within 5 s of a mark, serialized per tab. The popup turns the log
  into findings (`syncWatchFindings`: one per field per criterion) on refresh, on
  start/stop and on each `watch:` `seq` change, MERGED with the report's
  existing input-watcher findings, and each finding carries the url of the page the
  field was on. Incremental stores (each log entry, each Error capture window,
  each popup refresh) pass `{final:false}` to `storeToolFindings`: status is
  still computed against the last finished run, but history is written only by
  each tool's Stop, so a finding stays `new` for the whole session. After a
  navigation with no Resume, the log stays `active` until Stop, Clear all or tab
  close; it is harmless leftover state, because only a running page script sends
  the marks that link a later navigation to a field. Stop: the page returns its open window's events (a post could arrive
  after the stop), the popup sends them with `inputWatch stop`, and the SW logs them,
  returns the final log for the last sync, then clears it. After a navigation the button reads "Resume
  watcher" and starting again continues the log.
- `test-pages/*.html` — deliberate-defect fixtures. Every defect element carries a
  `data-expect="fail|warn|review|pass"` attribute; the E2E verify script asserts
  against these. Self-contained inline CSS/JS is intentional — ignore inline-style
  linter warnings here.

## Contracts (do not break)

- **Checker registration:** each checker file guards with
  `if (!globalThis.__a11yX)` and registers
  `globalThis.__a11yCheckers.<name> = (arg) => findings`. The popup first injects
  `files[]`, then invokes via a second injection (both through the SW's `exec`)
  that runs `globalThis.__a11yCheckers[n](arg)`. Do NOT rely on files[]-injection
  return values. Async checkers may return a Promise (executeScript awaits it), but
  keep one call short — the SW holds the message open while it waits; a timed watch
  (auto-update) uses `start` + popup-side wait + `collect` instead.
- **Findings schema** (shared with the scanner; both CSV writers must stay in sync):
  `{tool, wcag, severity: fail|warn|review, selector, snippet, details, url,
  timestamp, status}`. Popup stamps url/timestamp/status (url only when the finding
  carries none — Input watcher findings keep the page the field was on). Severity semantics:
  `review` = heuristic couldn't verify, human must check — grade honestly, never
  upgrade uncertain findings to `fail`.
- **Diff fingerprint** is `tool|wcag|selector` against `chrome.storage.local`
  key `history:${normUrl}:${tool}`. Changing selector generation changes fingerprints
  and silently resets everyone's diff history — think twice.
- **Message protocol** (popup ↔ SW): `getState`, `setMediaFeature`,
  `setVisionDeficiency`, `setReflow {value: false|'320'|'320zoom'}` ('320zoom' adds
  `scale: 4` to the viewport override — same 320px layout, 400%-zoom rendering),
  `hoverProbe {action: start|move|escape|end}`, `recordAudio` (→ `{ok, loaded}` after
  the reload finishes), `clickListeners` (→ `{ok, paths: [{path, tag}], truncated}`;
  attaches, reads, releases; refused during Reload and record; any CDP error other
  than "node gone" fails the whole read → `ok:false`), `tableAX` (→ `{ok, tables:
  [{path, tag, role, ignored}], truncated}`, Chrome's AX role per table in the top
  document via `Accessibility.getPartialAXTree`; same hold/refusal/error rules as
  `clickListeners`), `inputWatch {action:
  start|stop|status}` from the popup and `{action: mark|unmark|event}` from the
  watcher's content script (top frame, tab from `sender.tab`), `exec {files,
  allFrames}` (→ `{ok}`) and `exec {global, method, args, allFrames}` (→ `{ok,
  results: [{frameId, result}]}`; extension pages only — `sender.url` must be the
  extension's origin; only the global's OWN function properties can be called; a
  top-frame exception returns `{ok:false, error}`, a subframe exception only nulls
  that frame's result), `resetTab`. Pages also
  post `errorCaptureUpdate` (a `PAGE_NOTICES` type: the SW returns false and never
  answers it; popup/panel consume it). Reload and record,
  `clickListeners`, `tableAX` and the hover probe (start→end) take an in-memory per-tab
  **debugger hold** (`holdDebugger`/`releaseDebugger` in debugger-manager.js; the
  hover probe uses `holdHover`/`touchHover`/`releaseHover` — one slot per tab, not a
  count, so a lapsed hold cannot outlive the next probe — and its hold lapses after
  15 s with no hover message, so a popup closed mid-probe cannot pin it). The
  debugger detaches only when no hold is left and no emulation is on: the last
  release runs `detachIfIdle`, and `updateTabState`'s all-off branch clears the
  overrides but stays attached while a hold exists; SW broadcasts
  `stateChanged {tabId, state, reason}`.
- **Intentional duplication:** `checkers/lib/selector.js`+`findings.js` vs
  `tools/keyboard-trap-scan/lib/focusables.js`, and `popup/csv.js` vs
  `tools/keyboard-trap-scan/lib/csv.js`. The scanner must stay standalone (no shared
  imports possible without a build step). When touching one sibling, update the other.
  The sync contract for csv.js is the findings COLUMN SET; `buildCsv`/`downloadTable`
  (column-parameterized, used by the live-region log export) are popup-only and
  deliberately absent from the scanner sibling.

## Hard-won gotchas

- **After editing any extension file, hit ↻ Reload on `chrome://extensions`.** Chrome
  can serve a cached popup.js against a fresh popup.html (or vice versa) until the
  extension is reloaded — the symptom is null-element TypeErrors at line numbers that
  don't match the file on disk, and every popup button dead (init wiring threw early).

- `import()` is **disallowed in MV3 service workers** — static imports only in
  `background/`. This also means E2E tests can't `worker.evaluate(import(...))`;
  drive the real message protocol from an extension page instead (see below).
- Computed `animation-timeline` is `'auto'` for ordinary animations — only
  `!== 'none' && !== 'auto'` means scroll-driven (motion-check).
- Synthetic `el.focus()` may not trigger `:focus-visible`; focus-walker combines a
  computed-style diff with a CSSOM scan of `:focus` rules and downgrades to `review`
  when cross-origin sheets are unreadable. Don't "simplify" that away.
- CSS `:hover` cannot be faked from JS — the 1.4.13 dynamic pass needs real CDP
  `Input.dispatchMouseEvent` via the SW `hoverProbe` messages. Escape listeners in
  pages must be on `document` (key events go to the focused element, not the hovered
  one) — two test fixtures were originally broken this way.
- Under `setDeviceMetricsOverride({width:320})`, `documentElement.clientWidth` reads
  ~305 (scrollbar excluded). Assert ranges, not equality.
- `HELPERS_SOURCE` in `tools/keyboard-trap-scan/lib/focusables.js` is code inside a
  template literal: backslash escapes collapse once, so a regex like `/\\/g` becomes
  invalid in the injected script and `window.__kt` silently never installs. Write that
  code backslash-free (e.g. `String.fromCharCode(92)`) and parse-check with
  `new Function(HELPERS_SOURCE)` after editing.
- `chrome.debugger` conflicts with open DevTools on the same tab (friendly error is
  mapped in debugger-manager); it coexists fine with Playwright's CDP connection.
- `Page.addScriptToEvaluateOnNewDocument` silently does nothing under
  chrome.debugger unless `Page.enable` is sent first (verified 2026-10-05).
- **A popup-made `chrome.scripting.executeScript` carries the click's user gesture
  into the page** (`navigator.userActivation.hasBeenActive` turns true; the page can
  then start audio the autoplay policy blocked). It lasts as long as the popup's
  transient activation (5 s in Chrome) and hits automatic injections too, such as
  the side panel's `refreshForActiveTab`. **Routing through the SW alone does not
  fix it**: Chrome forwards the sender's gesture into the SW's `onMessage` dispatch,
  and an executeScript made in that same task leaks it too. A call after one
  microtask, an await, or `setTimeout(0)` does not (all verified 2026-10-08 in a
  throwaway Playwright experiment, with the popup-direct path as the control). So
  `handleExec` waits one task before it injects — never remove that wait, and never
  add a popup-side `chrome.scripting` call (#15). The E2E `[#15]` section guards
  this, probing from the SW. The audio checker still does not read
  `hasBeenActive`: the tester's own page clicks set it too.
- **An exception inside a `chrome.scripting.executeScript` function does NOT
  reject the call** — that frame's result is just `null` (verified 2026-10-09). Until
  the PR #26 review, a crashed checker therefore read as a clean "0 findings". The
  `exec` wrapper catches and returns `{error}`; keep it that way, and never treat a
  null result as "nothing found" in new code.
- **Chrome's layout-table guess is visible only in the AX tree** (role `LayoutTable`
  vs `table`; rows/cells `LayoutTableRow`/`LayoutTableCell`). Verified 2026-10-15 on
  Chromium 149: a data-looking table with no th AND no cell borders is `LayoutTable`
  (borders alone flip it to `table`); `role="presentation"` plus `aria-label` is
  ignored (→ `table`); `display:block` keeps `table`. `Accessibility.getPartialAXTree
  ({objectId, fetchRelatives:false})` works with no `Accessibility.enable` or
  `DOM.getDocument` first.
- Newer CDP values (`reducedContrast`, `inverted-colors`,
  `prefers-reduced-transparency`) are capability-probed on first attach and their UI
  hidden if rejected — keep the probe when adding features.

## Verify changes

- Syntax: `node --check` (classic checker files directly; copy `background/`,
  `popup/*.js` to `.mjs` first — they're ES modules).
- **E2E:** `node tools/e2e/verify.mjs` from the repo root (needs
  `tools/keyboard-trap-scan`'s `npm ci` for Playwright). The default run skips
  the audio checker / Reload and record sections and launches every browser with
  `--mute-audio` (Matt may be on a call); `--audio` runs only the audio sections,
  with sound, and `--all` runs both. The `[#15]` activation guard stays in the
  default run: it reads `hasBeenActive` and `play()` rejection, which muting does
  not change. Run `--audio` only when Matt says sound is OK, and before handing
  over a change to `audio-check.js`, `audio-hook.js`, `mechanism.js` or Reload and record. 370 checks in the default (muted) run on 2026-10-16 after CSS positioning (#29, +34); `--all` should be 421, not yet run (the audio sections were last run in the 387-check run). 387 checks on 2026-10-15 after the #27 peer review (377 after the Tables checker, +102); 275 on 2026-10-09 after the PR #26 review (267 before it, 249 before the earlier review rounds; 208 before, 123 before the TT section 5 tools, 58 before #20). It stages
  a copy of the extension with `host_permissions: ["<all_urls>"]` added (in the OS temp
  folder), launches `chromium.launchPersistentContext` with `--load-extension`, opens
  `chrome-extension://<id>/popup/popup.html` in a tab, and drives the real popup buttons,
  `chrome.runtime.sendMessage` and `chrome.scripting` from that page. It asserts against
  `data-expect` in test-pages. It covers motion 2.B, audio, Reload and record, the
  batch runner, no user activation from any checker path (`[#15]`, probed from the
  SW, with a real page click as the control), tables (guess, Chrome role, header
  algorithm per cell via `data-expect-headers`, overlay, the saved choice), auto-update (`data-expect` = 2.2.2,
  `data-expect-notify` = 4.1.2), keyboard access, the focus locator, and the TT section 5 tools (form
  labels, error capture, input watcher — the test plays the tester with real
  clicks/keys/selects); older checkers have no section yet — **extend it with each new checker**
  (more gotchas in project memory `ext-e2e-verify-technique`). Audio fixtures carry per-policy expectations (`data-expect` = autoplay allowed,
  `data-expect-blocked`, `data-expect-recorded`; `--audio`/`--all` only): launch twice, with
  `--autoplay-policy=no-user-gesture-required` and `=document-user-activation-required`
  (Playwright sets no autoplay flag by default). Under Playwright,
  `chrome.debugger.getTargets()` always reports `attached: true` (Playwright's own
  session) — check the `tab:${id}` session state instead.
- Scanner: `cd tools/keyboard-trap-scan && node scan.js
  "file:///C:/wamp64/www/chrome-ext-accessibility-modes/test-pages/keyboard-trap.html"`
  → expect `fail`, exit 1; with `?escapable=1` → `warn`, exit 0;
  `focus-styles.html` → clean, exit 0.
- Manual-only surface: popup UI interactions, infobar behavior, colorblind sims
  (eyeball `test-pages/media-queries.html`).

## Conventions

- Findings `details` strings: full sentences, name the WCAG criterion's requirement,
  and say what to verify when severity is `review`/`warn`.
- New checkers: add the file under `checkers/`, register on `__a11yCheckers`, wire a
  row + badge in `popup/popup.html`/`popup.js` (`BADGE_BY_TOOL`), add a `CHECKERS`
  registry entry + `data-batch-id` checkbox if it's batchable, add a fixture page
  with `data-expect` attributes, and extend the verify script.
- The user manages git entirely — never commit, push, or stage.
