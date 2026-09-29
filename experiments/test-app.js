// node harness: drives js/app.js against a stub DOM to check the key map, debounce,
// picker/drop wiring, deduplication, menu buttons, per-file forget, and window title.
// usage: node experiments/test-app.js
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const eq = (name, got, want) => {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a === b) { pass++; return; }
	fail++;
	console.log('FAIL ' + name + '\n  got  ' + a + '\n  want ' + b);
};

// --- element stub ---
const classList = el => ({
	add: c => el.classes.add(c),
	remove: c => el.classes.delete(c),
	toggle: (c, on) => { on ? el.classes.add(c) : el.classes.delete(c); },
	contains: c => el.classes.has(c)
});
const mk = tag => {
	const el = {
		tagName: (tag || 'div').toUpperCase(),
		title: '', value: '', files: [], hidden: false,
		classes: new Set(), handlers: {}, children: [], style: {},
		addEventListener(k, fn) { (this.handlers[k] = this.handlers[k] || []).push(fn); },
		fire(k, ev) { (this.handlers[k] || []).forEach(fn => fn.call(this, ev)); },
		appendChild(node) { node.parent = this; this.children.push(node); return node; },
		removeChild(node) { const i = this.children.indexOf(node); if (i >= 0) this.children.splice(i, 1); node.parent = null; },
		closest(sel) { return this.matches(sel) ? this : (this.parent && this.parent.closest(sel)) || null; },
		matches(sel) { return sel[0] === '.' ? this.classes.has(sel.slice(1)) : this.tagName === sel.toUpperCase(); },
		contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; },
		get firstChild() { return this.children[0] || null; },
		scrollIntoView() { this.scrolled = (this.scrolled || 0) + 1; },
		click() { this.clicked = (this.clicked || 0) + 1; this.fire('click', {}); },
		blur() { this.blurred = (this.blurred || 0) + 1; },
		select() { this.selected = (this.selected || 0) + 1; }
	};
	el.classList = classList(el);
	Object.defineProperty(el, 'className', {
		get() { return [...el.classes].join(' '); },
		set(v) { el.classes = new Set(String(v).split(' ').filter(Boolean)); }
	});
	let text = '';
	Object.defineProperty(el, 'textContent', {
		get() { return text + this.children.map(c => c.textContent).join(''); },
		set(v) {
			text = v;
			if (v) return;
			el.children.splice(0).forEach(c => { c.parent = null; });
		}
	});
	return el;
};

const els = {};
global.document = {
	getElementById: id => els[id] || (els[id] = mk(id.indexOf('pick') === 0 ? 'input' : 'div')),
	createElement: tag => mk(tag),
	body: mk('body')
};

let autoLoad = true;
els.pic = mk('img');
els.pic.naturalWidth = 4;
els.pic.naturalHeight = 4;
Object.defineProperty(els.pic, 'src', {
	set(v) { this._src = v; if (v && autoLoad && this.onload) this.onload(); },
	get() { return this._src; }
});
els.pic.removeAttribute = function () { this._src = ''; };

const winHandlers = {};
global.window = {
	devicePixelRatio: 1,
	addEventListener: (k, fn) => { (winHandlers[k] = winHandlers[k] || []).push(fn); }
};
const fire = (k, ev) => (winHandlers[k] || []).forEach(fn => fn(ev));

let liveUrls = 0, madeUrls = 0;
global.URL = {
	createObjectURL: () => { liveUrls++; return 'blob:' + (++madeUrls); },
	revokeObjectURL: u => { if (u) liveUrls--; }
};
let clock = 1000;
global.performance = { now: () => clock };

let copied = [];
let clip = { writeText: t => { copied.push(t); return Promise.resolve(); } };
const setClip = c => Object.defineProperty(global, 'navigator',
	{ value: c, configurable: true, writable: true });
setClip({ clipboard: clip });

global.Files = require(path.join(__dirname, '..', 'js', 'files.js'));
global.Viewer = require(path.join(__dirname, '..', 'js', 'viewer.js'));
require(path.join(__dirname, '..', 'js', 'app.js'));

els.list.hidden = true;
els.pic.parent = els.stage;
els.stage.parent = document.body;
els.empty.parent = document.body;
els.listItems.parent = els.list;
els.list.parent = document.body;

