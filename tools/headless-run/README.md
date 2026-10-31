# Headless runner

## What it does

This command runs the extension's batch checkers on one page, with no browser window. It writes the findings as JSON or CSV. A script, a CI job, or an AI agent can use it. Nobody needs to click **Run selected** in the popup.

The command drives the popup's own code in headless Chromium, so its findings are the popup's findings: the same checkers, the same batch order, and the same findings schema.

## Setup

The command uses the Playwright install of the keyboard-trap scanner:

```bash
cd tools/keyboard-trap-scan
npm ci
npx playwright install chromium
```

Branded Google Chrome does not load unpacked extensions from the command line. The command uses Playwright's Chromium.

## Usage

```bash
node tools/headless-run/run.mjs <url|file> [--checkers id,id] [--reduced-motion]
  [--reflow 320|320zoom] [--json file|-] [--csv file|-] [--settle ms] [--timeout s]
```

Run it from any folder. Examples:

```bash
# The default checkers; the JSON goes to stdout.
node tools/headless-run/run.mjs https://example.com/

# Two checkers, the JSON and the CSV to files.
node tools/headless-run/run.mjs https://example.com/ --checkers form-labels,tables \
  --json findings.json --csv findings.csv

# A local file. Its folder is served on http://127.0.0.1.
node tools/headless-run/run.mjs test-pages/reflow.html --reflow 320 --checkers reflow
```

### Options

- `<url|file>` (required): an `http` or `https` URL, or a local HTML file. Extensions cannot run on `file://` pages, so the command serves the file's folder over `http://127.0.0.1` on a free port. The `url` of each finding then has that address.
- `--checkers id,id`: the checkers to run. They always run in the popup's batch order. With no `--checkers`, the command runs the checkers that are ticked by default in **Run selected**. An unknown id gives an error that lists the valid ids. `--help` lists them too.
- `--reduced-motion`: turn on `prefers-reduced-motion: reduce` before the checkers run.
- `--reflow 320` or `--reflow 320zoom`: turn on the Reflow test viewport before the checkers run. The `reflow` checker needs it. With no `--checkers`, the `reflow` checker runs only when you give `--reflow`, as in the popup.
- `--json file`: write the findings as a JSON array. `-` writes to stdout.
- `--csv file`: write the findings as CSV, with the columns of the popup's **Export CSV**. `-` writes to stdout.
- With no `--json` and no `--csv`, the JSON goes to stdout.
- `--settle ms` (default 1500): the time to wait after the page loads, before the checkers run.
- `--timeout s` (default 600): stop if the batch does not end in this time.

Progress and a summary go to stderr.

### Checker ids

| Id | Default | Checker |
| --- | --- | --- |
| `auto-update` | no | Auto-update (it adds its 10-second watch) |
| `motion` | yes | Motion respect |
| `audio` | yes | Audio autoplay (static scan; not Reload and record) |
| `focus-visibility` | yes | Focus visibility |
| `keyboard-access` | yes | Keyboard access |
| `form-labels` | yes | Form labels |
| `tables` | yes | Tables (the tool's guess; no saved choices) |
| `css-position` | yes | CSS positioning |
| `target-size` | yes | Target size |
| `reflow` | yes, with `--reflow` | Reflow scan |
| `text-spacing-analyze` | yes | Text spacing (the overrides are removed after the run) |
| `hover-static` | yes | Hover and focus content, static pass |
| `hover-probe` | no | Hover and focus content, full pointer probe (includes `hover-static`) |

The tools that need a person to act on the page are not available: error capture, the input watcher, the focus locator, the accessible-name inspector, and the live-regions monitor.

### Exit codes

- `0`: no `fail` finding. There can be `warn` and `review` findings.
- `1`: one or more `fail` findings.
- `2`: a usage error, or the run failed (for example, the page did not load).

## Output

The JSON is an array of findings. Each finding has these keys, in this order: `tool`, `wcag`, `severity`, `selector`, `snippet`, `details`, `url`, `timestamp`, `status`. The CSV has the same columns. These are the extension's and the keyboard-trap scanner's columns.

- Each run uses a new browser profile, so there is no run history: `status` is always `new`.
- If a checker fails in a frame, a `(page)` finding with severity `review` tells you what was not checked. If a checker cannot run at all, the command adds a `(page)` review for it. A failed checker never reads as "0 findings".
- `review` findings need a person to check them. An agent can run the command on each page and give the `review` findings to a person.

## How it works

1. The command copies the extension to a temp folder and adds `host_permissions` to the copy. The copy can then run the checkers without an activeTab click. The extension's own `manifest.json` does not change.
2. It starts Chromium in headless mode with the copy loaded. It opens the popup page in one tab and the URL in another tab.
3. It reloads the popup, so the popup takes the page as its tab. It saves the checker selection first, so the popup shows the asked checkboxes ticked.
4. It clicks **Run selected** in the popup and waits for the batch to end. Then it reads the findings from the popup's session storage.

The command never runs a script in the page itself. A Playwright `page.evaluate` call gives the page user activation, and the page could then do things that it cannot do on a normal load, such as start audio ([#15](https://github.com/mattcowan/accessibility-chrome-extension/issues/15)).

## Differences from a person's browser

- The window is 1280 × 720 CSS pixels.
- Audio is muted. The profile is new, so Chromium's autoplay policy blocks media that would play with sound until the user acts on the page. The audio checker reports such media as `review`. In a person's browser, a site that they often use can be allowed to autoplay.
- The checkers see a mouse-type pointer (`hover: hover`), as on a desktop.
- Nobody moves the mouse or presses keys while the checkers run, so no input changes the results.
