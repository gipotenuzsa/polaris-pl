// Генератор иконок Polaris (Северная звезда) без внешних зависимостей: node scripts/gen-assets.mjs
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

/** Четырёхлучевая звезда (астроида): |x|^(2/3) + |y|^(2/3) = R^(2/3). Возвращает покрытие и свечение. */
function star(u, v, radius) {
  const x = Math.abs(u - 0.5),
    y = Math.abs(v - 0.5);
  const f = Math.pow(x, 2 / 3) + Math.pow(y, 2 / 3);
  const edge = Math.pow(radius, 2 / 3);
  const d = f - edge;
  const cover = clamp01(0.5 - d / 0.012);
  const glow = Math.exp(-Math.max(0, d) * 9) * 0.55;
  const core = Math.exp(-(x * x + y * y) / 0.0012);
  return { cover, glow, core };
}

function icon({ background, radius, transparent }) {
  return (u, v) => {
    const { cover, glow, core } = star(u, v, radius);
    let bg = [0, 0, 0, 0];
    if (background) {
      const d = Math.hypot(u - 0.5, v - 0.42);
      const t = clamp01(d / 0.75);
      bg = [mix(250, 232, t), mix(245, 222, t), mix(236, 203, t), 255];
    }
    const glowA = clamp01(glow) * 0.45;
    const base = background ? bg : [0, 0, 0, 0];
    const gcol = [184, 97, 58];
    let out = [
      mix(base[0], gcol[0], glowA),
      mix(base[1], gcol[1], glowA),
      mix(base[2], gcol[2], glowA),
      transparent ? Math.max(base[3], glowA * 255) : 255,
    ];
    const white = [43, 38, 32];
    const k = clamp01(cover + core * 0.6);
    out = [mix(out[0], white[0], k), mix(out[1], white[1], k), mix(out[2], white[2], k), Math.max(out[3], k * 255)];
    return out.map((c) => Math.round(c));
  };
}

mkdirSync('assets', { recursive: true });
mkdirSync('public', { recursive: true });
const write = (path, size, fn) => writeFileSync(path, png(size, fn));

write('assets/icon.png', 1024, icon({ background: true, radius: 0.32, transparent: false }));
write('assets/adaptive-icon.png', 1024, icon({ background: false, radius: 0.2, transparent: true }));
write('assets/splash-icon.png', 1024, icon({ background: false, radius: 0.22, transparent: true }));
write('assets/favicon.png', 64, icon({ background: true, radius: 0.34, transparent: false }));
write('public/icon-192.png', 192, icon({ background: true, radius: 0.32, transparent: false }));
write('public/icon-512.png', 512, icon({ background: true, radius: 0.32, transparent: false }));
write('public/apple-touch-icon.png', 180, icon({ background: true, radius: 0.32, transparent: false }));
console.log('Иконки созданы: assets/, public/');

// Иконки для Windows-приложения (desktop/build): PNG для окна и ICO (PNG-in-ICO, 256×256) для .exe
const desktopBuild = '../desktop/build';
mkdirSync(desktopBuild, { recursive: true });
const iconFn = icon({ background: true, radius: 0.32, transparent: false });
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
