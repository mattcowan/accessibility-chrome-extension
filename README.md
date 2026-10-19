# Accessibility Modes & Checkers

Chrome extension for accessibility testing: emulate accessibility media features and
vision deficiencies per-tab, run WCAG 2.2 checkers that fill WAVE's gaps, and export
findings to CSV with a run-over-run diff. Ships with a companion Playwright
keyboard-trap scanner.

## Install (load unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder

## Features

### Emulation modes (per-tab, via Chrome DevTools Protocol)

- **Reduced motion** — `prefers-reduced-motion: reduce`
- **Color scheme** — `prefers-color-scheme: dark | light`
- **Forced colors** — `forced-colors: active` (approximates Windows High Contrast; Chromium renders the forced palette)
- **Contrast** — `prefers-contrast: more | less` (≈ macOS Increase Contrast; media feature only — the page must support it)
- **Reduced transparency / Inverted colors** — hidden automatically if your Chrome version rejects them
- **Reflow test** — 320 px viewport override (WCAG 1.4.10), plain or at 4× visual zoom
  (the 4× option is equivalent to a 1280 px window at 400% browser zoom — the canonical
  1.4.10 test condition — and shows content magnified as a low-vision user sees it)
- **Vision simulation** — protanopia, deuteranopia, tritanopia, achromatopsia, blurred vision, reduced contrast (Chrome's built-in colorimetric simulations; one at a time)

### Checkers (run on demand from the popup or side panel)

| Checker | WCAG | What it does |
|---|---|---|
| Motion respect | 2.2.2 (TT 2.B) / 2.3.3 (not in TT 5.1) | With reduced-motion emulated, reports animations and autoplaying video still running. The row has its own **Reduced motion** toggle (same emulation as the toggle up top) so you can flip it and re-run in place. For each autoplaying video it looks for a pause/stop/hide control (native controls, a control named pause/stop/play/hide/freeze, or one with `aria-controls` on the video) in the Trusted Tester 2.B location: the first three elements, or three elements before or after the video. Found there → `review`; found elsewhere → `warn`; not found → `fail` |
| Audio autoplay | 1.4.2 (TT 2.A) | Reports unmuted audio longer than 3 seconds that **plays now**, or that **would play** (an autoplay element the browser's autoplay policy kept paused), plus embeds that request autoplay. Looks for a pause/stop/volume control within the first three elements (`review` if found, `warn` if elsewhere, `fail` if none). If Chrome marks the tab as audible but no page element explains it (Web Audio, cross-origin iframes), it adds a page-level `review`. **Reload and record** reloads the page with a recorder that catches audio scripts start, including attempts the browser blocked |
| Auto-update | 2.2.2 (TT 2.C) / 4.1.2 (TT 2.D) | Watches the page for a set time with no user action. Set the time in the **Watch for** field: whole seconds from 1 to 300, 10 by default, kept between sessions. An empty, zero, negative, or non-numeric value uses 10. It reports each part of the page that changes on its own two or more times, or that keeps changing: carousels, tickers, feeds, and counters. It sees changed text, added or removed content, show/hide changes (`class`, `style`, `hidden`, `aria-hidden`, `src`, `open`), and scroll-position changes of overflow containers. For TT 2.C, it looks for a control to pause, stop, or hide the content, or to set how often it updates, in the first three elements or within three elements before or after the content. The control's name must start with the action ("Pause", "Stop slideshow", "Change speed") and have four words or fewer, so a headline link in a ticker is not a control. A "Next slide" button is not a control either. Found there → `review`; found elsewhere → `warn`; not found → `warn`, because only a person can decide if the "essential" exception applies. For TT 2.D, it looks for how the user is told about the change → `review`: the changes are in a live region; a live region next to the content changes each time the content changes; focus moves into the content; or a dialog opens when it changes, and the dialog holds the content, is inside it, or opens with most of its changes (at least three). None → `fail`. If only inline styles change (a script animation or a progress bar), the result is `review`, because the checker cannot tell decoration from new information. A page-level `review` tells you when Reduced motion was on, when user input happened during the watch, when the tab was hidden during the watch, or when the page has too many scrolling containers to watch all of them. If the popup closes during the watch (a click on the page closes it), the page keeps watching. Open the popup again to see the results. Content that only a CSS animation moves makes no page change; Motion respect reports it. It only watches. Do not touch the page while it runs |
| Text spacing | 1.4.12 (not in TT 5.1) | Applies the standard spacing overrides, then flags **newly** clipped text (pre-existing clipping is baselined out) |
| Focus visibility | 2.4.7 (TT 4.D) | Badges tab order; flags focusables with no detectable focus indicator (style-diff + CSSOM `:focus`/`:focus-visible` analysis, confidence-graded) |
| Focus locator | 2.4.7 / 2.1.1 (TT 4.D vs 4.A) | A start/stop tool for manual Tab testing. While you press Tab or Shift+Tab, it draws a dashed box around the element that has focus and shows its role and name. It follows focus into open shadow roots and same-origin iframes. The label says whether the **page** shows a focus indicator on that element: an outline or ring, a subtle change only, a change on the parent or a `::before`/`::after`, or nothing. "Nothing" is a 4.D failure (2.4.7), not 4.A: focus did reach the element. The label also tells you when focus came from a mouse click, when the focused element is hidden or off-screen, and when focus is in a cross-origin frame. It only watches. It does not move focus, press keys, or click |
| Keyboard access | 2.1.1 (TT 4.A) | Reports elements that a mouse can operate but Tab cannot reach. An element is a candidate when it sets a pointer cursor, has an `onclick`-type attribute or an interactive `role`, or has a click listener. It is reported only if it is not focusable and not inside a focusable element. Items in a composite widget that arrow keys reach (roving `tabindex`, `aria-activedescendant`) are not reported. Every finding is `review`: Trusted Tester 4.A accepts another keyboard method for the same function, and you must look for it. The scan reads click listeners through the debugger, so the debugging bar shows for a moment. It does not test Enter or Space activation (TT 4.A step 2). Do that step by hand |
| Form labels | 1.3.1 (TT 5.C) | Reports the cues that a form field gives in addition to its own name. (1) Radio buttons or checkboxes in one group with no group label: no `fieldset` with a `legend`, and no `role="group"` or `role="radiogroup"` with a name. This is `fail`. It is `review` when the question can be in a place that the checker cannot judge: a member's `aria-describedby`, table headers on every member (for example, bulk-select checkboxes), or an `aria-labelledby` on a member that joins two or more elements. (2) A label or nearby text that shows "*" or "required" when the field has no `required` or `aria-required`, or the reverse (`review`). (3) Two or more fields in one form with the same accessible name (`review`). The finding lists the table headers or the group label of each field, so you can pass 5.C without a different ANDI module. It tells you when nothing makes the fields different. Table headers are context, not part of the name. It only reads the form |
| Tables | 1.3.1 (TT section 14) | Finds every table (`<table>`, `role="table"`, `role="grid"`, `role="treegrid"`) in all same-origin frames. It guesses if each table is a data table or a layout table, and shows the signs it used: the markup, the role in Chrome's accessibility tree (`table` or `LayoutTable`), and how the table looks (a header-styled first row, cell borders and short text, or headings, lists and long text in the cells). In the Tables list, choose **Data table** or **Layout table** for each table. The tool keeps your choice for the page and uses it for the findings. Data table: an empty `th`, or a `headers` id that does not exist → `fail`. An empty top-left `th` that heads no data cells is `review`. No header cells, or Chrome shows the table as `LayoutTable` → `fail` after you choose **Data table**, else `review`. A header row coded as `td`, `headers` that names a `td`, or a `scope` value that is not valid (the browser then uses the position of the cell) → `warn`. Complex headers with no `scope` or `headers`, a `th` that heads no row or column, data cells with no header, `scope` on a `td`, or a header row in a different table → `review`. Layout table: `th`, `caption`, `summary`, `scope` or `headers` → `fail` after you choose **Layout table**, else `review`. Chrome shows it as a data table → `review`. An ARIA table with a cell outside a `role="row"` → `fail`. A table that the tool cannot decide gets a `review` that lists the signs. **Run** also outlines each table on the page and colors its header cells: column headers, row headers, and headers that head no row or column. The header cells come from the HTML header algorithm (`headers`, `scope`, row groups and column groups). **Clear overlays** does not remove the outlines. **Hide overlay** does. The tool reads Chrome's roles through the debugger, so the debugging bar shows for a moment |
| CSS positioning | 1.3.2 (TT 15.B) | Finds content that CSS moves away from its place in the reading order, in all same-origin frames: `position: absolute` or `fixed`, `position: relative` with an offset that is not 0, `float`, and flex or grid containers that change the order of their items (`row-reverse`, `column-reverse`, `wrap-reverse`, `order`, grid placement). It counts only content that a screen reader reads (text, an image with alt text, a form field, media). Visually hidden content (sr-only, off screen) and empty decoration give no finding. For each moved element, the tool compares where it shows with the content before and after it in the reading order. The element shows before content that a screen reader reads first, after content that a screen reader reads later, or on top of it → `review`, and the finding names that content. A flex or grid container gets one finding that names the items out of order. A `fixed` element in the top half of the window (a header) is compared as the page shows when it opens. A `fixed` element lower in the window (a chat button, a cookie bar) shows on every screen: it gets a `review` only when it holds a control, because a screen reader user must find that control at its place in the code. All findings are `review`: only you can decide if the meaning changes. **Run** outlines each moved element and the content in it, with its reading-order number: orange solid = order changed, blue dashed = same order. **Linearize** removes the positioning and the flex and grid reordering, so the page shows the moved content in reading order. ANDI's **Linearize Page** does this for positioning only. Content that is placed inside a moved element can move too, because its reference box changes. This is expected in the preview. **Undo linearize** puts back the page's own values. **Clear overlays** does not remove the outlines. **Hide overlay** removes them and ends **Linearize** |
| Error capture | 3.3.1 (TT 5.F) / 3.3.3 (TT 5.G) | A start/stop tool. Start it, type bad data, and submit the form yourself. A click on a button, Enter in a field, a submit, or the browser's own validation (`invalid` event) starts a capture. When the page stops changing, the capture compares each field with its state at start. Each field that shows an error gets one 3.3.1 finding. The finding quotes the error text, so you can judge 3.3.3 from it. It names the cues it found and the cues that are missing: error text, text tied to the field (`aria-describedby` or `aria-errormessage`), `aria-invalid="true"`, and an announcement (live region or `role="alert"`) or a focus move to the error. An error that only changes a color, with no text, is `warn`. All other findings are `review`. It only watches. It does not type, click, or submit |
| Input watcher | 3.2.2 (TT 5.D) / 4.1.2 (TT 5.E) | A start/stop tool. While it is on, change the fields yourself and tab away. For each change, it logs what the field's `input`, `change`, or blur caused: a navigation or reload, a new tab or window, a form submit, a focus move by a script (no Tab key or click before it), or content shown in a different part of the page. For shown content, it tells you if focus moved to the content and if a live region changed. Each field gets one `review` finding for 3.2.2 and one for 4.1.2. The service worker keeps the log, so a navigation finding stays after the page navigates. After a navigation, **Resume watcher** continues the same log on the new page. It never attaches the debugger. It only watches. It does not type, select, or submit |
| Target size | 2.5.8 (not in TT 5.1) | Flags interactive targets under 24×24 px, with the spacing and inline exceptions approximated |
| Hover/focus content | 1.4.13 (not in TT 5.1) + title triage: 3.3.2 (TT 5.A), 2.4.4 (TT 6.A) | Triages `title` tooltips (exempt from 1.4.13 as user-agent-controlled): redundant titles → `warn`, titles carrying unique info → `review` under 2.4.4/1.3.1, title-as-only-label fields → `review` under 3.3.2. Separately discovers CSS reveal-on-hover/focus content, triggers it with **real** CDP mouse events, and tests Escape dismissability (author-built tooltips do fail 1.4.13) |
| Reflow scan | 1.4.10 (not in TT 5.1) | With the 320 px override on, reports elements that force horizontal scrolling (tables/images/code flagged for review, not failure) |
| Accessible names | 4.1.2 (an empty name fails TT 5.C for a form field and TT 6.A for a link) | Batch-flags interactive elements with empty accessible names + a hover-to-inspect tooltip showing role/name/source (Escape exits) |
| Live regions | 4.1.3 (not in TT 5.1) | Start/stop monitor that finds every live region (`aria-live`, `role=status/log/alert`, `<output>`) and attaches a visible on-page log panel to each — green **polite** / red **assertive** tag, every announcement appended with a timestamp, never overwritten. **Export log** downloads the accumulated messages as their own CSV (selector, politeness, role, message, timestamp, url). Regions added after start get panels too (they just don't count toward the start-time badge — restart the monitor to refresh it). Stopping the monitor discards the log, so export first |

The WCAG column names the Trusted Tester (TT) 5.1 test that each checker helps with. TT 5.1 tests that the table does not name are manual tests. Use ANDI for them.

### Run selected (batch)

Each batchable checker row has a checkbox; **Run selected** runs the ticked ones
sequentially (checkers share the page, focus, and mouse — parallel would corrupt
results) and updates each badge as it completes. The selection is remembered across
sessions. Notes:

- **Auto-update** runs first, before the other checkers focus, style, or hover the
  page. It is off by default, because it adds its watch time to the run.
- The **Reflow scan** checkbox is only enabled while the Reflow emulation toggle is on.
- The hover row has two checkboxes: **static** (fast CSS analysis; skipped-probe
  candidates are reported as `review`) and **probe** (the full pointer probe — slow,
  moves the real mouse; off by default). Selecting probe subsumes static.
- Text spacing's analyze pass removes its spacing overrides again at the end of a batch
  so they can't skew other checkers (running it from its own button leaves them
  applied, as before).
- Tables does not draw its overlay in a batch. If the overlay is already on, the
  batch updates it.
- The stateful tools (text-spacing apply/remove, accname inspector, live-regions
  monitor, focus locator, error capture, input watcher) are not batchable. Neither is audio's **Reload and record**, because it
  reloads the page.

### Report

- Findings aggregate per tab **and per page** — navigating the tab to a different URL starts a fresh report, so one export never mixes sites; severity is `fail` / `warn` / `review` (heuristics are graded honestly — `review` means "verify by hand").
- Findings are grouped by checker with the full detail text visible. **Click a finding
  to reveal it live on the page** — the element is scrolled into view and outlined in
  its severity color; **Highlight all** outlines a checker's whole set at once (no
  scrolling). Page-level findings (`(page)`) aren't clickable. If the page re-rendered
  since the run, a not-found message suggests re-running the checker. For findings
  inside iframes, the highlight lands in the iframe and scrolling happens within it.
- **Export CSV** (Excel-safe RFC 4180). A two-line header names the run URL and export time, then columns: tool, wcag, severity, selector, snippet, details, url, timestamp, status.
- **Run-over-run diff**: re-running a checker marks each finding `new` or `existing` and reports `resolved` ones, persisted per URL+tool across browser restarts.
- **Clear all checkers** resets everything in one click — removes on-page artifacts (overlay badges, text-spacing overrides, the accname inspector, the focus locator, the tables overlay, the CSS positioning overlay and **Linearize**, error capture, and the input watcher with its log) and clears the tab's findings and Tables list. Your Data / Layout table choices stay. **Clear overlays** and **Clear findings** remain for granular resets.

### Side panel

**Open in side panel** (top of the popup) docks the same UI in Chrome's side panel,
where it stays open while you interact with the page — no more popup closing on every
click. The panel follows your active tab (switching tabs or navigating re-syncs its
state, badges, and report). One caveat inherited from the activeTab permission model:
after a navigation, checker injection needs a fresh grant — **click the extension's
toolbar icon on that tab** (the popup that opens can be dismissed) and re-run.
Emulation toggles are unaffected; they work through the debugger permission.

The extension asks for the `tabs` permission ("read your browsing history" in the
install warning) solely so the side panel can see the active tab's URL when following
tab switches — without it, `chrome.tabs.query` omits `url` for tabs that haven't
received an activeTab grant. In practice this mostly formalizes visibility the
extension already had: the `debugger` permission it holds allows enumerating every
tab's URL and title via `chrome.debugger.getTargets()` without attaching. Still,
`tabs` makes that URL access ordinary and continuous rather than incidental, so it's
worth naming.

## The debugger infobar

Emulation uses the `chrome.debugger` API — the only way an extension can emulate CSS
media features and vision deficiencies. While any mode is active, Chrome shows a yellow
**"…started debugging this browser"** bar; turning every mode off detaches and removes
it. Consequences:

- DevTools and the extension can't debug the same tab at once. If DevTools is open,
  emulation fails with a message; if you open DevTools while emulating, emulation stops.
- Dismissing the infobar (×) also stops emulation; the popup reflects that.
- Emulation isn't available on `chrome://` pages, the Web Store, or other extensions.

## Limitations

- Checkers run in same-origin frames only (activeTab); cross-origin iframes are not scanned.
- Closed shadow roots are invisible to all checkers.
- Focus-indicator detection is heuristic: synthetic focus may not trigger `:focus-visible`,
  and cross-origin stylesheets can't be read — such findings are downgraded to `review`.
- The focus locator compares the focused element with its unfocused style. It records
  that style when you start it, when an element is added to the page, and each time
  an element loses focus. Some elements have no record when they first get focus: an
  element that gets focus at the moment it is added (for example, the first control
  in a dialog), and an element that loads later inside a frame or a shadow root. For
  these, the verdict says that the comparison is not available. Tab away and back to
  get a full verdict. The locator does not see indicators drawn on elements other than
  the focused element, its parent, and its `::before`/`::after`.
- The keyboard access scan cannot tell which element a delegated listener serves (one
  listener on `<body>` or on a container, such as the React 17+ root). It ignores
  listeners on `<html>` and `<body>`. It also ignores a container when the listener is
  its only signal and it holds a focusable element. A listener-only container with
  nothing focusable inside is still reported. A listener-only card with no pointer
  cursor is not reported if it holds a link, even if that link does something else.
  Click listeners inside iframes are not read; the other signals still apply there. If DevTools is open on the tab, the scan cannot read listeners and adds
  a page-level `review` that says so.
- Error capture and the input watcher run in the top frame only. They do not see forms
  in iframes. The Form labels checker runs in all same-origin frames.
- Error capture compares each field with its state when you started the capture. Any
  new text near a field counts as error text, so a character counter can show as error
  text. If the submit loads a new page, the capture stops with the old page. It does not
  record errors that a server shows on the new page.
- Trusted Tester 5.1 does not say if a browser validation message (the bubble that a
  `required` field shows) counts as error text. Error capture quotes the message and
  tells you to judge it.
- The input watcher links a navigation or a new tab to a field when it comes less than
  5 seconds after the field changed. A click on a different element cancels the link,
  and so do Enter and Space on a button, because they also click it. Enter in a field
  also cancels the link. If you reload the page yourself in that time, the watcher logs the
  reload against the field. A tab that `window.open` opens can have no URL yet when the
  watcher logs it.
- The Form labels checker finds table headers with the HTML table header algorithm: the
  `headers` attribute, or `scope` and `th` cells in the same row and column, with row
  groups and column groups. It also uses each row header in the field's row and each
  column header in its column at any position, as Chrome does. If the table uses
  `rowspan` or `colspan`, the finding tells you to check the headers.
- The Tables checker reads Chrome's table roles in the top document only. Tables in
  iframes and in closed shadow roots get no Chrome role. If DevTools is open on the
  tab, the checker cannot read the roles and adds a page-level `review`.
- The Tables checker checks the markup. It cannot tell if the header text is correct.
  Check that each header names its row or column as the page shows it.
- The data or layout guess is a heuristic. Your choice in the Tables list is kept by
  the table's selector. If the page changes so that the selector changes, the tool
  uses its guess again.
- The hover checker only discovers CSS-rule-based reveals (`:hover`/`:focus` toggling
  display/visibility/opacity); JS-driven tooltips are not probed.
- The accessible-name computation is a simplified subset of the AccName algorithm.
- Audio results depend on the browser profile. Chrome lets a site autoplay with sound
  after user interaction or when its Media Engagement Index is high, so the same page
  can play on one profile and be blocked on another. Blocked autoplay is reported as
  `review` ("would play"). No extension API can turn the autoplay policy off; start
  Chrome with `--autoplay-policy=no-user-gesture-required` to test with it off.
- Checkers do not give the page user activation. The popup and the side panel send
  every script through the service worker, which drops the click's user gesture
  before it injects. A click that you make on the page gives it user activation, as
  for any user. After that, the page's scripts can start sound that was blocked
  before. To see a page's first-load audio behavior, run **Reload and record**.
- Auto-update runs in the top frame only. It does not watch iframes, or shadow roots
  that the page attaches after the watch starts. It ignores changes in the second
  after a key press, click, touch, or wheel scroll on the page.
- "First three elements" (Trusted Tester) is counted in reading order: each control,
  media element, image with alt text, and run of text. Findings also give the
  control's tab-stop position.
- If you navigate the tab while the popup is closed, reopen the popup before running
  checkers (activeTab re-grant).

## Companion keyboard-trap scanner

Keyboard traps can't be reliably detected from inside a page (synthetic key events are
untrusted), so that lives in [tools/keyboard-trap-scan/](tools/keyboard-trap-scan/) — a
Playwright CLI for WCAG 2.1.2 (TT 4.C) that presses real Tab keys, detects stuck/cycling focus, probes Shift+Tab
and Escape escapability, and writes the same CSV schema. See its README, and
`EXTEND-PROMPT.md` for a ready-made prompt to extend it (crawl mode, modal interaction,
CI).

## Test pages

Deliberately broken fixtures for every checker live in [test-pages/](test-pages/)
(each defect is annotated with `data-expect`). With WAMP running:
`http://localhost/chrome-ext-accessibility-modes/test-pages/`
