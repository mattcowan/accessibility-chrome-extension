# Keyboard-Trap Scanner

## What it does

This tool presses real, trusted Tab keys via Playwright and watches where focus moves on a web page. It detects keyboard traps by identifying three patterns: stuck focus (the same element absorbing repeated Tabs), focus cycles among a subset while unvisited focusables remain, and focus lost to `<body>` mid-sequence. Before flagging a trap as a failure, the scanner probes escapability: it attempts Shift+Tab to break the cycle, then tests whether Escape enables forward focus movement. An escapable trap is flagged as a 'warn' (user instructions on the exit method must exist); an inescapable one is a 'fail' and the scan stops.

## Why a script and not a browser extension

Synthetic keyboard events fired from within a page are untrusted and do not move focus; they are consumed by the page's event handlers without side effects. Playwright sends real input to the browser, so Tab presses actually advance focus and reveal real keyboard traps, not simulated ones.

## Setup

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
node scan.js <url> [--max-tabs 200] [--out report.csv] [--headed]
```

### Flags

- `<url>` (required): The URL to scan.
- `--max-tabs N` (default 200): Stop after N Tab presses (to cap runtime on infinite-loop pages).
- `--out FILE` (default `report.csv`): Write findings to FILE in CSV format.
- `--headed`: Run with the browser window visible (useful for debugging focus movement).

### Exit codes

- `0`: Scan completed with no 'fail' findings (may have 'warn' or 'review' findings).
- `1`: One or more hard keyboard traps detected (severity 'fail').
- `2`: Usage error or runtime crash.

## Output

The scanner writes a CSV file (default `report.csv`) with the following columns:

- `tool`: Always `"keyboard-trap-scan"`.
- `wcag`: Always `"2.1.2"` (the WCAG criterion this scanner checks).
- `severity`: One of `"fail"` (hard trap, exit code 1), `"warn"` (escapable trap or lost focus), or `"review"` (coverage issue).
- `selector`: CSS selector (or pseudo-selector like `"(body)"`) of the trapped element.
- `snippet`: Empty (reserved for future HTML snippet extraction).
- `details`: Human-readable explanation of the finding.
- `url`: The scanned URL.
- `timestamp`: ISO 8601 timestamp when the finding was created.
- `status`: Empty (reserved for user annotation).

This CSV schema matches the export format of the companion Chrome extension, allowing reports to be merged and compared.

## Limitations

The scanner has several blind spots:

- **Initial state only**: The scanner does not click elements or otherwise interact with the page, so keyboard traps inside unopened modals, dropdowns, or dialogs remain invisible.
- **SPA route changes**: If the page is a single-page application and the URL changes mid-scan (e.g., due to routed navigation triggered by Tab or focus events), the scanner's element identity tracking becomes unreliable.
- **Cross-origin iframes**: Elements inside cross-origin `<iframe>` elements can receive focus, but the scanner cannot see into their contents due to browser security; traps inside cross-origin frames go undetected.
- **Closed shadow roots**: Elements in closed shadow DOM are invisible to the scanner. Only open shadow roots are traversed.
- **Hidden focusables**: The focusable count includes only visible, non-disabled elements in the light DOM and open shadow roots. Some frameworks intentionally render offscreen interactive elements (e.g., for keyboard shortcuts) or hide content for progressive disclosure. If a page has many such hidden focusables, the scanner's "90% coverage reached" heuristic may end the scan early.
- **Roving-tabindex widgets**: Components like menus and data grids often use roving-tabindex patterns (only one element in the tab order, arrow keys move focus within). A sequence of arrows that return to the start can resemble a cycle trap, causing false positives.
- **Escape semantics**: The Escape probe assumes Escape should release a trap or at least allow forward Tab to move beyond the trap. Non-standard Escape handlers may confuse the probe.

## Example

Serve the repo's test pages first (from the repo root, with Python 3):

```bash
python -m http.server 8000 --directory test-pages
```

Scan the keyboard-trap test page:

```bash
node scan.js http://localhost:8000/keyboard-trap.html
```

Expected: Finds a hard trap and exits with code 1.

Scan with `escapable=1` query parameter (a version with an Escape exit):

```bash
node scan.js "http://localhost:8000/keyboard-trap.html?escapable=1"
```

Expected: Detects the trap, finds it escapable via Escape, flags as warn, and exits with code 0.
