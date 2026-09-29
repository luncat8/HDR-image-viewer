# Path list worklog

## What the feature is

- A menu button copies every opened image path, newline separated, to the clipboard.
- A menu button, or ctrl-v on the page, reads the clipboard as one image path per line.
  A line is a path relative to `index.html`, or an http(s) link used as it stands.
- A pasted entry carries no `File`, only a path and the `src` it resolved to, so the viewer
  can display it and the list can show it like any other row.

## Faults found in review, and the fix for each

1. `js/files.js` and `js/app.js` were written with `\\r?\\n` and `join('\\n')`, literal
   backslashes, not newline escapes. Nothing ever split on a line break, the paste guard
   never matched, and copy all produced one long line. Fixed at `js/files.js:53`,
   `js/app.js:129`, `js/app.js:136`.
2. `gpu.html` had no paste/copy buttons, and `js/app.js` attached a listener to them
   unguarded, so the whole wiring file threw on that page before the pickers, drop, keys
   or wheel were ever connected. The buttons are on both pages now, and `menuAction()`
   (`js/app.js:104`) skips a button a page does not carry, so a page can never again take
   the rest of the file down with it.
3. `js/app.js:55` named a newly added image with `item.file.name`, which a pasted entry
   does not have. The name comes from the path now.
4. `js/expand.js:315` sniffed `item.file` unconditionally. A pasted entry has no bytes, so
   the sniffer threw inside the load and `finish()` never ran, leaving the viewer busy for
   good: no arrow, no wheel, nothing. It takes the native route when there is no file.
5. A single path with no line break was dropped without a word. The paste event is now
   claimed whenever the clipboard really holds image paths, one line or many, and left to
   the browser otherwise.
6. A windows path pasted as `C:\pics\a.png` resolved to the url scheme `c:`, and the entry
   opened as a broken image. Backslashes are normalised, and anything that is not http(s)
   but looks like a scheme is dropped before resolution.

## Validation

- `node experiments/test-pages.js` (11 checks) is new. It reads the ids each page really
  declares, checks app.js and expand.js ask for nothing the page lacks, and then loads
  app.js against that exact id set: a missing button used to show up as a thrown
  `addEventListener` and thirteen missing window listeners, and now fails nothing.
- `node experiments/test-app.js` (160 checks) covers copy all, the paste button, the paste
  event, a refused clipboard, a single line, a clipboard with no paths, and a paste landing
  on a text field. The harness stub now keeps the real `URL`, which `fromPaths` needs.
- `node experiments/test-files.js` (38 checks) covers the line splitting, the base url
  resolution, query strings, windows paths and the scheme filter.
- `node experiments/test-viewer.js` (67), `node experiments/test-sniff.js` (32), `git diff --check`.

## Next step

Open `index.html` and `gpu.html` from `file://` and over a real origin and paste: a list of
relative paths, a single link, a link that 404s, and a cross origin image on the WebGPU
page, which has to fall back to the native `<img>` because a cross origin bitmap is not
origin clean for `copyExternalImageToTexture`.
