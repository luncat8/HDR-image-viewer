// WebGPU stage: one image in an rgba16float texture, drawn to an rgba16float canvas with
// extended tone mapping, so values above 1.0 reach the display's HDR headroom.
//
// Values stay sRGB-encoded end to end, because that is what an 'srgb'/'display-p3' canvas
// expects (there is no linear-transfer canvas colour space); the shader decodes to linear
// light only for the expansion and re-encodes with the sRGB curve continued past 1.0.
//
// Expansion, per pixel, from the encoded input e:
//   t     = clamp((e - black) / (white - black))       levels, on the histogram's axis
//   lin   = srgbToLinear(t)
//   out   = lin * (1 + (peak - 1) * Y(lin)^2) * gain  Y = luminance, so hue is kept
// The squared luminance term leaves shadows and mid-tones near their SDR level and lifts only
// the highlights, input white landing at peak x SDR white; gain is the exposure on top.
var Gpu = (function () {
	'use strict';

	var FORMAT = 'rgba16float';
	var BG = 10 / 255;   // page background, encoded; transparent pixels blend onto it
	var P3_LUMA = [0.2289746, 0.6917385, 0.0792869];

	var SHADER = [
		'struct U { fit: vec4f, levels: vec4f, mode: vec4f };',
		'@group(0) @binding(0) var<uniform> u: U;',
		'@group(0) @binding(1) var samp: sampler;',
		'@group(0) @binding(2) var tex: texture_2d<f32>;',
		'struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };',
		'const LUMA = vec3f(' + P3_LUMA.join(', ') + ');',
		'const BG = ' + BG.toFixed(6) + ';',
		'fn decode(e: vec3f) -> vec3f {',
		'	let a = abs(e);',
		'	return sign(e) * select(pow((a + 0.055) / 1.055, vec3f(2.4)), a / 12.92, a <= vec3f(0.04045));',
		'}',
		'fn encode(l: vec3f) -> vec3f {',
		'	let a = abs(l);',
		'	return sign(l) * select(1.055 * pow(a, vec3f(1.0 / 2.4)) - 0.055, a * 12.92, a <= vec3f(0.0031308));',
		'}',
		// triangle strip over the contain-fitted quad
		'@vertex fn vs(@builtin(vertex_index) i: u32) -> V {',
		'	let c = vec2f(f32(i & 1u), f32(i >> 1u));',
		'	var o: V;',
		'	o.pos = vec4f((c * 2.0 - 1.0) * u.fit.xy, 0.0, 1.0);',
		'	o.uv = vec2f(c.x, 1.0 - c.y);',
		'	return o;',
		'}',
		'@fragment fn fs(v: V) -> @location(0) vec4f {',
		'	let s = textureSample(tex, samp, v.uv);',
		'	var e = s.rgb;',
		'	if (u.mode.x > 0.5) {',
		'		let lin = decode(clamp((e - u.levels.x) * u.levels.y, vec3f(0.0), vec3f(1.0)));',
		'		let y = dot(lin, LUMA);',
		'		e = encode(lin * (1.0 + u.levels.w * y * y) * u.levels.z);',
		'	}',
		'	return vec4f(mix(vec3f(BG), e, s.a), 1.0);',
		'}'
	].join('\n');

	// full-screen triangle that copies the previous mip level, bilinear = 2x2 box filter
	var MIP_SHADER = [
		'@group(0) @binding(0) var samp: sampler;',
		'@group(0) @binding(1) var src: texture_2d<f32>;',
		'struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };',
		'@vertex fn vs(@builtin(vertex_index) i: u32) -> V {',
		'	let c = vec2f(f32((i << 1u) & 2u), f32(i & 2u));',
		'	var o: V;',
		'	o.pos = vec4f(c * 2.0 - 1.0, 0.0, 1.0);',
		'	o.uv = vec2f(c.x, 1.0 - c.y);',
		'	return o;',
		'}',
		'@fragment fn fs(v: V) -> @location(0) vec4f { return textureSample(src, samp, v.uv); }'
	].join('\n');

	var device = null;
	var context = null;
	var canvas = null;
	var pipeline = null;
	var mipPipeline = null;
	var sampler = null;
	var uniformBuf = null;
	var uniforms = new Float32Array(12);
	var tex = null;
	var bind = null;
	var imgW = 0;
	var imgH = 0;
	var maxSize = 8192;
	var extended = false;
	var queued = 0;
	var clearColor = { r: BG, g: BG, b: BG, a: 1 };
	var attachment = { view: null, loadOp: 'clear', storeOp: 'store', clearValue: clearColor };
	var passDesc = { colorAttachments: [attachment] };
	var params = { on: 1, black: 0, white: 1, exposure: 0, peak: 0 };
	var api = {};

	// JS mirror of the fragment shader, for the curve plot: encoded input -> linear output,
	// on a grey pixel, relative to SDR white
	function curve(e, p) {
		var t = Math.min(1, Math.max(0, (e - p.black) / (p.white - p.black)));
		var lin = t <= 0.04045 ? t / 12.92 : Math.pow((t + 0.055) / 1.055, 2.4);
		return lin * (1 + (Math.pow(2, p.peak) - 1) * lin * lin) * Math.pow(2, p.exposure);
	}

	function init(el) {
		if (!navigator.gpu) return Promise.resolve(false);
		canvas = el;
		return navigator.gpu.requestAdapter().then(function (adapter) {
			if (!adapter) return false;
			maxSize = adapter.limits.maxTextureDimension2D;
			return adapter.requestDevice({ requiredLimits: { maxTextureDimension2D: maxSize } }).then(setup);
		}).catch(function () { return false; });
	}

	function setup(dev) {
		device = dev;
		context = canvas.getContext('webgpu');
		context.configure({
			device: device,
			format: FORMAT,
			colorSpace: 'display-p3',
			toneMapping: { mode: 'extended' },
			alphaMode: 'opaque'
		});
		var conf = context.getConfiguration ? context.getConfiguration() : null;
		extended = !!(conf && conf.toneMapping && conf.toneMapping.mode === 'extended');
		sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
		uniformBuf = device.createBuffer({ size: uniforms.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		pipeline = makePipeline(SHADER, 'triangle-strip');
		mipPipeline = makePipeline(MIP_SHADER, 'triangle-list');
		new ResizeObserver(resize).observe(canvas);
		return true;
	}

	function makePipeline(code, topology) {
		var module = device.createShaderModule({ code: code });
		return device.createRenderPipeline({
			layout: 'auto',
			vertex: { module: module, entryPoint: 'vs' },
			fragment: { module: module, entryPoint: 'fs', targets: [{ format: FORMAT }] },
			primitive: { topology: topology }
		});
	}

	function resize(entries) {
		var e = entries[0];
		var box = e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
		var w = box ? box.inlineSize : Math.round(e.contentRect.width * devicePixelRatio);
		var h = box ? box.blockSize : Math.round(e.contentRect.height * devicePixelRatio);
		canvas.width = Math.max(1, Math.min(maxSize, w));
		canvas.height = Math.max(1, Math.min(maxSize, h));
		draw();
	}

	function mipCount(w, h) { return Math.floor(Math.log2(Math.max(w, h))) + 1; }

	// largest size that fits the device's texture limit, aspect kept
	function fitSize(w, h) {
		var k = Math.min(1, maxSize / Math.max(w, h));
		return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
	}

	function buildMips(levels) {
		var enc = device.createCommandEncoder();
		for (var i = 1; i < levels; i++) {
			var pass = enc.beginRenderPass({ colorAttachments: [{
				view: tex.createView({ baseMipLevel: i, mipLevelCount: 1 }),
				loadOp: 'clear', storeOp: 'store'
			}] });
			pass.setPipeline(mipPipeline);
			pass.setBindGroup(0, device.createBindGroup({
				layout: mipPipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: sampler },
					{ binding: 1, resource: tex.createView({ baseMipLevel: i - 1, mipLevelCount: 1 }) }
				]
			}));
			pass.draw(3);
			pass.end();
		}
		device.queue.submit([enc.finish()]);
	}

	// source: ImageBitmap already sized to fitSize(); resolves false when the GPU refused it
	// (out of memory on a huge image), so the caller can fall back to <img>
	function upload(source) {
		var w = source.width, h = source.height;
		var levels = mipCount(w, h);
		device.pushErrorScope('out-of-memory');
		device.pushErrorScope('validation');
		var next = device.createTexture({
			size: [w, h],
			format: FORMAT,
			mipLevelCount: levels,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
		});
		device.queue.copyExternalImageToTexture({ source: source }, { texture: next, colorSpace: 'display-p3' }, [w, h]);
		release();
		tex = next;
		imgW = w;
		imgH = h;
		buildMips(levels);
		bind = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: uniformBuf } },
				{ binding: 1, resource: sampler },
				{ binding: 2, resource: tex.createView() }
			]
		});
		return Promise.all([device.popErrorScope(), device.popErrorScope()]).then(function (errs) {
			if (!errs[0] && !errs[1]) return true;
			release();
			return false;
		});
	}

	function release() {
		if (tex) tex.destroy();
		tex = null;
		bind = null;
		imgW = imgH = 0;
	}

	function writeUniforms() {
		var r = (imgW / imgH) / (canvas.width / canvas.height);
		uniforms[0] = r > 1 ? 1 : r;
		uniforms[1] = r > 1 ? 1 / r : 1;
		uniforms[4] = params.black;
		uniforms[5] = 1 / Math.max(1e-4, params.white - params.black);
		uniforms[6] = Math.pow(2, params.exposure);
		uniforms[7] = Math.pow(2, params.peak) - 1;
		uniforms[8] = params.on ? 1 : 0;
		device.queue.writeBuffer(uniformBuf, 0, uniforms);
	}

	function draw() {
		queued = 0;
		if (!device) return;
		attachment.view = context.getCurrentTexture().createView();
		var enc = device.createCommandEncoder();
		var pass = enc.beginRenderPass(passDesc);
		if (bind) {
			writeUniforms();
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, bind);
			pass.draw(4);
		}
		pass.end();
		device.queue.submit([enc.finish()]);
		attachment.view = null;
	}

	// slider input arrives faster than frames; one draw per frame at most
	function redraw() {
		if (queued) return;
		queued = requestAnimationFrame(draw);
	}

	api.init = init;
	api.upload = upload;
	api.release = function () { release(); draw(); };
	api.draw = draw;
	api.redraw = redraw;
	api.params = params;
	api.curve = curve;
	api.fitSize = fitSize;
	api.extended = function () { return extended; };

	return api;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Gpu;
