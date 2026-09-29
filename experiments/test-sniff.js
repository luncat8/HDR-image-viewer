// node harness: js/sniff.js HDR detection on hand-built PNG, JPEG and ISOBMFF headers.
// usage: node experiments/test-sniff.js
'use strict';
const path = require('path');
const Sniff = require(path.join(__dirname, '..', 'js', 'sniff.js'));

let pass = 0, fail = 0;
const eq = (name, got, want) => {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a === b) { pass++; return; }
	fail++;
	console.log('FAIL ' + name + '\n  got  ' + a + '\n  want ' + b);
};

const bytes = (...parts) => Uint8Array.from(parts.flatMap(p => typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : p));
const be32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = n => [(n >>> 8) & 255, n & 255];
const sniff = (...parts) => Sniff.bytes(bytes(...parts));

// --- PNG ---
const chunk = (type, data) => [...be32(data.length), ...[...type].map(c => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const IHDR = chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 16, 2, 0, 0, 0]);
const IDAT = chunk('IDAT', [1, 2, 3]);
const cicp = tf => chunk('cICP', [9, tf, 0, 1]);

eq('png plain', sniff(PNG, IHDR, IDAT), '');
eq('png cICP PQ', sniff(PNG, IHDR, cicp(16), IDAT), 'pq');
eq('png cICP HLG', sniff(PNG, IHDR, cicp(18), IDAT), 'hlg');
eq('png cICP sRGB transfer', sniff(PNG, IHDR, cicp(13), IDAT), '');
eq('png cICP after IDAT is not read', sniff(PNG, IHDR, IDAT, cicp(16)), '');
eq('png other chunks before cICP', sniff(PNG, IHDR, chunk('gAMA', [0, 0, 177, 143]), chunk('iCCP', new Array(40).fill(7)), cicp(16), IDAT), 'pq');
eq('png truncated inside cICP', Sniff.bytes(bytes(PNG, IHDR, cicp(16)).slice(0, 8 + 25 + 9)), '');

// --- JPEG ---
const seg = (m, text) => [0xff, m, ...be16(text.length + 2), ...[...text].map(c => c.charCodeAt(0))];
const SOI = [0xff, 0xd8];
const JFIF = seg(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0');
const SOS = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0];
const XMP_HDR = 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0"/></x:xmpmeta>';
const XMP_SDR = 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/"/></x:xmpmeta>';

eq('jpeg plain', sniff(SOI, JFIF, seg(0xe1, XMP_SDR), SOS, 1, 2, 3), '');
eq('jpeg Ultra HDR XMP', sniff(SOI, JFIF, seg(0xe1, XMP_HDR), SOS), 'gainmap');
eq('jpeg ISO 21496-1 APP2', sniff(SOI, JFIF, seg(0xe2, 'urn:iso:std:iso:ts:21496:-1\0\0\0'), SOS), 'gainmap');
eq('jpeg Apple gain map XMP', sniff(SOI, seg(0xe1, 'http://ns.adobe.com/xap/1.0/\0 xmlns:HDRGainMap="http://ns.apple.com/HDRGainMap/1.0/"'), SOS), 'gainmap');
eq('jpeg marker text in a comment segment is not a signal', sniff(SOI, seg(0xfe, XMP_HDR), SOS), '');
eq('jpeg marker after SOS belongs to entropy data', sniff(SOI, JFIF, SOS, ...seg(0xe1, XMP_HDR)), '');
eq('jpeg fill bytes before a marker', sniff(SOI, 0xff, 0xff, seg(0xe1, XMP_HDR), SOS), 'gainmap');
eq('jpeg truncated segment', Sniff.bytes(bytes(SOI, JFIF, seg(0xe1, XMP_HDR)).slice(0, 60)), '');

