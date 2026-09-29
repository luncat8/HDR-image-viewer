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

## `undefined < 0` is `false`

```js
api.item = function (i) { return list[i < 0 ? index : i] || null; };   // item() -> null
```

The intent was "no index means the current one", but the negative test does not catch
`undefined`, so `list[undefined]` is `undefined` and the caller gets `null` with no error.
Either test `i == null || i < 0`, or make every caller pass the sentinel explicitly.

## A hover that opens a panel will reopen it from the same pointer

Open a panel when the pointer reaches a screen edge and it closes correctly — then the pointer
is still in the strip, so it opens again on the next move.

The fix is not a "spent" flag bolted onto the open path. Make it a drawer: it also closes when
the pointer leaves, so the pointer that closed it is by definition not in the trigger zone
any more, and the guard disappears along with the whole class of bug.

```js
window.addEventListener('pointermove', function (e) {
	if (e.clientX <= EDGE) { if (panel.hidden) openList(); return; }
	if (!panel.hidden && e.clientX > LEAVE) closeList();
});
```

The close threshold is the panel's own geometry. A constant next to the width in the CSS is
better than `getBoundingClientRect()` per mouse move, which forces a layout read on every
event. Keep the number and the `width` next to each other in review.

The other trap this version had: the **button that replaces the gesture** sat inside the
trigger zone, so reaching for it opened the panel and the click closed it again. Either move
the control out of the zone or skip the gesture when the move lands on a control
(`if (bar.contains(e.target)) return;`).

## One icon, many rows: clone a template, do not share a node

An `<svg>` per row in a 5000-row folder is 5000 parses. Put it in a `<template>`, take
`content.firstChild` once and `cloneNode(true)` it into each row. Appending one node to many
parents moves it rather than copying it, so the check that matters is that two rows do not
share:

```js
eq('each row gets its own glyph node',
	rows()[0].children[2].children[0] === rows()[1].children[2].children[0], false);
```

## A button inside a list steals the keyboard

Clicking a per-row button focuses it, and the app's key handler skips anything typed into a
control — so after one click of a small button, the arrow keys stop paging the image. Blur it
in the same handler that runs its action:

```js
copy(Viewer.item(i).path);
cp.blur();
```

## Hold-to-open gestures are testable without sleeping

A long press is a `setTimeout`. Swap the globals for the duration of the test, fire the
`pointerdown`, then fire whatever it queued:

```js
const withFakeClock = fn => {
	const q = new Map();
	const realSet = global.setTimeout, realClear = global.clearTimeout;
	let id = 0;
	global.setTimeout = f => { q.set(++id, f); return id; };
	global.clearTimeout = i => q.delete(i);
	try { fn(() => [...q.values()].forEach(f => f())); }      // snapshot, not live iteration
	finally { global.setTimeout = realSet; global.clearTimeout = realClear; }
};
```

Snapshot the queue before firing, or a handler that re-arms its own timer loops forever.
Swapping `clearTimeout` matters too: a real `clearTimeout(1)` can cancel an unrelated node
timer that happens to hold the same id.

## Async events that repeat: drop, do not queue

A key held down repeats at the OS rate and a wheel flick keeps emitting. If every event turns
into a request for an async operation, they pile up: the viewer ends up decoding a whole
folder nobody asked for, one object URL and one decode per event, and only the last result is
ever seen. A token that discards a superseded result fixes the *visible* result and none of
the work.

Guard the start instead:

```js
if (busy) return;      // one load in flight; a step that arrives too early is dropped
busy = 1;
img.onload = function () { if (mine !== token) return; busy = 0; report(); };
img.onerror = function () { if (mine !== token) return; busy = 0; failed = 1; report(); };
```

The trap is the door out. Anything that *replaces* state rather than stepping through it —
open a new set, forget, empty — has to clear `busy` before it shows anything, or the new
set's own first load is dropped by its own guard and nothing appears at all. `onerror` has
to clear it too, or one undecodable file wedges the viewer permanently.

Coalescing (remember the direction, apply it after the load) feels smoother under a held
key, and is the same bug with extra state: it still walks every image the burst asked for.

## Two async handlers racing: the newest must win, not the first

Same shape one level up, in the drop path. A directory walk is async and a big tree is slow,
so a second drop can land while the first is still walking. If both call the same setter on
the way out, the set on screen ends up being whichever walk *finished* last — the one that
arrived first. Mark each request and drop a result whose mark is stale:

```js
var mine = ++token;
Files.fromDataTransfer(e.dataTransfer).then(function (items) {
	if (mine !== token) return;   // a later request already took the set
	load(items);
});
```

Note the direction differs from the previous section. Steps are dropped; a whole new set
replaces an old one, and the user's most recent action cannot be the one ignored.

