import { GrammyError, InlineKeyboard, InputFile } from 'grammy';
import { removeBackground, renderPackPreview, toTile } from './image.js';
import { packLink } from './pack.js';
import { downloadFile } from './download.js';
import { getPack, removePack, updatePack, userPacks } from './store.js';
import { escapeHtml } from './settings.js';

const PAGE_SIZE = 40; // номерных кнопок на одной странице клавиатуры
const MAX_BUTTONS_PER_ROW = 8; // ограничение Telegram

/** file_unique_id -> PNG/WEBP буфер стикера, чтобы не скачивать заново при каждом рендере. */
const tileCache = new Map();
/** userId -> { kind: 'replace'|'emoji'|'add'|'title', pid, index, chatId, messageId } */
const pending = new Map();

const cb = (...parts) => ['pk', ...parts].join(':');

/** Кладём в кэш уже готовые тайлы, чтобы сразу после создания не скачивать их обратно. */
export function seedCache(stickers, tiles, offset = 0) {
  tiles.forEach((buf, i) => {
    const s = stickers[offset + i];
    if (s) tileCache.set(s.file_unique_id, buf);
  });
}

async function downloadTiles(api, token, stickers) {
  const missing = stickers.filter((s) => !tileCache.has(s.file_unique_id));
  const queue = [...missing];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      tileCache.set(s.file_unique_id, await downloadFile(api, token, s.file_id));
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return stickers.map((s) => tileCache.get(s.file_unique_id));
}

async function fetchSet(api, pack) {
  try {
    return await api.getStickerSet(pack.name);
  } catch (err) {
    if (err instanceof GrammyError && /STICKERSET_INVALID|not found/i.test(err.description)) {
      await removePack(pack.pid);
      return null;
    }
    throw err;
  }
}

function overviewKeyboard(pack, set, page) {
  const total = set.stickers.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const perRow = Math.min(pack.cols, MAX_BUTTONS_PER_ROW);

  // Номерные кнопки раскладываем по строкам сетки (длинные строки сетки — по 8 кнопок).
  const rows = [];
  let current = [];
  const start = page * PAGE_SIZE;
  const end = Math.min(total, start + PAGE_SIZE);
  for (let i = start; i < end; i++) {
    current.push(InlineKeyboard.text(String(i + 1), cb('s', pack.pid, i)));
    const col = i % pack.cols;
    if (col === pack.cols - 1 || (col + 1) % perRow === 0 || i === end - 1) {
      rows.push(current);
      current = [];
    }
  }
  const kb = InlineKeyboard.from(rows).row();
  if (pages > 1) {
    kb.text('◀️', cb('o', pack.pid, (page - 1 + pages) % pages))
      .text(`${page + 1}/${pages}`, cb('n'))
      .text('▶️', cb('o', pack.pid, (page + 1) % pages))
      .row();
  }
  kb.text('➕ Добавить', cb('a', pack.pid))
    .text('✏️ Название', cb('t', pack.pid))
    .text('🔄 Обновить', cb('o', pack.pid, page))
    .row()
    .text('🗑 Удалить весь пак', cb('x', pack.pid))
    .url('🔗 Открыть', packLink(pack.type, pack.name));
  if (pack.type === 'emoji') kb.row().text('😀 Прислать эмодзи', cb('g', pack.pid));
  return kb;
}

function stickerKeyboard(pack, index) {
  const page = Math.floor(index / PAGE_SIZE);
  return new InlineKeyboard()
    .text('⬅️', cb('m', pack.pid, index, index - 1))
    .text('➡️', cb('m', pack.pid, index, index + 1))
    .text('⬆️', cb('m', pack.pid, index, index - pack.cols))
    .text('⬇️', cb('m', pack.pid, index, index + pack.cols))
    .row()
    .text('🔄 Заменить', cb('r', pack.pid, index))
    .text('😀 Emoji', cb('e', pack.pid, index))
    .row()
    .text('🗑 Удалить', cb('d', pack.pid, index))
    .text('« Назад', cb('o', pack.pid, page));
}

function position(pack, index) {
  return `строка ${Math.floor(index / pack.cols) + 1}, место ${(index % pack.cols) + 1}`;
}