// --- helpers ---
const rawKey = (code, mod) => {
	let prevented = 0;
	fire('keydown', Object.assign({
		code, target: { tagName: 'BODY' },
		preventDefault: () => { prevented++; }
	}, mod || {}));
	return { i: Viewer.index(), p: prevented };
};
const press = (code, mod) => {
	clock += 120;
	return rawKey(code, mod);
};
const file = (name, rel) => ({ name, webkitRelativePath: rel || '' });
const open = files => {
	els.pickFiles.files = files;
	els.pickFiles.fire('change', {});
};
const resetOpen = files => {
	els.btnForget.click();
	open(files);
};
const rowPath = li => li.children[0].textContent + li.children[1].textContent;

const down = (x, y, extra) => fire('pointerdown', Object.assign({
	clientX: x, clientY: y, button: 0, target: els.pic, preventDefault() { }
}, extra || {}));
const move = (x, y, target) => fire('pointermove', { clientX: x, clientY: y, target: target || els.pic });
const pullOut = () => move(4, 300);
const pushBack = () => move(600, 300);
const withFakeClock = fn => {
	let id = 0;
	const q = new Map();
	const realSet = global.setTimeout, realClear = global.clearTimeout;
	global.setTimeout = f => { q.set(++id, f); return id; };
	global.clearTimeout = i => q.delete(i);
	try { fn(() => { [...q.values()].forEach(f => f()); }); }
	finally { global.setTimeout = realSet; global.clearTimeout = realClear; }
};

// --- empty state before anything is opened ---
eq('empty state visible at start', document.getElementById('empty').classes.has('hidden'), false);

// --- open three images ---
open([file('a.png', 'd/a.png'), file('b.png', 'd/b.png'), file('c.png', 'd/c.png')]);
eq('viewer got 3', Viewer.count(), 3);
eq('empty state hidden', document.getElementById('empty').classes.has('hidden'), true);
eq('title carries name, position and size', document.title, 'a.png · 1/3 · 4×4');

// --- key map: one press, both effects checked ---
eq('ArrowRight -> next', press('ArrowRight'), { i: 1, p: 1 });
eq('ArrowLeft -> prev', press('ArrowLeft'), { i: 0, p: 1 });
eq('Space -> next', press('Space'), { i: 1, p: 1 });
eq('Shift+Space -> prev', press('Space', { shiftKey: true }), { i: 0, p: 1 });
eq('KeyD -> next', press('KeyD'), { i: 1, p: 1 });
eq('KeyA -> prev', press('KeyA'), { i: 0, p: 1 });
eq('PageDown -> next', press('PageDown'), { i: 1, p: 1 });
eq('PageUp -> prev', press('PageUp'), { i: 0, p: 1 });
eq('End -> last', press('End'), { i: 2, p: 0 });
eq('Home -> first', press('Home'), { i: 0, p: 0 });
eq('unbound key ignored', press('KeyZ'), { i: 0, p: 0 });
eq('modifier combo ignored', press('ArrowRight', { ctrlKey: true }), { i: 0, p: 0 });
eq('typed in an input ignored', press('Space', { target: { tagName: 'INPUT' } }), { i: 0, p: 0 });
eq('focused button keeps space', press('Space', { target: { tagName: 'BUTTON' } }), { i: 0, p: 0 });
eq('wrap to last', press('ArrowLeft'), { i: 2, p: 1 });
eq('wrap to first', press('ArrowRight'), { i: 0, p: 1 });
eq('hud follows', document.title, 'a.png · 1/3 · 4×4');

// --- key debounce & ignore while image is still opening ---
eq('first key press steps', press('ArrowRight'), { i: 1, p: 1 });
eq('rapid second key press within 100ms debounce is ignored', rawKey('ArrowRight'), { i: 1, p: 1 });
clock += 50;
eq('50ms later still debounced', rawKey('ArrowRight'), { i: 1, p: 1 });
clock += 60;
eq('after 100ms debounce expires, key steps', rawKey('ArrowRight'), { i: 2, p: 1 });

// slow image decode: events arriving while loading AND within 100ms after load are ignored
clock += 200;
autoLoad = false;
eq('start slow load', rawKey('ArrowRight'), { i: 0, p: 1 });
clock += 300;   // 300ms into slow load, still not decoded
eq('key during slow load is ignored even after 300ms', rawKey('ArrowRight'), { i: 0, p: 1 });
els.pic.onload();   // finishes decoding at clock + 300
autoLoad = true;
clock += 50;        // 50ms after load completed: queued event arrives
eq('queued event 50ms after slow load completion is ignored by post-load debounce',
	rawKey('ArrowRight'), { i: 0, p: 1 });
