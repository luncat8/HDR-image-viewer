// Wiring: pickers, drop target, keyboard navigation, HUD.
(function () {
	'use strict';

	var pic = document.getElementById('pic');
	var bad = document.getElementById('bad');
	var empty = document.getElementById('empty');
	var hud = document.getElementById('hud');
	var hudName = document.getElementById('hudName');
	var hudCount = document.getElementById('hudCount');
	var toast = document.getElementById('toast');
	var pickFiles = document.getElementById('pickFiles');
	var pickFolder = document.getElementById('pickFolder');
	var btnList = document.getElementById('btnList');
	var panel = document.getElementById('list');
	var btnForget = document.getElementById('btnForget');
	var listCount = document.getElementById('listCount');
	var listItems = document.getElementById('listItems');
	var row = null;   // the highlighted list row, so navigation never queries the dom
	var wheelAcc = 0; // wheel delta carried toward the next notch
	var wheelUntil = 0;   // timestamp before which a further notch is ignored

	var flashTimer = 0;

	function flash(text) {
		if (!text) return;
		toast.textContent = text;
		toast.classList.add('on');
		clearTimeout(flashTimer);
		flashTimer = setTimeout(function () { toast.classList.remove('on'); }, 1800);
	}

	function name(path) {
		var cut = path.lastIndexOf('/');
		return cut < 0 ? path : path.slice(cut + 1);
	}

	function load(items) {
		if (!items.length) return flash('no images found');
		Viewer.setImages(items, 0);
		flash(items.length === 1 ? items[0].file.name : items.length + ' images');
	}

	Viewer.init(pic);

	Viewer.onchange = function (path, i, n, w, h, failed) {
		var live = i >= 0;
		hudName.textContent = live ? name(path) : '';
		hudName.title = live ? path : '';
		hudCount.textContent = live ? (i + 1) + ' / ' + n + (w ? '   ' + w + '×' + h : '') : '';
		hud.classList.toggle('bad', !!failed);
		// a file the browser cannot decode says so instead of leaving a blank stage
		bad.hidden = !failed;
		bad.textContent = failed ? 'cannot decode ' + name(path) : '';
		if (live) markRow();
	};

	Viewer.onempty = function (has) {
		empty.classList.toggle('hidden', has);
		document.body.classList.toggle('has-images', has);
		btnList.classList.toggle('hidden', !has);
		wheelAcc = 0;   // a half-accumulated flick must not carry into a new set
		wheelUntil = 0;
		if (!has) {
			row = null;
			listItems.textContent = '';
			return;
		}
		if (!panel.hidden) buildList();
	};

	// blur after picking, otherwise a focused button swallows the space key
	function pick(btn, input) {
		btn.addEventListener('click', function () {
			input.click();
			btn.blur();
		});
	}

	pick(document.getElementById('btnFiles'), pickFiles);
	pick(document.getElementById('btnFolder'), pickFolder);

	pickFiles.addEventListener('change', function () {
		load(Files.fromInput(pickFiles.files));
		pickFiles.value = '';
	});

	pickFolder.addEventListener('change', function () {
		load(Files.fromInput(pickFolder.files));
		pickFolder.value = '';
	});

	// --- open file list ---
	// built when the panel opens and when the set changes, never per keystroke
	function buildList() {
		var n = Viewer.count();
		listCount.textContent = n + (n === 1 ? ' image' : ' images');
		listItems.textContent = '';
		row = null;
		for (var i = 0; i < n; i++) {
			var path = Viewer.item(i).path;
			var li = document.createElement('li');
			li.textContent = path;
			li.title = path;
			listItems.appendChild(li);
		}
		markRow();
	}

	// one listener for the whole list, so a large folder costs no per-row closures
	listItems.addEventListener('click', function (e) {
		var li = e.target.closest('li');
		if (li) Viewer.goto(Array.prototype.indexOf.call(listItems.children, li));
	});

	function markRow() {
		if (panel.hidden) return;
		if (row) row.classList.remove('on');
		row = listItems.children[Viewer.index()] || null;
		if (!row) return;
		row.classList.add('on');
		row.scrollIntoView({ block: 'nearest' });
	}

	btnList.addEventListener('click', function () {
		panel.hidden = !panel.hidden;
		btnList.classList.toggle('on', !panel.hidden);
		btnList.blur();
		if (!panel.hidden) buildList();
	});

	btnForget.addEventListener('click', function () {
		// revokes the object url, drops every File handle, empties the list
		Viewer.destroy();
		btnForget.blur();
	});

	var dropDepth = 0;
	var dropEntries = [];

	window.addEventListener('dragenter', function (e) {
		if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
		e.preventDefault();
		dropDepth++;
		// taken once per drag, while the item list is still readable
		if (!dropEntries.length) dropEntries = Files.captureEntries(e.dataTransfer);
		document.body.classList.add('dropping');
	});

	window.addEventListener('dragover', function (e) { e.preventDefault(); });

	window.addEventListener('dragleave', function () {
		if (--dropDepth <= 0) {
			dropDepth = 0;
			dropEntries = [];
			document.body.classList.remove('dropping');
		}
	});

	window.addEventListener('drop', function (e) {
		e.preventDefault();
		dropDepth = 0;
		document.body.classList.remove('dropping');
		var entries = dropEntries;
		dropEntries = [];
		Files.fromDataTransfer(e.dataTransfer, entries).then(load, function () { flash('cannot read dropped items'); });
	});

	var NEXT = { ArrowRight: 1, KeyD: 1, Space: 1, PageDown: 1 };
	var PREV = { ArrowLeft: -1, KeyA: -1, Backspace: -1, PageUp: -1 };

	window.addEventListener('keydown', function (e) {
		// let the browser own shortcuts and anything typed into a control
		if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
		if (e.code === 'Home') return void Viewer.first();
		if (e.code === 'End') return void Viewer.last();
		var dir = e.code === 'Space' && e.shiftKey ? -1 : (NEXT[e.code] || PREV[e.code] || 0);
		if (!dir) return;
		// nothing to move through: leave space and arrows scrolling as usual
		if (Viewer.count() < 2) return;
		e.preventDefault();
		Viewer.cycle(dir);
	});

	// A wheel notch, not a wheel event: a trackpad flick emits dozens of small deltas and
	// would otherwise blow through a whole folder in one gesture. Threshold plus cooldown.
	var WHEEL_STEP = 40;      // accumulated deltaY/deltaX that counts as one notch
	var WHEEL_WAIT = 120;     // ms of quiet after a step, before another can fire

	window.addEventListener('wheel', function (e) {
		if (e.ctrlKey) return;                       // leave browser zoom alone
		if (panel.contains(e.target)) return;         // the list scrolls instead
		if (Viewer.count() < 2) return;
		var d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
		if (!d) return;
		e.preventDefault();
		var now = performance.now();
		if (now < wheelUntil) return;
		wheelAcc += d;
		if (Math.abs(wheelAcc) < WHEEL_STEP) return;
		Viewer.cycle(wheelAcc > 0 ? 1 : -1);
		wheelAcc = 0;
		wheelUntil = now + WHEEL_WAIT;
	}, { passive: false });

	window.addEventListener('beforeunload', function () { Viewer.destroy(); });
})();
