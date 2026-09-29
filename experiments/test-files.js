// node harness: exercises js/files.js with a mock File / FileSystemEntry tree.
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

// --- mock FileSystemEntry tree for drag & drop ---
const entry = (name, children) => ({
	name,
	isFile: !children,
	isDirectory: !!children,
	createReader: () => {
		let sent = false;
		return {
			// force 100-per-batch delivery the way Chrome does
			readEntries: cb => setTimeout(() => cb(sent ? [] : (sent = true, children)), 0)
		};
	},
	file: cb => setTimeout(() => cb(file(name, '')), 0)
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

const live = { files: [], items: [{ webkitGetAsEntry: () => tree }] };
// what a real drop event sees: Chrome has already invalidated the item list
const spent = { files: [], items: [{ webkitGetAsEntry: () => null }] };

// --- captureEntries, and the walk driven by what it captured ---
(async () => {
	eq('captures live entries', Files.captureEntries(live).length, 1);
	eq('captures nothing once spent', Files.captureEntries(spent).length, 0);
	eq('captures nothing without the api', Files.captureEntries({ files: [], items: [{}] }).length, 0);
	eq('captures nothing from an empty transfer', Files.captureEntries({ files: [], items: [] }).length, 0);
	eq('captures nothing from nothing', Files.captureEntries(null).length, 0);

	// entries captured mid-drag drive the walk, even though the transfer is spent by drop time
	const out = await Files.fromDataTransfer(spent, Files.captureEntries(live));
	eq('drop count', out.length, 254);
	eq('drop first', out[0].path, 'photos/b.png');
	eq('drop skips hidden', out.some(i => i.path.indexOf('.hidden') >= 0), false);
	eq('drop skips non-image', out.some(i => i.path.indexOf('notes') >= 0), false);
	eq('drop batches >100', out.filter(i => i.path.indexOf('photos/wide/') === 0).length, 250);
	eq('drop natural order tail', out[out.length - 1].path, 'photos/wide/p250.png');
	eq('drop order is numeric', out.slice(4, 8).map(i => i.path),
		['photos/wide/p1.png', 'photos/wide/p2.png', 'photos/wide/p3.png', 'photos/wide/p4.png']);

	// with nothing captured and nothing readable, the drop is simply empty
	eq('spent transfer, no entries', (await Files.fromDataTransfer(spent, [])).length, 0);
	eq('spent transfer, live capture', (await Files.fromDataTransfer(spent)).length, 0);
	eq('no second argument still walks', (await Files.fromDataTransfer(live)).length, 254);

	// plain file drop: no entries, falls back to the file list, non-images filtered
	const flat = await Files.fromDataTransfer(
		{ files: [file('b.png'), file('a.png'), file('x.zip')], items: [{ webkitGetAsEntry: () => null }] }, []);
	eq('fallback paths', flat.map(i => i.path), ['a.png', 'b.png']);
	eq('empty drop', (await Files.fromDataTransfer({ files: [], items: [] }, [])).length, 0);

	console.log(fail ? fail + ' FAILED' : 'files.js OK (' + pass + ' checks)');
	process.exit(fail ? 1 : 0);
})().catch(e => { console.log('threw', e); process.exit(1); });
