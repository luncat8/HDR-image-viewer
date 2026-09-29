// node harness: loads js/app.js against the element ids each page really declares, so a menu
// button that lives on one page only can never again take the whole wiring down with it.
// usage: node experiments/test-pages.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const eq = (name, got, want) => {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a === b) { pass++; return; }
	fail++;
	console.log('FAIL ' + name + '\n  got  ' + a + '\n  want ' + b);
};

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const idsOf = page => [...read(page).matchAll(/id="([^"]+)"/g)].map(m => m[1]);
// every element a script asks the page for, however it asks for it
const needsOf = (file, re) => [...read(file).matchAll(re)].map(m => m[1] || m[2]);

const APP_IDS = needsOf('js/app.js', /getElementById\('([^']+)'\)/g);
const EXPAND_IDS = needsOf('js/expand.js', /getElementById\('([^']+)'\)|el\('([^']+)'\)/g);
const WINDOW_EVENTS = ['beforeunload', 'contextmenu', 'dragenter', 'dragleave', 'dragover', 'drop',
	'keydown', 'paste', 'pointercancel', 'pointerdown', 'pointermove', 'pointerup', 'wheel'];

const mk = tag => ({
	tagName: (tag || 'div').toUpperCase(), classes: new Set(), children: [], handlers: [],
	hidden: false, title: '', value: '', files: [],
	addEventListener(k, fn) { (this.handlers[k] = this.handlers[k] || []).push(fn); },
	appendChild(n) { this.children.push(n); return n; },
	removeAttribute() { }, click() { }, blur() { }, contains() { return false; }, closest() { return null; }
});

// an undeclared id resolves to null, exactly as it does in a browser
const load = (page, declared) => {
	const els = {};
	const listeners = {};
	global.document = {
		baseURI: 'file:///view/' + page,
		getElementById: id => !declared.has(id) ? null
			: (els[id] || (els[id] = mk(id.indexOf('pick') === 0 ? 'input' : 'div'))),
		createElement: mk,
		body: mk('body')
	};
	global.window = {
		devicePixelRatio: 1,
		addEventListener: (k, fn) => { (listeners[k] = listeners[k] || []).push(fn); }
	};
	global.performance = { now: () => 0 };
	// node ships a navigator getter, so it has to be redefined rather than assigned
	Object.defineProperty(global, 'navigator', {
		value: { clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') } },
		configurable: true,
		writable: true
	});
	global.Files = require(path.join(root, 'js/files.js'));
	global.Viewer = require(path.join(root, 'js/viewer.js'));
	let error = '';
	try {
		delete require.cache[require.resolve(path.join(root, 'js/app.js'))];
		require(path.join(root, 'js/app.js'));
	} catch (e) { error = e.message; }
	return { error, keys: Object.keys(listeners).sort() };
};

for (const page of ['index.html', 'gpu.html']) {
	const declared = new Set(idsOf(page));
	eq(page + ' declares every element app.js needs', APP_IDS.filter(id => !declared.has(id)), []);
	eq(page + ' declares no element twice', declared.size, idsOf(page).length);
	const run = load(page, declared);
	eq(page + ' wires app.js without throwing', run.error, '');
	// a null button used to abort the whole file, which shows up here as missing listeners
	eq(page + ' registers every window listener', run.keys, WINDOW_EVENTS);
	eq(page + ' runs the wiring top to bottom', run.error === '' && run.keys.length === WINDOW_EVENTS.length, true);
}

eq('expand.js is gpu.html only, and gpu.html has all of it',
	EXPAND_IDS.filter(id => !new Set(idsOf('gpu.html')).has(id)), []);

console.log(fail ? fail + ' FAILED' : 'pages OK (' + pass + ' checks)');
process.exit(fail ? 1 : 0);
