import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import ExcelJS from "exceljs";
import { createApp } from "../app.js";
import { createBatchStore } from "../batches.js";
import { createExcel } from "../export.js";
import { requestWordstatTop, WordstatRateLimitError } from "../wordstat.js";
import { hashPassword } from "../auth.js";

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "wordstat-regression-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("wordstat-regression-"));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function fixture(phrase) {
  return {
    totalCount: "100",
    results: [{ phrase, count: "90" }],
    associations: [{ phrase: "related", count: "5" }],
  };
}

function failedOutput(file) {
  const output = createWriteStream(file);
  output.once("open", () => {
    output.destroy(Object.assign(new Error("Simulated full disk"), { code: "ENOSPC" }));
  });
  return output;
}

test("compressed requests are rejected before authentication and the server stays alive", async t => {
  const exportsDir = await temporary(t);
  const app = await createApp({ exportsDir, passwordHash: "" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = Buffer.concat([gzipSync(Buffer.from("{}")), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
  const response = await fetch(`${base}/api/health`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    body,
  });
  assert.equal(response.status, 415);
  await response.json();
  const health = await fetch(`${base}/api/auth/session`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).authenticated, false);
});

test("120 seeds survive the hourly quota and resume the same phrase without error rows", { timeout: 30000 }, async t => {
  const exportsDir = await temporary(t);
  const oldKey = process.env.YANDEX_API_KEY;
  const oldFolder = process.env.YANDEX_FOLDER_ID;
  process.env.YANDEX_API_KEY = "regression-fixture";
  process.env.YANDEX_FOLDER_ID = "regression-fixture";
  t.after(() => {
    if (oldKey === undefined) delete process.env.YANDEX_API_KEY;
    else process.env.YANDEX_API_KEY = oldKey;
    if (oldFolder === undefined) delete process.env.YANDEX_FOLDER_ID;
    else process.env.YANDEX_FOLDER_ID = oldFolder;
  });
  let time = Date.now();
  const startedAt = time;
  let upstreamCalls = 0;
  const requests = [];
  const now = () => time;
  let store;
  let batchId;
  store = await createBatchStore({
    exportsDir,
    delayMs: 0,
    now,
    wait: async ms => {
      const saved = JSON.parse(await readFile(path.join(exportsDir, batchId, "batch.json"), "utf8"));
      assert.equal(saved.status, "waiting");
      assert.equal(saved.items.length, 100);
      assert.equal(saved.currentQuery, "seed 100");
      assert.equal(store.busy(), true);
      time += ms;
    },
    requestWordstat: query => requestWordstatTop(query, {
      now,
      fetchImpl: async (url, options) => {
        const { phrase } = JSON.parse(options.body);
        requests.push(phrase);
        upstreamCalls += 1;
        if (upstreamCalls === 101) return new Response("quota", { status: 429, headers: { "retry-after": "3600" } });
        return Response.json(fixture(phrase));
      },
    }),
  });
  const started = await store.start({ queries: Array.from({ length: 120 }, (_, index) => `seed ${index}`), regionId: "all", regionName: "Все регионы" });
  batchId = started.id;
  await store.wait(batchId);
  const done = store.get(batchId);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.items.length, 120);
  assert.ok(done.items.every(item => item.status === "success"));
  assert.equal(done.semanticCount, 240);
  assert.equal(upstreamCalls, 121);
  assert.deepEqual(requests.slice(100, 102), ["seed 100", "seed 100"]);
  assert.equal(time - startedAt, 3600000);
  assert.equal(done.retryAt, null);
});

test("quota Retry-After accepts dates and defaults to one hour when absent", async t => {
  const oldKey = process.env.YANDEX_API_KEY;
  const oldFolder = process.env.YANDEX_FOLDER_ID;
  process.env.YANDEX_API_KEY = "regression-fixture";
  process.env.YANDEX_FOLDER_ID = "regression-fixture";
  t.after(() => {
    if (oldKey === undefined) delete process.env.YANDEX_API_KEY;
    else process.env.YANDEX_API_KEY = oldKey;
    if (oldFolder === undefined) delete process.env.YANDEX_FOLDER_ID;
    else process.env.YANDEX_FOLDER_ID = oldFolder;
  });
  const time = Date.parse("2026-11-09T10:00:00Z");
  for (const header of [null, "Mon, 09 Nov 2026 11:00:00 GMT"]) {
    const headers = header ? { "retry-after": header } : {};
    await assert.rejects(requestWordstatTop({ phrase: "seed" }, {
      now: () => time,
      fetchImpl: async () => new Response("quota", { status: 429, headers }),
    }), error => error instanceof WordstatRateLimitError && error.retryAt === time + 3600000);
  }
});

test("authenticated batch API exposes the quota wait and automatically completes the job", { timeout: 10000 }, async t => {
  const exportsDir = await temporary(t);
  const password = "quota-api-regression-fixture";
  let time = Date.now();
  const retryAt = time + 3600000;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const app = await createApp({
    exportsDir,
    passwordHash: await hashPassword(password),
    isConfigured: () => true,
    delayMs: 0,
    now: () => time,
    wait: () => gate,
    requestWordstat: async ({ phrase }) => {
      calls += 1;
      if (calls === 1) throw new WordstatRateLimitError(retryAt);
      return fixture(phrase);
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let id;
  try {
    const loggedIn = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
    });
    assert.equal(loggedIn.status, 200);
    const headers = { Cookie: loggedIn.headers.get("set-cookie").split(";")[0], "Content-Type": "application/json" };
    const start = await fetch(`${base}/api/wordstat/batch/start`, {
      method: "POST", headers, body: JSON.stringify({ queries: ["seed"] }),
    });
    assert.equal(start.status, 202);
    id = (await start.json()).id;
    let batch;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      batch = await (await fetch(`${base}/api/wordstat/batch/${id}`, { headers })).json();
      if (batch.status === "waiting") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(batch.status, "waiting");
    assert.equal(batch.retryAt, new Date(retryAt).toISOString());
    assert.equal(batch.processed, 0);
    assert.equal(batch.currentQuery, "seed");
    const blocked = await fetch(`${base}/api/wordstat/batch/start`, {
      method: "POST", headers, body: JSON.stringify({ queries: ["another"] }),
    });
    assert.equal(blocked.status, 409);
    time = retryAt;
    release();
    await app.locals.store.wait(id);
    const done = await (await fetch(`${base}/api/wordstat/batch/${id}`, { headers })).json();
    assert.equal(done.status, "completed");
    assert.equal(done.processed, 1);
    assert.equal(done.semanticCount, 2);
    assert.equal(calls, 2);
    const download = await fetch(base + done.downloadUrl, { headers });
    assert.equal(download.status, 200);
    await download.arrayBuffer();
  } finally {
    time = retryAt;
    release();
    if (id) await app.locals.store.wait(id);
    await new Promise(resolve => server.close(resolve));
  }
});

test("a persisted quota wait automatically resumes after server restart", async t => {
  const exportsDir = await temporary(t);
  const id = randomUUID();
  let time = Date.now();
  const retryAt = time + 3600000;
  const directory = path.join(exportsDir, id);
  await mkdir(directory);
  await writeFile(path.join(directory, "batch.json"), JSON.stringify({
    id, createdAt: new Date(time).toISOString(), queries: ["seed"], regionId: "all", regionName: "Все регионы",
    items: [], semanticCount: 0, uniqueCount: 0, status: "waiting", currentQuery: "seed", fileName: null,
    retryAt: new Date(retryAt).toISOString(),
  }));
  let calls = 0;
  const store = await createBatchStore({
    exportsDir, delayMs: 0, now: () => time,
    wait: async ms => { time += ms; },
    requestWordstat: async ({ phrase }) => {
      assert.ok(time >= retryAt);
      calls += 1;
      return fixture(phrase);
    },
  });
  await store.wait(id);
  assert.equal(store.get(id).status, "completed");
  assert.equal(calls, 1);
});

test("an early Excel disk error pauses the job, releases the queue, and allows recovery", { timeout: 5000 }, async t => {
  const exportsDir = await temporary(t);
  let calls = 0;
  let failNextExport = true;
  const store = await createBatchStore({
    exportsDir, delayMs: 0,
    requestWordstat: async ({ phrase }) => { calls += 1; return fixture(phrase); },
    writeExcel: (batch, directory) => {
      if (failNextExport) {
        failNextExport = false;
        return createExcel(batch, directory, { createOutput: failedOutput });
      }
      return createExcel(batch, directory);
    },
  });
  const first = await store.start({ queries: ["seed"], regionId: "all", regionName: "Все регионы" });
  await store.wait(first.id);
  assert.equal(store.get(first.id).status, "paused");
  assert.equal(store.busy(), false);
  assert.equal(store.get(first.id).items.length, 1);
  await assert.rejects(readFile(path.join(exportsDir, first.id, `wordstat-${first.id}.xlsx.tmp`)), { code: "ENOENT" });
  const second = await store.start({ queries: ["another"], regionId: "all", regionName: "Все регионы" });
  await store.wait(second.id);
  assert.equal(store.get(second.id).status, "completed");
  store.resume(store.get(first.id));
  await store.wait(first.id);
  assert.equal(store.get(first.id).status, "completed");
  assert.equal(calls, 2);
});

test("missing, malformed and mismatched saved responses are individually recovered", async t => {
  const exportsDir = await temporary(t);
  const original = await createBatchStore({ exportsDir, delayMs: 0, requestWordstat: async ({ phrase }) => fixture(phrase) });
  const started = await original.start({ queries: ["missing", "malformed", "mismatched", "intact"], regionId: "all", regionName: "Все регионы" });
  await original.wait(started.id);
  const batch = original.get(started.id);
  const directory = path.join(exportsDir, started.id);
  await rm(path.join(directory, "0.json"));
  await writeFile(path.join(directory, "1.json"), "{broken");
  const mismatched = JSON.parse(await readFile(path.join(directory, "2.json"), "utf8"));
  mismatched.phrase = "wrong source";
  await writeFile(path.join(directory, "2.json"), JSON.stringify(mismatched));
  batch.status = "exporting";
  batch.fileName = null;
  await writeFile(path.join(directory, "batch.json"), JSON.stringify(batch));
  const calls = [];
  const restored = await createBatchStore({
    exportsDir, delayMs: 0,
    requestWordstat: async ({ phrase }) => { calls.push(phrase); return fixture(phrase); },
  });
  restored.resume(restored.get(batch.id));
  await restored.wait(batch.id);
  const done = restored.get(batch.id);
  assert.equal(done.status, "completed", done.error);
  assert.deepEqual(calls, ["missing", "malformed", "mismatched"]);
  assert.equal(done.items.length, 4);
  assert.equal(done.semanticCount, 8);
  assert.equal(done.uniqueCount, 5);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(directory, done.fileName));
  assert.equal(workbook.getWorksheet("Семантика").rowCount, 9);
});

test("unfinished batches stay visible beyond the 30 most recent completed jobs", async t => {
  const exportsDir = await temporary(t);
  const pausedId = randomUUID();
  const ids = [pausedId, ...Array.from({ length: 31 }, () => randomUUID())];
  for (const [index, id] of ids.entries()) {
    await mkdir(path.join(exportsDir, id));
    await writeFile(path.join(exportsDir, id, "batch.json"), JSON.stringify({
      id, createdAt: new Date(index * 1000).toISOString(), queries: ["seed"], items: [],
      status: index === 0 ? "paused" : "completed", fileName: null,
    }));
  }
  const store = await createBatchStore({ exportsDir, requestWordstat: async () => assert.fail("Unexpected API request") });
  assert.equal(store.list().length, 31);
  assert.equal(store.list()[0].id, pausedId);
  assert.equal(store.list().filter(batch => batch.status === "completed").length, 30);
});