/** Собирает картинку + подпись + клавиатуру редактора. */
async function buildEditor(api, token, pack, { page = 0, selected = -1 } = {}) {
  const set = await fetchSet(api, pack);
  if (!set) return null;
  const tiles = await downloadTiles(api, token, set.stickers);
  const image = await renderPackPreview(tiles, pack.cols, { selected });
  const total = set.stickers.length;
  const rows = Math.ceil(total / pack.cols);

  let caption = `<b>${escapeHtml(set.title)}</b>\n${total} шт. · ${rows} стр. по ${pack.cols}\n${packLink(pack.type, pack.name)}`;
  let keyboard;
  if (selected >= 0 && selected < total) {
    const s = set.stickers[selected];
    caption += `\n\nВыбран <b>#${selected + 1}</b> (${position(pack, selected)}), emoji: ${s.emoji ?? '—'}`;
    keyboard = stickerKeyboard(pack, selected);
  } else {
    caption += `\n\nНажмите номер, чтобы изменить, переместить или удалить стикер.`;
    keyboard = overviewKeyboard(pack, set, page);
  }
  return { set, image, caption, keyboard };
}

/** Отправляет новое сообщение-редактор. */
export async function sendEditor(api, token, chatId, pack, opts) {
  const ed = await buildEditor(api, token, pack, opts);
  if (!ed) return api.sendMessage(chatId, 'Пак не найден — возможно, он был удалён.');
  return api.sendPhoto(chatId, new InputFile(ed.image, 'pack.png'), {
    caption: ed.caption,
    parse_mode: 'HTML',
    reply_markup: ed.keyboard,
  });
}

const EMOJI_PER_MESSAGE = 100; // больше custom emoji в одном сообщении Telegram не показывает
export const EMOJI_FALLBACK_NOTE =
  'Telegram показал обычные emoji вместо ваших: ботам custom emoji в сообщениях доступны не всегда. ' +
  'Откройте пак по ссылке — там эмодзи видны как есть.';

/**
 * Присылает emoji-пак «картинкой» из самих custom emoji: по `cols` штук в строке,
 * длинный пак делится на несколько сообщений целыми строками.
 * Возвращает false, если Telegram заменил custom emoji обычными (бот не может их слать).
 */
export async function sendEmojiGrid(api, chatId, pack, set) {
  set ??= await fetchSet(api, pack);
  if (!set) return api.sendMessage(chatId, 'Пак не найден — возможно, он был удалён.');
  const rows = [];
  for (let i = 0; i < set.stickers.length; i += pack.cols) rows.push(set.stickers.slice(i, i + pack.cols));
  const rowsPerMessage = Math.max(1, Math.floor(EMOJI_PER_MESSAGE / pack.cols));

  let delivered = true;
  for (let r = 0; r < rows.length; r += rowsPerMessage) {
    let text = '';
    const entities = [];
    rows.slice(r, r + rowsPerMessage).forEach((row, j) => {
      if (j > 0) text += '\n';
      for (const s of row) {
        const emoji = s.emoji ?? pack.emoji;
        // offset/length в UTF-16 — ровно то, что считает String#length.
        entities.push({ type: 'custom_emoji', offset: text.length, length: emoji.length, custom_emoji_id: s.custom_emoji_id });
        text += emoji;
      }
    });
    const msg = await api.sendMessage(chatId, text, { entities });
    if (!msg.entities?.some((e) => e.type === 'custom_emoji')) delivered = false;
  }
  return delivered;
}

/** Перерисовывает редактор в сообщении, на кнопку которого нажали. */
async function refreshEditor(ctx, token, pack, opts) {
  const ed = await buildEditor(ctx.api, token, pack, opts);
  if (!ed) {
    return ctx.editMessageCaption({ caption: 'Пак не найден — возможно, он был удалён.' });
  }
  await ctx.editMessageMedia(
    { type: 'photo', media: new InputFile(ed.image, 'pack.png'), caption: ed.caption, parse_mode: 'HTML' },
    { reply_markup: ed.keyboard },
  );
}

/** После ввода текста/файла: старое сообщение-редактор удаляем, присылаем свежее. */
async function resendEditor(ctx, token, p, opts) {
  await ctx.api.deleteMessage(p.chatId, p.messageId).catch(() => {});
  const pack = getPack(p.pid);
  if (pack) await sendEditor(ctx.api, token, ctx.chat.id, pack, opts);
}

