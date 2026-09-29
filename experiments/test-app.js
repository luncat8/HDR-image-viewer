// node harness: drives js/app.js against a stub DOM to check the key map,
// picker/drop wiring and HUD state. usage: node experiments/test-app.js
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
// enough DOM for the file list: children, closest, and the real rule that assigning
// textContent throws away child nodes
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
		classes: new Set(), handlers: {}, children: [],
		addEventListener(k, fn) { (this.handlers[k] = this.handlers[k] || []).push(fn); },
		fire(k, ev) { (this.handlers[k] || []).forEach(fn => fn.call(this, ev)); },
		appendChild(node) { node.parent = this; this.children.push(node); return node; },
		closest(sel) { return this.matches(sel) ? this : (this.parent && this.parent.closest(sel)) || null; },
		matches(sel) { return sel === 'li' && this.tagName === 'LI'; },
		contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; },
		scrollIntoView() { this.scrolled = (this.scrolled || 0) + 1; },
		click() { this.clicked = (this.clicked || 0) + 1; this.fire('click', {}); },
		blur() { this.blurred = (this.blurred || 0) + 1; }
	};
	el.classList = classList(el);
	let text = '';
	Object.defineProperty(el, 'textContent', {
		get() { return text; },
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
// the <img> the viewer drives. handlers are assigned before src, so firing onload
// synchronously keeps the harness deterministic with no timers for the render loop
els.pic = mk('img');
els.pic.naturalWidth = 4;
els.pic.naturalHeight = 4;
Object.defineProperty(els.pic, 'src', {
	set(v) { this._src = v; if (v && this.onload) this.onload(); },
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
// the wheel handler reads a clock; driving it by hand makes the cooldown testable
let clock = 1000;
global.performance = { now: () => clock };

global.Files = require(path.join(__dirname, '..', 'js', 'files.js'));
global.Viewer = require(path.join(__dirname, '..', 'js', 'viewer.js'));
require(path.join(__dirname, '..', 'js', 'app.js'));

// initial state the markup supplies: the list panel is closed and its toggle hidden
els.list.hidden = true;
els.btnList.classes.add('hidden');
// the markup nests these, and the stub only needs that chain for contains()
els.listItems.parent = els.list;
els.list.parent = document.body;

// --- helpers ---
// one key press, reporting both the resulting index and whether scroll was swallowed
const press = (code, mod) => {
	let prevented = 0;
	fire('keydown', Object.assign({
		code, target: { tagName: 'BODY' },
		preventDefault: () => { prevented++; }
	}, mod || {}));
	return { i: Viewer.index(), p: prevented };
};
const file = (name, rel) => ({ name, webkitRelativePath: rel || '' });
const open = files => {
	els.pickFiles.files = files;
	els.pickFiles.fire('change', {});
};

// --- empty state before anything is opened ---
eq('empty state visible at start', document.getElementById('empty').classes.has('hidden'), false);
eq('hud hidden at start', document.body.classes.has('has-images'), false);

// --- open three images ---
open([file('a.png', 'd/a.png'), file('b.png', 'd/b.png'), file('c.png', 'd/c.png')]);
eq('viewer got 3', Viewer.count(), 3);
eq('empty state hidden', document.getElementById('empty').classes.has('hidden'), true);
eq('body marked', document.body.classes.has('has-images'), true);
eq('hud shows name only', els.hudName.textContent, 'a.png');
eq('hud counter', els.hudCount.textContent, '1 / 3   4×4');
eq('hud title holds full path', els.hudName.title, 'd/a.png');

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
eq('hud follows', els.hudCount.textContent, '1 / 3   4×4');
eq('hud title holds full path', els.hudName.title, 'd/a.png');

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

// --- folder picker uses webkitRelativePath ---
els.pickFolder.files = [file('z.png', 'root/sub/z.png'), file('a.png', 'root/a.png')];
els.pickFolder.fire('change', {});
eq('folder order', Viewer.item(0).path, 'root/a.png');
eq('folder count', Viewer.count(), 2);
eq('toast counts', els.toast.textContent, '2 images');
eq('single file toast', (open([file('one.png')]), els.toast.textContent), 'one.png');

// --- re-open resets to the first image ---
open([file('a.png'), file('b.png'), file('c.png')]);
press('End');
open([file('x.png'), file('y.png')]);
eq('reopen starts at first', Viewer.index(), 0);

// --- single image: keys must not throw, move, or hijack scrolling ---
open([file('solo.png')]);
eq('solo index', Viewer.index(), 0);
eq('solo key is a no-op', [press('ArrowRight'), press('ArrowLeft'), press('Space')],
	[{ i: 0, p: 0 }, { i: 0, p: 0 }, { i: 0, p: 0 }]);
eq('solo hud', els.hudCount.textContent, '1 / 1   4×4');

// --- drop ---
// mock FileSystemEntry tree. callbacks fire synchronously: the walker's re-entrancy is
// what needs testing here, and async mocks would only add timing to every assertion
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
// a macrotask, so the whole microtask queue has drained and the walk has resolved
const tick = () => new Promise(r => setTimeout(r, 0));
// the app calls preventDefault on enter/over/drop, so every drag event needs one
const drag = (kind, dt) => fire(kind, { dataTransfer: dt, preventDefault: () => {} });
// Chrome empties the item list once drop fires; this is what a drop event really sees
const spent = { items: [{ webkitGetAsEntry: () => null }], files: [] };

(async () => {
	// plain file drop: no entries to capture, falls back to dataTransfer.files
	drag('dragenter', { types: ['Files'], items: [{ webkitGetAsEntry: () => null }] });
	drag('drop', { items: [{ webkitGetAsEntry: () => null }],
		files: [file('d2.png'), file('d1.png'), file('skip.md')] });
	await tick();
	eq('drop loads sorted', Viewer.item(0).path, 'd1.png');
	eq('drop filters non-images', Viewer.count(), 2);
	eq('drop clears highlight', document.body.classes.has('dropping'), false);

	// REGRESSION: a dropped folder. Chrome has already invalidated the item list by the
	// time drop fires, so webkitGetAsEntry returns null there. The entries captured during
	// dragenter are the only source, and reading them only at drop is what made this report
	// "no images found".
	const album = entry('album', [entry('b.png'), entry('a.png'), entry('readme.txt')]);
	drag('dragenter', { types: ['Files'], items: [{ webkitGetAsEntry: () => album }] });
	drag('drop', spent);
	await tick();
	eq('dropped folder walks', Viewer.count(), 2);
	eq('dropped folder order', Viewer.item(0).path, 'album/a.png');
	eq('dropped folder non-image skipped', Viewer.item(1).path, 'album/b.png');

	// a drag that never entered still works through the fallback capture
	drag('drop', { items: [{ webkitGetAsEntry: () => album }], files: [] });
	await tick();
	eq('drop without dragenter still walks', Viewer.count(), 2);

	// leaving the window forgets the captured entries
	drag('dragenter', { types: ['Files'], items: [{ webkitGetAsEntry: () => album }] });
	drag('dragleave', null);
	drag('drop', spent);
	await tick();
	eq('stale entries dropped after dragleave', els.toast.textContent, 'no images found');

	// drag highlight on/off
	drag('dragenter', { types: ['Files'] });
	eq('dropping class set', document.body.classes.has('dropping'), true);
	drag('dragleave', null);
	eq('dropping class cleared', document.body.classes.has('dropping'), false);
	drag('dragenter', { types: ['text/plain'] });
	eq('non-file drag ignored', document.body.classes.has('dropping'), false);

	// a drop with nothing in it keeps the current list and says so
	drag('drop', { items: [], files: [] });
	await tick();
	eq('empty drop keeps list', Viewer.count(), 2);
	eq('empty drop warns', els.toast.textContent, 'no images found');

	// --- the open file list ---
	open([file('a.png'), file('b.png'), file('c.png')]);
	const rows = () => els.listItems.children;
	eq('list stays closed until asked for, toggle offers it', [els.list.hidden, els.btnList.classes.has('hidden')], [true, false]);
	eq('toggle appears with images', els.btnList.classes.has('hidden'), false);

	els.btnList.click();
	eq('list opens', els.list.hidden, false);
	eq('toggle shows as active', els.btnList.classes.has('on'), true);
	eq('toggle released focus', els.btnList.blurred, 1);
	eq('one row per image', rows().length, 3);
	eq('rows show paths', rows().map(li => li.textContent), ['a.png', 'b.png', 'c.png']);
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

	// a different set replaces the list rather than appending to it
	open([file('x.png'), file('y.png')]);
	eq('new set rebuilds the open list', rows().map(li => li.textContent), ['x.png', 'y.png']);
	eq('rebuilt list marks the first', rows()[0].classes.has('on'), true);
	eq('count label follows the set', els.listCount.textContent, '2 images');

	els.btnList.click();
	eq('list closes', els.list.hidden, true);
	press('End');
	eq('navigation while closed does not build', Viewer.index(), 1);
	els.btnList.click();
	eq('reopening rebuilds', rows().length, 2);
	eq('reopened list marks the current row', rows().map(li => li.classes.has('on')), [false, true]);

	// --- forget: release the blob and the File handles ---
	const beforeForget = liveUrls;
	eq('one blob alive', beforeForget, 1);
	els.btnForget.click();
	eq('forget empties the viewer', Viewer.count(), 0);
	eq('forget revokes the object url', liveUrls, 0);
	eq('forget empties the list', rows().length, 0);
	eq('forget detaches the image', els.pic.src, '');
	eq('forget clears the hud', [els.hudName.textContent, els.hudCount.textContent], ['', '']);
	eq('forget hides the hud', document.body.classes.has('has-images'), false);
	eq('forget hides the toggle', els.btnList.classes.has('hidden'), true);
	eq('forget brings back the empty state', document.getElementById('empty').classes.has('hidden'), false);
	eq('keys are inert after forgetting', press('ArrowRight'), { i: -1, p: 0 });
	eq('reopening after forget is blocked', [Viewer.count(), els.btnList.classes.has('hidden')], [0, true]);

	// --- wheel ---
	// the wheel helper needs a target so the panel can claim the event
	const wheel = (dy, extra) => {
		let prevented = 0;
		fire('wheel', Object.assign({
			deltaY: dy, deltaX: 0, ctrlKey: false, target: els.pic,
			preventDefault: () => { prevented++; }
		}, extra || {}));
		return prevented;
	};
	const trio = () => open([file('a.png'), file('b.png'), file('c.png')]);

	trio();
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
	// the panel is open here, so the wheel belongs to the list, not the image
	eq('wheel over the list scrolls it instead of paging',
		[wheel(40, { target: rows()[0] }), Viewer.index()], [0, 0]);
	clock += 120;
	eq('wheel over the image still pages', [wheel(40), Viewer.index()], [1, 1]);

	// a half-accumulated flick must not carry into a new set
	clock += 120;
	wheel(30);
	open([file('p.png'), file('q.png')]);
	clock += 120;
	// 30 alone is under the threshold, so this only holds if the accumulator was cleared
	eq('new set starts the wheel clean', [wheel(30), Viewer.index()], [1, 0]);
	clock += 120;
	eq('and it still steps from there', [wheel(10), Viewer.index()], [1, 1]);

	open([file('solo.png')]);
	clock += 120;
	eq('one image: the wheel is not claimed', [wheel(40), Viewer.index()], [0, 0]);

	console.log(fail ? fail + ' FAILED' : 'app.js OK (' + pass + ' checks)');
	process.exit(fail ? 1 : 0);
})();
