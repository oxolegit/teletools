import { InlineKeyboard } from 'grammy';

export const LIMITS = { sticker: 120, emoji: 200 };
export const MAX_SIDE = 20;
const PADDINGS = [0, 2, 4, 8];
const BG_MODES = ['auto', 'color', 'none'];
const BG_LABELS = { auto: 'Авто', color: 'Убрать по цвету', none: 'Не трогать' };

export function defaultSettings(username) {
  return {
    type: 'sticker',
    cols: 3,
    rows: 3,
    bg: 'auto',
    tolerance: 30,
    padding: 0,
    repaint: false,
    emoji: '🙂',
    title: username ? `Pack by @${username}` : 'My pack',
  };
}

/** Строки подбираются по пропорции картинки при текущем числе колонок. */
export function autoRows(s, width, height) {
  const rows = Math.round((s.cols * height) / width);
  s.rows = clamp(rows, 1, MAX_SIDE);
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function renderText(s, image) {
  const total = s.cols * s.rows;
  const cellW = Math.round(image.width / s.cols);
  const cellH = Math.round(image.height / s.rows);
  const over = total > LIMITS[s.type];
  return [
    `<b>Настройки пака</b>`,
    `Картинка: ${image.width}×${image.height}px`,
    ``,
    `Тип: <b>${s.type === 'emoji' ? 'Emoji (100×100)' : 'Стикеры (512px)'}</b>`,
    `Сетка: <b>${s.cols}×${s.rows}</b> = ${total} шт. (ячейка ~${cellW}×${cellH}px)` +
      (over ? `\n⚠️ Максимум ${LIMITS[s.type]} в паке этого типа` : ''),
    `Фон: <b>${BG_LABELS[s.bg]}</b>` + (s.bg === 'none' ? '' : `, допуск ${s.tolerance}`),
    `Отступ: <b>${s.padding}px</b>`,
    s.type === 'emoji' ? `Цвет: <b>${s.repaint ? 'под тему' : 'как в PNG'}</b>` : null,
    `Emoji: ${s.emoji}`,
    `Название: <b>${escapeHtml(s.title)}</b>`,
    ``,
    `<i>/title Название — сменить название, /emoji 🔥 — сменить emoji</i>`,
    s.type === 'emoji'
      ? `<i>Панель emoji показывает 8 в ряд — для «собранной» картинки ставьте 8 колонок.</i>`
      : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

export function renderKeyboard(s) {
  const kb = new InlineKeyboard()
    .text(s.type === 'sticker' ? '✅ Стикеры' : 'Стикеры', 'type:sticker')
    .text(s.type === 'emoji' ? '✅ Emoji' : 'Emoji', 'type:emoji')
    .row()
    .text('Колонки −', 'cols:-1')
    .text(`${s.cols}`, 'noop')
    .text('Колонки +', 'cols:+1')
    .row()
    .text('Строки −', 'rows:-1')
    .text(`${s.rows}`, 'noop')
    .text('Строки +', 'rows:+1')
    .row()
    .text('📐 Строки по пропорции', 'rows:auto');
  if (s.type === 'emoji') kb.text('8 колонок', 'cols:8');
  kb.row()
    .text(`Фон: ${BG_LABELS[s.bg]}`, 'bg:next')
    .row();
  if (s.bg !== 'none') {
    kb.text('Допуск −', 'tol:-10').text(`${s.tolerance}`, 'noop').text('Допуск +', 'tol:+10').row();
  }
  kb
    .text(`Отступ: ${s.padding}px`, 'pad:next')
    .row();
  // Одноцветные emoji Telegram перекрашивает в цвет текста: белые в тёмной теме, тёмные в светлой.
  if (s.type === 'emoji') kb.text(s.repaint ? '🎨 Цвет: под тему' : '🎨 Цвет: как в PNG', 'repaint').row();
  return kb
    .text('👁 Превью', 'preview')
    .text('🚀 Создать пак', 'create');
}

/**
 * Применяет нажатие кнопки к настройкам.
 * Возвращает true, если настройки изменились и сообщение нужно перерисовать.
 */
export function applyAction(s, action, image) {
  const [key, value] = action.split(':');
  switch (key) {
    case 'type':
      s.type = value;
      return true;
    case 'cols':
      s.cols = clamp(value === '8' ? 8 : s.cols + Number(value), 1, MAX_SIDE);
      return true;
    case 'rows':
      if (value === 'auto') autoRows(s, image.width, image.height);
      else s.rows = clamp(s.rows + Number(value), 1, MAX_SIDE);
      return true;
    case 'bg':
      s.bg = BG_MODES[(BG_MODES.indexOf(s.bg) + 1) % BG_MODES.length];
      return true;
    case 'tol':
      s.tolerance = clamp(s.tolerance + Number(value), 0, 200);
      return true;
    case 'repaint':
      s.repaint = !s.repaint;
      return true;
    case 'pad':
      s.padding = PADDINGS[(PADDINGS.indexOf(s.padding) + 1) % PADDINGS.length];
      return true;
    default:
      return false;
  }
}

export function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
