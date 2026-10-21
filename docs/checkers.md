# Checkers

Each checker runs when you start it from the popup or the side panel. Each section names the WCAG 2.2 success criterion and the Trusted Tester (TT) 5.1 test that the checker helps with. TT 5.1 tests that this page does not name are manual tests. Use ANDI for them.

Severity has three values:

- `fail`: the checker found a defect.
- `warn`: the checker found a probable defect. Check it.
- `review`: the checker cannot decide. A person must check it. The checker never changes an uncertain result to `fail`.

## Contents

- [Motion respect](#motion-respect)
- [Audio autoplay](#audio-autoplay)
- [Auto-update](#auto-update)
- [Text spacing](#text-spacing)
- [Focus visibility](#focus-visibility)
- [Focus locator](#focus-locator)
- [Keyboard access](#keyboard-access)
- [Form labels](#form-labels)
- [Tables](#tables)
- [CSS positioning](#css-positioning)
- [Error capture](#error-capture)
- [Input watcher](#input-watcher)
- [Target size](#target-size)
- [Hover and focus content](#hover-and-focus-content)
- [Reflow scan](#reflow-scan)
- [Accessible names](#accessible-names)
- [Live regions](#live-regions)

## Motion respect

**WCAG:** 2.2.2 (TT 2.B), 2.3.3 (not in TT 5.1)

With reduced motion emulated, the checker reports animations and autoplay video that still run. The row has its own **Reduced motion** toggle. It uses the same emulation as the toggle at the top, so you can change it and run the checker again in the same place.

For each autoplay video, the checker looks for a pause, stop, or hide control: native controls, a control named pause, stop, play, hide, or freeze, or a control with `aria-controls` on the video. The control must be in the Trusted Tester 2.B location: the first three elements, or three elements before or after the video. Found there → `review`. Found in a different place → `warn`. Not found → `fail`.

## Audio autoplay

**WCAG:** 1.4.2 (TT 2.A)

Reports unmuted audio longer than 3 seconds that **plays now**, or that **would play** (an autoplay element that the browser's autoplay policy kept paused). It also reports embeds that request autoplay. It looks for a pause, stop, or volume control in the first three elements: `review` if found, `warn` if in a different place, `fail` if none.

If Chrome marks the tab as audible but no page element explains it (Web Audio, cross-origin iframes), the checker adds a page-level `review`.

**Reload and record** reloads the page with a recorder that catches the audio that scripts start, also the attempts that the browser blocked.

## Auto-update

**WCAG:** 2.2.2 (TT 2.C), 4.1.2 (TT 2.D)

Watches the page for a set time with no user action. Set the time in the **Watch for** field: whole seconds from 1 to 300, 10 by default, kept between sessions. An empty, zero, negative, or non-numeric value uses 10.

It reports each part of the page that changes on its own two or more times, or that keeps changing: carousels, tickers, feeds, and counters. It sees changed text, added or removed content, show/hide changes (`class`, `style`, `hidden`, `aria-hidden`, `src`, `open`), and scroll-position changes of overflow containers.

For TT 2.C, it looks for a control to pause, stop, or hide the content, or to set how often it updates. The control must be in the first three elements or within three elements before or after the content. The control's name must start with the action ("Pause", "Stop slideshow", "Change speed") and have four words or fewer, so a headline link in a ticker is not a control. A "Next slide" button is not a control either. Found there → `review`. Found in a different place → `warn`. Not found → `warn`, because only a person can decide if the "essential" exception applies.

For TT 2.D, it looks for how the user is told about the change → `review`:

- The changes are in a live region.
- A live region next to the content changes each time the content changes.
- Focus moves into the content.
- A dialog opens when the content changes, and the dialog holds the content, is inside it, or opens with most of its changes (at least three).

None → `fail`. If only inline styles change (a script animation or a progress bar), the result is `review`, because the checker cannot tell decoration from new information.

A page-level `review` tells you when Reduced motion was on, when user input occurred during the watch, when the tab was hidden during the watch, or when the page has too many scrolling containers to watch all of them.

If the popup closes during the watch (a click on the page closes it), the page continues the watch. Open the popup again to see the results. Content that only a CSS animation moves makes no page change. Motion respect reports it. The checker only watches. Do not touch the page while it runs.

## Text spacing

**WCAG:** 1.4.12 (not in TT 5.1)

Applies the WCAG 1.4.12 text spacing values to the page. Then it reports text that the new spacing clips. It does not report text that was clipped before the change.

## Focus visibility

**WCAG:** 2.4.7 (TT 4.D)

Shows the tab order with numbered badges. Reports each focusable element that shows no focus indicator. The checker compares the computed style with and without focus, and it reads the page's `:focus` and `:focus-visible` CSS rules. If the page has a cross-origin stylesheet that the checker cannot read, a `fail` becomes `review`.

## Focus locator

**WCAG:** 2.4.7, 2.1.1 (TT 4.D vs 4.A)

A start/stop tool for manual Tab tests. While you press Tab or Shift+Tab, it draws a dashed box around the element that has focus and shows its role and name. It follows focus into open shadow roots and same-origin iframes.

The label says whether the **page** shows a focus indicator on that element: an outline or ring, a subtle change only, a change on the parent or a `::before`/`::after`, or nothing. "Nothing" is a 4.D failure (2.4.7), not 4.A: focus did reach the element. The label also tells you when focus came from a mouse click, when the focused element is hidden or off-screen, and when focus is in a cross-origin frame.

It only watches. It does not move focus, press keys, or click.

## Keyboard access

**WCAG:** 2.1.1 (TT 4.A)

Reports elements that a mouse can operate but Tab cannot reach. An element is a candidate when it sets a pointer cursor, has an `onclick`-type attribute or an interactive `role`, or has a click listener. It is reported only if it is not focusable and not inside a focusable element. Items in a composite widget that arrow keys reach (roving `tabindex`, `aria-activedescendant`) are not reported.

Every finding is `review`: Trusted Tester 4.A accepts a different keyboard method for the same function, and you must look for it. The scan reads click listeners through the debugger, so the debugging bar shows for a moment. It does not test Enter or Space activation (TT 4.A step 2). Do that step by hand.

## Form labels

**WCAG:** 1.3.1 (TT 5.C)

Reports the cues that a form field gives in addition to its own name:

1. Radio buttons or checkboxes in one group with no group label: no `fieldset` with a `legend`, and no `role="group"` or `role="radiogroup"` with a name. This is `fail`. It is `review` when the question can be in a place that the checker cannot judge: a member's `aria-describedby`, table headers on every member (for example, bulk-select checkboxes), or an `aria-labelledby` on a member that joins two or more elements.
2. A label or nearby text that shows "*" or "required" when the field has no `required` or `aria-required`, or the reverse (`review`).
3. Two or more fields in one form with the same accessible name (`review`). The finding lists the table headers or the group label of each field, so you can pass 5.C without a different ANDI module. It tells you when nothing makes the fields different. Table headers are context, not part of the name.

It only reads the form.

## Tables

**WCAG:** 1.3.1 (TT section 14)

Finds every table (`<table>`, `role="table"`, `role="grid"`, `role="treegrid"`) in all same-origin frames. It guesses if each table is a data table or a layout table, and shows the signs it used: the markup, the role in Chrome's accessibility tree (`table` or `LayoutTable`), and how the table looks (a header-styled first row, cell borders and short text, or headings, lists and long text in the cells).

In the Tables list, choose **Data table** or **Layout table** for each table. The tool keeps your choice for the page and uses it for the findings.

Data table:

- An empty `th`, or a `headers` id that does not exist → `fail`.
- An empty top-left `th` that heads no data cells → `review`.
- No header cells, or Chrome shows the table as `LayoutTable` → `fail` after you choose **Data table**, else `review`.
- A header row coded as `td`, `headers` that names a `td`, or a `scope` value that is not valid (the browser then uses the position of the cell) → `warn`.
- Complex headers with no `scope` or `headers`, a `th` that heads no row or column, data cells with no header, `scope` on a `td`, or a header row in a different table → `review`.

Layout table:

- `th`, `caption`, `summary`, `scope` or `headers` → `fail` after you choose **Layout table**, else `review`.
- Chrome shows it as a data table → `review`.

An ARIA table with a cell outside a `role="row"` → `fail`. A table that the tool cannot decide gets a `review` that lists the signs.

**Run** also outlines each table on the page and colors its header cells: column headers, row headers, and headers that head no row or column. The header cells come from the HTML header algorithm (`headers`, `scope`, row groups and column groups). **Clear overlays** does not remove the outlines. **Hide overlay** does. The tool reads Chrome's roles through the debugger, so the debugging bar shows for a moment.

## CSS positioning

**WCAG:** 1.3.2 (TT 15.B)

Finds content that CSS moves away from its place in the reading order, in all same-origin frames: `position: absolute` or `fixed`, `position: relative` with an offset that is not 0, `float`, and flex or grid containers that change the order of their items (`row-reverse`, `column-reverse`, `wrap-reverse`, `order`, grid placement). It counts only content that a screen reader reads (text, an image with alt text, a form field, media). Visually hidden content (sr-only, off screen) and empty decoration give no finding.

For each moved element, the tool compares where it shows with the content before and after it in the reading order. The element shows before content that a screen reader reads first, after content that a screen reader reads later, or on top of it → `review`, and the finding names that content. A flex or grid container gets one finding that names the items out of order.

A `fixed` element in the top half of the window (a header) is compared as the page shows when it opens. A `fixed` element lower in the window (a chat button, a cookie bar) shows on every screen: it gets a `review` only when it holds a control, because a screen reader user must find that control at its place in the code. All findings are `review`: only you can decide if the meaning changes.

**Run** outlines each moved element and the content in it, with its reading-order number: orange solid = order changed, blue dashed = same order.

**Linearize** removes the positioning and the flex and grid reordering, so the page shows the moved content in reading order. ANDI's **Linearize Page** does this for positioning only. Content that is placed inside a moved element can move too, because its reference box changes. This is expected in the preview. **Undo linearize** puts back the page's own values. **Clear overlays** does not remove the outlines. **Hide overlay** removes them and ends **Linearize**.

## Error capture

**WCAG:** 3.3.1 (TT 5.F), 3.3.3 (TT 5.G)

A start/stop tool. Start it, type bad data, and submit the form yourself. A click on a button, Enter in a field, a submit, or the browser's own validation (`invalid` event) starts a capture. When the page stops changing, the capture compares each field with its state at start.

Each field that shows an error gets one 3.3.1 finding. The finding quotes the error text, so you can judge 3.3.3 from it. It names the cues it found and the cues that are missing: error text, text tied to the field (`aria-describedby` or `aria-errormessage`), `aria-invalid="true"`, and an announcement (live region or `role="alert"`) or a focus move to the error. An error that only changes a color, with no text, is `warn`. All other findings are `review`.

It only watches. It does not type, click, or submit.

## Input watcher

**WCAG:** 3.2.2 (TT 5.D), 4.1.2 (TT 5.E)

A start/stop tool. While it is on, change the fields yourself and tab away. For each change, it logs what the field's `input`, `change`, or blur caused: a navigation or reload, a new tab or window, a form submit, a focus move by a script (no Tab key or click before it), or content shown in a different part of the page. For shown content, it tells you if focus moved to the content and if a live region changed.

Each field gets one `review` finding for 3.2.2 and one for 4.1.2. The service worker keeps the log, so a navigation finding stays after the page navigates. After a navigation, **Resume watcher** continues the same log on the new page.

It never attaches the debugger. It only watches. It does not type, select, or submit.

## Target size

**WCAG:** 2.5.8 (not in TT 5.1)

Reports interactive targets smaller than 24 × 24 CSS pixels. The spacing and inline exceptions are approximations.

## Hover and focus content

**WCAG:** 1.4.13 (not in TT 5.1); `title` triage for 3.3.2 (TT 5.A) and 2.4.4 (TT 6.A)

The checker does two jobs:

1. It sorts `title` tooltips. WCAG 1.4.13 does not apply to them, because the browser controls them. A redundant title → `warn`. A title with information that is not in a different place → `review` under 2.4.4 and 1.3.1. A field whose only label is its title → `review` under 3.3.2.
2. It finds content that CSS shows on hover or focus. It moves the **real** mouse pointer with debugger mouse events to show the content, then tests if Escape closes it. Tooltips that a page makes itself can fail 1.4.13.

## Reflow scan

**WCAG:** 1.4.10 (not in TT 5.1)

Turn on the 320 px reflow emulation first. The scan then reports elements that make the page scroll horizontally. Tables, images, and code get `review`, not `fail`, because WCAG 1.4.10 exempts content that needs a two-dimensional layout. Check that the element needs it.

## Accessible names

**WCAG:** 4.1.2 (an empty name fails TT 5.C for a form field and TT 6.A for a link)

Reports interactive elements with an empty accessible name. An inspector shows the role, the name, and the source of the name for the element under the pointer. Press Escape to stop the inspector.

## Live regions

**WCAG:** 4.1.3 (not in TT 5.1)

A start/stop monitor. It finds each live region (`aria-live`, `role=status`, `role=log`, `role=alert`, `<output>`) and attaches a visible log panel to it on the page. The panel has a green **polite** tag or a red **assertive** tag. The monitor adds each announcement to the log with a time. It never overwrites an entry.

**Export log** downloads the messages as their own CSV file (selector, politeness, role, message, timestamp, url). Regions that the page adds after the start also get panels, but the badge counts only the regions at the start. Start the monitor again to update the count.

Stop discards the log. Export the log before you stop the monitor.
