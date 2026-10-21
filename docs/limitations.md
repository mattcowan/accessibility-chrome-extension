# Limitations

## All checkers

- Checkers run in same-origin frames only (activeTab). The extension does not scan cross-origin iframes.
- No checker can see into a closed shadow root.
- If you go to a new page in the tab while the popup is closed, open the popup again before you run a checker. This gives the extension a new activeTab permission.
- The accessible-name computation is a simplified subset of the AccName algorithm.
- "First three elements" (Trusted Tester) is counted in reading order: each control, media element, image with alt text, and run of text. Findings also give the tab-stop position of the control.

## Focus

- Focus-indicator detection is a heuristic. Synthetic focus does not always match `:focus-visible`, and the extension cannot read cross-origin stylesheets. Such findings change to `review`.
- The focus locator compares the focused element with its unfocused style. It records that style when you start it, when an element is added to the page, and each time an element loses focus.
- Some elements have no record when they first get focus: an element that gets focus at the moment it is added (for example, the first control in a dialog), and an element that loads later inside a frame or a shadow root. For these, the verdict says that the comparison is not available. Tab away and back to get a full verdict.
- The locator does not see indicators drawn on elements other than the focused element, its parent, and its `::before`/`::after`.

## Keyboard access

- The scan cannot tell which element a delegated listener serves (one listener on `<body>` or on a container, such as the React 17+ root).
- It ignores listeners on `<html>` and `<body>`. It also ignores a container when the listener is its only signal and it holds a focusable element. A listener-only container with nothing focusable inside is still reported.
- A listener-only card with no pointer cursor is not reported if it holds a link, even if that link does something else.
- The scan does not read click listeners inside iframes. The other signals still apply there.
- If DevTools is open on the tab, the scan cannot read listeners. It adds a page-level `review` that says so.

## Forms

- Error capture and the input watcher run in the top frame only. They do not see forms in iframes. The Form labels checker runs in all same-origin frames.
- Error capture compares each field with its state when you started the capture. Any new text near a field counts as error text, so a character counter can show as error text.
- If the submit loads a new page, the capture stops with the old page. It does not record errors that a server shows on the new page.
- Trusted Tester 5.1 does not say if a browser validation message (the bubble that a `required` field shows) counts as error text. Error capture quotes the message and tells you to judge it.
- The input watcher links a navigation or a new tab to a field when it comes less than 5 seconds after the field changed. A click on a different element cancels the link, and so do Enter and Space on a button, because they also click it. Enter in a field also cancels the link.
- If you reload the page yourself in that time, the watcher logs the reload against the field. A tab that `window.open` opens can have no URL yet when the watcher logs it.
- The Form labels checker finds table headers with the HTML table header algorithm: the `headers` attribute, or `scope` and `th` cells in the same row and column, with row groups and column groups. It also uses each row header in the field's row and each column header in its column at any position, as Chrome does. If the table uses `rowspan` or `colspan`, the finding tells you to check the headers.

## Tables

- The Tables checker reads Chrome's table roles in the top document only. Tables in iframes and in closed shadow roots get no Chrome role.
- If DevTools is open on the tab, the checker cannot read the roles. It adds a page-level `review`.
- The checker checks the markup. It cannot tell if the header text is correct. Check that each header names its row or column as the page shows it.
- The data or layout guess is a heuristic. The extension keeps your choice in the Tables list by the table's selector. If the page changes so that the selector changes, the tool uses its guess again.

## Hover

- The hover checker finds only reveals that CSS rules make (`:hover` or `:focus` that changes display, visibility, or opacity). It does not probe tooltips that JavaScript shows.

## Audio and auto-update

- Audio results depend on the browser profile. Chrome lets a site autoplay with sound after user interaction or when its Media Engagement Index is high. So the same page can play on one profile and be blocked on another. The checker reports blocked autoplay as `review` ("would play").
- No extension API can turn off the autoplay policy. To test with it off, start Chrome with `--autoplay-policy=no-user-gesture-required`.
- Checkers do not give the page user activation. The popup and the side panel send each script through the service worker, which drops the click's user gesture before it injects the script.
- A click that you make on the page gives it user activation, as for any user. After that, the page's scripts can start sound that the browser blocked before. To see the audio behavior of a page when it first loads, run **Reload and record**.
- Auto-update runs in the top frame only. It does not watch iframes, or shadow roots that the page attaches after the watch starts. It ignores changes in the second after a key press, click, touch, or wheel scroll on the page.
