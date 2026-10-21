# Accessibility Modes & Checkers

A Chrome extension for manual accessibility testers. It emulates user settings such as reduced motion and forced colors, runs WCAG 2.2 checkers for the tests that automated tools miss, and exports the findings to CSV with a run-over-run diff.

## Why it exists

Automated tools such as WAVE find defects in the markup. Many WCAG 2.2 tests need a person to watch the page behave: motion, audio, content that updates on its own, focus, form errors, and reading order. This extension gives the tester tools for those tests, and maps each tool to the Trusted Tester 5.1 test that it helps with.

Each finding has a severity: `fail`, `warn`, or `review`. A checker that cannot prove a result gives `review` and tells you what to check. It never changes an uncertain result to `fail`.

## Features

### Emulation

Each mode applies to one tab, through the Chrome DevTools Protocol:

- `prefers-reduced-motion`, `prefers-color-scheme`, `forced-colors`, `prefers-contrast`, and, if your Chrome supports them, reduced transparency and inverted colors.
- A 320 px reflow viewport, plain or at 4× zoom (WCAG 1.4.10).
- Vision simulations: protanopia, deuteranopia, tritanopia, achromatopsia, blurred vision, and reduced contrast.

### Checkers

| Checker | WCAG (Trusted Tester) | What it checks |
| --- | --- | --- |
| [Motion respect](docs/checkers.md#motion-respect) | 2.2.2 (2.B), 2.3.3 | Animation and video that still run with reduced motion on, and their pause controls. |
| [Audio autoplay](docs/checkers.md#audio-autoplay) | 1.4.2 (2.A) | Audio that plays, or would play, on its own, and its controls. |
| [Auto-update](docs/checkers.md#auto-update) | 2.2.2 (2.C), 4.1.2 (2.D) | Content that changes on its own, its controls, and how users are told about it. |
| [Text spacing](docs/checkers.md#text-spacing) | 1.4.12 | Text that the WCAG spacing values clip. |
| [Focus visibility](docs/checkers.md#focus-visibility) | 2.4.7 (4.D) | Focusable elements with no focus indicator. |
| [Focus locator](docs/checkers.md#focus-locator) | 2.4.7, 2.1.1 (4.D, 4.A) | Where focus is during a manual Tab test, and if the page shows it. |
| [Keyboard access](docs/checkers.md#keyboard-access) | 2.1.1 (4.A) | Elements that a mouse can use but Tab cannot reach. |
| [Form labels](docs/checkers.md#form-labels) | 1.3.1 (5.C) | Group labels, required cues, and repeated field names. |
| [Tables](docs/checkers.md#tables) | 1.3.1 (section 14) | Data and layout tables and their header markup. |
| [CSS positioning](docs/checkers.md#css-positioning) | 1.3.2 (15.B) | Content that CSS shows out of reading order. |
| [Error capture](docs/checkers.md#error-capture) | 3.3.1, 3.3.3 (5.F, 5.G) | What a form shows after you submit bad data. |
| [Input watcher](docs/checkers.md#input-watcher) | 3.2.2, 4.1.2 (5.D, 5.E) | Changes of context that a form field causes. |
| [Target size](docs/checkers.md#target-size) | 2.5.8 | Targets smaller than 24 × 24 CSS pixels. |
| [Hover and focus content](docs/checkers.md#hover-and-focus-content) | 1.4.13, 3.3.2 (5.A), 2.4.4 (6.A) | Content shown on hover or focus, and `title` tooltips. |
| [Reflow scan](docs/checkers.md#reflow-scan) | 1.4.10 | Elements that cause horizontal scroll at 320 px. |
| [Accessible names](docs/checkers.md#accessible-names) | 4.1.2 | Interactive elements with no accessible name. |
| [Live regions](docs/checkers.md#live-regions) | 4.1.3 | A log of each live-region announcement. |

### Report

- Run one checker, or run a selected set in one batch.
- Click a finding to scroll to its element and outline it on the page.
- Export the findings to CSV. When you run a checker again, the report marks each finding `new`, `existing`, or `resolved`.
- Use the same controls in Chrome's side panel, which stays open while you use the page.

### Keyboard-trap scanner

Keyboard traps need real Tab key presses, and a script in the page cannot send them. A separate Playwright command-line tool in [tools/keyboard-trap-scan/](tools/keyboard-trap-scan/) does this test (WCAG 2.1.2, Trusted Tester 4.C). It writes the same CSV columns as the extension.

## Install

The extension is not in the Chrome Web Store. Load it from the source:

1. Clone or download this repo.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the repo folder.

You need Chrome 120 or later.

## Use

1. Open the page that you want to test.
2. Click the extension's toolbar icon.
3. Turn on an emulation mode, or click **Run** on a checker row.
4. Read the findings in the report. Click a finding to show its element on the page.
5. Click **Export CSV** to save the findings.

While an emulation mode is on, Chrome shows a "started debugging this browser" bar. This is normal: emulation uses the `chrome.debugger` API. Turn off all modes to remove the bar.

## Documentation

- [docs/checkers.md](docs/checkers.md): what each checker does and how it grades a result.
- [docs/usage.md](docs/usage.md): emulation, batch runs, the report, the side panel, and the permissions.
- [docs/limitations.md](docs/limitations.md): what the checkers cannot see.
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, test pages, the end-to-end tests, and how to add a checker.
- [CLAUDE.md](CLAUDE.md): detailed architecture notes.

## License

MIT. See [LICENSE](LICENSE).
