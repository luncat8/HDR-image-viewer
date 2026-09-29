// File collection: pickers, drag & drop (incl. directories), image filter, natural order.
var Files = (function () {
	'use strict';

	// extension test beats MIME: OSes and browsers report empty/odd types for some formats
	var EXT = new Set('jpg jpeg jpe jfif png apng gif webp avif bmp ico tif tiff svg jxl heic heif'.split(' '));

	var isDigit = function (code) { return code > 47 && code < 58; };

	// digits compare by value, everything else by code unit, so img2 < img10
	function natCmp(a, b) {
		var x = a.toLowerCase(), y = b.toLowerCase();
		var i = 0, j = 0;
		while (i < x.length && j < y.length) {
			var cx = x.charCodeAt(i), cy = y.charCodeAt(j);
			if (!isDigit(cx) || !isDigit(cy)) {
				if (cx !== cy) return cx - cy;
				i++; j++;
				continue;
			}
			var xs = i, ys = j;
			while (i < x.length && isDigit(x.charCodeAt(i))) i++;
			while (j < y.length && isDigit(y.charCodeAt(j))) j++;
			// compare the runs by value: skip leading zeros, then length, then digits
			while (xs < i - 1 && x.charCodeAt(xs) === 48) xs++;
			while (ys < j - 1 && y.charCodeAt(ys) === 48) ys++;
			var len = (i - xs) - (j - ys);
			if (len) return len;
			while (xs < i) {
				if (x.charCodeAt(xs) !== y.charCodeAt(ys)) return x.charCodeAt(xs) - y.charCodeAt(ys);
				xs++; ys++;
			}
		}
		return (x.length - i) - (y.length - j);
	}

	function extOf(name) {
		var dot = name.lastIndexOf('.');
		if (dot < 1) return '';
		return name.slice(dot + 1).toLowerCase();
	}

	function isImage(file) { return EXT.has(extOf(file.name)); }

	function item(file, path) {
		return { file: file, path: path || file.webkitRelativePath || file.name };
	}

	function byPath(a, b) { return natCmp(a.path, b.path); }

	// keeps only images, drops the rest, natural path order
	function collect(list) {
		var out = [];
		for (var i = 0; i < list.length; i++) {
			if (isImage(list[i].file)) out.push(list[i]);
		}
		out.sort(byPath);
		return out;
	}

	// <input type=file> and <input webkitdirectory>
	function fromInput(fileList) {
		var out = [];
		for (var i = 0; i < fileList.length; i++) out.push(item(fileList[i]));
		return collect(out);
	}

	// readEntries yields max 100 entries per call and signals end with an empty batch
	function readDir(reader) {
		return new Promise(function (resolve) {
			var out = [];
			var step = function () {
				reader.readEntries(function (batch) {
					if (!batch.length) return resolve(out);
					for (var i = 0; i < batch.length; i++) out.push(batch[i]);
					step();
				}, function () { resolve(out); });
			};
			step();
		});
	}

	// iterative tree walk. async callbacks call back into drain(), so nothing recurses on
	// depth and each callback owns its own path binding instead of sharing a loop variable.
	function crawler() {
		var out = [];
		var stack = [];
		var pending = 0;
		var waiting = null;
		var draining = false;

		var settle = function () {
			if (pending || !waiting) return;
			var done = waiting;
			waiting = null;
			done(out);
		};

		var drain = function () {
			if (draining) return;
			draining = true;
			while (stack.length) {
				var top = stack.pop();
				take(top.entry, top.path);
			}
			draining = false;
			settle();
		};

		function take(entry, path) {
			if (!entry) return;
			pending++;
			if (entry.isFile) {
				entry.file(function (file) {
					out.push(item(file, path));
					pending--;
					drain();
				}, function () { pending--; drain(); });
				return;
			}
			// hidden dirs (.git, .thumbnails) hold no viewable content and are slow to walk
			if (!entry.isDirectory || entry.name.charAt(0) === '.') {
				pending--;
				return;
			}
			readDir(entry.createReader()).then(function (children) {
				for (var i = 0; i < children.length; i++) {
					stack.push({ entry: children[i], path: path + '/' + children[i].name });
				}
				pending--;
				drain();
			});
		}

		return {
			add: function (entry) {
				stack.push({ entry: entry, path: entry.name || '' });
				drain();
			},
			// fires only once every added subtree has reported back
			done: function (cb) {
				if (pending) { waiting = cb; return; }
				cb(out);
			}
		};
	}

	// Chrome invalidates the DataTransferItem list once drop has fired: entries handed out
	// during drop are null. They have to be taken while the drag is still live, so this is
	// called from dragenter/dragover and the result is passed back in at drop time.
	function captureEntries(dt) {
		var items = dt && dt.items;
		if (!items || !items.length || !items[0].webkitGetAsEntry) return [];
		var out = [];
		for (var i = 0; i < items.length; i++) {
			var entry = items[i].webkitGetAsEntry();
			if (entry) out.push(entry);
		}
		return out;
	}

	// entries captured during the drag; a plain file drop needs none and falls back to files
	function fromDataTransfer(dt, entries) {
		var list = entries && entries.length ? entries : captureEntries(dt);
		if (!list.length) return Promise.resolve(fromInput((dt && dt.files) || []));
		var cr = crawler();
		for (var i = 0; i < list.length; i++) cr.add(list[i]);
		return new Promise(function (resolve) {
			cr.done(function (out) { resolve(collect(out)); });
		});
	}

	return {
		isImage: isImage,
		fromInput: fromInput,
		captureEntries: captureEntries,
		fromDataTransfer: fromDataTransfer,
		natCmp: natCmp
	};
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Files;
