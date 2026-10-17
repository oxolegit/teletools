import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Созданные паки храним в JSON, чтобы их можно было редактировать и после перезапуска бота.
const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'packs.json');

let packs = {};
try {
  packs = JSON.parse(await readFile(FILE, 'utf8'));
} catch {
  packs = {};
}

async function save() {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(packs, null, 2));
}

/** Короткий id — чтобы помещаться в 64 байта callback_data. */
export async function addPack(pack) {
  const pid = Date.now().toString(36);
  packs[pid] = { pid, ...pack };
  await save();
  return packs[pid];
}

export function getPack(pid) {
  return packs[pid];
}

export async function updatePack(pid, patch) {
  Object.assign(packs[pid], patch);
  await save();
}

export async function removePack(pid) {
  delete packs[pid];
  await save();
}

export function userPacks(userId) {
  return Object.values(packs).filter((p) => p.userId === userId);
}
