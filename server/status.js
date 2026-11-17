import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "exports");
const batches = [];
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
  try {
    const batch = JSON.parse(await readFile(path.join(root, entry.name, "batch.json"), "utf8"));
    batches.push({ id: batch.id, createdAt: batch.createdAt, status: batch.status,
      processed: batch.items.length, total: batch.queries.length,
      errors: batch.items.filter(item => item.status === "error").length,
      retryAt: batch.retryAt || null, lastRateLimit: batch.lastRateLimit || null, lastFailure: batch.lastFailure || null });
  } catch { /* Skip unreadable checkpoints. */ }
}
console.log(JSON.stringify(batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3), null, 2));
