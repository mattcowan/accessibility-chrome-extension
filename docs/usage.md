# Use the extension

## Emulation modes

The emulation modes apply to one tab. They use the Chrome DevTools Protocol through the `chrome.debugger` API.

- **Reduced motion:** `prefers-reduced-motion: reduce`.
- **Color scheme:** `prefers-color-scheme: dark` or `light`.
- **Forced colors:** `forced-colors: active`. This is near to Windows High Contrast. Chromium draws the forced palette.
- **Contrast:** `prefers-contrast: more` or `less`. This is near to macOS Increase Contrast. It sets the media feature only, so the page must support it.
- **Reduced transparency** and **Inverted colors:** the popup hides these controls if your Chrome version does not accept them.
- **Reflow test:** a 320 px viewport override for WCAG 1.4.10, plain or at 4× zoom. The 4× option is equal to a 1280 px window at 400% browser zoom, which is the standard 1.4.10 test condition. It shows the content magnified, as a low-vision user sees it.
- **Vision simulation:** protanopia, deuteranopia, tritanopia, achromatopsia, blurred vision, and reduced contrast. These are Chrome's built-in simulations. You can use one at a time.

## The debugger bar

Emulation uses the `chrome.debugger` API. It is the only way for an extension to emulate CSS media features and vision deficiencies. While a mode is on, Chrome shows a yellow bar that says that the extension "started debugging this browser". When you turn off all modes, the extension detaches and the bar goes away.

- DevTools and the extension cannot debug the same tab at the same time. If DevTools is open, emulation fails with a message. If you open DevTools during emulation, emulation stops.
- If you close the bar (×), emulation also stops. The popup shows this.
- Emulation is not available on `chrome://` pages, the Chrome Web Store, or other extensions.

## Run selected (batch)

Each checker row that can run in a batch has a checkbox. **Run selected** runs the selected checkers one at a time and updates each badge when it completes. The checkers share the page, the focus, and the mouse, so they cannot run in parallel. The extension keeps your selection between sessions.

- **Auto-update** runs first, before the other checkers focus, style, or hover the page. It is off by default, because it adds its watch time to the run.
- The **Reflow scan** checkbox is enabled only while the Reflow emulation toggle is on.
- The hover row has two checkboxes. **static** is a fast CSS analysis that reports the candidates it did not probe as `review`. **probe** is the full pointer probe. It is slow and moves the real mouse, so it is off by default. **probe** includes **static**.
- At the end of a batch, the text spacing analysis removes its spacing overrides, so they cannot change the results of other checkers. The text spacing button in its own row leaves them applied.
- Tables does not draw its overlay in a batch. If the overlay is already on, the batch updates it.
- The tools that start and stop are not in the batch: text spacing apply and remove, the accessible-name inspector, the live-regions monitor, the focus locator, error capture, and the input watcher. Audio **Reload and record** is not in the batch either, because it reloads the page.

## Report

- The report keeps findings per tab **and per page**. When the tab goes to a different URL, a new report starts, so one export never mixes sites.
- The report groups findings by checker and shows the full detail text.
- **Click a finding to show it on the page.** The page scrolls to the element and outlines it in the color of its severity. **Highlight all** outlines all findings of one checker and does not scroll.
- Page-level findings (`(page)`) have no element to show. If the page changed after the run, a message tells you to run the checker again.
- For a finding in an iframe, the outline goes in the iframe, and the iframe scrolls.
- **Export CSV** writes an RFC 4180 file that Excel opens correctly. Two header lines give the URL of the run and the time of the export. The columns are: tool, wcag, severity, selector, snippet, details, url, timestamp, status.
- **Run-over-run diff:** when you run a checker again, the report marks each finding `new` or `existing` and lists the `resolved` ones. The extension keeps this history per URL and checker, also after a browser restart.
- **Clear all checkers** resets all in one click. It removes everything that the checkers put on the page and clears the tab's findings and the Tables list. Your data or layout table choices stay. **Clear overlays** and **Clear findings** reset one part only.

## Side panel

**Open in side panel**, at the top of the popup, puts the same controls in Chrome's side panel. The panel stays open while you use the page. The popup closes each time you click the page.

The panel follows the active tab. When you change tabs or go to a new page, the panel updates its state, badges, and report.

After a navigation, the extension must get a new permission to run checkers on the page (activeTab). Click the extension's toolbar icon on that tab, close the popup, and run the checker again. Emulation toggles do not need this step, because they use the debugger permission.

## Permissions

| Permission | Why the extension needs it |
| --- | --- |
| `debugger` | Emulation, the hover probe, and the reads of click listeners and table roles. |
| `scripting` | To run the checkers in the page. |
| `activeTab` | To get access to the current page when you click the toolbar icon. The extension has no host permissions. |
| `storage` | Findings, run history, settings, and your table choices. |
| `sidePanel` | The side panel. |
| `tabs` | To let the side panel read the URL of the active tab when you change tabs. |

Chrome shows the `tabs` permission as "Read your browsing history" in the install warning. Without it, `chrome.tabs.query` gives no `url` for a tab that has no activeTab permission. The `debugger` permission already lets the extension get the URL and title of each tab through `chrome.debugger.getTargets()`. The `tabs` permission makes that access normal and continuous.
