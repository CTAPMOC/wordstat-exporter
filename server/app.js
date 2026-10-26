import express from "express";
import path from "node:path";
import { installAuth } from "./auth.js";
import { createBatchStore, validId } from "./batches.js";
import { requestWordstatTop, isWordstatConfigured, PHRASE_LIMIT } from "./wordstat.js";

const regions = { all: "Все регионы", "225": "Россия", "213": "Москва", "2": "Санкт-Петербург" };

export async function createApp(options) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  installAuth(app, options);
  const store = await createBatchStore({ ...options, requestWordstat: options.requestWordstat || requestWordstatTop });
  app.locals.store = store;
  const configured = options.isConfigured || isWordstatConfigured;
  app.get("/api/health", (req, res) => res.json({ ok: true, wordstatConfigured: configured(), phraseLimit: PHRASE_LIMIT }));
  app.get("/api/wordstat/batches", (req, res) => res.json({ batches: store.list() }));
  app.post("/api/wordstat/batch/start", async (req, res) => {
    if (!configured()) return res.status(503).json({ error: "Wordstat API не настроен" });
    if (store.busy()) return res.status(409).json({ error: "Другой сбор уже выполняется. Дождитесь его завершения." });
    const input = req.body?.queries;
    const regionId = String(req.body?.regionId ?? "all");
    if (!Array.isArray(input) || input.length === 0 || input.length > 2000 || input.some(value => typeof value !== "string" || !value.trim() || value.trim().length > 400)) {
      return res.status(400).json({ error: "Нужны от 1 до 2000 запросов, каждый от 1 до 400 символов." });
    }
    if (!Object.hasOwn(regions, regionId)) return res.status(400).json({ error: "Некорректный регион" });
    const queries = [...new Set(input.map(value => value.trim()))];
    // Reserve the single runner before yielding to disk writes.
    if (app.locals.starting) return res.status(409).json({ error: "Запуск уже создаётся" });
    app.locals.starting = true;
    try { res.status(202).json(await store.start({ queries, regionId, regionName: regions[regionId] })); }
    finally { app.locals.starting = false; }
  });
  app.get("/api/wordstat/batch/:id", (req, res) => {
    const batch = store.get(req.params.id);
    if (!batch) return res.status(404).json({ error: "Запуск не найден" });
    res.json(store.view(batch));
  });
  app.post("/api/wordstat/batch/:id/resume", (req, res) => {
    const batch = store.get(req.params.id);
    if (!batch) return res.status(404).json({ error: "Запуск не найден" });
    if (!configured()) return res.status(503).json({ error: "Wordstat API не настроен" });
    if (store.busy() || app.locals.starting) return res.status(409).json({ error: "Другой сбор уже выполняется" });
    if (batch.status !== "paused") return res.status(409).json({ error: "Этот запуск не приостановлен" });
    store.resume(batch);
    res.json(store.view(batch));
  });
  app.get("/api/files/:id/:fileName", (req, res) => {
    const batch = store.get(req.params.id);
    if (!validId(req.params.id) || !batch?.fileName || batch.fileName !== req.params.fileName) return res.status(404).json({ error: "Файл не найден" });
    res.download(path.join(options.exportsDir, batch.id, batch.fileName), batch.fileName, error => {
      if (error && !res.headersSent) res.status(404).json({ error: "Файл не найден" });
    });
  });
  app.use("/api", (req, res) => res.status(404).json({ error: "Маршрут не найден" }));
  if (options.clientDir) app.use(express.static(options.clientDir));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status === 400 || error.status === 413 ? error.status : 500).json({ error: "Не удалось выполнить запрос. Проверьте данные и доступность диска." });
  });
  return app;
}
