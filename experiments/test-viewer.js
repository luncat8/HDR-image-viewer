// node harness: drives js/viewer.js against a stub <img> to check the load lifecycle,
// navigation wrap, stale-load rejection, deduplication, per-file removal, and URL lifetime.
// usage: node experiments/test-viewer.js
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const eq = (name, got, want) => {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a === b) { pass++; return; }
	fail++;
	console.log('FAIL ' + name + '\n  got  ' + a + '\n  want ' + b);
};

// --- stub <img> ---
const requests = [];
const pic = {
	naturalWidth: 0, naturalHeight: 0,
	onload: null, onerror: null, _src: '',
	set src(v) { this._src = v; if (v) requests.push({ el: this, url: v, onload: this.onload, onerror: this.onerror }); },
	get src() { return this._src; },
	removeAttribute() { this._src = ''; }
};
const decode = (req, w, h, bad) => {
	req.el.naturalWidth = w;
	req.el.naturalHeight = h;
	(bad ? req.onerror : req.onload).call(req.el);
};
const go = (move, w, h, bad) => { move(); decode(requests.pop(), w, h, bad); };

let live = 0, made = 0;
const revoked = [];
global.URL = {
	createObjectURL: () => { live++; made++; return 'blob:' + made; },
	revokeObjectURL: u => { if (u) { live--; revoked.push(u); } }
};

const Viewer = require(path.join(__dirname, '..', 'js', 'viewer.js'));

const item = n => ({ file: { name: n }, path: n });
const next = () => Viewer.cycle(1);
const prev = () => Viewer.cycle(-1);

const events = [];
Viewer.onchange = (...a) => events.push(a);
Viewer.init(pic);

// --- first image ---
Viewer.setImages([item('a.png'), item('b.png'), item('c.png')], 0);
eq('opens at first', Viewer.index(), 0);
eq('count', Viewer.count(), 3);
eq('one url alive', live, 1);
eq('one request issued', requests.length, 1);
eq('no report before decode', events.length, 0);
eq('src is the live url', pic.src, 'blob:1');

go(() => {}, 200, 100);
eq('reported geometry', events.pop(), ['a.png', 0, 3, 200, 100, 0]);
eq('url survives decode', live, 1);

eq('current item with no index', Viewer.item().path, 'a.png');
eq('current item with a negative index', Viewer.item(-1).path, 'a.png');
eq('indexed item', Viewer.item(2).path, 'c.png');
eq('out of range item is null', Viewer.item(9), null);

// --- switching releases the previous blob ---
go(next, 300, 900);
eq('one url alive after switch', live, 1);
eq('exactly one revoke', revoked.length, 1);
eq('reported after switch', events.pop(), ['b.png', 1, 3, 300, 900, 0]);
go(next, 1000, 500);
eq('two revokes', revoked.length, 2);

// --- wrap ---
go(next, 10, 10);
eq('wraps past end to first', Viewer.index(), 0);
go(prev, 10, 10);
eq('wraps before start to last', Viewer.index(), 2);
eq('one url alive after wraps', live, 1);
eq('one revoke per switch', revoked.length, 4);
eq('reported at last', events.pop(), ['c.png', 2, 3, 10, 10, 0]);

// --- single image never refetches ---
Viewer.setImages([item('only.png')], 0);
go(() => {}, 4, 4);
next(); next(); prev();
eq('single image is stable', Viewer.index(), 0);
eq('single image makes no request', requests.length, 0);
eq('single image keeps one url', live, 1);
eq('first/last are safe on one image', [Viewer.first(), Viewer.last(), Viewer.index()], [undefined, undefined, 0]);
eq('re-setting the same list reloads', (Viewer.setImages([item('only.png')], 0), requests.length), 1);

// --- a step that arrives before the frame is up is dropped, not queued ---
requests.length = 0;
Viewer.setImages([item('x.png'), item('y.png'), item('z.png')], 0);
next(); next(); next();
eq('one request while loading', requests.length, 1);
eq('the index does not walk ahead of the picture', Viewer.index(), 0);
const eventsBefore = events.length;
go(() => {}, 640, 480);
eq('the load in flight is the one reported', events.pop(), ['x.png', 0, 3, 640, 480, 0]);
eq('dropped steps report nothing', events.length, eventsBefore);
next();
eq('a step after the decode moves', Viewer.index(), 1);
eq('the step is the only request in the air', requests.length, 1);
go(() => {}, 800, 600);
eq('reported after the step', events.pop(), ['y.png', 1, 3, 800, 600, 0]);

