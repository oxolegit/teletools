import sharp from 'sharp';

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/** Декодирует картинку в сырые RGBA-пиксели. */
async function toRaw(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function fromRaw({ data, width, height }) {
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/** Есть ли уже прозрачность по краям картинки (значит фон уже убран). */
function hasTransparentEdges({ data, width, height }) {
  let total = 0;
  let transparent = 0;
  const check = (x, y) => {
    total++;
    if (data[(y * width + x) * 4 + 3] < 250) transparent++;
  };
  for (let x = 0; x < width; x++) {
    check(x, 0);
    check(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    check(0, y);
    check(width - 1, y);
  }
  return transparent / total > 0.05;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Убирает фон заливкой от краёв: прозрачными становятся только пиксели,
 * связанные с краем картинки и близкие по цвету к фону (цвет берётся из углов).
 * mode: 'auto' | 'color' | 'none'
 */
export async function removeBackground(buf, { mode = 'auto', tolerance = 30 } = {}) {
  if (mode === 'none') return sharp(buf).ensureAlpha().png().toBuffer();

  const img = await toRaw(buf);
  if (mode === 'auto' && hasTransparentEdges(img)) return fromRaw(img);

  const { data, width, height } = img;
  const corners = [0, width - 1, (height - 1) * width, height * width - 1].map((i) => i * 4);
  const bg = [0, 1, 2].map((c) => median(corners.map((i) => data[i + c])));

  const hard = tolerance;
  const soft = Math.max(tolerance * 1.5, tolerance + 1);
  const dist = (p) => {
    const dr = data[p] - bg[0];
    const dg = data[p + 1] - bg[1];
    const db = data[p + 2] - bg[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const push = (i) => {
    if (visited[i]) return;
    visited[i] = 1;
    queue[tail++] = i;
  };

  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (head < tail) {
    const i = queue[head++];
    const p = i * 4;
    const d = dist(p);
    if (d > soft) continue;
    if (d > hard) {
      // Край объекта: частичная прозрачность для мягкого контура, дальше не идём.
      data[p + 3] = Math.round(data[p + 3] * ((d - hard) / (soft - hard)));
      continue;
    }
    data[p + 3] = 0;
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (y > 0) push(i - width);
    if (y < height - 1) push(i + width);
  }

  return fromRaw(img);
}

/** Границы ячеек сетки: остаток пикселей распределяется равномерно. */
export function gridBounds(width, height, cols, rows) {
  const xs = Array.from({ length: cols + 1 }, (_, i) => Math.round((i * width) / cols));
  const ys = Array.from({ length: rows + 1 }, (_, i) => Math.round((i * height) / rows));
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({ left: xs[c], top: ys[r], width: xs[c + 1] - xs[c], height: ys[r + 1] - ys[r] });
    }
  }
  return cells;
}

/** Режет картинку на ячейки (порядок: слева направо, сверху вниз). */
export async function splitGrid(buf, cols, rows) {
  const { width, height } = await sharp(buf).metadata();
  const cells = gridBounds(width, height, cols, rows).filter((c) => c.width > 0 && c.height > 0);
  return Promise.all(cells.map((cell) => sharp(buf).extract(cell).png().toBuffer()));
}

export async function isEmpty(buf) {
  const { channels } = await sharp(buf).ensureAlpha().stats();
  return channels[3].max === 0;
}

/**
 * Готовит тайл под требования Telegram:
 * sticker — PNG, одна сторона ровно 512, другая ≤ 512;
 * emoji — PNG 100×100.
 */
export async function toTile(cellBuf, type, padding = 0) {
  if (type === 'emoji') {
    const inner = 100 - padding * 2;
    return sharp(cellBuf)
      .resize(inner, inner, { fit: 'contain', background: TRANSPARENT })
      .extend({ top: padding, bottom: padding, left: padding, right: padding, background: TRANSPARENT })
      .png()
      .toBuffer();
  }
  const inner = 512 - padding * 2;
  return sharp(cellBuf)
    .resize(inner, inner, { fit: 'inside' })
    .extend({ top: padding, bottom: padding, left: padding, right: padding, background: TRANSPARENT })
    .png()
    .toBuffer();
}

/**
 * Полностью прозрачный тайл: ставим один почти невидимый пиксель (alpha 1/255),
 * чтобы Telegram гарантированно принял его и сетка не «съезжала».
 */
async function markEmpty(tile) {
  const dot = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 / 255 } } })
    .png()
    .toBuffer();
  return sharp(tile).composite([{ input: dot, left: 0, top: 0 }]).png().toBuffer();
}

