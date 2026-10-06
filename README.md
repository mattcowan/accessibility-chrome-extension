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
| Motion respect | 2.3.3 / 2.2.2 | With reduced-motion emulated, reports animations and autoplaying video still running. The row has its own **Reduced motion** toggle (same emulation as the toggle up top) so you can flip it and re-run in place. For each autoplaying video it looks for a pause/stop/hide control (native controls, a control named pause/stop/play/hide/freeze, or one with `aria-controls` on the video) in the Trusted Tester 2.B location: the first three elements, or three elements before or after the video. Found there → `review`; found elsewhere → `warn`; not found → `fail` |
| Audio autoplay | 1.4.2 (TT 2.A) | Reports unmuted audio longer than 3 seconds that **plays now**, or that **would play** (an autoplay element the browser's autoplay policy kept paused), plus embeds that request autoplay. Looks for a pause/stop/volume control within the first three elements (`review` if found, `warn` if elsewhere, `fail` if none). If Chrome marks the tab as audible but no page element explains it (Web Audio, cross-origin iframes), it adds a page-level `review`. **Reload and record** reloads the page with a recorder that catches audio scripts start, including attempts the browser blocked |
| Text spacing | 1.4.12 | Applies the standard spacing overrides, then flags **newly** clipped text (pre-existing clipping is baselined out) |
| Focus visibility | 2.4.7 | Badges tab order; flags focusables with no detectable focus indicator (style-diff + CSSOM `:focus`/`:focus-visible` analysis, confidence-graded) |
| Target size | 2.5.8 | Flags interactive targets under 24×24 px, with the spacing and inline exceptions approximated |
| Hover/focus content | 1.4.13 + title triage | Triages `title` tooltips (exempt from 1.4.13 as user-agent-controlled): redundant titles → `warn`, titles carrying unique info → `review` under 2.4.4/1.3.1, title-as-only-label fields → `review` under 3.3.2. Separately discovers CSS reveal-on-hover/focus content, triggers it with **real** CDP mouse events, and tests Escape dismissability (author-built tooltips do fail 1.4.13) |
| Reflow scan | 1.4.10 | With the 320 px override on, reports elements that force horizontal scrolling (tables/images/code flagged for review, not failure) |
| Accessible names | 4.1.2 | Batch-flags interactive elements with empty accessible names + a hover-to-inspect tooltip showing role/name/source (Escape exits) |
| Live regions | 4.1.3 | Start/stop monitor that finds every live region (`aria-live`, `role=status/log/alert`, `<output>`) and attaches a visible on-page log panel to each — green **polite** / red **assertive** tag, every announcement appended with a timestamp, never overwritten. **Export log** downloads the accumulated messages as their own CSV (selector, politeness, role, message, timestamp, url). Regions added after start get panels too (they just don't count toward the start-time badge — restart the monitor to refresh it). Stopping the monitor discards the log, so export first |

### Run selected (batch)

Each batchable checker row has a checkbox; **Run selected** runs the ticked ones
sequentially (checkers share the page, focus, and mouse — parallel would corrupt
results) and updates each badge as it completes. The selection is remembered across
sessions. Notes:

- The **Reflow scan** checkbox is only enabled while the Reflow emulation toggle is on.
- The hover row has two checkboxes: **static** (fast CSS analysis; skipped-probe
  candidates are reported as `review`) and **probe** (the full pointer probe — slow,
  moves the real mouse; off by default). Selecting probe subsumes static.
- Text spacing's analyze pass removes its spacing overrides again at the end of a batch
  so they can't skew other checkers (running it from its own button leaves them
  applied, as before).
- The stateful tools (text-spacing apply/remove, accname inspector, live-regions
  monitor) are not batchable. Neither is audio's **Reload and record**, because it
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
- **Clear all checkers** resets everything in one click — removes on-page artifacts (overlay badges, text-spacing overrides, the accname inspector) and clears the tab's findings. **Clear overlays** and **Clear findings** remain for granular resets.

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
- The hover checker only discovers CSS-rule-based reveals (`:hover`/`:focus` toggling
  display/visibility/opacity); JS-driven tooltips are not probed.
- The accessible-name computation is a simplified subset of the AccName algorithm.
- Audio results depend on the browser profile. Chrome lets a site autoplay with sound
  after user interaction or when its Media Engagement Index is high, so the same page
  can play on one profile and be blocked on another. Blocked autoplay is reported as
  `review` ("would play"). No extension API can turn the autoplay policy off; start
  Chrome with `--autoplay-policy=no-user-gesture-required` to test with it off.
- Running any checker from the popup gives the page user activation (Chrome passes
  the click's user gesture into injected scripts). After that, the page's scripts can
  start sound that was blocked before. To see a page's first-load audio behavior, run
  **Reload and record**; its reload comes from the service worker, with no gesture.
- "First three elements" (Trusted Tester) is counted in reading order: each control,
  media element, image with alt text, and run of text. Findings also give the
  control's tab-stop position.
- If you navigate the tab while the popup is closed, reopen the popup before running
  checkers (activeTab re-grant).

## Companion keyboard-trap scanner

Keyboard traps can't be reliably detected from inside a page (synthetic key events are
untrusted), so that lives in [tools/keyboard-trap-scan/](tools/keyboard-trap-scan/) — a
Playwright CLI that presses real Tab keys, detects stuck/cycling focus, probes Shift+Tab
and Escape escapability, and writes the same CSV schema. See its README, and
`EXTEND-PROMPT.md` for a ready-made prompt to extend it (crawl mode, modal interaction,
CI).

## Test pages

Deliberately broken fixtures for every checker live in [test-pages/](test-pages/)
(each defect is annotated with `data-expect`). With WAMP running:
`http://localhost/chrome-ext-accessibility-modes/test-pages/`
