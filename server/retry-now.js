// Run with the server stopped: node server/retry-now.js
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile, writeFile, rename, copyFile } from "node:fs/promises";
const directory = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(directory, ".env"), quiet: true });
const port = Number(process.env.PORT || 8788);
let online = false;
try {
  await fetch(`http://127.0.0.1:${port}/api/auth/session`, { signal: AbortSignal.timeout(1500) });
  online = true;
} catch { /* No HTTP server at this address. */ }
if (online) {
  console.error("Сначала остановите сервер через Ctrl+C, затем повторите команду.");
  process.exitCode = 1;
} else {
  const root = path.join(directory, "exports");
  const waiting = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const file = path.join(root, entry.name, "batch.json");
    try {
      const batch = JSON.parse(await readFile(file, "utf8"));
      if (batch.id === entry.name && batch.status === "waiting") waiting.push({ file, batch });
    } catch { /* Leave unreadable checkpoints untouched. */ }
  }
  if (waiting.length !== 1) {
    console.error(`Ожидающих запусков: ${waiting.length}. Изменения не внесены.`);
    process.exitCode = 1;
  } else {
    const { file, batch } = waiting[0];
    await copyFile(file, `${file}.before-retry-${Date.now()}.bak`);
    batch.retryAt = new Date().toISOString();
    batch.quotaAttempts = 0;
    await writeFile(`${file}.tmp`, JSON.stringify(batch), "utf8");
    await rename(`${file}.tmp`, file);
    console.log(`Готово: при запуске сервера сбор ${batch.id} повторит текущую фразу сразу. Сохранённые ответы и ошибки не изменены.`);
  }
}