/** Полный пайплайн: фон → нарезка → тайлы. Пустые ячейки тоже становятся тайлами. */
export async function buildTiles(buf, s) {
  const clean = await removeBackground(buf, { mode: s.bg, tolerance: s.tolerance });
  const cells = await splitGrid(clean, s.cols, s.rows);
  const tiles = [];
  for (const cell of cells) {
    const tile = await toTile(cell, s.type, s.padding);
    tiles.push((await isEmpty(cell)) ? await markEmpty(tile) : tile);
  }
  return tiles;
}

function checkerSvg(w, h, size = 16, extra = '') {
  const half = size / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs><pattern id="c" width="${size}" height="${size}" patternUnits="userSpaceOnUse">
        <rect width="${size}" height="${size}" fill="#ffffff"/><rect width="${half}" height="${half}" fill="#d9d9d9"/><rect x="${half}" y="${half}" width="${half}" height="${half}" fill="#d9d9d9"/>
      </pattern></defs><rect width="100%" height="100%" fill="url(#c)"/>${extra}</svg>`,
  );
}

/**
 * Превью готового пака: тайлы раскладываются по строкам по `cols` штук,
 * каждый подписан номером (с 1). `selected` — индекс выделенного тайла.
 */
export async function renderPackPreview(tiles, cols, { selected = -1 } = {}) {
  const gap = 8;
  const perRow = Math.max(1, Math.min(cols, tiles.length || 1));
  const cell = Math.max(48, Math.min(128, Math.floor((2000 - gap) / perRow) - gap));
  const rowsCount = Math.max(1, Math.ceil(tiles.length / perRow));
  const w = gap + perRow * (cell + gap);
  const h = gap + rowsCount * (cell + gap);
  const pos = (i) => ({ left: gap + (i % perRow) * (cell + gap), top: gap + Math.floor(i / perRow) * (cell + gap) });

  const thumbs = await Promise.all(
    tiles.map((t) => sharp(t).resize(cell, cell, { fit: 'contain', background: TRANSPARENT }).png().toBuffer()),
  );

  const fontSize = Math.max(11, Math.round(cell / 6));
  const labels = tiles
    .map((_, i) => {
      const { left, top } = pos(i);
      const text = String(i + 1);
      const lw = Math.round(fontSize * 0.65 * text.length + 8);
      const border =
        i === selected
          ? `<rect x="${left - 3}" y="${top - 3}" width="${cell + 6}" height="${cell + 6}" fill="none" stroke="#0a84ff" stroke-width="4" rx="6"/>`
          : `<rect x="${left - 0.5}" y="${top - 0.5}" width="${cell + 1}" height="${cell + 1}" fill="none" stroke="#bbbbbb" stroke-width="1"/>`;
      return (
        border +
        `<rect x="${left}" y="${top}" width="${lw}" height="${fontSize + 6}" rx="4" fill="${i === selected ? '#0a84ff' : '#000000'}" fill-opacity="0.7"/>` +
        `<text x="${left + 4}" y="${top + fontSize + 1}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#ffffff">${text}</text>`
      );
    })
    .join('');

  // Разделители между строками сетки
  const dividers = Array.from({ length: rowsCount - 1 }, (_, r) => {
    const y = gap + (r + 1) * (cell + gap) - gap / 2;
    return `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#888888" stroke-width="2" stroke-dasharray="6 4"/>`;
  }).join('');

  const background = await sharp(checkerSvg(w, h, 16, dividers)).png().toBuffer();
  return sharp(background)
    .composite([
      ...thumbs.map((input, i) => ({ input, ...pos(i) })),
      { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${labels}</svg>`), left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
}

/**
 * Превью: картинка без фона с наложенной сеткой — прозрачный WEBP ≤ 512px,
 * чтобы Telegram показал его как стикер (без пузыря и «шахматки»).
 */
export async function renderPreview(buf, s) {
  const clean = await removeBackground(buf, { mode: s.bg, tolerance: s.tolerance });
  const meta = await sharp(clean).metadata();
  const scale = Math.min(1, 512 / Math.max(meta.width, meta.height));
  const w = Math.max(1, Math.round(meta.width * scale));
  const h = Math.max(1, Math.round(meta.height * scale));
  const img = await sharp(clean).resize(w, h).png().toBuffer();

  const lines = gridBounds(w, h, s.cols, s.rows);
  const rects = lines
    .map((c) => `<rect x="${c.left + 0.5}" y="${c.top + 0.5}" width="${Math.max(c.width - 1, 0)}" height="${Math.max(c.height - 1, 0)}" fill="none" stroke="#ff2d55" stroke-width="1.5"/>`)
    .join('');
  const grid = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${rects}</svg>`);

  return sharp(img)
    .composite([{ input: grid }])
    .webp({ lossless: true })
    .toBuffer();
}
