// Wiring: pickers, drop target, keyboard/wheel navigation, side drawer menu, window title.
(function () {
	'use strict';

	var APP = 'Image Viewer';
	var EDGE = 28;        // px from the left window edge that pulls the menu out
	var LEAVE = 330;      // px from that edge past which leaving the menu closes it
	var LONG = 450;       // ms a press has to hold before it counts as a long press
	var SLOP = 12;        // px of pointer travel that turns a held press into a drag
	var WHEEL_STEP = 40;  // accumulated deltaY/deltaX that counts as one wheel notch
	var DEBOUNCE = 100;   // ms cooldown after an image finishes opening

	var stage = document.getElementById('stage');
	var pic = document.getElementById('pic');
	var bad = document.getElementById('bad');
	var empty = document.getElementById('empty');
	var toast = document.getElementById('toast');
	var pickFiles = document.getElementById('pickFiles');
	var pickFolder = document.getElementById('pickFolder');
	var panel = document.getElementById('list');
	var btnForget = document.getElementById('btnForget');
	var btnClose = document.getElementById('btnClose');
	var listCount = document.getElementById('listCount');
	var listItems = document.getElementById('listItems');
	var row = null;        // highlighted list row
	var inMenu = false;    // whether pointer has entered the menu zone since it opened
	var wheelAcc = 0;      // wheel delta carried toward the next notch
	var navUntil = 0;      // timestamp before which next/prev input is ignored
	var stepping = false;  // whether a navigation step is awaiting load completion
	var flashTimer = 0;
	var holdTimer = 0;
	var holdX = 0;
	var holdY = 0;

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
		var added = Viewer.addImages(items);
		if (!added) return flash('already opened');
		flash(added === 1 ? Viewer.item(Viewer.count() - 1).file.name : added + ' images');
	}

	Viewer.init(pic);

	// the file info lives in the window title so the stage stays clear of overlays
	Viewer.onchange = function (path, i, n, w, h, failed) {
		wheelAcc = 0;
		bad.hidden = !failed;
		bad.textContent = failed ? 'cannot decode ' + name(path) : '';
		if (i < 0) {
			stepping = false;
			navUntil = 0;
			document.title = APP;
			return;
		}
		// start the debounce window once the image is actually decoded and ready
		if (stepping) {
			navUntil = performance.now() + DEBOUNCE;
			stepping = false;
		}
		document.title = name(path) + ' · ' + (i + 1) + '/' + n + (w ? ' · ' + w + '×' + h : '');
		if (!panel.hidden) markRow();
	};

	Viewer.onempty = function (has) {
		empty.classList.toggle('hidden', has);
		wheelAcc = 0;
		navUntil = 0;
		stepping = false;
		if (has) {
			if (!panel.hidden) buildList();
			return;
		}
		row = null;
		listCount.textContent = '0 images';
		listItems.textContent = '';
		closeList();
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

	// --- the open file list ---
	function buildList() {
		var n = Viewer.count();
		listCount.textContent = n + (n === 1 ? ' image' : ' images');
		listItems.textContent = '';
		row = null;
		for (var i = 0; i < n; i++) {
			var path = Viewer.item(i).path;
			var cut = path.lastIndexOf('/');
			var li = document.createElement('li');
			li.title = path;
			// the folder shrinks and the name does not, so a deep path never hides the file
			li.appendChild(span('dir', cut < 0 ? '' : path.slice(0, cut + 1)));
			li.appendChild(span('nm', cut < 0 ? path : path.slice(cut + 1)));
			li.appendChild(rowButton('cp', 'Path', 'copy path'));
			li.appendChild(rowButton('rm', 'X', 'forget'));
			listItems.appendChild(li);
		}
		markRow();
	}

	function span(cls, text) {
		var s = document.createElement('span');
		s.className = cls;
		s.textContent = text;
		return s;
	}

	function rowButton(cls, label, title) {
		var b = document.createElement('button');
		b.className = cls;
		b.type = 'button';
		b.title = title;
		b.textContent = label;
		return b;
	}

	// one listener for the whole list, so a large folder costs no per-row closures
	listItems.addEventListener('click', function (e) {
		var li = e.target.closest('li');
		if (!li) return;
		var i = Array.prototype.indexOf.call(listItems.children, li);
		if (i < 0) return;
		var cp = e.target.closest('.cp');
		if (cp) {
			copy(Viewer.item(i).path);
			cp.blur();
			return;
		}
		var rm = e.target.closest('.rm');
		if (rm) {
			rm.blur();
			Viewer.remove(i);
			return;
		}
		Viewer.goto(i);
	});

	function markRow() {
		if (panel.hidden) return;
		if (row) row.classList.remove('on');
		row = listItems.children[Viewer.index()] || null;
		if (!row) return;
		row.classList.add('on');
		row.scrollIntoView({ block: 'nearest' });
	}

	function openList() {
		if (!panel.hidden) return;
		panel.hidden = false;
		buildList();
	}

	function closeList() {
		if (panel.hidden) return;
		panel.hidden = true;
		inMenu = false;
	}

	function toggleList() {
		if (panel.hidden) openList();
		else closeList();
	}

	if (btnClose) {
		btnClose.addEventListener('click', function () {
			closeList();
			btnClose.blur();
		});
	}

	// pointer near the left edge pulls the drawer out; leaving after entering pushes it back
	window.addEventListener('pointermove', function (e) {
		if (e.clientX <= EDGE) {
			inMenu = true;
			openList();
			return;
		}
		if (panel.hidden) return;
		if (e.clientX <= LEAVE) {
			inMenu = true;
			return;
		}
		if (inMenu) closeList();
	});

	// press outside closes an open menu; long press on the stage toggles it
	window.addEventListener('pointerdown', function (e) {
		if (e.button > 0) return;
		if (panel.contains(e.target)) return;
		if (!panel.hidden) {
			closeList();
			return;
		}
		if (!stage.contains(e.target) && !empty.contains(e.target)) return;
		holdX = e.clientX;
		holdY = e.clientY;
		holdCancel();
		holdTimer = setTimeout(function () { holdTimer = 0; toggleList(); }, LONG);
	});

	window.addEventListener('pointermove', function (e) {
		if (!holdTimer) return;
		if (Math.abs(e.clientX - holdX) < SLOP && Math.abs(e.clientY - holdY) < SLOP) return;
		holdCancel();
	});

	function holdCancel() { clearTimeout(holdTimer); holdTimer = 0; }

	window.addEventListener('pointerup', holdCancel);
	window.addEventListener('pointercancel', holdCancel);

	window.addEventListener('contextmenu', function (e) {
		if (stage.contains(e.target)) e.preventDefault();
	});

	function copy(path) {
		if (!navigator.clipboard) return flash('clipboard unavailable');
		navigator.clipboard.writeText(path).then(function () { flash('path copied'); },
			function () { flash('copy failed'); });
	}

	btnForget.addEventListener('click', function () {
		Viewer.destroy();
		btnForget.blur();
	});

	var dropDepth = 0;
	var dropToken = 0;

	function isFiles(dt) {
		return !!dt && Array.prototype.indexOf.call(dt.types || [], 'Files') >= 0;
	}

	window.addEventListener('dragenter', function (e) {
		if (!isFiles(e.dataTransfer)) return;
		e.preventDefault();
		dropDepth++;
		document.body.classList.add('dropping');
	});

	window.addEventListener('dragover', function (e) {
		e.preventDefault();
	});

	window.addEventListener('dragleave', function () {
		if (--dropDepth <= 0) {
			dropDepth = 0;
			document.body.classList.remove('dropping');
		}
	});

	window.addEventListener('drop', function (e) {
		e.preventDefault();
		dropDepth = 0;
		document.body.classList.remove('dropping');
		var mine = ++dropToken;
		Files.fromDataTransfer(e.dataTransfer).then(function (items) {
			if (mine !== dropToken) return;
			load(items);
		}, function () {
			if (mine === dropToken) flash('cannot read dropped items');
		});
	});

	function canStep() {
		if (Viewer.busy() || performance.now() < navUntil) {
			wheelAcc = 0;
			return false;
		}
		return true;
	}

	function step(fn) {
		if (!canStep()) return;
		var prev = Viewer.index();
		stepping = true;
		wheelAcc = 0;
		navUntil = performance.now() + DEBOUNCE;
		fn();
		if (!Viewer.busy() && Viewer.index() === prev) stepping = false;
	}

	var NEXT = { ArrowRight: 1, KeyD: 1, Space: 1, PageDown: 1 };
	var PREV = { ArrowLeft: -1, KeyA: -1, Backspace: -1, PageUp: -1 };

	window.addEventListener('keydown', function (e) {
		if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
		if (e.code === 'Escape') return void closeList();
		if (e.code === 'KeyF') return void toggleList();
		if (e.code === 'KeyC') { if (Viewer.count()) copy(Viewer.item().path); return; }
		if (e.code === 'Home') { if (Viewer.count() > 1) step(Viewer.first); return; }
		if (e.code === 'End') { if (Viewer.count() > 1) step(Viewer.last); return; }
		var dir = e.code === 'Space' && e.shiftKey ? -1 : (NEXT[e.code] || PREV[e.code] || 0);
		if (!dir) return;
		if (Viewer.count() < 2) return;
		e.preventDefault();
		step(function () { Viewer.cycle(dir); });
	});

	window.addEventListener('wheel', function (e) {
		if (e.ctrlKey) return;
		if (!panel.hidden && panel.contains(e.target)) return;
		if (Viewer.count() < 2) return;
		var d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
		if (!d) return;
		e.preventDefault();
		if (!canStep()) return;
		wheelAcc += d;
		if (Math.abs(wheelAcc) < WHEEL_STEP) return;
		var dir = wheelAcc > 0 ? 1 : -1;
		step(function () { Viewer.cycle(dir); });
	}, { passive: false });

	window.addEventListener('beforeunload', function () { Viewer.destroy(); });
})();
