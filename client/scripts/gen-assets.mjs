// Генератор иконок ChatGTT (зелёный квадрат с белым узлом) без внешних зависимостей: node scripts/gen-assets.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Узел из шести переплетённых петель (в духе логотипа ChatGPT). Возвращает покрытие 0..1. */
function knot(u, v, scale) {
  const x = (u - 0.5) / scale,
    y = (v - 0.5) / scale;
  let cover = 0;
  for (let k = 0; k < 6; k++) {
    const th = (k * Math.PI) / 3;
    const cx = Math.cos(th) * 0.17,
      cy = Math.sin(th) * 0.17;
    const dx = x - cx,
      dy = y - cy;
    const t2 = th + 1.0;
    const rx = dx * Math.cos(t2) + dy * Math.sin(t2);
    const ry = -dx * Math.sin(t2) + dy * Math.cos(t2);
    const d = Math.hypot(rx / 0.34, ry / 0.2);
    const ring = clamp01(0.5 - (Math.abs(d - 1) - 0.12) / 0.03);
    cover = Math.max(cover, ring);
  }
  return cover;
}

function icon({ background, radius }) {
  return (u, v) => {
    const k = knot(u, v, radius / 0.32 * 0.95);
    const bg = background ? [23, 23, 23] : [0, 0, 0];
    const white = [255, 255, 255];
    const a = background ? 255 : Math.round(k * 255);
    const c = background ? bg.map((b, i) => mix(b, white[i], k)) : white;
    return [...c.map((x) => Math.round(x)), a];
  };
}

mkdirSync('assets', { recursive: true });
mkdirSync('public', { recursive: true });
const write = (path, size, fn) => writeFileSync(path, png(size, fn));

write('assets/icon.png', 1024, icon({ background: true, radius: 0.32 }));
write('assets/adaptive-icon.png', 1024, icon({ background: false, radius: 0.2 }));
write('assets/splash-icon.png', 1024, icon({ background: false, radius: 0.22 }));
write('assets/favicon.png', 64, icon({ background: true, radius: 0.34 }));
write('public/icon-192.png', 192, icon({ background: true, radius: 0.32 }));
write('public/icon-512.png', 512, icon({ background: true, radius: 0.32 }));
write('public/apple-touch-icon.png', 180, icon({ background: true, radius: 0.32 }));
console.log('Иконки созданы: assets/, public/');

// Иконки для Windows-приложения (desktop/build): PNG для окна и ICO (PNG-in-ICO, 256×256) для .exe
const desktopBuild = '../desktop/build';
mkdirSync(desktopBuild, { recursive: true });
const iconFn = icon({ background: true, radius: 0.32 });
write(`${desktopBuild}/icon.png`, 512, iconFn);
const png256 = png(256, iconFn);
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // image count
header[6] = 0; // width 256
header[7] = 0; // height 256
header.writeUInt16LE(1, 10); // planes
header.writeUInt16LE(32, 12); // bits per pixel
header.writeUInt32LE(png256.length, 14);
header.writeUInt32LE(22, 18);
writeFileSync(`${desktopBuild}/icon.ico`, Buffer.concat([header, png256]));
console.log('Иконки Windows созданы: desktop/build/');
