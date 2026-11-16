// Gera assets/icon.png (512x512): capelo branco sobre um quadrado azul arredondado.
// PNG escrito à mão (zlib + CRC) para não precisar de dependências de imagem.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const S = 512;
const px = new Uint8Array(S * S * 4);

function blend(x, y, [r, g, b], a) {
  if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
  const i = (y * S + x) * 4;
  const A = a + (px[i + 3] / 255) * (1 - a);
  for (const [k, c] of [[0, r], [1, g], [2, b]]) px[i + k] = Math.round((c * a + px[i + k] * (px[i + 3] / 255) * (1 - a)) / (A || 1));
  px[i + 3] = Math.round(A * 255);
}

/** Preenche uma forma com antisserrilhado (4x4 amostras por pixel). */
function fill(inside, color, alpha = 1) {
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let n = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) n++;
      if (n) blend(x, y, color, (n / 16) * alpha);
    }
}

const roundRect = (x0, y0, x1, y1, r) => (x, y) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const polygon = (pts) => (x, y) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const ellipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const line = (x0, y0, x1, y1, w) => (x, y) => {
  const dx = x1 - x0, dy = y1 - y0;
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
  return (x - (x0 + t * dx)) ** 2 + (y - (y0 + t * dy)) ** 2 <= (w / 2) ** 2;
};

const BG = [32, 64, 140];
const WHITE = [255, 255, 255];
const ACCENT = [255, 196, 64];

fill(roundRect(16, 16, 496, 496, 110), BG);
// base do capelo
fill(polygon([[160, 250], [352, 250], [352, 330], [256, 370], [160, 330]]), WHITE);
// tampo (losango)
fill(polygon([[256, 130], [440, 210], [256, 290], [72, 210]]), WHITE);
fill(ellipse(256, 210, 18, 10), BG, 0.35);
// cordão e borla
fill(line(256, 210, 404, 262, 9), ACCENT);
fill(line(404, 262, 404, 348, 9), ACCENT);
fill(roundRect(390, 340, 418, 392, 8), ACCENT);

// ---- PNG ----
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync(new URL("../assets/", import.meta.url), { recursive: true });
writeFileSync(new URL("../assets/icon.png", import.meta.url), png);
console.log(`assets/icon.png (${png.length} bytes)`);
