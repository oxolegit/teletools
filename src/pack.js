import { InputFile } from 'grammy';

const FIRST_BATCH = 50; // createNewStickerSet принимает максимум 50 стикеров

/** Имя набора: только латиница/цифры/_, ≤ 64 символов, обязательно `_by_<bot>`. */
export function makePackName(userId, botUsername) {
  const suffix = `_by_${botUsername}`;
  const base = `p${userId}_${Date.now().toString(36)}`;
  return (base.slice(0, 64 - suffix.length) + suffix).replace(/__+/g, '_');
}

export function packLink(type, name) {
  return `https://t.me/${type === 'emoji' ? 'addemoji' : 'addstickers'}/${name}`;
}

function inputSticker(buf, emoji, i) {
  return { sticker: new InputFile(buf, `tile_${i}.png`), format: 'static', emoji_list: [emoji] };
}

/**
 * Создаёт набор из готовых PNG-тайлов.
 * onProgress(done, total) вызывается после каждой загруженной порции.
 */
export async function createPack(api, { userId, botUsername, settings, tiles, onProgress }) {
  const name = makePackName(userId, botUsername);
  const stickers = tiles.map((buf, i) => inputSticker(buf, settings.emoji, i));
  const first = stickers.slice(0, FIRST_BATCH);

  await api.createNewStickerSet(userId, name, settings.title.slice(0, 64), first, {
    sticker_type: settings.type === 'emoji' ? 'custom_emoji' : 'regular',
  });
  let done = first.length;
  await onProgress?.(done, stickers.length);

  for (const sticker of stickers.slice(FIRST_BATCH)) {
    await api.addStickerToSet(userId, name, sticker);
    done++;
    if (done % 10 === 0 || done === stickers.length) await onProgress?.(done, stickers.length);
  }

  return { name, link: packLink(settings.type, name) };
}
