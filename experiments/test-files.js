// node harness: exercises js/files.js with mock File, FileSystemEntry, and FileSystemHandle trees.
// usage: node experiments/test-files.js
'use strict';
const path = require('path');
const Files = require(path.join(__dirname, '..', 'js', 'files.js'));

let pass = 0, fail = 0;
const eq = (name, got, want) => {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a === b) { pass++; return; }
	fail++;
	console.log('FAIL ' + name + '\n  got  ' + a + '\n  want ' + b);
};

const file = (name, rel) => ({ name, webkitRelativePath: rel || '' });

// --- isImage ---
const names = ['a.JPG', 'a.jpeg', 'a.png', 'a.GIF', 'a.webp', 'a.avif', 'a.bmp', 'a.svg',
	'a.tiff', 'a.apng', 'a.ico', 'a.jxl', 'a.heic', 'noext', 'a.txt', 'a.mp4', 'a.', '.png', 'a.png.bak'];
const wantImg = names.map(n => !!Files.isImage(file(n)));
eq('isImage', wantImg, names.map((n, i) => i < 13));

// --- natural order ---
const sort = a => a.slice().sort(Files.natCmp);
eq('natCmp numbers', sort(['img10.png', 'img2.png', 'img1.png', 'IMG3.png']), ['img1.png', 'img2.png', 'IMG3.png', 'img10.png']);
eq('natCmp deep', sort(['b/2.png', 'b/10.png', 'a/9.png', 'b/1/1.png', 'b/1.png']),
	['a/9.png', 'b/1.png', 'b/1/1.png', 'b/2.png', 'b/10.png']);
eq('natCmp wide', sort(['a9.png', 'a10.png', 'a9x.png', 'a007.png', 'a100.png', 'a20.png']),
	['a007.png', 'a9.png', 'a9x.png', 'a10.png', 'a20.png', 'a100.png']);
eq('natCmp equal', Files.natCmp('x.png', 'X.PNG'), 0);

// --- fromInput: filter + path + order ---
const list = [file('b.png', 'dir/b.png'), file('n.txt', 'dir/n.txt'), file('a2.jpg', 'dir/a2.jpg'),
	file('a10.jpg', 'dir/a10.jpg'), file('a1.jpg', 'dir/a1.jpg')];
const picked = Files.fromInput(list);
eq('fromInput paths', picked.map(i => i.path), ['dir/a1.jpg', 'dir/a2.jpg', 'dir/a10.jpg', 'dir/b.png']);
eq('fromInput keeps File', picked[0].file === list[4], true);
eq('fromInput empty', Files.fromInput([]), []);
eq('fromInput name fallback', Files.fromInput([file('z.png')])[0].path, 'z.png');

// --- mock FileSystemEntry tree (Firefox / classic API) ---
const entry = (name, children) => ({
	name,
	isFile: !children,
	isDirectory: !!children,
	createReader: () => {
		let sent = false;
		return {
			readEntries: cb => setTimeout(() => cb(sent ? [] : (sent = true, children)), 0)
		};
	},
	file: cb => setTimeout(() => cb(file(name, '')), 0)
});

// --- mock FileSystemHandle tree (Chrome getAsFileSystemHandle API) ---
const handle = (name, children) => ({
	name,
	kind: children ? 'directory' : 'file',
	getFile: () => Promise.resolve(file(name, '')),
	values: () => {
		let i = 0;
		return {
			next: () => Promise.resolve(i < children.length
				? { done: false, value: children[i++] }
				: { done: true })
		};
	}
});

const bulk = [];
for (let i = 1; i <= 250; i++) bulk.push(entry('p' + i + '.png'));
bulk.push(entry('notes.txt'));

const tree = entry('photos', [
	entry('b.png'),
	entry('.hidden', [entry('secret.png')]),
	entry('sub', [entry('c.png'), entry('d.jpg'), entry('e.gif')]),
	entry('wide', bulk)
]);

