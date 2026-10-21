# Contributing

This file tells you how to set up, change, and test the extension.

## Requirements

- Chrome or Chromium 120 or later.
- Node.js 18 or later, for the keyboard-trap scanner and the end-to-end tests.
- Python 3, or a different static file server, for the test pages.

The extension has no build step, no bundler, and no TypeScript. Chrome loads the files from the repo root as they are.

## Set up

1. Clone the repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repo root.
4. Install Playwright for the scanner and the end-to-end tests:

   ```bash
   cd tools/keyboard-trap-scan
   npm ci
   npx playwright install chromium
   ```

After you change an extension file, click **Reload** (↻) on the extension's card in `chrome://extensions`. If you do not, Chrome can use an old `popup.js` with a new `popup.html`, and the popup buttons stop working.

## Test pages

The `test-pages/` folder has a page with deliberate defects for each checker. Each defect element has a `data-expect` attribute with the result that the checker must give (`fail`, `warn`, `review`, or `pass`).

Serve the folder over HTTP, because extensions cannot inject scripts into `file://` pages without extra settings. From the repo root:

```bash
python -m http.server 8000 --directory test-pages
```

Then open `http://localhost:8000/`.

## Run the tests

### Syntax

Check a checker file with `node --check`:

```bash
node --check checkers/tables.js
```

The files in `background/` and `popup/` are ES modules. Copy a file to a `.mjs` name before you check it.

### End to end

Run the end-to-end tests from the repo root:

```bash
node tools/e2e/verify.mjs
```

The script loads the extension into a real Chromium with Playwright and serves `test-pages/` on a local port. It clicks the real popup buttons and compares the findings with the `data-expect` attributes. It prints `PASS` or `FAIL` for each check and exits with code 1 if a check fails.

- The default run mutes audio and skips the audio sections.
- `--audio` runs only the audio sections, with sound.
- `--all` runs both.

The browsers open in headed mode and take focus. Do not use the keyboard or the mouse while the tests run. A click or a key press gives the test page user activation, and the user-activation checks then fail.

### Keyboard-trap scanner

See [tools/keyboard-trap-scan/README.md](tools/keyboard-trap-scan/README.md).

## Add a checker

1. Add the checker file in `checkers/`. Register it on `globalThis.__a11yCheckers`.
2. Add a row and a badge in `popup/popup.html` and `popup/popup.js` (`BADGE_BY_TOOL`).
3. If the checker can run in a batch, add a `CHECKERS` registry entry in `popup/popup.js` and a checkbox with the same `data-batch-id` in `popup/popup.html`.
4. Add a test page in `test-pages/` with `data-expect` attributes.
5. Add a section for the checker to `tools/e2e/verify.mjs`.
6. Add the checker to [docs/checkers.md](docs/checkers.md).

## Rules for findings

Each finding has these fields: `tool`, `wcag`, `severity`, `selector`, `snippet`, `details`, `url`, `timestamp`, `status`. The keyboard-trap scanner writes the same columns. If you change the columns, change both CSV writers: `popup/csv.js` and `tools/keyboard-trap-scan/lib/csv.js`.

- Use `review` when the checker cannot prove the result. Do not change an uncertain result to `fail`.
- Write `details` as full sentences. Name the requirement of the WCAG criterion. For `review` and `warn`, say what the tester must check.
- The run-over-run diff uses `tool|wcag|selector` as the key. If you change how the selector is made, the diff history of each user resets.

## Architecture notes

[CLAUDE.md](CLAUDE.md) has the detailed architecture notes, the contracts between the parts, and the browser problems that the code works around. Read it before you change `background/`, the message protocol, or a shared library in `checkers/lib/`.
