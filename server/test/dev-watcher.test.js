import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, copyFile, writeFile, readdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function scenario(t, fixed) {
  const directory = await mkdtemp(path.join(tmpdir(), "wordstat-watcher-"));
  let child;
  let output = "";
  t.after(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      for (const match of output.matchAll(/child pid: (\d+)/g)) {
        try { process.kill(Number(match[1])); } catch { /* Already exited. */ }
      }
      child.kill();
      await Promise.race([exited, pause(2000)]);
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref();
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("wordstat-watcher-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  for (const entry of await readdir(source)) {
    if (entry.endsWith(".js") || entry === "package.json") await copyFile(path.join(source, entry), path.join(directory, entry));
  }
  await symlink(path.join(source, "node_modules"), path.join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  if (fixed) await copyFile(path.join(source, "nodemon.json"), path.join(directory, "nodemon.json"));
  await mkdir(path.join(directory, "exports"));
  await writeFile(path.join(directory, "fixture.js"), `
import { createApp } from './app.js';
import { hashPassword } from './auth.js';
const app = await createApp({
  exportsDir: new URL('./exports/', import.meta.url).pathname.replace(/^\\/(?=[A-Za-z]:)/, ''),
  passwordHash: await hashPassword('test-password'), isConfigured: () => true,
  delayMs: 750,
  requestWordstat: async ({ phrase }) => {
    await new Promise(resolve => setTimeout(resolve, 750));
    return { totalCount: '2', results: [{ phrase, count: '2' }], associations: [] };
  }
});
const listener = app.listen(0, '127.0.0.1', () => console.log('FIXTURE_URL=http://127.0.0.1:' + listener.address().port));
`);
  child = spawn(process.execPath, [path.join(source, "node_modules/nodemon/bin/nodemon.js"), "--verbose", "fixture.js"], {
    cwd: directory, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  async function until(predicate, description) {
    const deadline = Date.now() + 12000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, `${description}\n${output}`);
      await pause(50);
    }
  }
  await until(() => output.includes("FIXTURE_URL="), "server starts under nodemon");
  const base = /FIXTURE_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(output)[1];
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test-password" }) });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get("set-cookie").split(";")[0], "Content-Type": "application/json" };
  const started = await fetch(base + "/api/wordstat/batch/start", { method: "POST", headers, body: JSON.stringify({ queries: ["one", "two"] }) });
  assert.equal(started.status, 202);
  const { id } = await started.json();
  if (!fixed) {
    await until(() => output.includes("restarting due to changes"), "JSON checkpoint triggers the faulty restart");
    return;
  }
  let batch;
  const deadline = Date.now() + 10000;
  do {
    const response = await fetch(base + `/api/wordstat/batch/${id}`, { headers });
    assert.equal(response.status, 200, output);
    batch = await response.json();
    assert.ok(Date.now() < deadline, JSON.stringify(batch));
    if (batch.status !== "completed") await pause(150);
  } while (batch.status !== "completed");
  assert.equal(batch.processed, 2);
  const download = await fetch(base + batch.downloadUrl, { headers });
  assert.equal(download.status, 200);
  assert.ok((await download.arrayBuffer()).byteLength > 0);
  await pause(1000);
  assert.equal((output.match(/FIXTURE_URL=/g) || []).length, 1, output);
  assert.ok(!output.includes("restarting due to changes"), output);
  assert.equal((await fetch(base + "/api/health", { headers })).status, 200);
  await writeFile(path.join(directory, "fixture.js"), "\n// source edit\n", { flag: "a" });
  await until(() => output.includes("restarting due to changes"), "source edits still trigger a restart");
}

test("checkpoint JSON triggers a server restart with the original dev settings", { timeout: 25000 }, t => scenario(t, false));
test("dev watcher preserves session and completes Excel, while source edits still restart", { timeout: 25000 }, t => scenario(t, true));
