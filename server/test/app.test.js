import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { createApp } from "../app.js";
import { hashPassword, verifyPassword } from "../auth.js";
import { createBatchStore } from "../batches.js";
import { createExcel, countValue } from "../export.js";
import { requestWordstatTop } from "../wordstat.js";

const password = "test-only-password-not-for-real-use";
const passwordHash = await hashPassword(password);
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "wordstat-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("wordstat-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function server(t, overrides = {}) {
  const exportsDir = await temporary(t);
  const app = await createApp({ exportsDir, passwordHash, isConfigured: () => true, delayMs: 0, allowedOrigins: ["http://localhost:5173"], ...overrides });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise(resolve => listener.once("listening", resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const base = `http://127.0.0.1:${listener.address().port}`;
  const request = (url, options = {}) => fetch(base + url, options);
  const login = () => request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  return { app, exportsDir, request, login };
}

test("scrypt is salted and verifies without storing the password", async () => {
  assert.notEqual(await hashPassword(password), passwordHash);
  assert.equal(await verifyPassword(password, passwordHash), true);
  assert.equal(await verifyPassword("wrong", passwordHash), false);
  assert.equal(await verifyPassword(password, "broken"), false);
});

test("authentication protects API and downloads, rejects foreign origins, expires and revokes sessions", async t => {
  let time = Date.now();
  const { request, login } = await server(t, { now: () => time, secureCookies: true });
  for (const url of ["/api/health", "/api/wordstat/batches", "/api/files/a/b", "/api/files/old.xlsx"]) assert.equal((await request(url)).status, 401);
  assert.equal((await request("/api/wordstat/batch/start", { method: "POST" })).status, 401);
  assert.equal((await request("/api/auth/login", { method: "POST", headers: { Origin: "https://evil.example" } })).status, 403);
  const loggedIn = await login();
  assert.equal(loggedIn.status, 200);
  const cookieHeader = loggedIn.headers.get("set-cookie");
  assert.match(cookieHeader, /HttpOnly/); assert.match(cookieHeader, /SameSite=Strict/); assert.match(cookieHeader, /Secure/);
  const headers = { Cookie: cookieHeader.split(";")[0] };
  assert.equal((await request("/api/health", { headers })).status, 200);
  await request("/api/auth/logout", { method: "POST", headers });
  assert.equal((await request("/api/health", { headers })).status, 401);
  const again = await login();
  time += 12 * 60 * 60 * 1000 + 1;
  assert.equal((await request("/api/health", { headers: { Cookie: again.headers.get("set-cookie").split(";")[0] } })).status, 401);
});

test("missing hash fails closed and password guesses are rate limited", async t => {
  const unconfigured = await server(t, { passwordHash: "" });
  assert.equal((await unconfigured.login()).status, 503);
  assert.equal((await unconfigured.request("/api/health")).status, 401);
  const configured = await server(t);
  for (let i = 0; i < 10; i++) assert.equal((await configured.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"password":"wrong"}' })).status, 401);
  const blocked = await configured.login();
  assert.equal(blocked.status, 429); assert.ok(blocked.headers.get("retry-after"));
});

test("mixed batch preserves every returned row, fallback, zero, error, and source total separately", async t => {
  const calls = [];
  const { app, request, login, exportsDir } = await server(t, { requestWordstat: async ({ phrase }) => {
    calls.push(phrase);
    if (phrase === "error") throw new Error("Test upstream failure");
    if (phrase === "empty") return { totalCount: "0", results: [], associations: [] };
    if (phrase === "fallback") return { totalCount: "3518666", results: [], associations: [{ phrase: "related", count: "5" }] };
    return { totalCount: "1000", results: [{ phrase, count: "800" }, { phrase: "=literal", count: "3" }], associations: [{ phrase: "related", count: "12" }] };
  } });
  const loginResponse = await login();
  const headers = { Cookie: loginResponse.headers.get("set-cookie").split(";")[0], "Content-Type": "application/json" };
  const invalid = await request("/api/wordstat/batch/start", { method: "POST", headers, body: JSON.stringify({ queries: ["x".repeat(401)] }) });
  assert.equal(invalid.status, 400);
  const response = await request("/api/wordstat/batch/start", { method: "POST", headers, body: JSON.stringify({ queries: ["hello", "fallback", "empty", "error", "hello"], regionId: "all" }) });
  assert.equal(response.status, 202);
  const batch = await response.json();
  await app.locals.store.wait(batch.id);
  const result = await (await request(`/api/wordstat/batch/${batch.id}`, { headers })).json();
  assert.equal(result.status, "completed");
  assert.equal(result.processed, 4); assert.equal(result.semanticCount, 6); assert.equal(result.uniqueCount, 5);
  assert.deepEqual(calls, ["hello", "fallback", "empty", "error"]);
  const download = await request(result.downloadUrl, { headers });
  assert.equal(download.status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await download.arrayBuffer()));
  const summary = workbook.getWorksheet("Исходные запросы");
  assert.equal(summary.getCell("C2").value, 1000);
  assert.equal(summary.getCell("C3").value, 3518666);
  assert.equal(summary.getCell("C4").value, 0);
  assert.equal(summary.getCell("C5").value, null);
  const semantic = workbook.getWorksheet("Семантика");
  assert.equal(semantic.rowCount, 8);
  assert.equal(semantic.getCell("D2").value, 800);
  assert.equal(semantic.getCell("C3").value, "=literal");
  assert.equal(semantic.getCell("C3").type, ExcelJS.ValueType.String);
  assert.equal(semantic.getCell("D5").value, 3518666);
  const raw = JSON.parse(await readFile(path.join(exportsDir, batch.id, "0.json"), "utf8"));
  assert.equal(raw.data.results.length, 2);
  assert.equal((await request(result.downloadUrl)).status, 401);
  assert.equal((await request(`/api/files/${batch.id}/0.json`, { headers })).status, 404);
  const restored = await createBatchStore({ exportsDir, requestWordstat: () => assert.fail("Should not call upstream"), delayMs: 0 });
  assert.equal(restored.get(batch.id).fileName, result.fileName);
});

test("restart resumes from durable raw response without querying the same phrase again", async t => {
  const exportsDir = await temporary(t);
  const original = await createBatchStore({ exportsDir, delayMs: 0, requestWordstat: async () => ({ totalCount: "20", results: [] }) });
  const first = await original.start({ queries: ["one"], regionId: "all", regionName: "Все регионы" });
  await original.wait(first.id);
  const manifest = original.get(first.id);
  // Simulate interruption after raw JSON was saved, before progress was checkpointed.
  Object.assign(manifest, { queries: ["one", "two"], items: [], semanticCount: 0, uniqueCount: 0, status: "running", fileName: null });
  await writeFile(path.join(exportsDir, first.id, "batch.json"), JSON.stringify(manifest));
  const calls = [];
  const restored = await createBatchStore({ exportsDir, delayMs: 0, requestWordstat: async ({ phrase }) => { calls.push(phrase); return { totalCount: "9", results: [] }; } });
  assert.equal(restored.get(first.id).status, "paused");
  restored.resume(restored.get(first.id));
  await restored.wait(first.id);
  assert.deepEqual(calls, ["two"]);
  assert.equal(restored.get(first.id).status, "completed");
  assert.equal(restored.get(first.id).items.length, 2);
});

test("large batch: 120 seeds, 240240 semantic rows, exact export counts, sheet rollover", { timeout: 120000 }, async t => {
  const exportsDir = await temporary(t);
  const store = await createBatchStore({ exportsDir, delayMs: 0, requestWordstat: async ({ phrase }) => ({
    totalCount: "3518666",
    results: Array.from({ length: 2000 }, (_, i) => ({ phrase: `${phrase} result ${i}`, count: String(i) })),
    associations: [{ phrase: "shared related", count: "10" }, { phrase: `${phrase} related`, count: "12" }],
  }) });
  const batch = await store.start({ queries: Array.from({ length: 120 }, (_, i) => `seed ${i}`), regionId: "225", regionName: "Россия" });
  await store.wait(batch.id);
  const done = store.get(batch.id);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.items.length, 120);
  assert.equal(done.semanticCount, 240240);
  assert.equal(done.uniqueCount, 240121);
  assert.ok(done.items.every(item => item.limitReached));
  const file = path.join(exportsDir, batch.id, done.fileName);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, { worksheets: "emit", sharedStrings: "cache", hyperlinks: "ignore", styles: "ignore" });
  let rows = 0;
  // Streaming writer emits workbook names after worksheet data; reader uses IDs here.
  for await (const sheet of reader) for await (const row of sheet) if (String(sheet.id) === "2" && row.number > 1) rows++;
  assert.equal(rows, 240240);
  // Exercise Excel's sheet-size rollover without generating a million-row fixture.
  const tiny = { ...done, items: done.items.slice(0, 1) };
  await createExcel(tiny, path.join(exportsDir, batch.id), { rowLimit: 1000 });
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(file);
  assert.equal(book.getWorksheet("Семантика").rowCount, 1000);
  assert.equal(book.getWorksheet("Семантика 2").rowCount, 1000);
  assert.equal(book.getWorksheet("Семантика 3").rowCount, 5);
  assert.equal(countValue("9223372036854775807"), "9223372036854775807");
});

