# findings, pitfalls, skills

## `var` in a loop, captured by an async callback

```js
while (stack.length) {
	var top = stack.pop();
	readDir(top.entry).then(function (kids) {
		stack.push({ path: top.path + '/' + kids[0].name });   // wrong path
	});
}
```

`var` is function-scoped, so every callback closes over the *same* binding. By the time the
callback runs, `top` is whatever the loop reached last. Copying `var dir = top.path` does not
help — it is the same binding under a new name.

Fix: move the work into its own function so the value is a parameter, one binding per call.

```js
function take(entry, path) { readDir(entry).then(function (kids) { /* path is ours */ }); }
```

Same trap with `forEach` and a `var i`, and with any callback that escapes the loop body.
`let` in a `for`/`for...of` header also fixes it, but the helper-function form also fixes the
recursion-depth problem, so it is usually the better shape.

## Driving browser code from node

Stub `window`, `document`, `Image`, `URL`, `requestAnimationFrame` and `require()` the file.
Works because the project keeps each file a global with a `module.exports` guard.

Two traps:

- **A stubbed `Image` is one shared object.** Real code reuses a single `<img>` element, so a
  queue of "pending loads" collected in the `src` setter holds N references to the same
  object. Snapshot the handlers at `src`-set time
  (`{ onload: this.onload, onerror: this.onerror }`) or every record aliases and the test
  passes for the wrong reason.
- **Assertions with side effects.** `eq('x', key('ArrowRight'), 1)` presses a key, so the next
  assertion starts from a moved state. Return the post-press state from the helper
  (`{ index, prevented }`) and assert on that instead.

Also: fire `onload` synchronously from the `src` setter. Production code assigns handlers
before `src`, and a synchronous callback keeps the harness deterministic with no timers.

## Natural sort

The widely copied digit shortcut compares *digit-run lengths*:

```js
if (nx.length !== ny.length) return nx.length - ny.length;   // p1, p10, p100, p11, p2
```

That is not natural order. To get `p2 < p10 < p250`, skip leading zeros from each run, then
compare remaining lengths, then the digits one by one. No allocation needed.

## `direction: rtl` to keep the tail of a path visible

Reverses the path. `photos/img.png` renders as `img.png/photos`, because the base direction
reorders the LTR runs around the neutral `/`. Use a basename in the label and the full path in
the `title` attribute instead.

## Wheel input needs a notch, not an event

A trackpad two-finger flick emits dozens of small `wheel` events; a mouse notch emits one
large one. Mapping events 1:1 to next/previous pages through an entire folder in one gesture.
Accumulate `deltaY` (or `deltaX`, whichever dominates) to a threshold, fire, then hold a
short cooldown. Register with `{ passive: false }` or `preventDefault()` is ignored, and skip
`ctrlKey` so browser zoom survives.

Clear the accumulator when the underlying set changes, or a half-accumulated flick fires a
step the instant a new set is opened.

## Overlays claim their own scroll

A `wheel` handler on `window` also fires for events over a floating panel, so a list that
scrolls under the pointer will page the image behind it as well. Guard with
`panel.contains(e.target)`. `overscroll-behavior: contain` is not a substitute — it stops
scroll chaining, not the event.

## Object URLs and `File` both pin memory

Revoking the object URL is not enough to free a picked file. The `File` objects held in the
list each keep a handle to the bytes, so a folder of large images stays resident even though
only the current one is decoded. A "forget" or "close" action has to clear the list as well as
revoke the URL, and clear the `<img>` `src`.

## Flex + `text-overflow: ellipsis`

A flex item needs `min-width: 0`; the default `min-width: auto` refuses to shrink below the
content, so the ellipsis never appears.

## Canvas 2D options

`getContext('2d', { colorSpace: 'display-p3' })` returns `null` where unsupported and can
throw. Both need handling: `try { var c = el.getContext(...); if (c) return c; } catch (e) {}`
then the plain call.

But do not reach for a canvas to display an image at all. A 2D canvas is 8 bits per channel,
so any HDR content drawn into it is clamped to SDR at draw time. `colorSpace: 'display-p3'`
widens the gamut without adding bits, which is a different problem from the one HDR has, and
it is an easy mistake because it looks like the fix. A plain `<img>` is composited by the
browser, which already decodes, colour-manages and tone-maps for whatever the display can do.
`object-fit: contain` is the contain fit, in CSS.

## `webkitGetAsEntry` must be called before `drop`

Chrome invalidates the `DataTransferItem` list once the drop has fired, so
`item.webkitGetAsEntry()` returns `null` in the `drop` handler — for *every* item, with no
error. `dataTransfer.files` is still readable there, which is why dropped *files* work and a
dropped *folder* silently comes back empty.

```js
var entries = [];
window.addEventListener('dragenter', function (e) {
	entries = Files.captureEntries(e.dataTransfer);   // still readable here
});
window.addEventListener('drop', function (e) {
	Files.fromDataTransfer(e.dataTransfer, entries);  // walk the captured roots
});
```

A drag that never fires `dragenter` still needs to work, so `fromDataTransfer` should capture
live when it is given no entries. Clear the capture on `dragleave` so a stale drag cannot feed
the next one.

Testable: mock a live transfer whose `webkitGetAsEntry` returns a directory, then a *spent*
one that returns `null` and has an empty `files` list. That is exactly what the browser does,
and it is the only way the bug shows up in a harness.
