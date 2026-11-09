import path from "node:path";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { semanticRows, summarize, createExcel } from "./export.js";
import { WordstatRateLimitError } from "./wordstat.js";

const uuid = /^[0-9a-f-]{36}$/;
export const validId = id => uuid.test(id);
const readJson = async file => JSON.parse(await readFile(file, "utf8"));
const writeJson = async (file, value) => {
  await writeFile(`${file}.tmp`, JSON.stringify(value), "utf8");
  await rename(`${file}.tmp`, file);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function createBatchStore({
  exportsDir,
  requestWordstat,
  delayMs = 500,
  wait = sleep,
  now = Date.now,
  writeExcel = createExcel,
}) {
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

  async function loadRecord(batch, index) {
    let record;
    try {
      record = await readJson(path.join(directory(batch), `${index}.json`));
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
    if (record?.phrase !== batch.queries[index]) return null;
    if (record.regionId != null && record.regionId !== batch.regionId) return null;
    if (!record.error && record.data?.totalCount == null) return null;
    try {
      summarize(record);
      return record;
    } catch {
      return null;
    }
  }

  async function waitForQuota(batch) {
    if (!batch.retryAt) return;
    batch.status = "waiting";
    await save(batch);
    const retryAt = Date.parse(batch.retryAt);
    while (retryAt > now()) {
      await wait(Math.min(60000, retryAt - now()));
    }
    batch.retryAt = null;
    batch.status = "running";
    await save(batch);
  }

  function updateProgress(batch, items, unique) {
    batch.items = [...items];
    batch.semanticCount = items.reduce((total, item) => total + item.semanticCount, 0);
    batch.uniqueCount = unique.size;
  }

  async function run(batch) {
    try {
      batch.status = batch.retryAt ? "waiting" : "running";
      batch.error = null;
      batch.fileName = null;
      await save(batch);
      await waitForQuota(batch);
      const unique = new Set();
      const items = [];
      // Rebuild counters from durable responses, including files saved before a crash.
      for (let index = 0; index < batch.queries.length; index += 1) {
        batch.currentQuery = batch.queries[index];
        const file = path.join(directory(batch), `${index}.json`);
        let record = await loadRecord(batch, index);
        const needsRequest = !record;
        if (needsRequest) {
          updateProgress(batch, items, unique);
          await save(batch);
        }
        while (!record) {
          record = { phrase: batch.currentQuery, regionId: batch.regionId, collectedAt: new Date().toISOString() };
          try {
            record.data = await requestWordstat({ phrase: record.phrase, regionId: batch.regionId });
            summarize(record);
          } catch (error) {
            if (error instanceof WordstatRateLimitError) {
              record = null;
              batch.retryAt = new Date(error.retryAt).toISOString();
              await waitForQuota(batch);
              continue;
            }
            record.error = error.message || "Ошибка Wordstat";
          }
          // A complete upstream response is durable before progress advances.
          await writeJson(file, record);
        }
        const item = summarize(record);
        items.push(item);
        if (!record.error) for (const row of semanticRows(record)) unique.add(row.phrase.trim().toLocaleLowerCase("ru-RU"));
        updateProgress(batch, items, unique);
        await save(batch);
        if (needsRequest && delayMs && index < batch.queries.length - 1) await wait(delayMs);
      }
      batch.status = "exporting";
      batch.currentQuery = "Формируем Excel…";
      await save(batch);
      batch.fileName = await writeExcel(batch, directory(batch));
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
    batch.status = batch.retryAt ? "waiting" : "running";
    const job = run(batch).finally(() => jobs.delete(batch.id));
    jobs.set(batch.id, job);
  }

  // A quota wait survives server restarts. Other interrupted jobs keep manual resume.
  const waitingBatch = [...batches.values()].find(batch => batch.status === "waiting");
  if (waitingBatch) launch(waitingBatch);

  return {
    get: id => batches.get(id),
    view: publicBatch,
    list: () => {
      const sorted = [...batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const unfinished = sorted.filter(batch => batch.status !== "completed");
      const completed = sorted.filter(batch => batch.status === "completed").slice(0, 30);
      return [...unfinished, ...completed].map(publicBatch);
    },
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