test("Wordstat request uses maximum phrases, all-region filter, timeout, and backs off on throttling", async t => {
  const previous = { key: process.env.YANDEX_API_KEY, folder: process.env.YANDEX_FOLDER_ID };
  process.env.YANDEX_API_KEY = "fixture-secret"; process.env.YANDEX_FOLDER_ID = "fixture-folder";
  t.after(() => {
    if (previous.key === undefined) delete process.env.YANDEX_API_KEY; else process.env.YANDEX_API_KEY = previous.key;
    if (previous.folder === undefined) delete process.env.YANDEX_FOLDER_ID; else process.env.YANDEX_FOLDER_ID = previous.folder;
  });
  let calls = 0;
  const waits = [];
  const data = await requestWordstatTop({ phrase: "hello" }, { wait: async ms => waits.push(ms), fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.numPhrases, 2000); assert.deepEqual(body.regions, []); assert.ok(options.signal);
    calls++;
    return calls === 1 ? new Response('{}', { status: 429 }) : Response.json({ totalCount: "1", results: [] });
  } });
  assert.equal(data.totalCount, "1"); assert.deepEqual(waits, [2000]);
  await assert.rejects(requestWordstatTop({ phrase: "bad" }, { fetchImpl: async () => new Response('{"message":"fixture-secret"}', { status: 403 }) }), error => !error.message.includes("fixture-secret"));
});
