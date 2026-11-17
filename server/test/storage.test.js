import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJsonStorage } from "../storage.js";
import { createBatchStore } from "../batches.js";

test("temporary rename locks reuse the written response and back off", async () => {
  let writes = 0, renames = 0;
  const waits = [], sources = [];
  const storage = createJsonStorage({
    write: async (file, content) => { writes++; assert.equal(content, '{"count":12}'); },
    replace: async (source, target) => {
      sources.push(source);
      assert.equal(target, "batch.json");
      if (++renames < 4) throw Object.assign(new Error("locked"), { code: "EPERM" });
    }, wait: async ms => waits.push(ms),
  });
  await storage.writeJson("batch.json", { count: 12 });
  assert.equal(writes, 1);
  assert.equal(renames, 4);
  assert.equal(new Set(sources).size, 1);
  assert.deepEqual(waits, [50, 100, 200]);
});
test("read locks are retried, permanent errors are propagated with their operation", async () => {
  let calls = 0;
  const storage = createJsonStorage({ read: async () => {
    if (++calls === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return '{"ok":true}';
  }, wait: async () => {} });
  assert.deepEqual(await storage.readJson("checkpoint"), { ok: true });
  const full = createJsonStorage({ write: async () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); }, wait: async () => assert.fail("permanent error must not retry") });
  await assert.rejects(full.writeJson("checkpoint", {}), error => error.code === "ENOSPC" && error.storageOperation === "write");
  let tries = 0;
  const locked = createJsonStorage({ attempts: 3, read: async () => { tries++; throw Object.assign(new Error("locked"), { code: "EACCES" }); }, wait: async () => {} });
  await assert.rejects(locked.readJson("checkpoint"), error => error.code === "EACCES" && error.storageOperation === "read");
  assert.equal(tries, 3);
});
test("transient response-file locks finish the batch without another API call", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "wordstat-storage-test-"));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("wordstat-storage-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  let calls = 0, locks = 0;
  const storage = createJsonStorage({ read: readFile, write: writeFile, wait: async () => {}, replace: async (source, destination) => {
    if (path.basename(destination) === "0.json" && ++locks < 4) throw Object.assign(new Error("OneDrive-like lock"), { code: "EPERM" });
    await rename(source, destination);
  } });
  const store = await createBatchStore({ exportsDir: directory, jsonStorage: storage, delayMs: 0, requestWordstat: async () => {
    calls++; return { totalCount: "12", results: [], associations: [] };
  } });
  const batch = await store.start({ queries: ["seed"], regionId: "all", regionName: "Все регионы" });
  await store.wait(batch.id);
  assert.equal(store.get(batch.id).status, "completed");
  assert.equal(calls, 1);
  assert.equal(locks, 4);
});
