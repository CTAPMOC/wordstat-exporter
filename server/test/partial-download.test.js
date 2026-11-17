import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import { createApp } from "../app.js";
import { hashPassword } from "../auth.js";
import { WordstatRateLimitError } from "../wordstat.js";

test("authenticated concurrent partial downloads work during quota wait and leave the runner untouched", async t => {
  const exportsDir = await mkdtemp(path.join(tmpdir(), "wordstat-partial-test-"));
  const password = "partial-test-password";
  let time = Date.now(), release, waiting;
  const enteredWait = new Promise(resolve => { waiting = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const app = await createApp({ exportsDir, passwordHash: await hashPassword(password), delayMs: 0,
    isConfigured: () => true, now: () => time,
    wait: async () => { waiting(); await gate; },
    requestWordstat: async ({ phrase }) => {
      if (++calls === 2) throw new WordstatRateLimitError(time + 3600000);
      return { totalCount: "8", results: [{ phrase, count: "5" }], associations: [] };
    },
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise(resolve => listener.once("listening", resolve));
  const base = `http://127.0.0.1:${listener.address().port}`;
  let id;
  t.after(async () => {
    time += 7200000; release();
    if (id) await app.locals.store.wait(id);
    await new Promise(resolve => listener.close(resolve));
    assert.equal(path.dirname(exportsDir), path.resolve(tmpdir()));
    assert.ok(path.basename(exportsDir).startsWith("wordstat-partial-test-"));
    await rm(exportsDir, { recursive: true, force: true });
  });
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  const headers = { Cookie: login.headers.get("set-cookie").split(";")[0], "Content-Type": "application/json" };
  const started = await fetch(base + "/api/wordstat/batch/start", { method: "POST", headers, body: JSON.stringify({ queries: ["one", "two", "three"] }) });
  id = (await started.json()).id;
  await enteredWait;
  const url = base + `/api/wordstat/batch/${id}/download`;
  assert.equal((await fetch(url)).status, 401);
  const before = await readFile(path.join(exportsDir, id, "batch.json"), "utf8");
  const snapshots = await Promise.all([fetch(url, { headers }), fetch(url, { headers })]);
  for (const response of snapshots) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition"), /1-partial\.xlsx/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(await response.arrayBuffer()));
    assert.equal(book.getWorksheet("Исходные запросы").rowCount, 2);
    assert.equal(book.getWorksheet("Семантика").getCell("C2").value, "one");
    assert.equal(book.getWorksheet("Не обработаны").rowCount, 3);
    assert.equal(book.getWorksheet("Не обработаны").getCell("B2").value, "two");
    assert.equal(book.getWorksheet("О выгрузке").getCell("B1").value, "Промежуточная: сбор ещё не завершён");
  }
  assert.equal(calls, 2);
  assert.equal(app.locals.store.busy(), true);
  assert.equal(app.locals.store.get(id).status, "waiting");
  assert.equal(await readFile(path.join(exportsDir, id, "batch.json"), "utf8"), before);
  time += 7200000; release(); await app.locals.store.wait(id);
  const completed = await fetch(url, { headers });
  assert.equal(completed.status, 200);
  const finalBook = new ExcelJS.Workbook();
  await finalBook.xlsx.load(Buffer.from(await completed.arrayBuffer()));
  assert.equal(finalBook.getWorksheet("Исходные запросы").rowCount, 4);
  assert.equal(finalBook.getWorksheet("Не обработаны"), undefined);
  assert.equal(calls, 4);
});
