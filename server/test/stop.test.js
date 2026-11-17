import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createBatchStore } from "../batches.js";
import { createApp } from "../app.js";
import { hashPassword } from "../auth.js";
import { requestWordstatTop, WordstatRateLimitError } from "../wordstat.js";
import ExcelJS from "exceljs";
const fixture = phrase => ({ totalCount: "8", results: [{ phrase, count: "5" }], associations: [] });
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "wordstat-stop-test-"));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("wordstat-stop-test-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return directory;
}

test("stop interrupts an hour quota wait, persists across restart, and releases the queue", { timeout: 5000 }, async t => {
  const exportsDir = await temporary(t);
  let calls = 0, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const store = await createBatchStore({ exportsDir, delayMs: 0,
    requestWordstat: async ({ phrase }) => { if (++calls === 2) throw new WordstatRateLimitError(Date.now() + 3600000); return fixture(phrase); },
    wait: async () => { entered(); await new Promise(() => {}); },
  });
  const started = await store.start({ queries: ["one", "two"], regionId: "all", regionName: "Все регионы" });
  await waiting;
  const stopped = await store.stop(store.get(started.id));
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.processed, 1);
  assert.equal(stopped.retryAt, null);
  assert.equal(stopped.items[0].status, "success");
  assert.equal(store.busy(), false);
  assert.equal(calls, 2);
  const restored = await createBatchStore({ exportsDir, requestWordstat: () => assert.fail("must not auto-resume") });
  assert.equal(restored.get(started.id).status, "stopped");
  assert.equal(restored.busy(), false);
  assert.equal(JSON.parse(await readFile(path.join(exportsDir, started.id, "batch.json"), "utf8")).status, "stopped");
  const next = await store.start({ queries: ["new"], regionId: "all", regionName: "Все регионы" });
  await store.wait(next.id);
  assert.equal(store.get(next.id).status, "completed");
  store.resume(store.get(started.id)); await store.wait(started.id);
  assert.equal(store.get(started.id).status, "completed");
  assert.equal(calls, 4); // The saved first phrase was not requested again.
});

test("stop aborts an in-flight request without saving an error or sending another phrase", { timeout: 5000 }, async t => {
  const exportsDir = await temporary(t);
  let calls = 0, entered, receivedSignal;
  const inFlight = new Promise(resolve => { entered = resolve; });
  const store = await createBatchStore({ exportsDir, delayMs: 0, requestWordstat: async ({ phrase, signal }) => {
    calls++;
    if (calls === 1) return fixture(phrase);
    receivedSignal = signal; entered();
    return new Promise(() => {});
  } });
  const started = await store.start({ queries: ["one", "two", "three"], regionId: "all", regionName: "Все регионы" });
  await inFlight;
  const stopped = await store.stop(store.get(started.id));
  assert.equal(receivedSignal.aborted, true);
  assert.equal(stopped.status, "stopped"); assert.equal(stopped.processed, 1);
  assert.equal(stopped.items.filter(item => item.status === "error").length, 0);
  assert.equal(calls, 2);
  await assert.rejects(readFile(path.join(exportsDir, started.id, "1.json")), { code: "ENOENT" });
  assert.equal((await store.stop(store.get(started.id))).status, "stopped");
});

test("stop endpoint requires login and stopped results remain downloadable", { timeout: 10000 }, async t => {
  const exportsDir = await temporary(t);
  const password = "stop-test-password";
  let calls = 0, entered;
  const inFlight = new Promise(resolve => { entered = resolve; });
  const app = await createApp({ exportsDir, passwordHash: await hashPassword(password), isConfigured: () => true, delayMs: 0,
    requestWordstat: async ({ phrase }) => { if (++calls === 1) return fixture(phrase); entered(); return new Promise(() => {}); },
  });
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  const headers = { Cookie: login.headers.get("set-cookie").split(";")[0], "Content-Type": "application/json" };
  const response = await fetch(base + "/api/wordstat/batch/start", { method: "POST", headers, body: JSON.stringify({ queries: ["one", "two"] }) });
  const { id } = await response.json(); await inFlight;
  const stopUrl = base + `/api/wordstat/batch/${id}/stop`;
  assert.equal((await fetch(stopUrl, { method: "POST" })).status, 401);
  const stopped = await fetch(stopUrl, { method: "POST", headers });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).status, "stopped");
  const download = await fetch(base + `/api/wordstat/batch/${id}/download`, { headers });
  assert.equal(download.status, 200);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(await download.arrayBuffer()));
  assert.equal(workbook.getWorksheet("Исходные запросы").rowCount, 2);
  assert.equal(workbook.getWorksheet("Не обработаны").rowCount, 2);
});

test("Wordstat cancellation interrupts retry backoff and does not send a retry", { timeout: 5000 }, async t => {
  const old = { key: process.env.YANDEX_API_KEY, folder: process.env.YANDEX_FOLDER_ID };
  process.env.YANDEX_API_KEY = "test"; process.env.YANDEX_FOLDER_ID = "test";
  t.after(() => { for (const [name, value] of [["YANDEX_API_KEY", old.key], ["YANDEX_FOLDER_ID", old.folder]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const controller = new AbortController();
  let calls = 0, entered;
  const backoff = new Promise(resolve => { entered = resolve; });
  const request = requestWordstatTop({ phrase: "test", signal: controller.signal }, {
    fetchImpl: async () => { calls++; return new Response("{}", { status: 503 }); },
    wait: async () => { entered(); await new Promise(() => {}); },
  });
  const rejected = assert.rejects(request, error => error.name === "AbortError");
  await backoff; controller.abort(); await rejected;
  assert.equal(calls, 1);
});
