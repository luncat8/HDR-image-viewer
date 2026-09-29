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

	function isImage(file) { return !!file && EXT.has(extOf(file.name || '')); }

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

	// FileSystemDirectoryHandle async iterator (used by getAsFileSystemHandle in Chrome)
	function readHandleDir(dir) {
		return new Promise(function (resolve) {
			var out = [];
			var it = dir.values ? dir.values() : (dir.entries ? dir.entries() : null);
			if (!it || !it.next) return resolve(out);
			var step = function () {
				it.next().then(function (res) {
					if (!res || res.done) return resolve(out);
					var val = res.value;
					out.push(Array.isArray(val) ? val[1] : val);
					step();
				}, function () { resolve(out); });
			};
			step();
		});
	}

	// iterative tree walk supporting both FileSystemHandle (Chrome) and FileSystemEntry (Firefox)
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
				take(top.entry, top.path, top.file);
			}
			draining = false;
			settle();
		};

		function take(entry, path, fallback) {
			if (!entry) return;
			pending++;
			if (entry.kind === 'file') {
				entry.getFile().then(function (file) {
					out.push(item(file, path));
					pending--;
					drain();
				}, function () {
					if (fallback) out.push(item(fallback, path));
					pending--;
					drain();
				});
				return;
			}
			if (entry.isFile) {
				entry.file(function (file) {
					out.push(item(file, path));
					pending--;
					drain();
				}, function () {
					if (fallback) out.push(item(fallback, path));
					pending--;
					drain();
				});
				return;
			}
			// hidden dirs (.git, .thumbnails) hold no viewable content and are slow to walk
			var isDir = entry.kind === 'directory' || entry.isDirectory;
			if (!isDir || (entry.name && entry.name.charAt(0) === '.')) {
				pending--;
				return;
			}
			var childrenPromise = entry.kind === 'directory' ? readHandleDir(entry) : readDir(entry.createReader());
			childrenPromise.then(function (children) {
				for (var i = 0; i < children.length; i++) {
					var c = children[i];
					stack.push({ entry: c, path: path + '/' + c.name, file: null });
				}
				pending--;
				drain();
			});
		}

		return {
			add: function (entry, file) {
				stack.push({ entry: entry, path: entry.name || '', file: file || null });
				drain();
			},
			done: function (cb) {
				if (pending) { waiting = cb; return; }
				cb(out);
			}
		};
	}

	function walk(roots) {
		if (!roots.length) return Promise.resolve([]);
		var cr = crawler();
		for (var i = 0; i < roots.length; i++) cr.add(roots[i].entry, roots[i].file);
		return new Promise(function (resolve) {
			cr.done(function (out) { resolve(collect(out)); });
		});
	}

	// synchronously snapshot flat files before the drop event ends and clears dataTransfer
	function snapFiles(dt) {
		if (!dt) return [];
		if (dt.files && dt.files.length) return fromInput(dt.files);
		var items = dt.items || [];
		var out = [];
		for (var i = 0; i < items.length; i++) {
			var it = items[i];
			if (it && (!it.kind || it.kind === 'file') && it.getAsFile) {
				var f = it.getAsFile();
				if (f) out.push(item(f));
			}
		}
		return collect(out);
	}

	function grabHandle(it, file) {
		try {
			var p = it.getAsFileSystemHandle();
			if (!p || !p.then) return null;
			return p.then(function (h) {
				return h ? { entry: h, file: file } : null;
			}, function () { return null; });
		} catch (e) {
			return null;
		}
	}

	// On file:// in Chrome, webkitGetAsEntry's file()/readEntries() fails asynchronously with
	// EncodingError, and by then dataTransfer.files is already cleared. Everything on
	// dataTransfer must be captured synchronously during drop: getAsFileSystemHandle (works
	// for folders and files on file:// in Chrome), webkitGetAsEntry (works in Firefox), and
	// the flat files list as fallback.
	function fromDataTransfer(dt) {
		var flat = snapFiles(dt);
		var items = (dt && dt.items) || [];
		var handlePromises = [];
		var entries = [];
		for (var i = 0; i < items.length; i++) {
			var it = items[i];
			if (!it || (it.kind && it.kind !== 'file')) continue;
			var f = it.getAsFile ? it.getAsFile() : null;
			if (it.getAsFileSystemHandle) {
				var hp = grabHandle(it, f);
				if (hp) handlePromises.push(hp);
			}
			if (it.webkitGetAsEntry) {
				var entry = it.webkitGetAsEntry();
				if (entry) entries.push({ entry: entry, file: f });
			}
		}
		var tryEntries = function () {
			if (!entries.length) return Promise.resolve(flat);
			return walk(entries).then(function (res) {
				return res.length && res.length >= flat.length ? res : flat;
			});
		};
		if (!handlePromises.length) return tryEntries();
		return Promise.all(handlePromises).then(function (resolved) {
			var handles = [];
			for (var i = 0; i < resolved.length; i++) {
				if (resolved[i]) handles.push(resolved[i]);
			}
			if (!handles.length) return tryEntries();
			return walk(handles).then(function (res) {
				return res.length && res.length >= flat.length ? res : tryEntries();
			});
		});
	}

	return {
		isImage: isImage,
		fromInput: fromInput,
		fromDataTransfer: fromDataTransfer,
		natCmp: natCmp
	};
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Files;
