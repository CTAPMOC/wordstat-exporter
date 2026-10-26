import path from "node:path";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { semanticRows, summarize, createExcel } from "./export.js";

const uuid = /^[0-9a-f-]{36}$/;
export const validId = id => uuid.test(id);
const readJson = async file => JSON.parse(await readFile(file, "utf8"));
const writeJson = async (file, value) => {
  await writeFile(`${file}.tmp`, JSON.stringify(value), "utf8");
  await rename(`${file}.tmp`, file);
};

export async function createBatchStore({ exportsDir, requestWordstat, delayMs = 500 }) {
  await mkdir(exportsDir, { recursive: true });
  const batches = new Map();
  const jobs = new Map();
  for (const entry of await readdir(exportsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !validId(entry.name)) continue;
    try {
      const batch = await readJson(path.join(exportsDir, entry.name, "batch.json"));
      if (batch.id !== entry.name) continue;
      if (["running", "exporting"].includes(batch.status)) batch.status = "paused";
      batches.set(batch.id, batch);
    } catch { console.error(`Не удалось прочитать сохранённый запуск ${entry.name}`); }
  }
  const directory = batch => path.join(exportsDir, batch.id);
  const save = batch => writeJson(path.join(directory(batch), "batch.json"), batch);
  const publicBatch = batch => ({ ...batch, processed: batch.items.length, total: batch.queries.length,
    downloadUrl: batch.fileName ? `/api/files/${batch.id}/${batch.fileName}` : null });

  async function run(batch) {
    try {
      batch.status = "running";
      batch.error = null;
      await save(batch);
      const unique = new Set();
      for (let i = 0; i < batch.items.length; i += 1) {
        const record = await readJson(path.join(directory(batch), `${i}.json`));
        if (!record.error) for (const row of semanticRows(record)) unique.add(row.phrase.trim().toLocaleLowerCase("ru-RU"));
      }
      for (let index = batch.items.length; index < batch.queries.length; index += 1) {
        batch.currentQuery = batch.queries[index];
        const file = path.join(directory(batch), `${index}.json`);
        let record;
        try { record = await readJson(file); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!record) {
          record = { phrase: batch.currentQuery, regionId: batch.regionId, collectedAt: new Date().toISOString() };
          try {
            record.data = await requestWordstat({ phrase: record.phrase, regionId: batch.regionId });
            summarize(record);
          } catch (error) {
            record.error = error.message || "Ошибка Wordstat";
          }
          // A complete upstream response is durable before progress advances.
          await writeJson(file, record);
        }
        const item = summarize(record);
        batch.items.push(item);
        batch.semanticCount += item.semanticCount;
        if (!record.error) for (const row of semanticRows(record)) unique.add(row.phrase.trim().toLocaleLowerCase("ru-RU"));
        batch.uniqueCount = unique.size;
        await save(batch);
        if (delayMs && index < batch.queries.length - 1) await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      batch.status = "exporting";
      batch.currentQuery = "Формируем Excel…";
      await save(batch);
      batch.fileName = await createExcel(batch, directory(batch));
      batch.status = "completed";
      batch.currentQuery = "";
      await save(batch);
    } catch {
      batch.status = "paused";
      batch.error = "Сбор приостановлен: не удалось прочитать или сохранить данные. Проверьте свободное место и нажмите «Продолжить».";
      try { await save(batch); } catch { /* Preserve the last successful checkpoint. */ }
    }
  }

  function launch(batch) {
    if (jobs.has(batch.id)) return;
    batch.status = "running";
    const job = run(batch).finally(() => jobs.delete(batch.id));
    jobs.set(batch.id, job);
  }

  return {
    get: id => batches.get(id),
    view: publicBatch,
    list: () => [...batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map(publicBatch),
    busy: () => jobs.size > 0,
    async start({ queries, regionId, regionName }) {
      const batch = { id: randomUUID(), createdAt: new Date().toISOString(), queries, regionId, regionName,
        items: [], semanticCount: 0, uniqueCount: 0, status: "running", currentQuery: "", fileName: null };
      await mkdir(directory(batch), { recursive: true });
      await save(batch);
      batches.set(batch.id, batch);
      launch(batch);
      return publicBatch(batch);
    },
    resume: launch,
    wait: id => jobs.get(id) || Promise.resolve(),
  };
}
