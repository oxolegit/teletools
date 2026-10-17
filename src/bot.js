import 'dotenv/config';
import { Bot, GrammyError, InputFile } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import sharp from 'sharp';
import { buildTiles, renderPreview } from './image.js';
import { createPack } from './pack.js';
import { EMOJI_FALLBACK_NOTE, registerEditor, seedCache, sendEditor, sendEmojiGrid } from './editor.js';
import { addPack } from './store.js';
import { downloadFile } from './download.js';
import { LIMITS, applyAction, autoRows, defaultSettings, escapeHtml, renderKeyboard, renderText } from './settings.js';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Не задан BOT_TOKEN. Скопируйте .env.example в .env и вставьте токен от @BotFather.');
  process.exit(1);
}

const MAX_FILE_SIZE = 20 * 1024 * 1024; // лимит getFile в Bot API

const bot = new Bot(token);
bot.api.config.use(autoRetry({ maxRetryAttempts: 5, maxDelaySeconds: 60 }));

/** userId -> { image: Buffer, meta: {width,height}, settings, messageId, busy } */
const sessions = new Map();

function getSettings(ctx) {
  const session = sessions.get(ctx.from.id);
  return session?.settings ?? defaultSettings(ctx.from.username);
}

async function showSettings(ctx, session, edit = false) {
  const text = renderText(session.settings, session.meta);
  const opts = { parse_mode: 'HTML', reply_markup: renderKeyboard(session.settings) };
  if (edit) {
    await ctx.editMessageText(text, opts).catch((err) => {
      if (!(err instanceof GrammyError && err.description.includes('message is not modified'))) throw err;
    });
  } else {
    const msg = await ctx.reply(text, opts);
    session.messageId = msg.message_id;
  }
}

function errorText(err) {
  if (err instanceof GrammyError) return `Telegram: ${err.description}`;
  return err?.message ?? String(err);
}

bot.command('start', (ctx) =>
  ctx.reply(
    [
      'Привет! Пришлите мне PNG <b>файлом</b> (📎 → Файл, без сжатия).',
      '',
      'Я разрежу картинку по сетке, уберу фон и соберу из кусочков стикер-пак или emoji-пак.',
      '',
      'Команды:',
      '/title Название — название пака',
      '/emoji 🔥 — emoji, к которому привязываются стикеры',
      '/settings — показать настройки текущей картинки',
      '/packs — редактировать созданные паки',
    ].join('\n'),
    { parse_mode: 'HTML' },
  ),
);

bot.command('title', async (ctx) => {
  const title = ctx.match.trim();
  if (!title) return ctx.reply('Использование: /title Мой пак');
  const session = sessions.get(ctx.from.id);
  if (!session) return ctx.reply('Сначала пришлите PNG-файл.');
  session.settings.title = title.slice(0, 64);
  await ctx.reply(`Название: <b>${escapeHtml(session.settings.title)}</b>`, { parse_mode: 'HTML' });
  await showSettings(ctx, session);
});

bot.command('emoji', async (ctx) => {
  const emoji = ctx.match.trim();
  if (!emoji) return ctx.reply('Использование: /emoji 🔥');
  const session = sessions.get(ctx.from.id);
  if (!session) return ctx.reply('Сначала пришлите PNG-файл.');
  session.settings.emoji = emoji.split(/\s+/)[0];
  await showSettings(ctx, session);
});

bot.command('settings', async (ctx) => {
  const session = sessions.get(ctx.from.id);
  if (!session) return ctx.reply('Сначала пришлите PNG-файл.');
  await showSettings(ctx, session);
});

// Редактор паков перехватывает ожидаемый ввод (замена картинки, emoji, название),
// поэтому регистрируется до обработчиков фото и файлов.
registerEditor(bot, token);

bot.on('message:photo', (ctx) =>
  ctx.reply('Telegram сжимает фото и убирает прозрачность. Пришлите PNG как <b>файл</b> (📎 → Файл).', {
    parse_mode: 'HTML',
  }),
);

bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document;
  const isPng = doc.mime_type === 'image/png' || doc.file_name?.toLowerCase().endsWith('.png');
  if (!isPng) return ctx.reply('Нужен PNG-файл.');
  if (doc.file_size && doc.file_size > MAX_FILE_SIZE) return ctx.reply('Файл больше 20 МБ — Telegram не даст его скачать.');

  let image;
  try {
    image = await downloadFile(ctx.api, token, doc.file_id);
  } catch (err) {
    console.error(err);
    return ctx.reply(`Не удалось скачать файл, попробуйте ещё раз.\n${errorText(err)}`);
  }

  let meta;
  try {
    meta = await sharp(image).metadata();
  } catch {
    return ctx.reply('Не получилось прочитать картинку. Это точно PNG?');
  }

  const settings = getSettings(ctx);
  autoRows(settings, meta.width, meta.height);
  const session = { image, meta: { width: meta.width, height: meta.height }, settings, busy: false };
  sessions.set(ctx.from.id, session);
  await showSettings(ctx, session);
});

bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());

bot.callbackQuery('preview', async (ctx) => {
  const session = sessions.get(ctx.from.id);
  if (!session) return ctx.answerCallbackQuery({ text: 'Сначала пришлите PNG-файл.', show_alert: true });
  await ctx.answerCallbackQuery({ text: 'Готовлю превью…' });
  try {
    const preview = await renderPreview(session.image, session.settings);
    // Стикером, а не фото: Telegram покажет прозрачность без фона-пузыря.
    await ctx.replyWithSticker(new InputFile(preview, 'preview.webp'));
    await showSettings(ctx, session);
  } catch (err) {
    await ctx.reply(`Ошибка превью: ${errorText(err)}`);
  }
});

bot.callbackQuery('create', async (ctx) => {
  const session = sessions.get(ctx.from.id);
  if (!session) return ctx.answerCallbackQuery({ text: 'Сначала пришлите PNG-файл.', show_alert: true });
  if (session.busy) return ctx.answerCallbackQuery({ text: 'Уже создаю пак, подождите.' });

  const s = { ...session.settings };
  if (s.cols * s.rows > LIMITS[s.type]) {
    return ctx.answerCallbackQuery({ text: `Слишком много тайлов: максимум ${LIMITS[s.type]}.`, show_alert: true });
  }

  session.busy = true;
  await ctx.answerCallbackQuery();
  const status = await ctx.reply('⏳ Режу картинку…');
  const setStatus = (text) =>
    ctx.api.editMessageText(ctx.chat.id, status.message_id, text, { parse_mode: 'HTML' }).catch(() => {});

  try {
    const tiles = await buildTiles(session.image, s);
    await setStatus(`⏳ Загружаю 0/${tiles.length}…`);
    const { name, link } = await createPack(ctx.api, {
      userId: ctx.from.id,
      botUsername: ctx.me.username,
      settings: s,
      tiles,
      onProgress: (done, total) => setStatus(`⏳ Загружаю ${done}/${total}…`),
    });
    await setStatus(
      `✅ Готово! ${s.type === 'emoji' ? 'Emoji-пак' : 'Стикер-пак'} «${escapeHtml(s.title)}» (${tiles.length} шт.)\n${link}`,
    );
    const pack = await addPack({ userId: ctx.from.id, name, type: s.type, cols: s.cols, title: s.title, emoji: s.emoji });
    // Пак уже создан — ошибка превью не должна перетирать статус «Готово».
    try {
      const set = await ctx.api.getStickerSet(name);
      seedCache(set.stickers, tiles);
      if (s.type === 'emoji' && !(await sendEmojiGrid(ctx.api, ctx.chat.id, pack, set))) {
        await ctx.reply(EMOJI_FALLBACK_NOTE);
      }
      await sendEditor(ctx.api, token, ctx.chat.id, pack);
    } catch (err) {
      console.error(err);
      await ctx.reply(`Не удалось показать превью: ${errorText(err)}\nОткройте редактор позже через /packs.`);
    }
  } catch (err) {
    console.error(err);
    await setStatus(`❌ Не удалось создать пак.\n${escapeHtml(errorText(err))}`);
  } finally {
    session.busy = false;
  }
});

bot.on('callback_query:data', async (ctx) => {
  const session = sessions.get(ctx.from.id);
  if (!session) return ctx.answerCallbackQuery({ text: 'Сначала пришлите PNG-файл.', show_alert: true });
  const changed = applyAction(session.settings, ctx.callbackQuery.data, session.meta);
  await ctx.answerCallbackQuery();
  if (changed) await showSettings(ctx, session, true);
});

bot.catch((err) => console.error('Ошибка в обработчике:', err.error));

await bot.api.setMyCommands([
  { command: 'start', description: 'Как пользоваться' },
  { command: 'title', description: 'Название пака' },
  { command: 'emoji', description: 'Emoji для стикеров' },
  { command: 'settings', description: 'Показать настройки' },
  { command: 'packs', description: 'Мои паки (редактор)' },
  { command: 'cancel', description: 'Отменить ввод' },
]);

console.log('Бот запущен');
bot.start();
