// HDR detection from file header bytes, so already-HDR images can skip the SDR expander.
//
// The WebGPU path uploads through createImageBitmap, which hands over the SDR rendition: PQ/HLG
// is tone-mapped down and a gain map is dropped. Only the browser's own <img> compositing shows
// these at full range, so the page needs to know before it picks a path. The signals read:
//
//   PNG        cICP chunk, transfer 16 (PQ) or 18 (HLG)
//   AVIF/HEIF  colr nclx, transfer 16/18; tmap item or brand (ISO 21496-1 gain map);
//              auxC hdrgainmap (Apple gain map)
//   JPEG       APP1/APP2 of the primary image: Ultra HDR hdrgm XMP, ISO 21496-1 URN,
//              Apple HDRGainMap XMP
//
// JPEG XL is not parsed: its colour encoding sits in a bit-packed codestream header.
var Sniff = (function () {
	'use strict';

	var HEAD = 512 * 1024;   // HEIF meta and JPEG APP segments sit well inside this
	var TRANSFER = { 16: 'pq', 18: 'hlg' };
	var JPEG_MARKS = [
		ascii('http://ns.adobe.com/hdr-gain-map/1.0/'),
		ascii('urn:iso:std:iso:ts:21496:-1'),
		ascii('http://ns.apple.com/HDRGainMap/1.0/')
	];
	var APPLE_AUX = ascii('hdrgainmap');
	var PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

	function ascii(s) {
		var out = new Uint8Array(s.length);
		for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
		return out;
	}

	function u16(b, i) { return (b[i] << 8) | b[i + 1]; }
	function u32(b, i) { return ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]); }
	function tag(b, i) { return String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]); }

	function find(b, pat, from, to) {
		var last = to - pat.length;
		for (var i = from; i <= last; i++) {
			var j = 0;
			while (j < pat.length && b[i + j] === pat[j]) j++;
			if (j === pat.length) return i;
		}
		return -1;
	}

	function isPng(b) {
		for (var i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return false;
		return true;
	}

	function png(b) {
		var at = 8;
		while (at + 8 <= b.length) {
			var len = u32(b, at);
			var type = tag(b, at + 4);
			if (type === 'IDAT' || type === 'IEND') return '';
			if (type === 'cICP' && at + 10 <= b.length) return TRANSFER[b[at + 9]] || '';
			at += 12 + len;
		}
		return '';
	}

	function jpeg(b) {
		var at = 2;
		while (at + 4 <= b.length) {
			if (b[at] !== 0xff) return '';
			var m = b[at + 1];
			if (m === 0xff) { at++; continue; }                     // fill byte
			if (m === 0xda || m === 0xd9) return '';                // image data: headers are over
			if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { at += 2; continue; }
			var end = at + 2 + u16(b, at + 2);
			if ((m === 0xe1 || m === 0xe2) && hasAny(b, JPEG_MARKS, at + 4, Math.min(end, b.length))) return 'gainmap';
			at = end;
		}
		return '';
	}

	function hasAny(b, pats, from, to) {
		for (var i = 0; i < pats.length; i++) if (find(b, pats[i], from, to) >= 0) return true;
		return false;
	}

	// ISOBMFF: walk only the boxes that can hold the answer, skipping mdat by size
	var CONTAINER = { meta: 4, iprp: 0, ipco: 0 };

	function heif(b) {
		return boxes(b, 0, b.length);
	}

	function boxes(b, from, to) {
		var at = from;
		while (at + 8 <= to) {
			var size = u32(b, at);
			var head = 8;
			if (size === 1) { size = u32(b, at + 8) * 4294967296 + u32(b, at + 12); head = 16; }
			if (size === 0) size = to - at;
			if (size < head) return '';
			var end = Math.min(at + size, to);
			var kind = box(b, tag(b, at + 4), at + head, end);
			if (kind) return kind;
			at += size;
		}
		return '';
	}

	function box(b, type, body, end) {
		if (type in CONTAINER) return boxes(b, body + CONTAINER[type], end);
		if (type === 'ftyp') return brands(b, body, end);
		if (type === 'iinf') return boxes(b, body + (b[body] === 0 ? 6 : 8), end);
		if (type === 'infe') return infe(b, body, end);
		if (type === 'colr') return colr(b, body, end);
		if (type === 'auxC') return find(b, APPLE_AUX, body + 4, end) >= 0 ? 'gainmap' : '';
		return '';
	}

	function brands(b, body, end) {
		for (var i = body + 8; i + 4 <= end; i += 4) if (tag(b, i) === 'tmap') return 'gainmap';
		return '';
	}

	function infe(b, body, end) {
		var version = b[body];
		if (version < 2) return '';
		var type = body + 4 + (version === 2 ? 2 : 4) + 2;
		return type + 4 <= end && tag(b, type) === 'tmap' ? 'gainmap' : '';
	}

	function colr(b, body, end) {
		if (body + 8 > end || tag(b, body) !== 'nclx') return '';
		return TRANSFER[u16(b, body + 6)] || '';
	}

	function isHeif(b) { return b.length >= 12 && tag(b, 4) === 'ftyp'; }
	function isJpeg(b) { return b[0] === 0xff && b[1] === 0xd8; }

	// '' for SDR, else 'pq' | 'hlg' | 'gainmap'
	function bytes(b) {
		if (b.length < 12) return '';
		if (isPng(b)) return png(b);
		if (isJpeg(b)) return jpeg(b);
		if (isHeif(b)) return heif(b);
		return '';
	}

	function file(f) {
		return f.slice(0, HEAD).arrayBuffer().then(function (buf) {
			return bytes(new Uint8Array(buf));
		}, function () { return ''; });
	}

	return { bytes: bytes, file: file };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Sniff;
