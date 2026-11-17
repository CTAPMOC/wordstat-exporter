import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, symlink, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
const execute = promisify(execFile);
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "wordstat-retry-command-"));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("wordstat-retry-command-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await copyFile(path.join(source, "retry-now.js"), path.join(directory, "retry-now.js"));
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  await symlink(path.join(source, "node_modules"), path.join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const id = "11111111-1111-1111-1111-111111111111";
  const folder = path.join(directory, "exports", id);
  await mkdir(folder, { recursive: true });
  const manifest = { id, status: "waiting", retryAt: "2099-01-01T00:00:00.000Z", queries: ["saved", "pending"], items: [{ phrase: "saved", status: "success" }] };
  const file = path.join(folder, "batch.json");
  await writeFile(file, JSON.stringify(manifest));
  return { directory, folder, file, manifest };
}
test("retry command backs up checkpoint and changes only the wait on a stopped server", async t => {
  const { directory, folder, file, manifest } = await fixture(t);
  await execute(process.execPath, [path.join(directory, "retry-now.js")], { env: { ...process.env, PORT: "0" }, windowsHide: true });
  const updated = JSON.parse(await readFile(file, "utf8"));
  assert.equal(updated.status, "waiting");
  assert.deepEqual(updated.items, manifest.items);
  assert.deepEqual(updated.queries, manifest.queries);
  assert.ok(Date.parse(updated.retryAt) <= Date.now());
  const backup = (await readdir(folder)).find(name => name.endsWith(".bak"));
  assert.deepEqual(JSON.parse(await readFile(path.join(folder, backup), "utf8")), manifest);
});
test("retry command refuses to modify a checkpoint while the server is online", async t => {
  const { directory, folder, file, manifest } = await fixture(t);
  const listener = createServer((req, res) => res.end('{}')).listen(0, "127.0.0.1");
  await new Promise(resolve => listener.once("listening", resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  await assert.rejects(execute(process.execPath, [path.join(directory, "retry-now.js")], { env: { ...process.env, PORT: String(listener.address().port) }, windowsHide: true }), error => error.code === 1);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), manifest);
  assert.deepEqual(await readdir(folder), ["batch.json"]);
});
