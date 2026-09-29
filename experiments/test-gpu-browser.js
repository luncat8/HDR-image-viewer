// browser harness: drives gpu.html in headless Chromium with SwiftShader WebGPU and reads the
// f16 canvas back, so the shader, the path choice (canvas vs <img>) and the panel are checked
// on real WebGPU, not a stub.
//
// Not part of the no-dependency suite: needs puppeteer-core and a Chromium binary.
//   PUPPETEER=/path/to/node_modules/puppeteer-core CHROME=/path/to/chromium \
//   node experiments/test-gpu-browser.js
// (@sparticuz/chromium from npm works offline: it bundles Chromium and SwiftShader.)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

let puppeteer;
try { puppeteer = require(process.env.PUPPETEER || 'puppeteer-core'); } catch (e) {
	console.log('gpu browser test SKIPPED: set PUPPETEER to a puppeteer-core install');
	process.exit(0);
}

let pass = 0, fail = 0;
const eq = (name, got, want) => {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a === b) { pass++; return; }
	fail++;
	console.log('FAIL ' + name + '\n  got  ' + a + '\n  want ' + b);
};
const near = (name, got, want, tol) => {
	if (Math.abs(got - want) <= tol) { pass++; return; }
	fail++;
	console.log('FAIL ' + name + '\n  got  ' + got + '\n  want ' + want + ' +- ' + tol);
};