const handleTree = handle('album', [
	handle('p10.png'),
	handle('p2.png'),
	handle('.git', [handle('ignored.png')]),
	handle('nested', [handle('z.avif'), handle('readme.md')])
]);

(async () => {
	// Firefox / webkitGetAsEntry tree walk
	const out = await Files.fromDataTransfer({ files: [], items: [{ webkitGetAsEntry: () => tree }] });
	eq('drop count', out.length, 254);
	eq('drop first', out[0].path, 'photos/b.png');
	eq('drop skips hidden', out.some(i => i.path.indexOf('.hidden') >= 0), false);
	eq('drop skips non-image', out.some(i => i.path.indexOf('notes') >= 0), false);
	eq('drop batches >100', out.filter(i => i.path.indexOf('photos/wide/') === 0).length, 250);
	eq('drop natural order tail', out[out.length - 1].path, 'photos/wide/p250.png');
	eq('drop order is numeric', out.slice(4, 8).map(i => i.path),
		['photos/wide/p1.png', 'photos/wide/p2.png', 'photos/wide/p3.png', 'photos/wide/p4.png']);

	// Chrome Windows file:// directory drop: getAsFileSystemHandle works when webkitGetAsEntry fails
	const brokenEntry = {
		name: 'album', isFile: false, isDirectory: true,
		createReader: () => ({ readEntries: (ok, err) => setTimeout(() => err(new Error('EncodingError')), 0) })
	};
	const chromeDrop = await Files.fromDataTransfer({
		files: [],
		items: [{
			kind: 'file',
			getAsFileSystemHandle: () => Promise.resolve(handleTree),
			webkitGetAsEntry: () => brokenEntry
		}]
	});
	eq('chrome handle walk count', chromeDrop.length, 3);
	eq('chrome handle walk paths', chromeDrop.map(i => i.path),
		['album/nested/z.avif', 'album/p2.png', 'album/p10.png']);

	// Chrome Windows file:// file drop where webkitGetAsEntry.file() fails asynchronously and
	// dt.files is cleared by the browser as soon as the synchronous drop handler returns
	const transientDt = {
		files: [file('b.png'), file('a.png'), file('doc.pdf')],
		items: [{
			kind: 'file',
			getAsFile: () => file('b.png'),
			webkitGetAsEntry: () => ({
				name: 'b.png', isFile: true, isDirectory: false,
				file: (ok, err) => setTimeout(() => err(new Error('EncodingError')), 0)
			})
		}]
	};
	const p = Files.fromDataTransfer(transientDt);
	transientDt.files = [];
	transientDt.items = [];
	const recovered = await p;
	eq('synchronous snapshot survives async EncodingError and cleared dt.files',
		recovered.map(i => i.path), ['a.png', 'b.png']);

	// Fallback when getAsFileSystemHandle rejects (e.g. insecure context)
	const fallbackWalk = await Files.fromDataTransfer({
		files: [],
		items: [{
			kind: 'file',
			getAsFileSystemHandle: () => Promise.reject(new Error('SecurityError')),
			webkitGetAsEntry: () => handleTree ? entry('dir', [entry('img.png')]) : null
		}]
	});
	eq('falls back to webkitGetAsEntry when handle rejects', fallbackWalk.map(i => i.path), ['dir/img.png']);

	// Plain file drop with no entries
	const flat = await Files.fromDataTransfer({
		files: [file('b.png'), file('a.png'), file('x.zip')],
		items: [{ webkitGetAsEntry: () => null }]
	});
	eq('fallback paths', flat.map(i => i.path), ['a.png', 'b.png']);
	eq('empty drop', (await Files.fromDataTransfer({ files: [], items: [] })).length, 0);
	eq('null drop', (await Files.fromDataTransfer(null)).length, 0);

	console.log(fail ? fail + ' FAILED' : 'files.js OK (' + pass + ' checks)');
	process.exit(fail ? 1 : 0);
})().catch(e => { console.log('threw', e); process.exit(1); });
