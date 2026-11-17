import path from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { semanticRows, summarize, createExcel } from "./export.js";
import { WordstatRateLimitError } from "./wordstat.js";
import { createJsonStorage } from "./storage.js";
import { sleep, withAbort } from "./cancellation.js";

const uuid = /^[0-9a-f-]{36}$/;
export const validId = id => uuid.test(id);

export async function createBatchStore({
  exportsDir,
  requestWordstat,
  delayMs = 500,
  wait = sleep,
  now = Date.now,
  writeExcel = createExcel,
  jsonStorage = createJsonStorage(),
}) {
  const { readJson, writeJson } = jsonStorage;
  await mkdir(exportsDir, { recursive: true });
  const batches = new Map();
  const jobs = new Map();
  const controllers = new Map();
  const saves = new Map();
  for (const entry of await readdir(exportsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !validId(entry.name)) continue;
    try {
      const batch = await readJson(path.join(exportsDir, entry.name, "batch.json"));
      if (batch.id !== entry.name) continue;
      if (batch.stopRequested || ["stopped", "stopping"].includes(batch.status)) {
        batch.status = "stopped"; batch.retryAt = null; batch.currentQuery = ""; batch.error = null;
      } else if (["running", "exporting"].includes(batch.status)) batch.status = "paused";
      batches.set(batch.id, batch);
    } catch { console.error(`Не удалось прочитать сохранённый запуск ${entry.name}`); }
  }
  const directory = batch => path.join(exportsDir, batch.id);
  const save = batch => {
    const snapshot = structuredClone(batch);
    const previous = saves.get(batch.id) || Promise.resolve();
    const saving = previous.catch(() => {}).then(() => writeJson(path.join(directory(batch), "batch.json"), snapshot));
    saves.set(batch.id, saving);
    return saving.finally(() => { if (saves.get(batch.id) === saving) saves.delete(batch.id); });
  };
  const checkStop = (batch, signal) => {
    signal.throwIfAborted();
    if (batch.stopRequested) throw new DOMException("Сбор остановлен", "AbortError");
  };
  const waitFor = (ms, signal) => withAbort(() => wait(ms, signal), signal);
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

  async function waitForQuota(batch, signal) {
    checkStop(batch, signal);
    if (!batch.retryAt) return;
    batch.status = "waiting";
    await save(batch);
    const retryAt = Date.parse(batch.retryAt);
    while (retryAt > now()) {
      await waitFor(Math.min(60000, retryAt - now()), signal);
      checkStop(batch, signal);
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

  async function run(batch, signal) {
    try {
      batch.status = batch.retryAt ? "waiting" : "running";
      batch.error = null;
      batch.lastFailure = null;
      batch.fileName = null;
      await save(batch);
      checkStop(batch, signal);
      await waitForQuota(batch, signal);
      const unique = new Set();
      const items = [];
      // Rebuild counters from durable responses, including files saved before a crash.
      for (let index = 0; index < batch.queries.length; index += 1) {
        checkStop(batch, signal);
        batch.currentQuery = batch.queries[index];
        const file = path.join(directory(batch), `${index}.json`);
        let record = await loadRecord(batch, index);
        const needsRequest = !record;
        if (needsRequest) {
          updateProgress(batch, items, unique);
          await save(batch);
        }
        while (!record) {
          checkStop(batch, signal);
          record = { phrase: batch.currentQuery, regionId: batch.regionId, collectedAt: new Date().toISOString() };
          try {
            record.data = await withAbort(() => requestWordstat({ phrase: record.phrase, regionId: batch.regionId, quotaAttempt: batch.quotaAttempts || 0, signal }), signal);
            summarize(record);
            batch.quotaAttempts = 0;
          } catch (error) {
            checkStop(batch, signal);
            if (error instanceof WordstatRateLimitError) {
              record = null;
              batch.retryAt = new Date(error.retryAt).toISOString();
              batch.quotaAttempts = (batch.quotaAttempts || 0) + 1;
              batch.lastRateLimit = { at: new Date(now()).toISOString(), ...error.diagnostics };
              await waitForQuota(batch, signal);
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
        checkStop(batch, signal);
        if (needsRequest && delayMs && index < batch.queries.length - 1) await waitFor(delayMs, signal);
      }
      checkStop(batch, signal);
      batch.status = "exporting";
      batch.currentQuery = "Формируем Excel…";
      await save(batch);
      batch.fileName = await writeExcel(batch, directory(batch));
      checkStop(batch, signal);
      batch.status = "completed";
      batch.currentQuery = "";
      await save(batch);
    } catch (error) {
      if (batch.stopRequested || signal.aborted) {
        batch.status = "stopped"; batch.retryAt = null; batch.currentQuery = "";
        batch.error = null; batch.stoppedAt = new Date(now()).toISOString();
        try { await save(batch); return; } catch (storageError) { error = storageError; }
      }
      batch.status = "paused";
      const code = ["EBUSY", "EPERM", "EACCES", "ENOSPC", "EIO", "ENOENT", "EROFS", "EMFILE", "ENFILE"].includes(error.code) ? error.code : "UNEXPECTED";
      const operation = ["read", "write", "rename"].includes(error.storageOperation) ? error.storageOperation : "processing";
      batch.lastFailure = { at: new Date(now()).toISOString(), code, operation };
      const explanation = ["EBUSY", "EPERM", "EACCES"].includes(code)
        ? "Файл временно заблокирован или нет доступа к нему. Проверьте синхронизацию OneDrive и права доступа."
        : code === "ENOSPC" ? "Недостаточно свободного места на диске."
        : "Не удалось прочитать, обработать или сохранить данные.";
      batch.error = `Сбор приостановлен (${code}, ${operation}). ${explanation} Нажмите «Продолжить сохранённый сбор».`;
      console.error(`Сбор ${batch.id} приостановлен: ${code}, ${operation}`);
      try { await save(batch); } catch { /* Preserve the last successful checkpoint. */ }
    }
  }

  function launch(batch) {
    if (jobs.has(batch.id)) return;
    const controller = new AbortController();
    controllers.set(batch.id, controller);
    batch.stopRequested = false;
    batch.status = batch.retryAt ? "waiting" : "running";
    const job = run(batch, controller.signal).finally(() => { jobs.delete(batch.id); controllers.delete(batch.id); });
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
    async stop(batch) {
      if (["completed", "stopped"].includes(batch.status)) return publicBatch(batch);
      batch.stopRequested = true;
      batch.status = "stopping";
      // Persist intent first so a process restart cannot resume quota waiting.
      await save(batch);
      const controller = controllers.get(batch.id);
      if (controller) {
        controller.abort(new DOMException("Сбор остановлен", "AbortError"));
        await jobs.get(batch.id);
      } else {
        batch.status = "stopped"; batch.retryAt = null; batch.currentQuery = ""; batch.error = null;
        batch.stoppedAt = new Date(now()).toISOString();
        await save(batch);
      }
      if (batch.status !== "stopped") throw new Error("Не удалось сохранить остановку сбора");
      return publicBatch(batch);
    },
    wait: id => jobs.get(id) || Promise.resolve(),
  };
}