function errorText(err) {
  return err instanceof GrammyError ? `Telegram: ${err.description}` : (err?.message ?? String(err));
}

async function readImage(ctx, token) {
  const doc = ctx.message.document;
  const photo = ctx.message.photo?.at(-1);
  if (doc && !doc.mime_type?.startsWith('image/')) return null;
  return downloadFile(ctx.api, token, (doc ?? photo).file_id);
}

async function makeTile(buf, pack) {
  const clean = await removeBackground(buf, { mode: 'auto', tolerance: 30 });
  return toTile(clean, pack.type, 0);
}

const cancelKeyboard = (pid) => new InlineKeyboard().text('✖️ Отмена', cb('c', pid));

export function registerEditor(bot, token) {
  bot.command('packs', async (ctx) => {
    const list = userPacks(ctx.from.id);
    if (list.length === 0) return ctx.reply('У вас пока нет паков, созданных этим ботом.');
    const kb = new InlineKeyboard();
    for (const p of list.slice(-30).reverse()) {
      kb.text(`${p.type === 'emoji' ? '😀' : '🖼'} ${p.title}`.slice(0, 60), cb('o', p.pid, 0)).row();
    }
    await ctx.reply('Ваши паки — выберите для редактирования:', { reply_markup: kb });
  });

  bot.command('cancel', async (ctx) => {
    pending.delete(ctx.from.id);
    await ctx.reply('Отменено.');
  });

  // Ввод, которого ждёт редактор (замена/добавление картинки, emoji, название).
  bot.on('message', async (ctx, next) => {
    const p = pending.get(ctx.from.id);
    if (!p) return next();
    const pack = getPack(p.pid);
    if (!pack) {
      pending.delete(ctx.from.id);
      return next();
    }

    try {
      if (p.kind === 'replace' || p.kind === 'add') {
        if (!ctx.message.document && !ctx.message.photo) return ctx.reply('Пришлите картинку (лучше PNG файлом) или /cancel.');
        const buf = await readImage(ctx, token);
        if (!buf) return ctx.reply('Это не картинка. Пришлите PNG файлом или /cancel.');
        const tile = await makeTile(buf, pack);
        const set = await ctx.api.getStickerSet(pack.name);

        if (p.kind === 'replace') {
          const old = set.stickers[p.index];
          if (!old) throw new Error('Стикер не найден — пак изменился.');
          await ctx.api.replaceStickerInSet(ctx.from.id, pack.name, old.file_id, {
            sticker: new InputFile(tile, 'tile.png'),
            format: 'static',
            emoji_list: [old.emoji ?? pack.emoji],
          });
        } else {
          await ctx.api.addStickerToSet(ctx.from.id, pack.name, {
            sticker: new InputFile(tile, 'tile.png'),
            format: 'static',
            emoji_list: [pack.emoji],
          });
        }
        const fresh = await ctx.api.getStickerSet(pack.name);
        const index = p.kind === 'replace' ? p.index : fresh.stickers.length - 1;
        seedCache(fresh.stickers, [tile], index);
        pending.delete(ctx.from.id);
        await resendEditor(ctx, token, p, { selected: index });
      } else if (p.kind === 'emoji') {
        const emoji = ctx.message.text?.trim().split(/\s+/)[0];
        if (!emoji) return ctx.reply('Пришлите emoji текстом или /cancel.');
        const set = await ctx.api.getStickerSet(pack.name);
        const sticker = set.stickers[p.index];
        if (!sticker) throw new Error('Стикер не найден — пак изменился.');
        await ctx.api.setStickerEmojiList(sticker.file_id, [emoji]);
        pending.delete(ctx.from.id);
        await resendEditor(ctx, token, p, { selected: p.index });
      } else if (p.kind === 'title') {
        const title = ctx.message.text?.trim().slice(0, 64);
        if (!title) return ctx.reply('Пришлите название текстом или /cancel.');
        await ctx.api.setStickerSetTitle(pack.name, title);
        await updatePack(pack.pid, { title });
        pending.delete(ctx.from.id);
        await resendEditor(ctx, token, p, {});
      }
    } catch (err) {
      console.error(err);
      await ctx.reply(`❌ ${escapeHtml(errorText(err))}`, { parse_mode: 'HTML' });
    }
  });

  bot.callbackQuery(/^pk:/, async (ctx) => {
    const [, act, pid, a, b] = ctx.callbackQuery.data.split(':');
    if (act === 'n') return ctx.answerCallbackQuery();

    const pack = getPack(pid);
    if (!pack || pack.userId !== ctx.from.id) {
      return ctx.answerCallbackQuery({ text: 'Пак не найден.', show_alert: true });
    }
    const index = Number(a);
    const ask = async (kind, text) => {
      pending.set(ctx.from.id, {
        kind,
        pid,
        index,
        chatId: ctx.chat.id,
        messageId: ctx.callbackQuery.message.message_id,
      });
      await ctx.answerCallbackQuery();
      await ctx.reply(text, { reply_markup: cancelKeyboard(pid) });
    };

    try {
      switch (act) {
        case 'o':
          await ctx.answerCallbackQuery();
          return await refreshEditor(ctx, token, pack, { page: index || 0 });
        case 's':
          await ctx.answerCallbackQuery();
          return await refreshEditor(ctx, token, pack, { selected: index });
        case 'm': {
          const to = Number(b);
          const set = await ctx.api.getStickerSet(pack.name);
          if (to < 0 || to >= set.stickers.length) {
            return ctx.answerCallbackQuery({ text: 'Дальше двигать некуда.' });
          }
          await ctx.api.setStickerPositionInSet(set.stickers[index].file_id, to);
          await ctx.answerCallbackQuery({ text: `Перемещён на #${to + 1}` });
          return await refreshEditor(ctx, token, pack, { selected: to });
        }
        case 'd':
          await ctx.answerCallbackQuery();
          return await ctx.editMessageReplyMarkup({
            reply_markup: new InlineKeyboard()
              .text(`🗑 Да, удалить #${index + 1}`, cb('dy', pid, index))
              .text('Отмена', cb('s', pid, index)),
          });
        case 'dy': {
          const set = await ctx.api.getStickerSet(pack.name);
          if (set.stickers.length <= 1) {
            return ctx.answerCallbackQuery({
              text: 'Это последний стикер — удалите весь пак кнопкой «Удалить весь пак».',
              show_alert: true,
            });
          }
          await ctx.api.deleteStickerFromSet(set.stickers[index].file_id);
          await ctx.answerCallbackQuery({ text: `Стикер #${index + 1} удалён` });
          return await refreshEditor(ctx, token, pack, { page: Math.floor(index / PAGE_SIZE) });
        }
        case 'g':
          await ctx.answerCallbackQuery();
          if (!(await sendEmojiGrid(ctx.api, ctx.chat.id, pack))) await ctx.reply(EMOJI_FALLBACK_NOTE);
          return;
        case 'r':
          return await ask('replace', `Пришлите картинку для замены стикера #${index + 1} (PNG файлом). Фон уберу автоматически.`);
        case 'e':
          return await ask('emoji', `Пришлите emoji для стикера #${index + 1}.`);
        case 'a':
          return await ask('add', 'Пришлите картинку, которую добавить в конец пака (PNG файлом).');
        case 't':
          return await ask('title', 'Пришлите новое название пака.');
        case 'c':
          pending.delete(ctx.from.id);
          await ctx.answerCallbackQuery({ text: 'Отменено' });
          return await ctx.deleteMessage().catch(() => {});
        case 'x':
          await ctx.answerCallbackQuery();
          return await ctx.editMessageReplyMarkup({
            reply_markup: new InlineKeyboard()
              .text('🗑 Да, удалить пак навсегда', cb('xy', pid))
              .row()
              .text('Отмена', cb('o', pid, 0)),
          });
        case 'xy':
          await ctx.api.deleteStickerSet(pack.name);
          await removePack(pid);
          await ctx.answerCallbackQuery({ text: 'Пак удалён' });
          return await ctx.editMessageCaption({ caption: `Пак «${pack.title}» удалён.` });
        default:
          return ctx.answerCallbackQuery();
      }
    } catch (err) {
      console.error(err);
      await ctx.answerCallbackQuery({ text: errorText(err).slice(0, 190), show_alert: true }).catch(() => {});
    }
  });
}
