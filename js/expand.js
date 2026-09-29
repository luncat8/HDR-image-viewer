// Wiring for gpu.html: picks the display path per image and drives the adjustment panel.
//
// SDR images go through the WebGPU stage and the expander. Images Sniff reports as HDR (PQ,
// HLG, gain map) go to a plain <img>, the only path where the browser keeps their range; they
// get their own control, the CSS dynamic-range-limit headroom, and never the expander. Without
// WebGPU every image takes the <img> path.
(function () {
	'use strict';

	var STORE = 'hdr-viewer.gpu';
	var DEFAULTS = { on: 1, black: 0, white: 1, exposure: 0, peak: 1.5, limit: 100 };
	var SAVE_DELAY = 1000;       // a slider drag writes once, after it stops
	var MIN_GAP = 0.02;          // black and white never cross or meet
	var AUTO_CLIP = 0.0005;      // share of pixels auto levels lets clip at each end
	var BINS = 256;
	var SAMPLE = 256;            // histogram is taken from a SAMPLE x SAMPLE resample
	var KIND_NAME = { pq: 'HDR (PQ)', hlg: 'HDR (HLG)', gainmap: 'HDR (gain map)' };

	var canvas = document.getElementById('gpu');
	var native = document.getElementById('native');
	var noGpu = document.getElementById('noGpu');
	var statusEl = document.getElementById('status');
	var modeEl = document.getElementById('mode');
	var sdrBox = document.getElementById('sdr');
	var hdrBox = document.getElementById('hdr');
	var hist = document.getElementById('hist');
	var hctx = hist.getContext('2d');
	var btnAuto = document.getElementById('btnAuto');
	var btnReset = document.getElementById('btnReset');

	var p = Gpu.params;
	var s = load();              // persisted settings, p mirrors the expander part of it
	var gpuOk = false;
	var mode = '';               // '' | 'sdr' | 'img' | 'pq' | 'hlg' | 'gainmap'
	var bins = new Uint32Array(BINS);
	var binsTotal = 0;
	var histQueued = 0;
	var saveTimer = 0;
	var sampler = null;          // 2D context the histogram resample is read back from

	// name -> [input, output, format]; the table drives sync, input and reset
	var sliders = {
		black: [el('black'), el('blackOut'), function (v) { return v.toFixed(3); }],
		white: [el('white'), el('whiteOut'), function (v) { return v.toFixed(3); }],
		exposure: [el('exposure'), el('exposureOut'), function (v) { return (v > 0 ? '+' : '') + v.toFixed(2) + ' EV'; }],
		peak: [el('peak'), el('peakOut'), function (v) { return '+' + v.toFixed(2) + ' EV'; }],
		limit: [el('limit'), el('limitOut'), function (v) { return v === 100 ? 'full' : v === 0 ? 'SDR' : v + '%'; }]
	};
	var onBox = el('on');

	function el(id) { return document.getElementById(id); }

	function load() {
		var out = {};
		var saved = null;
		try { saved = JSON.parse(localStorage.getItem(STORE)); } catch (e) {}
		for (var k in DEFAULTS) out[k] = saved && typeof saved[k] === 'number' ? saved[k] : DEFAULTS[k];
		return out;
	}

	function save() {
		try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) {}
	}

	// a drag fires an input event per frame; only the last one is worth a write
	function saveSoon() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(function () { saveTimer = 0; save(); }, SAVE_DELAY);
	}

	function flushSave() {
		if (!saveTimer) return;
		clearTimeout(saveTimer);
		saveTimer = 0;
		save();
	}

	function apply() {
		p.on = s.on;
		p.black = s.black;
		p.white = s.white;
		p.exposure = s.exposure;
		p.peak = s.peak;
		native.style.dynamicRangeLimit = limitCss(s.limit);
		if (mode === 'sdr') Gpu.redraw();
		drawHistSoon();
	}

	function limitCss(v) {
		if (v >= 100) return 'no-limit';
		if (v <= 0) return 'standard';
		return 'dynamic-range-limit-mix(standard ' + (100 - v) + '%, no-limit ' + v + '%)';
	}

	function sync() {
		for (var k in sliders) {
			sliders[k][0].value = s[k];
			sliders[k][1].textContent = sliders[k][2](s[k]);
		}
		onBox.checked = !!s.on;
		apply();
	}

	function set(k, v) {
		if (k === 'black') v = Math.min(v, s.white - MIN_GAP);
		if (k === 'white') v = Math.max(v, s.black + MIN_GAP);
		s[k] = v;
		sliders[k][0].value = v;
		sliders[k][1].textContent = sliders[k][2](v);
		apply();
		saveSoon();
	}

	function bindSlider(k) {
		var input = sliders[k][0];
		input.addEventListener('input', function () { set(k, +input.value); });
		// a focused slider would keep the arrow keys from paging images
		input.addEventListener('pointerup', function () { input.blur(); });
		input.addEventListener('dblclick', function () { set(k, DEFAULTS[k]); });
	}

	for (var k in sliders) bindSlider(k);

	onBox.addEventListener('change', function () {
		s.on = onBox.checked ? 1 : 0;
		apply();
		saveSoon();
		onBox.blur();
	});

	function toggle() {
		s.on = s.on ? 0 : 1;
		onBox.checked = !!s.on;
		apply();
		saveSoon();
	}

	btnReset.addEventListener('click', function () {
		var limit = s.limit;
		for (var k in DEFAULTS) s[k] = DEFAULTS[k];
		s.limit = limit;   // reset belongs to the SDR group
		sync();
		saveSoon();
		btnReset.blur();
	});

	btnAuto.addEventListener('click', function () {
		btnAuto.blur();
		if (!binsTotal) return;
		var lo = percentile(AUTO_CLIP), hi = percentile(1 - AUTO_CLIP);
		s.black = Math.min(lo, 1 - MIN_GAP);
		s.white = Math.max(hi, s.black + MIN_GAP);
		sync();
		saveSoon();
	});

	// leaving inside the debounce window must not lose the last adjustment
	window.addEventListener('pagehide', flushSave);
	document.addEventListener('visibilitychange', function () { if (document.hidden) flushSave(); });

	function percentile(q) {
		var want = q * binsTotal, sum = 0;
		for (var i = 0; i < BINS; i++) {
			sum += bins[i];
			if (sum >= want) return (i + (q < 0.5 ? 0 : 1)) / BINS;
		}
		return 1;
	}

	window.addEventListener('keydown', function (e) {
		if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
		if (e.code === 'KeyE') toggle();
	});

	// --- histogram ---
	// luma of the encoded values (Rec.709 weights), the axis the black/white points live on
	function takeHistogram(bmp) {
		if (!sampler) sampler = new OffscreenCanvas(SAMPLE, SAMPLE).getContext('2d', { willReadFrequently: true });
		sampler.clearRect(0, 0, SAMPLE, SAMPLE);
		sampler.drawImage(bmp, 0, 0, SAMPLE, SAMPLE);
		var d = sampler.getImageData(0, 0, SAMPLE, SAMPLE).data;
		bins.fill(0);
		binsTotal = 0;
		for (var i = 0; i < d.length; i += 4) {
			if (d[i + 3] < 128) continue;
			bins[(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] + 0.5) | 0]++;
			binsTotal++;
		}
		drawHistSoon();
	}

	function dropHistogram() {
		bins.fill(0);
		binsTotal = 0;
		drawHistSoon();
	}

	function drawHistSoon() {
		if (histQueued) return;
		histQueued = requestAnimationFrame(drawHist);
	}

	function drawHist() {
		histQueued = 0;
		var w = hist.width, h = hist.height;
		var bx = s.black * w, wx = s.white * w;
		hctx.clearRect(0, 0, w, h);
		hctx.fillStyle = 'rgba(255,255,255,0.05)';
		hctx.fillRect(0, 0, bx, h);
		hctx.fillRect(wx, 0, w - wx, h);
		drawBins(w, h);
		// output curve: SDR white is the dashed line, anything above it is HDR headroom
		var top = Math.max(1, Gpu.curve(1, p)) * 1.08;
		var sdr = h - h / top;
		hctx.strokeStyle = 'rgba(255,255,255,0.25)';
		hctx.setLineDash([6, 6]);
		hctx.beginPath();
		hctx.moveTo(0, sdr);
		hctx.lineTo(w, sdr);
		hctx.stroke();
		hctx.setLineDash([]);
		hctx.strokeStyle = s.on ? '#e0b050' : 'rgba(224,176,80,0.35)';
		hctx.lineWidth = 3;
		hctx.beginPath();
		for (var x = 0; x <= w; x += 4) {
			var y = h - h * Gpu.curve(x / w, p) / top;
			if (x) hctx.lineTo(x, y);
			else hctx.moveTo(x, y);
		}
		hctx.stroke();
		hctx.lineWidth = 1;
		hctx.fillStyle = '#bbb';
		hctx.font = '22px system-ui, sans-serif';
		hctx.fillText('white \u2192 ' + Gpu.curve(1, p).toFixed(2) + '\u00d7 SDR', 10, 26);
	}

	// sqrt scale, and the end bins left out of the scale so a clipped spike does not flatten
	// the rest of the distribution
	function drawBins(w, h) {
		if (!binsTotal) return;
		var max = 1;
		for (var i = 1; i < BINS - 1; i++) if (bins[i] > max) max = bins[i];
		var k = h / Math.sqrt(max), step = w / BINS;
		hctx.fillStyle = '#5a6b78';
		hctx.beginPath();
		hctx.moveTo(0, h);
		for (var j = 0; j < BINS; j++) hctx.lineTo(j * step, h - Math.min(h, Math.sqrt(bins[j]) * k));
		hctx.lineTo(w, h);
		hctx.fill();
	}

	// --- display path per image ---
	function setMode(m) {
		mode = m;
		canvas.classList.toggle('off', m !== 'sdr');
		native.classList.toggle('off', !m || m === 'sdr');
		if (m === 'sdr') {
			native.removeAttribute('src');   // one decoded copy on screen, not two
			Gpu.draw();
		} else {
			Gpu.release();
			dropHistogram();
		}
		sdrBox.classList.toggle('active', m === 'sdr');
		hdrBox.classList.toggle('active', !!KIND_NAME[m]);
		modeEl.textContent = modeText(m);
	}

	function modeText(m) {
		if (!m) return 'no image';
		if (m === 'sdr') return 'this image: SDR, expanded on the GPU';
		if (KIND_NAME[m]) return 'this image: ' + KIND_NAME[m] + ', native <img>';
		return 'this image: native <img>';
	}

	function showNative(img, kind, finish) {
		native.src = img.src;
		native.decode().then(function () {
			if (finish(0)) setMode(kind || 'img');
		}, function () { finish(1); });
	}

	function showGpu(img, finish) {
		var size = Gpu.fitSize(img.naturalWidth, img.naturalHeight);
		var opts = size[0] === img.naturalWidth ? { premultiplyAlpha: 'none' }
			: { premultiplyAlpha: 'none', resizeWidth: size[0], resizeHeight: size[1], resizeQuality: 'high' };
		createImageBitmap(img, opts).then(function (bmp) {
			takeHistogram(bmp);
			return Gpu.upload(bmp).then(function (ok) {
				bmp.close();
				return ok;
			});
		}).then(function (ok) {
			if (!ok) return showNative(img, '', finish);
			if (finish(0)) setMode('sdr');
		}, function () { showNative(img, '', finish); });
	}

	var ready = Gpu.init(canvas).then(function (ok) {
		gpuOk = ok;
		noGpu.hidden = ok;
		sdrBox.disabled = !ok;
		statusEl.textContent = statusText();
	});

	function statusText() {
		var screen = matchMedia('(dynamic-range: high)').matches ? 'HDR display' : 'SDR display';
		if (!gpuOk) return 'WebGPU unavailable, <img> only \u00b7 ' + screen;
		var range = Gpu.extended() ? 'extended range' : 'standard range only';
		return 'WebGPU f16 \u00b7 ' + range + ' \u00b7 ' + screen;
	}

	Viewer.present = function (img, item, finish) {
		Promise.all([Sniff.file(item.file), ready]).then(function (r) {
			var kind = r[0];
			if (kind || !gpuOk) return showNative(img, kind, finish);
			showGpu(img, finish);
		});
	};

	Viewer.blank = function () {
		native.removeAttribute('src');
		setMode('');
	};

	if (!CSS.supports('dynamic-range-limit', 'standard')) {
		el('hdrNote').textContent = 'shown natively by the browser; this browser ignores the headroom limit';
	}

	sync();
})();
