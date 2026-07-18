# Scanner Extension Prompt

Paste the prompt below into a Claude Code session opened in `tools/keyboard-trap-scan/`.

---

## Prompt

You are extending a Playwright-based WCAG 2.1.2 keyboard-trap scanner. The codebase:

**Files:**
- `scan.js`: Main entry point. Parses CLI args, launches Chromium, injects helpers, presses Tab in a loop, detects trap patterns (stuck focus, cycles, body wraps), probes escapability (Shift+Tab, Escape), writes CSV.
- `lib/focusables.js`: Injects `window.__kt` helper object that counts visible, non-disabled focusables in light DOM + open shadow roots (including iframes, contenteditable, tabindex), and returns the current deeply-nested active element with CSS selector.
- `lib/csv.js`: Writes RFC 4180 CSV with columns: `tool`, `wcag`, `severity`, `selector`, `snippet`, `details`, `url`, `timestamp`, `status`. Includes UTF-8 BOM for Excel.

**Detection Algorithm (summary):**
The scanner presses Tab repeatedly, tracking each focused element's ID. It detects three trap patterns: (1) the same element focused 3+ times consecutively — i.e. two absorbed Tab presses; the deliberately conservative threshold avoids false positives from one-off focus-management bounces, and a genuinely stuck element always keeps absorbing Tabs so nothing is missed (stuck), (2) a repeating sequence of distinct elements while unvisited focusables exist (cycle), (3) focus returning to `<body>` before reaching 90% of detected focusables (lost focus). When a trap is detected, it probes escapability: Shift+Tab up to `cycleLen + 1` times, then Escape followed by Tab. If neither escapes, it's a 'fail' and the scan stops. If either escapes, it's a 'warn'. Exit code 1 = fail, 0 = clean/warn, 2 = crash.

**Known Limitations:**
- Initial state only (no clicking/interaction).
- SPA route changes mid-scan break element identity.
- Cross-origin iframe contents opaque.
- Closed shadow roots invisible.
- Focusable count includes only light DOM + open shadow roots.
- Roving-tabindex widgets (menus, grids) can false-positive as cycles.
- 90% coverage heuristic can exit early if legitimately hidden focusables exist.

**CSV Schema:**
Columns are `tool` (always `"keyboard-trap-scan"`), `wcag` (always `"2.1.2"`), `severity` (`"fail"` / `"warn"` / `"review"`), `selector`, `snippet`, `details`, `url`, `timestamp`, `status`. This schema is stable and shared with the companion Chrome extension's export.

**Three Extension Tasks:**

1. **Crawl Mode**: Accept a `--crawl` flag and a start URL. Queue same-origin links and recursively scan each page, merging CSVs. (Modify: create a new `lib/crawler.js` module that extracts links and filters for same-origin. Wrap the per-page Tab loop in a reusable function in `scan.js` main(), then call it for each page in a queue loop.)

2. **Modal-Interaction Mode**: Add a `--interact` flag. Before scanning, find elements matching aria-haspopup, data-toggle attributes, or buttons whose text contains "open", "menu", or "dialog". Click each, run the Tab loop in the opened state, restore via Escape. (Modify: extract the Tab loop in `scan.js` main() into a reusable async function. Create `lib/modals.js` to query and click modal triggers. Call the Tab loop before and after interaction, or only after as needed.)

3. **CI Integration**: Write a GitHub Actions workflow YAML snippet that runs the scanner against a deployed preview URL, fails the job if exit code is 1, and uploads the CSV as a build artifact. (No code change needed; include the YAML as a separate `.github/workflows/` file in the repo root.)

**Guardrails:**
- Any new detection logic (trap patterns, probes) must preserve the warn/fail escapability semantics (escapable = warn, inescapable = fail).
- The CSV schema must remain stable. Do not add or remove columns without coordinating with the extension.
- Keep the focusable-detection logic in sync between `lib/focusables.js` and the extension's `checkers/lib/selector.js` by hand (no shared build step).
- Test against the local test page (`http://localhost/chrome-ext-accessibility-modes/test-pages/keyboard-trap.html`) and verify exit codes match expectations.

