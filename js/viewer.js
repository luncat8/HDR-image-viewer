// One image at a time in a plain <img>.
//
// The browser owns decode, colour management and HDR tone mapping here, which is the whole
// reason there is no canvas: a 2D canvas is 8-bit per channel, so drawing an HDR frame into
// one clamps it to SDR on the way out, and asking for a display-p3 canvas only widens the
// gamut without adding bits. An <img> is composited by the browser and keeps whatever the
// file carries, and object-fit does the contain fit without any geometry code.
var Viewer = (function () {
	'use strict';

	var img = null;
	var list = [];
	var index = -1;
	var url = '';
	var token = 0;
	var failed = 0;
	var busy = 0;   // a load/decode is in flight
	var api = {};

	api.onchange = null;   // (path, index, count, width, height, failed)
	api.onempty = null;
	// optional display stage between decode and report, e.g. a GPU upload. present(img, item,
	// finish) keeps the load busy until it calls finish(bad), which returns false once the load
	// has been superseded so the stage knows not to swap its output in. blank() hides it.
	api.present = null;
	api.blank = null;

	function release() {
		if (!url) return;
		URL.revokeObjectURL(url);
		url = '';
	}

	function report() {
		if (!api.onchange) return;
		if (index < 0) return api.onchange('', -1, 0, 0, 0, 0);
		api.onchange(list[index].path, index, list.length,
			img.naturalWidth, img.naturalHeight, failed);
	}

	function sameItem(a, b) {
		if (a.file === b.file) return true;
		if (a.path !== b.path) return false;
		return a.file.size === b.file.size && a.file.lastModified === b.file.lastModified;
	}

	function findItem(arr, it) {
		for (var i = 0; i < arr.length; i++) {
			if (sameItem(arr[i], it)) return i;
		}
		return -1;
	}

	function dedup(items) {
		var out = [];
		for (var i = 0; i < items.length; i++) {
			if (findItem(out, items[i]) < 0) out.push(items[i]);
		}
		return out;
	}

	function show(i) {
		if (!list.length) {
			index = -1;
			token++;
			failed = 0;
			busy = 0;
			release();
			img.removeAttribute('src');
			if (api.blank) api.blank();
			report();
			return;
		}
		// one load at a time: any step arriving before decode completes is dropped
		if (busy) return;
		var n = ((i % list.length) + list.length) % list.length;
		if (n === index) return;
		index = n;
		failed = 0;
		busy = 1;
		var mine = ++token;
		release();
		url = URL.createObjectURL(list[n].file);
		var item = list[n];
		var finish = function (bad) {
			if (mine !== token) return false;
			busy = 0;
			failed = bad ? 1 : 0;
			if (bad && api.blank) api.blank();
			report();
			return true;
		};
		var decoded = function () {
			if (mine !== token) return;
			if (api.present) return api.present(img, item, finish);
			finish(0);
		};
		img.onload = function () {
			if (mine !== token) return;
			// in Firefox, onload fires before pixel decode; decode() waits until ready to paint
			if (typeof img.decode === 'function') {
				img.decode().then(decoded, decoded);
				return;
			}
			decoded();
		};
		img.onerror = function () {
			finish(1);
		};
		img.src = url;   // the previous frame stays up until this one decodes
	}

	function goto(i) { show(i); }

	// dropping the set is what actually frees the memory: the object URL holds the blob and
	// every File in the list holds a handle to its bytes, so both have to go.
	function setImages(items, startAt) {
		list = dedup(items || []);
		index = -1;
		busy = 0;   // a new set replaces the frame still decoding, it does not wait for it
		show(startAt || 0);
		if (api.onempty) api.onempty(list.length > 0);
	}

	// adds only files not already in the list; if all were already open, jumps to the first
	function addImages(items) {
		if (!items || !items.length) return 0;
		if (!list.length) {
			setImages(items, 0);
			return list.length;
		}
		var added = 0;
		for (var i = 0; i < items.length; i++) {
			if (findItem(list, items[i]) >= 0) continue;
			list.push(items[i]);
			added++;
		}
		if (added > 0) {
			if (api.onempty) api.onempty(true);
			report();
			return added;
		}
		var target = findItem(list, items[0]);
		if (target >= 0 && target !== index) show(target);
		return 0;
	}

	function remove(i) {
		if (i < 0 || i >= list.length) return;
		list.splice(i, 1);
		if (!list.length) {
			setImages([], 0);
			return;
		}
		if (i < index) {
			index--;
			if (api.onempty) api.onempty(true);
			report();
			return;
		}
		if (i > index) {
			if (api.onempty) api.onempty(true);
			report();
			return;
		}
		var next = index < list.length ? index : list.length - 1;
		index = -1;
		busy = 0;
		show(next);
		if (api.onempty) api.onempty(true);
	}

	api.init = function (el) { img = el; };
	api.setImages = setImages;
	api.addImages = addImages;
	api.remove = remove;
	api.busy = function () { return !!busy; };

	api.count = function () { return list.length; };
	api.index = function () { return index; };
	// no index, or a negative one, means the image on screen
	api.item = function (i) { return list[i == null || i < 0 ? index : i] || null; };
	api.goto = goto;
	api.cycle = function (dir) { goto(index + (dir < 0 ? -1 : 1)); };
	api.first = function () { goto(0); };
	api.last = function () { goto(list.length - 1); };

	api.destroy = function () { setImages([], 0); };

	return api;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Viewer;