clock += 60;        // 110ms after load completed
eq('event >100ms after load completion steps cleanly', rawKey('ArrowRight'), { i: 1, p: 1 });

// --- buttons open the matching picker and hand focus back to the page ---
els.btnFiles.click();
eq('files button opens files picker', [els.pickFiles.clicked, els.pickFolder.clicked || 0], [1, 0]);
eq('button releases focus', els.btnFiles.blurred, 1);
els.btnFolder.click();
eq('folder button opens folder picker', [els.pickFiles.clicked, els.pickFolder.clicked], [1, 1]);

// --- picker with no images flashes, keeps the list ---
open([file('notes.txt')]);
eq('no images keeps list', Viewer.count(), 3);
eq('no images warns', els.toast.textContent, 'no images found');
eq('toast shown', els.toast.classes.has('on'), true);

// --- adding same files again does not duplicate (GLM bug fix) ---
open([file('a.png', 'd/a.png'), file('b.png', 'd/b.png')]);
eq('re-adding same files does not duplicate', Viewer.count(), 3);
eq('re-adding same files warns already opened', els.toast.textContent, 'already opened');
open([file('b.png', 'd/b.png'), file('d.png', 'd/d.png')]);
eq('adding overlapping files adds only the new one', Viewer.count(), 4);
eq('toast reports newly added file', els.toast.textContent, 'd.png');

// --- folder picker uses webkitRelativePath ---
els.btnForget.click();
els.pickFolder.files = [file('z.png', 'root/sub/z.png'), file('a.png', 'root/a.png')];
els.pickFolder.fire('change', {});
eq('folder order', Viewer.item(0).path, 'root/a.png');
eq('folder count', Viewer.count(), 2);
eq('toast counts', els.toast.textContent, '2 images');
eq('single file toast', (resetOpen([file('one.png')]), els.toast.textContent), 'one.png');

// --- single image: keys must not throw, move, or hijack scrolling ---
resetOpen([file('solo.png')]);
eq('solo index', Viewer.index(), 0);
eq('solo key is a no-op', [press('ArrowRight'), press('ArrowLeft'), press('Space')],
	[{ i: 0, p: 0 }, { i: 0, p: 0 }, { i: 0, p: 0 }]);
eq('solo hud', document.title, 'solo.png · 1/1 · 4×4');

// --- drop ---
const entry = (name, kids) => ({
	name,
	isFile: !kids,
	isDirectory: !!kids,
	createReader: () => {
		let sent = false;
		return { readEntries: cb => cb(sent ? [] : (sent = true, kids)) };
	},
	file: cb => cb(file(name, ''))
});
const handle = (name, kids) => ({
	name,
	kind: kids ? 'directory' : 'file',
	getFile: () => Promise.resolve(file(name, '')),
	values: () => {
		let i = 0;
		return {
			next: () => Promise.resolve(i < kids.length
				? { done: false, value: kids[i++] }
				: { done: true })
		};
	}
});
const tick = () => new Promise(r => setTimeout(r, 0));
const drag = (kind, dt) => fire(kind, { dataTransfer: dt, preventDefault: () => {} });

