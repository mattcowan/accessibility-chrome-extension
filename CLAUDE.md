# CLAUDE.md

Chrome MV3 extension for accessibility testing (CDP emulation modes + WCAG checkers +
CSV report with run-over-run diff), plus a standalone Playwright keyboard-trap scanner
in `tools/keyboard-trap-scan/`. Plain HTML/CSS/JS everywhere — **no build step, no
bundler, no TypeScript**. Loaded unpacked from the repo root.

## Architecture (who owns what)

- `background/service-worker.js` — message router + lifecycle events ONLY. All
  debugger/CDP logic lives in `background/debugger-manager.js`. The SW owns nothing
  else; checkers are run by the popup, not the SW.
- `background/debugger-manager.js` — chrome.debugger attach/detach + emulation state.
  **Every state mutation writes through to `chrome.storage.session` (`tab:${tabId}`)**
  because the MV3 SW dies after ~30s idle while the debugger attachment survives
  browser-side. Never hold state in SW memory. All-off → detach (removes the yellow
  infobar). Emulation is re-applied on `tabs.onUpdated` (cross-process navigation
  persistence is not trusted).
- `popup/popup.js` — the integration hub: emulation controls (via `chrome.runtime`
  messages to the SW), checker injection (`chrome.scripting` under **activeTab** — no
  host_permissions in the real manifest, keep it that way), findings store, diff, CSV.
- `checkers/*.js` — injected as CLASSIC scripts (not modules) into the page's isolated
  world. Injection order: `checkers/lib/selector.js`, `checkers/lib/findings.js`,
  (optional `overlay.js` / `accname.js`), then the checker file.
- `test-pages/*.html` — deliberate-defect fixtures. Every defect element carries a
  `data-expect="fail|warn|review|pass"` attribute; the E2E verify script asserts
  against these. Self-contained inline CSS/JS is intentional — ignore inline-style
  linter warnings here.

## Contracts (do not break)

- **Checker registration:** each checker file guards with
  `if (!globalThis.__a11yX)` and registers
  `globalThis.__a11yCheckers.<name> = (arg) => findings`. The popup first injects
  `files[]`, then invokes via a second `executeScript` with
  `func: (n, a) => globalThis.__a11yCheckers[n](a)`. Do NOT rely on files[]-injection
  return values. Async checkers may return a Promise (executeScript awaits it).
- **Findings schema** (shared with the scanner; both CSV writers must stay in sync):
  `{tool, wcag, severity: fail|warn|review, selector, snippet, details, url,
  timestamp, status}`. Popup stamps url/timestamp/status. Severity semantics:
  `review` = heuristic couldn't verify, human must check — grade honestly, never
  upgrade uncertain findings to `fail`.
- **Diff fingerprint** is `tool|wcag|selector` against `chrome.storage.local`
  key `history:${normUrl}:${tool}`. Changing selector generation changes fingerprints
  and silently resets everyone's diff history — think twice.
- **Message protocol** (popup ↔ SW): `getState`, `setMediaFeature`,
  `setVisionDeficiency`, `setReflow {value: false|'320'|'320zoom'}` ('320zoom' adds
  `scale: 4` to the viewport override — same 320px layout, 400%-zoom rendering),
  `hoverProbe {action: start|move|escape|end}`, `resetTab`; SW broadcasts
  `stateChanged {tabId, state, reason}`.
- **Intentional duplication:** `checkers/lib/selector.js`+`findings.js` vs
  `tools/keyboard-trap-scan/lib/focusables.js`, and `popup/csv.js` vs
  `tools/keyboard-trap-scan/lib/csv.js`. The scanner must stay standalone (no shared
  imports possible without a build step). When touching one sibling, update the other.

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
- `chrome.debugger` conflicts with open DevTools on the same tab (friendly error is
  mapped in debugger-manager); it coexists fine with Playwright's CDP connection.
- Newer CDP values (`reducedContrast`, `inverted-colors`,
  `prefers-reduced-transparency`) are capability-probed on first attach and their UI
  hidden if rejected — keep the probe when adding features.

## Verify changes

- Syntax: `node --check` (classic checker files directly; copy `background/`,
  `popup/*.js` to `.mjs` first — they're ES modules).
- **E2E:** the verify script pattern lives in the session-scratchpad `verify.mjs`
  (technique documented in project memory `ext-e2e-verify-technique`): stage a copy of
  the extension with `host_permissions: ["<all_urls>"]` added, launch
  `chromium.launchPersistentContext` with `--load-extension`, open
  `chrome-extension://<id>/popup/popup.html` in a tab, and drive `chrome.runtime.sendMessage`
  / `chrome.scripting` from that page. Run it from `tools/keyboard-trap-scan/` so
  `playwright` resolves. Assert against `data-expect` in test-pages. Was 30/30 at build.
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
  row + badge in `popup/popup.html`/`popup.js` (`BADGE_BY_TOOL`), add a fixture page
  with `data-expect` attributes, and extend the verify script.
- The user manages git entirely — never commit, push, or stage.
