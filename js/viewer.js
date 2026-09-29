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
	var api = {};

	api.onchange = null;   // (path, index, count, width, height, failed)
	api.onempty = null;

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

	function show(i) {
		if (!list.length) {
			index = -1;
			token++;
			failed = 0;
			release();
			img.removeAttribute('src');
			report();
			return;
		}
		var n = ((i % list.length) + list.length) % list.length;
		if (n === index) return;
		index = n;
		failed = 0;
		var mine = ++token;
		release();
		url = URL.createObjectURL(list[n].file);
		img.onload = function () {
			if (mine !== token) return;   // a faster jump superseded this one
			report();
		};
		img.onerror = function () {
			if (mine !== token) return;
			failed = 1;
			report();
		};
		img.src = url;   // the previous frame stays up until this one decodes
	}

	function goto(i) { show(i); }

	// dropping the set is what actually frees the memory: the object URL holds the blob and
	// every File in the list holds a handle to its bytes, so both have to go.
	function setImages(items, startAt) {
		list = items;
		index = -1;
		show(startAt || 0);
		if (api.onempty) api.onempty(list.length > 0);
	}

	api.init = function (el) { img = el; };
	api.setImages = setImages;

	api.count = function () { return list.length; };
	api.index = function () { return index; };
	api.item = function (i) { return list[i < 0 ? index : i] || null; };
	api.goto = goto;
	api.cycle = function (dir) { goto(index + (dir < 0 ? -1 : 1)); };
	api.first = function () { goto(0); };
	api.last = function () { goto(list.length - 1); };

	api.destroy = function () { setImages([], 0); };

	return api;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Viewer;
