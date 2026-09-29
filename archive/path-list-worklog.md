# Path list worklog

- Added a menu button to copy all opened image paths, newline-separated.
- Added clipboard-list loading from the menu and standard paste events (including Ctrl+V) on the page. Relative entries resolve from `index.html`; absolute web URLs are used directly.
- Updated the viewer to display URL-backed entries as well as picked local files.
- Validation: `node experiments/test-files.js`, `node experiments/test-viewer.js`, and `git diff --check` pass.
- Next step: verify clipboard permissions and relative URL behavior in target browsers and under `file://`.