Testing this needs the mocks released out of arrival order — newest first, so the stale
walk is the one that lands last. Released in order, the test passes with and without the
guard, because the stale result is then the last one to arrive and happens to be right.

## `navigator` is a getter on `globalThis` in node 22

`global.navigator = {...}` silently does nothing. Use
`Object.defineProperty(global, 'navigator', { value, configurable: true, writable: true })`,
and have the code under test read `navigator.clipboard` at call time so it can be swapped
between a working, a refusing and an absent clipboard.

## Ellipsis on a path cuts off the part that matters

`text-overflow: ellipsis` on a full path drops the tail, which is the file name — the only
part a row exists to show. Split the row into two spans: the folder is the flex item with
`min-width: 0` that shrinks, the name is `flex: none`. The name is then always the readable
end. (`direction: rtl` was the other way to try this; it reverses the path instead.)

## Drag & drop on `file://` in Chrome vs Firefox

Three traps combine when reading dropped files and folders on a local `file://` page:

1. **Never capture entries in `dragenter` or `dragover`.** Outside `dragstart` and `drop`, the
   `DataTransfer` data store is in *protected mode*. Calling `webkitGetAsEntry()` during
   `dragenter`/`dragover` either returns `null` (Firefox) or, in Blink, creates an entry
   whose isolated filesystem is not registered until `drop`, poisoning the drop if reused.
2. **Chrome's `webkitGetAsEntry()` fails on `file://` origins.** Blink's legacy `DOMFileSystem`
   builds internal `filesystem:file:///...` URLs that fail asynchronously with `EncodingError`
   when `entry.file()` or `reader.readEntries()` runs under an opaque `file://` origin.
   `DataTransferItem.prototype.getAsFileSystemHandle()` uses native OS handles instead of
   `filesystem:` URLs and works for both files and directories on `file://` in Chrome.
   Firefox does not implement `getAsFileSystemHandle()`, and its `webkitGetAsEntry()` works
   on `file://`.
3. **Snapshot everything synchronously in `drop` before going async.** The browser clears
   `dataTransfer.files` and `dataTransfer.items` as soon as the synchronous `drop` handler
   returns. Reading `dt.files` inside an async fallback callback (after an entry walk fails)
   sees an empty `FileList`. Synchronously in `drop`:
   - copy `dt.files` (and `item.getAsFile()`) into a plain array,
   - invoke `item.getAsFileSystemHandle()` for all file items before any `await`,
   - invoke `item.webkitGetAsEntry()` for all file items as fallback.

## Post-decode debounce (`img.decode()` + completion-anchored cooldown)

Two browser behaviours cause next/previous input to advance again right after a large image
opens:

- In Firefox, `img.onload` on a `blob:` URL fires as soon as the blob header is read (< 1 ms),
  hundreds of milliseconds *before* pixel decoding finishes. Waiting for `img.decode()` inside
  `onload` keeps `busy` set until the frame is actually decoded.
- In Chrome, decoding a large HDR image can stall the main thread until `onload`, so `keydown`
  and `wheel` events emitted during the decode sit in the browser's task queue and run on the
  turn immediately after `onload`. If a 100 ms cooldown was started when navigation *began*,
  a 300 ms decode finishes with that cooldown already expired 200 ms ago, and the queued
  events immediately trigger another step.

Fix: drop all navigation input and zero the wheel accumulator while `busy` is set, and start
the 100 ms debounce window when the decode **finishes** (`navUntil = performance.now() + 100`),
not only when the request starts.

## Test a capability on every item, not on item 0

```js
if (!items.length || !items[0].webkitGetAsEntry) return [];   // one string item vetoes the drag
```

A `DataTransfer` can carry a string alongside its files, and that item has no
`webkitGetAsEntry`. The capability check on `items[0]` then returns `[]` and the whole drag
is lost. Test each item and skip the ones that cannot answer.

## A passing assertion can be reading leftovers

The drop path keeps the current set when a drop finds nothing, so an assertion on a *count*
after a failed drop passes against whatever the previous case loaded. Empty the set first, or
assert on a path that cannot be the leftover:

```js
els.btnForget.click();
```

The same trap made a new regression test look green against the code it was written to catch.
Worse, the sibling `Viewer.item(0)` threw on the empty set and took the rest of the run down
with it, so only the first failure was ever reported — read through `(Viewer.item(0) || {})`
so one failure does not hide the rest.

## Confirm the fix by running the new test against the old code

`git stash` is the obvious way and it is wrong when the tree already has uncommitted work
from an earlier session: it reverts that too, and the run fails on changes this round never
touched. Reconstruct the pre-fix files by hand (or keep a copy before editing) and check that
exactly the new assertions fail. A diagnostic that does not fail pre-fix is not a
reproduction — either the bug is not the one modelled, or the fix is not load-bearing, and
both are worth knowing before the code is written.