(async () => {
	// plain file drop
	els.btnForget.click();
	drag('dragenter', { types: ['Files'] });
	drag('drop', { items: [{ webkitGetAsEntry: () => null }],
		files: [file('d2.png'), file('d1.png'), file('skip.md')] });
	await tick();
	eq('drop loads sorted', Viewer.item(0).path, 'd1.png');
	eq('drop filters non-images', Viewer.count(), 2);
	eq('drop clears highlight', document.body.classes.has('dropping'), false);

	// Firefox dropped folder via webkitGetAsEntry
	els.btnForget.click();
	const album = entry('album', [entry('b.png'), entry('a.png'), entry('readme.txt')]);
	drag('drop', { items: [{ webkitGetAsEntry: () => album }], files: [] });
	await tick();
	eq('dropped folder walks', Viewer.count(), 2);
	eq('dropped folder order', Viewer.item(0).path, 'album/a.png');
	eq('dropped folder non-image skipped', Viewer.item(1).path, 'album/b.png');

	// REGRESSION: Chrome Windows file:// dropped folder where webkitGetAsEntry's readEntries
	// fails with EncodingError, while getAsFileSystemHandle succeeds.
	els.btnForget.click();
	const chromeAlbum = handle('winAlbum', [handle('img10.png'), handle('img2.png'), handle('notes.txt')]);
	const brokenDirEntry = {
		name: 'winAlbum', isFile: false, isDirectory: true,
		createReader: () => ({ readEntries: (ok, err) => err(new Error('EncodingError')) })
	};
	drag('drop', {
		files: [],
		items: [{
			kind: 'file',
			getAsFileSystemHandle: () => Promise.resolve(chromeAlbum),
			webkitGetAsEntry: () => brokenDirEntry
		}]
	});
	await tick();
	eq('chrome windows folder drop via getAsFileSystemHandle count', Viewer.count(), 2);
	eq('chrome windows folder drop natural order', [Viewer.item(0).path, Viewer.item(1).path],
		['winAlbum/img2.png', 'winAlbum/img10.png']);

	// REGRESSION: Chrome Windows file:// dropped files where webkitGetAsEntry.file() fails
	// asynchronously with EncodingError AND dt.files is cleared after drop returns
	els.btnForget.click();
	const liveDt = {
		files: [file('w2.png'), file('w1.png')],
		items: [{
			kind: 'file',
			webkitGetAsEntry: () => ({
				name: 'w2.png', isFile: true, isDirectory: false,
				file: (ok, err) => setTimeout(() => err(new Error('EncodingError')), 0)
			})
		}]
	};
	drag('drop', liveDt);
	liveDt.files = [];
	liveDt.items = [];
	await tick();
	eq('chrome windows file drop survives async EncodingError', [Viewer.count(), (Viewer.item(0) || {}).path],
		[2, 'w1.png']);

	// an empty walk falls back to the files on the event
	els.btnForget.click();
	drag('drop', { items: [{ webkitGetAsEntry: () => entry('void', []) }], files: [file('y.png'), file('z.png')] });
	await tick();
	eq('an empty walk falls back to the files on the event', Viewer.count(), 2);
	eq('the fallback keeps the dropped files', (Viewer.item(0) || {}).path, 'y.png');

	// drag highlight on/off
	drag('dragenter', { types: ['Files'] });
	eq('dropping class set', document.body.classes.has('dropping'), true);
	drag('dragleave', null);
	eq('dropping class cleared', document.body.classes.has('dropping'), false);
	drag('dragenter', { types: ['text/plain'] });
	eq('non-file drag ignored', document.body.classes.has('dropping'), false);

	// a drop with nothing in it keeps the current list and says so
	resetOpen([file('m.png'), file('n.png')]);
	drag('drop', { items: [], files: [] });
	await tick();
	eq('empty drop keeps list', Viewer.count(), 2);
	eq('empty drop warns', els.toast.textContent, 'no images found');

	// two drops in the air at once: the newest drop wins
	els.btnForget.click();
	const deferred = [];
	const held = name => ({
		name, isFile: true, isDirectory: false,
		file: cb => deferred.push(() => cb(file(name, ''))),
		createReader: () => ({ readEntries: cb => cb([]) })
	});
	drag('drop', { items: [{ webkitGetAsEntry: () => held('slow.png') }], files: [] });
	drag('drop', { items: [{ webkitGetAsEntry: () => held('quick.png') }], files: [] });
	eq('no drop has landed yet', els.toast.textContent, 'no images found');
	[...deferred].reverse().forEach(release => release());
	await tick();
	eq('the newest drop wins', [Viewer.count(), Viewer.item(0).path], [1, 'quick.png']);

	// --- the open file list ---
	resetOpen([file('a.png'), file('b.png'), file('c.png')]);
	const rows = () => els.listItems.children;
	eq('the list is a drawer: closed until the pointer reaches for it', els.list.hidden, true);

	pullOut();
	eq('list opens', els.list.hidden, false);
	eq('one row per image', rows().length, 3);
	eq('rows show paths', rows().map(rowPath), ['a.png', 'b.png', 'c.png']);
	eq('rows carry the full path as a title', rows()[0].title, 'a.png');
	eq('count label', els.listCount.textContent, '3 images');
	eq('current row marked', rows()[0].classes.has('on'), true);
	eq('current row scrolled into view', rows()[0].scrolled, 1);

	press('ArrowRight');
	eq('highlight follows navigation', rows().map(li => li.classes.has('on')), [false, true, false]);
	eq('previous row loses the mark', rows()[0].classes.has('on'), false);

	els.listItems.fire('click', { target: rows()[2] });
	eq('clicking a row jumps to it', Viewer.index(), 2);
	eq('jumped row is marked', rows().map(li => li.classes.has('on')), [false, false, true]);
	eq('clicking outside a row does nothing', [(() => { els.listItems.fire('click', { target: els.listItems }); return Viewer.index(); })()], [2]);

	// a deep path is split in the row into folder, name, copy ('Path') and forget ('X')
	resetOpen([file('x.png', 'root/a/very/deep/folder/x.png')]);
	pullOut();
	eq('row path reads as the whole path', rowPath(rows()[0]), 'root/a/very/deep/folder/x.png');
	eq('row splits into folder, name, copy and forget', rows()[0].children.map(c => c.className),
		['dir', 'nm', 'cp', 'rm']);
	eq('the copy button has Path label and title', [rows()[0].children[2].textContent, rows()[0].children[2].title],
		['Path', 'copy path']);
	eq('the forget button has X label and title', [rows()[0].children[3].textContent, rows()[0].children[3].title],
		['X', 'forget']);
	eq('row keeps the full path in the title', rows()[0].title, 'root/a/very/deep/folder/x.png');

	// per-row X button forgets a single file
	resetOpen([file('a.png'), file('b.png'), file('c.png')]);
	pullOut();
	els.listItems.fire('click', { target: rows()[1].children[3] });
	eq('per-row forget removes only that file', [Viewer.count(), rows().map(rowPath)], [2, ['a.png', 'c.png']]);

	// --- forget all: release the blob and the File handles ---
	const beforeForget = liveUrls;
	eq('one blob alive', beforeForget, 1);
	els.btnForget.click();
	eq('forget empties the viewer', Viewer.count(), 0);
	eq('forget revokes the object url', liveUrls, 0);
	eq('forget empties the list', rows().length, 0);
	eq('forget detaches the image', els.pic.src, '');
	eq('forget closes the drawer', els.list.hidden, true);
	eq('forget drops the title back to the app name', document.title, 'Image Viewer');
	eq('forget brings back the empty state', document.getElementById('empty').classes.has('hidden'), false);
	eq('keys are inert after forgetting', press('ArrowRight'), { i: -1, p: 0 });
	pullOut();
	eq('the drawer can still open when empty so Open buttons are reachable', [Viewer.count(), els.list.hidden], [0, false]);
	pushBack();

	// --- wheel ---
	const wheel = (dy, extra) => {
		let prevented = 0;
		fire('wheel', Object.assign({
			deltaY: dy, deltaX: 0, ctrlKey: false, target: els.pic,
			preventDefault: () => { prevented++; }
		}, extra || {}));
		return prevented;
	};
	const trio = () => resetOpen([file('a.png'), file('b.png'), file('c.png')]);

	trio();
	clock += 120;
	eq('wheel with no delta does nothing', [wheel(0), Viewer.index()], [0, 0]);
	eq('sub-notch deltas do not move', [wheel(10), wheel(10), wheel(10), Viewer.index()], [1, 1, 1, 0]);
	eq('a full notch moves once', [wheel(10), Viewer.index()], [1, 1]);
	eq('cooldown holds the next notch', [wheel(40), Viewer.index()], [1, 1]);
	clock += 120;
	eq('after the wait a notch moves again', [wheel(40), Viewer.index()], [1, 2]);
	clock += 120;
	eq('negative delta goes back', [wheel(-40), Viewer.index()], [1, 1]);
	clock += 120;
	eq('trackpad horizontal delta', [wheel(0, { deltaX: 40 }), Viewer.index()], [1, 2]);
	clock += 120;
	eq('vertical wins when it is larger', [wheel(40, { deltaX: 5 }), Viewer.index()], [1, 0]);
	clock += 120;
	eq('ctrl+wheel is left to the browser', [wheel(40, { ctrlKey: true }), Viewer.index()], [0, 0]);
	clock += 120;
	pullOut();
	eq('wheel over the list scrolls it instead of paging',
		[wheel(40, { target: rows()[0] }), Viewer.index()], [0, 0]);
	clock += 120;
	eq('wheel over the image still pages', [wheel(40), Viewer.index()], [1, 1]);

	// wheel events during a slow load are ignored and do not accumulate
	clock += 120;
	autoLoad = false;
	wheel(40);   // starts loading index 2
	clock += 200;
	wheel(35);   // arrives while still loading: must not accumulate
	els.pic.onload();
	autoLoad = true;
	clock += 120;
	eq('wheel delta during load was discarded, so 10 is still sub-notch', [wheel(10), Viewer.index()], [1, 2]);

	// a half-accumulated flick must not carry into a new set
	clock += 120;
	wheel(30);
	resetOpen([file('p.png'), file('q.png')]);
	clock += 120;
	eq('new set starts the wheel clean', [wheel(30), Viewer.index()], [1, 0]);
	clock += 120;
	eq('and it still steps from there', [wheel(10), Viewer.index()], [1, 1]);

	resetOpen([file('solo.png')]);
	clock += 120;
	eq('one image: the wheel is not claimed', [wheel(40), Viewer.index()], [0, 0]);

	// --- the drawer: edge open, leave close, press-outside close, F and close button ---
	const isOut = () => els.list.hidden === false;
	trio();
	pushBack();
	eq('drawer closed to start', isOut(), false);

	move(200, 300);
	eq('the middle of the window opens nothing', isOut(), false);
	pullOut();
	eq('the window edge pulls the list out', isOut(), true);
	eq('it comes out already built', rows().length, 3);
	pullOut();
	eq('the edge does not stack', rows().length, 3);
	move(200, 300);
	eq('staying inside the panel leaves it open', isOut(), true);
	press('KeyF');
	eq('F closes it', isOut(), false);
	pullOut();
	eq('the edge pulls it out again', isOut(), true);
	pushBack();
	eq('the pointer moving past it pushes it back', isOut(), false);
	press('Escape');
	eq('escape on a closed list is harmless', isOut(), false);
	press('KeyF');
	eq('F opens it from the keyboard', isOut(), true);
	move(500, 300);
	eq('moving outside before entering does not prematurely close F-opened menu', isOut(), true);
	move(200, 300);
	pushBack();
	eq('moving out after entering closes it', isOut(), false);
	press('KeyF');
	down(500, 300);
	eq('pressing outside the menu closes it immediately', isOut(), false);
	press('KeyF');
	els.btnClose.click();
	eq('close button X closes the menu', isOut(), false);

	// --- long press ---
	withFakeClock(flush => { down(400, 300); flush(); });
	eq('a held press opens the list', isOut(), true);
	withFakeClock(flush => { down(400, 300); flush(); });
	eq('pressing outside while open closes the list immediately', isOut(), false);
	withFakeClock(flush => { down(400, 300); fire('pointerup', {}); flush(); });
	eq('releasing before the hold does nothing', isOut(), false);
	withFakeClock(flush => { down(400, 300); move(401, 300); flush(); });
	eq('a press that stays still is still a press', isOut(), true);
	press('Escape');
	withFakeClock(flush => { down(400, 300); move(430, 300); flush(); });
	eq('travelling past the slop is a drag, not a press', isOut(), false);
	withFakeClock(flush => { down(400, 300, { target: rows()[0] }); flush(); });
	eq('the list keeps its own pointers', isOut(), false);
	withFakeClock(flush => { down(400, 300, { button: 2 }); flush(); });
	eq('a right click is not a press', isOut(), false);

	let ctx = 0;
	fire('contextmenu', { target: els.pic, preventDefault: () => { ctx++; } });
	eq('the browser menu is kept off the stage', ctx, 1);
	fire('contextmenu', { target: els.listItems, preventDefault: () => { ctx++; } });
	eq('the list keeps its own context menu', ctx, 1);

	// --- copy path ---
	pullOut();
	copied = [];
	els.listItems.fire('click', { target: rows()[0].children[2] });
	await tick();
	eq('a row copies its own path', copied, ['a.png']);
	eq('copying does not jump to the file', Viewer.index(), 0);
	eq('the copy is confirmed', els.toast.textContent, 'path copied');
	eq('the copy button hands focus back, so the arrows still page', rows()[0].children[2].blurred, 1);
	press('ArrowRight');
	eq('and they do', Viewer.index(), 1);
	press('End');
	copied = [];
	press('KeyC');
	await tick();
	eq('C copies the file on screen, not the first', copied, ['c.png']);

	setClip({ clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
	els.listItems.fire('click', { target: rows()[0].children[2] });
	await tick();
	eq('a refused write is reported', els.toast.textContent, 'copy failed');
	setClip({});
	els.listItems.fire('click', { target: rows()[0].children[2] });
	await tick();
	eq('a page without a clipboard says so', els.toast.textContent, 'clipboard unavailable');
	setClip({ clipboard: clip });

	pushBack();
	copied = [];
	els.listItems.fire('click', { target: els.listItems });
	eq('a click on no row copies nothing', copied, []);

	els.btnForget.click();
	copied = [];
	press('KeyC');
	eq('copy key is inert with no images', [copied.length, Viewer.count()], [0, 0]);

	console.log(fail ? fail + ' FAILED' : 'app.js OK (' + pass + ' checks)');
	process.exit(fail ? 1 : 0);
})();
