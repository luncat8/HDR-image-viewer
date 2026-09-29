// node harness: drives js/viewer.js against a stub <img> to check the load lifecycle,
// navigation wrap, stale-load rejection and object URL lifetime.
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
// the viewer reuses one element, so a request record must snapshot the handlers installed
// just before src was set, or every record would alias the same element
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

// --- stale load from a superseded jump is dropped ---
requests.length = 0;                // earlier probes left undecoded records behind
Viewer.setImages([item('x.png'), item('y.png')], 0);
next();                            // supersede the first request before it decodes
eq('two pending loads', requests.length, 2);
const eventsBefore = events.length;
requests[0].el.naturalWidth = 999;
requests[0].el.naturalHeight = 999;
requests[0].onload.call(requests[0].el);
eq('stale load ignored', events.length, eventsBefore);
go(() => {}, 640, 480);
eq('current load reported', events.pop(), ['y.png', 1, 2, 640, 480, 0]);
eq('superseded url revoked immediately', live, 1);

// --- decode failure ---
go(prev, 0, 0, true);
eq('failure reported', events.pop(), ['x.png', 0, 2, 0, 0, 1]);
go(next, 1, 1);
eq('recovers from a failure', events.pop(), ['y.png', 1, 2, 1, 1, 0]);

// --- teardown ---
Viewer.destroy();
eq('destroy frees urls', live, 0);
Viewer.setImages([], 0);
eq('empty list detaches src', pic.src, '');
eq('empty list reported', events.pop(), ['', -1, 0, 0, 0, 0]);

console.log(fail ? fail + ' FAILED' : 'viewer.js OK (' + pass + ' checks)');
process.exit(fail ? 1 : 0);