// --- test images: a horizontal grey ramp, 0..255 across 256 px, as PNG ---
const crcTable = new Int32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c;
});
const crc = buf => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
	const td = Buffer.concat([Buffer.from(type), data]);
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	td.copy(out, 4);
	out.writeUInt32BE(crc(td), 8 + data.length);
	return out;
};
function rampPng(extra) {
	const w = 256, h = 16;
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.fill(x, y * (w * 3 + 1) + 1 + x * 3, y * (w * 3 + 1) + 4 + x * 3);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; ihdr[9] = 2;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
		...(extra || []), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrv-'));
const sdrPath = path.join(dir, 'a-sdr.png');
const pqPath = path.join(dir, 'b-pq.png');
fs.writeFileSync(sdrPath, rampPng());
fs.writeFileSync(pqPath, rampPng([chunk('cICP', Buffer.from([9, 16, 0, 1]))]));

// Canvas readback: the page never reads its own canvas, so the harness adds COPY_SRC to the
// canvas configuration and, right after every submit that drew into the current texture (it
// expires once presented), copies the whole frame into a buffer that __read maps later.
function probe() {
	const configure = GPUCanvasContext.prototype.configure;
	GPUCanvasContext.prototype.configure = function (c) {
		window.__dev = c.device;
		return configure.call(this, Object.assign({}, c, { usage: (c.usage || 16) | GPUTextureUsage.COPY_SRC }));
	};
	const current = GPUCanvasContext.prototype.getCurrentTexture;
	GPUCanvasContext.prototype.getCurrentTexture = function () { return (window.__tex = current.call(this)); };
	const submit = GPUQueue.prototype.submit;
	GPUQueue.prototype.submit = function (cmds) {
		submit.call(this, cmds);
		const tex = window.__tex, dev = window.__dev;
		if (!tex) return;
		window.__tex = null;
		const bpr = Math.ceil(tex.width * 8 / 256) * 256;
		const buf = dev.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
		const enc = dev.createCommandEncoder();
		enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
		submit.call(this, [enc.finish()]);
		window.__frame = { buf, bpr };
	};
	window.__read = async function (x, y) {
		const f = window.__frame;
		if (!f.data) {
			await f.buf.mapAsync(GPUMapMode.READ);
			f.data = new Float16Array(f.buf.getMappedRange().slice(0));
			f.buf.unmap();
		}
		const i = (y * f.bpr / 8 + x) * 4;
		return Array.from(f.data.subarray(i, i + 4));
	};
}

(async () => {
	const browser = await puppeteer.launch({
		executablePath: process.env.CHROME,
		headless: 'shell',
		args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
			'--use-angle=swiftshader', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader']
	});
	const page = await browser.newPage();
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
	await page.setViewport({ width: 512, height: 64, deviceScaleFactor: 1 });
	await page.evaluateOnNewDocument(probe);
	await page.goto('file://' + path.join(__dirname, '..', 'gpu.html'));
	await page.waitForFunction(() => !/starting/.test(document.getElementById('status').textContent));

	const state = () => page.evaluate(() => ({
		status: document.getElementById('status').textContent,
		mode: document.getElementById('mode').textContent,
		canvas: !document.getElementById('gpu').classList.contains('off'),
		native: !document.getElementById('native').classList.contains('off'),
		nativeSrc: !!document.getElementById('native').getAttribute('src'),
		title: document.title
	}));
	const frame = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
	// the 256 px ramp contain-fits a 512x64 canvas as 256x16 scaled x4 to 1024x64: too wide,
	// so it fits as 512x32 centred; ramp value v sits at x = 2v + 1, y = 32
	const at = v => page.evaluate((x) => window.__read(x, 32), Math.round(v * 2) + 1);
	const click = id => page.evaluate(id => document.getElementById(id).click(), id);
	const setSlider = (id, v) => page.evaluate((id, v) => {
		const el = document.getElementById(id);
		el.value = v;
		el.dispatchEvent(new Event('input'));
	}, id, v);

	let s = await state();
	eq('status reports WebGPU with extended range', /WebGPU f16 · extended range/.test(s.status), true);
	eq('no fallback link when WebGPU works', await page.$eval('#noGpu', e => e.hidden), true);
	eq('menu links to the <img> page', await page.$eval('#list .pages a', a => a.getAttribute('href')), 'index.html');

	await page.evaluate(() => localStorage.clear());
	await (await page.$('#pickFiles')).uploadFile(sdrPath, pqPath);
	await page.waitForFunction(() => /a-sdr\.png · 1\/2/.test(document.title));
	await frame();
	s = await state();
	eq('SDR image is drawn on the canvas', [s.canvas, s.native, s.nativeSrc], [true, false, false]);
	eq('mode line names the SDR path', s.mode, 'this image: SDR, expanded on the GPU');

	// expander off: the canvas carries the input values unchanged
	await page.keyboard.press('KeyE');
	await frame();
	near('bypass keeps mid grey', (await at(128))[0], 128 / 255, 0.01);
	near('bypass keeps white at 1.0', (await at(255))[0], 1, 0.01);
	eq('opaque output', (await at(128))[3], 1);

	// expander on, defaults: highlights +1.5 EV lifts white past SDR, mid-tones barely move
	await page.keyboard.press('KeyE');
	await frame();
	const curve = (e, p) => page.evaluate((e, p) => Gpu.curve(e, p), e, p);
	const enc = l => l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
	const def = { black: 0, white: 1, exposure: 0, peak: 1.5 };
	const white = (await at(255))[0];
	near('white lands at peak x SDR white (encoded)', white, enc(Math.pow(2, 1.5)), 0.02);
	eq('white is above SDR white: HDR headroom in use', white > 1.3, true);
	near('mid grey matches the JS curve', (await at(128))[0], enc(await curve(128 / 255, def)), 0.01);
	near('mid grey stays near SDR', (await at(128))[0], 128 / 255, 0.05);

	// levels and exposure
	await setSlider('black', 0.5);
	await setSlider('exposure', 1);
	await frame();
	near('below the black point is black', (await at(100))[0], 0, 0.002);
	const p2 = { black: 0.5, white: 1, exposure: 1, peak: 1.5 };
	near('levels + exposure match the JS curve', (await at(200))[0], enc(await curve(200 / 255, p2)), 0.02);
	await setSlider('white', 0.3);
	eq('white point cannot cross the black point', await page.$eval('#white', e => +e.value), 0.52);
	await click('btnReset');
	await frame();
	near('reset restores the defaults', (await at(255))[0], white, 0.01);

	await click('btnAuto');
	eq('auto levels on a full ramp keeps the range', await page.evaluate(() => [+document.getElementById('black').value, +document.getElementById('white').value]), [0, 1]);
	eq('histogram holds the sample', await page.evaluate(() => {
		const d = document.getElementById('hist').getContext('2d').getImageData(0, 0, 600, 180).data;
		let lit = 0;
		for (let i = 3; i < d.length; i += 4) if (d[i]) lit++;
		return lit > 1000;
	}), true);

	eq('settings persist', await page.evaluate(() => JSON.parse(localStorage.getItem('hdr-viewer.gpu')).peak), 1.5);

	// PQ-tagged image: native <img>, the canvas texture is released
	await page.keyboard.press('ArrowRight');
	await page.waitForFunction(() => /b-pq\.png · 2\/2/.test(document.title));
	s = await state();
	eq('PQ image goes to the native <img>', [s.canvas, s.native, s.nativeSrc], [false, true, true]);
	eq('mode line names the HDR path', s.mode, 'this image: HDR (PQ), native <img>');
	eq('HDR group is the active one', await page.evaluate(() => [
		document.getElementById('sdr').classList.contains('active'),
		document.getElementById('hdr').classList.contains('active')]), [false, true]);
	await setSlider('limit', 30);
	eq('headroom slider sets dynamic-range-limit', await page.$eval('#native', e => e.style.dynamicRangeLimit),
		'dynamic-range-limit-mix(standard 70%, no-limit 30%)');
	await setSlider('limit', 0);
	eq('headroom 0 is standard', await page.$eval('#native', e => e.style.dynamicRangeLimit), 'standard');

	// back to SDR: native <img> is emptied, canvas returns
	await new Promise(r => setTimeout(r, 150));
	await page.keyboard.press('ArrowLeft');
	await page.waitForFunction(() => /a-sdr\.png · 1\/2/.test(document.title));
	await frame();
	s = await state();
	eq('back on the canvas, native <img> released', [s.canvas, s.native, s.nativeSrc], [true, false, false]);

	await click('btnForget');
	s = await state();
	eq('forget blanks both', [s.canvas, s.native, s.mode], [false, false, 'no image']);

	eq('no page errors or WebGPU warnings', errors, []);

	// the <img> page links back
	await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
	eq('<img> page menu links to gpu.html', await page.$eval('#list .pages a', a => a.getAttribute('href')), 'gpu.html');

	// no WebGPU: fallback link on the empty screen, images through <img>
	await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'gpu', { value: undefined }); });
	await page.goto('file://' + path.join(__dirname, '..', 'gpu.html'));
	await page.waitForFunction(() => !/starting/.test(document.getElementById('status').textContent));
	eq('fallback link shown without WebGPU', await page.$eval('#noGpu', e => e.hidden), false);
	eq('SDR controls disabled without WebGPU', await page.$eval('#sdr', e => e.disabled), true);
	await (await page.$('#pickFiles')).uploadFile(sdrPath);
	await page.waitForFunction(() => /a-sdr\.png/.test(document.title));
	s = await state();
	eq('without WebGPU an SDR image uses <img>', [s.canvas, s.native, s.mode], [false, true, 'this image: native <img>']);

	await browser.close();
	fs.rmSync(dir, { recursive: true, force: true });
	console.log(fail ? 'gpu browser FAILED ' + fail + ' of ' + (pass + fail) : 'gpu browser OK (' + pass + ' checks)');
	process.exit(fail ? 1 : 0);
})().catch(e => { console.log('gpu browser ERROR', e); process.exit(1); });