// --- ISOBMFF (AVIF / HEIF) ---
const box = (type, ...body) => { const b = body.flat(); return [...be32(b.length + 8), ...[...type].map(c => c.charCodeAt(0)), ...b]; };
const full = (type, version, ...body) => box(type, [version, 0, 0, 0], ...body);
const fourcc = s => [...s].map(c => c.charCodeAt(0));
const ftyp = (...brands) => box('ftyp', fourcc('avif'), be32(0), ...brands.map(fourcc));
const infe = (type, version = 2) => full('infe', version, version === 2 ? be16(1) : be32(1), be16(0), fourcc(type), [0]);
const iinf = (...items) => full('iinf', 0, be16(items.length), ...items);
const nclx = tf => box('colr', fourcc('nclx'), be16(9), be16(tf), be16(9), [0x80]);
const ipco = (...props) => box('iprp', box('ipco', ...props));
const hdlr = full('hdlr', 0, be32(0), fourcc('pict'), new Array(13).fill(0));
const meta = (...kids) => full('meta', 0, hdlr, ...kids);
const mdat = box('mdat', new Array(64).fill(0x11));
const ispe = full('ispe', 0, be32(640), be32(480));

eq('avif sRGB', sniff(ftyp('mif1', 'avif'), meta(iinf(infe('av01')), ipco(ispe, nclx(13))), mdat), '');
eq('avif PQ', sniff(ftyp('mif1', 'avif'), meta(iinf(infe('av01')), ipco(ispe, nclx(16))), mdat), 'pq');
eq('avif HLG', sniff(ftyp('mif1', 'avif'), meta(iinf(infe('av01')), ipco(nclx(18))), mdat), 'hlg');
eq('avif gain map brand', sniff(ftyp('mif1', 'avif', 'tmap'), meta(ipco(nclx(13))), mdat), 'gainmap');
eq('avif tmap item', sniff(ftyp('mif1', 'avif'), meta(iinf(infe('av01'), infe('tmap')), ipco(nclx(13))), mdat), 'gainmap');
eq('avif tmap item, infe v3', sniff(ftyp('mif1'), meta(iinf(infe('av01', 3), infe('tmap', 3)), ipco(nclx(1))), mdat), 'gainmap');
eq('avif ICC colr is not nclx', sniff(ftyp('mif1'), meta(ipco(box('colr', fourcc('prof'), new Array(20).fill(16)))), mdat), '');
eq('heic Apple gain map auxC', sniff(ftyp('heic'), meta(ipco(full('auxC', 0, fourcc('urn:com:apple:photo:2020:aux:hdrgainmap'), [0]))), mdat), 'gainmap');
eq('heic alpha auxC is not a gain map', sniff(ftyp('heic'), meta(ipco(full('auxC', 0, fourcc('urn:mpeg:mpegB:cicp:systems:auxiliary:alpha'), [0]))), mdat), '');
// mdat first with a 64-bit size: the walk has to jump it by its largesize to reach meta
const bigMdat = [...be32(1), ...fourcc('mdat'), ...be32(0), ...be32(16 + 8), ...new Array(8).fill(0)];
eq('meta after a largesize mdat', sniff(ftyp('mif1'), bigMdat, meta(ipco(nclx(16)))), 'pq');
eq('box with a bogus size stops the walk', sniff(ftyp('mif1'), be32(3), fourcc('free'), meta(ipco(nclx(16)))), '');
eq('truncated meta', Sniff.bytes(bytes(ftyp('mif1'), meta(ipco(nclx(16)))).slice(0, 50)), '');

// --- other ---
eq('webp is SDR', sniff('RIFF', be32(100), 'WEBPVP8 ', new Array(20).fill(0)), '');
eq('too short', sniff([0xff, 0xd8]), '');
eq('empty', Sniff.bytes(new Uint8Array(0)), '');

// --- Sniff.file reads a head slice of a Blob ---
Sniff.file(new Blob([bytes(PNG, IHDR, cicp(16), IDAT)])).then(kind => {
	eq('file() on a Blob', kind, 'pq');
	return Sniff.file({ slice: () => ({ arrayBuffer: () => Promise.reject(new Error('gone')) }) });
}).then(kind => {
	eq('unreadable file is SDR', kind, '');
	console.log(fail ? 'sniff.js FAILED ' + fail + ' of ' + (pass + fail) : 'sniff.js OK (' + pass + ' checks)');
	process.exitCode = fail ? 1 : 0;
});
