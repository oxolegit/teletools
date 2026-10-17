import https from 'node:https';

// Скачиваем через модуль https (как и сам grammY), а не через глобальный fetch:
// у fetch (undici) в некоторых сетях соединение с api.telegram.org падает по таймауту.
const agent = new https.Agent({ keepAlive: true });

function get(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Не удалось скачать файл (HTTP ${res.statusCode})`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Таймаут при скачивании файла')));
    req.on('error', reject);
  });
}

/** Скачивает файл Telegram по file_id с повторными попытками. */
export async function downloadFile(api, token, fileId, { retries = 3, timeoutMs = 60000 } = {}) {
  const file = await api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await get(url, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}