// --- async img.decode() holds busy until pixel decode finishes ---
let resolveDecode = null;
pic.decode = () => new Promise(r => { resolveDecode = r; });
next();
const reqDecode = requests.pop();
reqDecode.onload.call(pic);   // onload fired (Firefox style), but decode() has not resolved yet
eq('busy stays true while img.decode() is pending', Viewer.busy(), true);
next(); prev();
eq('steps during pending img.decode() are dropped', [Viewer.index(), requests.length], [2, 0]);
delete pic.decode;

// --- a new set supersedes the frame still decoding ---
requests.length = 0;
Viewer.setImages([item('x.png'), item('y.png')], 0);
const beforeSet = events.length;
Viewer.setImages([item('p.png'), item('q.png')], 0);
eq('the new set does not wait for the old load', requests.length, 2);
requests[0].onload.call(requests[0].el);
eq('stale load ignored', events.length, beforeSet);
go(() => {}, 300, 300);
eq('the new set is reported', events.pop(), ['p.png', 0, 2, 300, 300, 0]);

// --- addImages: deduplication and incremental add ---
requests.length = 0;
eq('adding already-open files adds 0', Viewer.addImages([item('p.png'), item('q.png')]), 0);
eq('count unchanged after duplicate add', Viewer.count(), 2);
eq('adding overlapping set adds only new files', Viewer.addImages([item('q.png'), item('r.png')]), 1);
eq('count reflects only new file', Viewer.count(), 3);
eq('current image stays on screen without reload', [Viewer.index(), requests.length], [0, 0]);
go(() => Viewer.addImages([item('r.png')]), 300, 300);
eq('adding an already-open single file jumps to it without duplicating', [Viewer.count(), Viewer.index()], [3, 2]);

// --- remove: per-file forget ---
Viewer.remove(0);   // remove p.png before current index (2)
eq('removing earlier item shifts index down', [Viewer.count(), Viewer.index(), Viewer.item().path], [2, 1, 'r.png']);
go(() => Viewer.remove(1), 100, 100);   // remove current item r.png
eq('removing current item loads remaining item', [Viewer.count(), Viewer.index(), Viewer.item().path], [1, 0, 'q.png']);
Viewer.remove(0);   // remove last remaining item
eq('removing last item empties viewer', [Viewer.count(), Viewer.index(), live], [0, -1, 0]);

// --- decode failure ---
requests.length = 0;
Viewer.setImages([item('p.png'), item('q.png')], 0);
go(() => {}, 300, 300);
go(next, 0, 0, true);
eq('failure reported', events.pop(), ['q.png', 1, 2, 0, 0, 1]);
go(prev, 1, 1);
eq('recovers from a failure', events.pop(), ['p.png', 0, 2, 1, 1, 0]);
eq('a failed frame releases the viewer', (next(), requests.length), 1);

// --- teardown ---
Viewer.destroy();
eq('destroy frees urls', live, 0);
Viewer.setImages([], 0);
eq('empty list detaches src', pic.src, '');
eq('empty list reported', events.pop(), ['', -1, 0, 0, 0, 0]);
eq('current item is null with no images', Viewer.item(), null);

// --- present/blank: an async display stage between decode and report ---
const staged = [];
let blanks = 0;
Viewer.present = (el, it, finish) => staged.push({ el, path: it.path, finish });
Viewer.blank = () => { blanks++; };
requests.length = 0;
Viewer.setImages([item('s.png'), item('t.png')], 0);
decode(requests.pop(), 50, 40);
eq('present gets the decoded img and its item', staged.map(x => [x.el === pic, x.path]), [[true, 's.png']]);
eq('busy until present finishes', Viewer.busy(), true);
const eventsStaged = events.length;
next();
eq('steps during present are dropped', [Viewer.index(), requests.length], [0, 0]);
eq('no report before present finishes', events.length, eventsStaged);
eq('finish on the current load returns true', staged.pop().finish(0), true);
eq('reported after present', events.pop(), ['s.png', 0, 2, 50, 40, 0]);
eq('free to step after present', Viewer.busy(), false);

next();
decode(requests.pop(), 60, 60);
const stale = staged.pop();
Viewer.setImages([item('u.png')], 0);
eq('finish on a superseded load returns false', stale.finish(0), false);
eq('superseded present reports nothing', events.length, eventsStaged);
decode(requests.pop(), 70, 70);
staged.pop().finish(1);
eq('a stage failure is reported as a failure', events.pop(), ['u.png', 0, 1, 70, 70, 1]);
eq('a stage failure blanks the stage', blanks, 1);

Viewer.setImages([item('v.png')], 0);
decode(requests.pop(), 1, 1, true);
eq('a decode failure blanks without presenting', [blanks, staged.length], [2, 0]);
Viewer.destroy();
eq('emptying blanks the stage', blanks, 3);
Viewer.present = Viewer.blank = null;

console.log(fail ? fail + ' FAILED' : 'viewer.js OK (' + pass + ' checks)');
process.exit(fail ? 1 : 0);
