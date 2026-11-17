// Offline export only: reads saved responses, never calls Wordstat or modifies the batch.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { createExcel, summarize } from "./export.js";
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.WORDSTAT_EXPORTS_DIR || path.join(directory, "exports");
const outputDir = path.resolve(process.argv[2] || path.join(directory, "downloads"));
const candidates = [];
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
  try {
    const batch = JSON.parse(await readFile(path.join(root, entry.name, "batch.json"), "utf8"));
    if (batch.id === entry.name && batch.items?.length) candidates.push(batch);
  } catch { /* Skip unreadable manifests. */ }
}
candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const batch = candidates.find(item => item.status !== "completed") || candidates[0];
if (!batch) throw new Error("Нет сохранённых обработанных запросов");
// Recompute counts from exactly the durable prefix included in this snapshot.
batch.items = [];
const unique = new Set();
const { semanticRows } = await import("./export.js");
for (let index = 0; index < batch.queries.length; index++) {
  let record;
  try { record = JSON.parse(await readFile(path.join(root, batch.id, `${index}.json`), "utf8")); }
  catch (error) { if (error.code === "ENOENT") break; throw error; }
  if (record.phrase !== batch.queries[index]) throw new Error("Сохранённый ответ относится к другой фразе");
  batch.items.push(summarize(record));
  if (!record.error) for (const row of semanticRows(record)) unique.add(row.phrase.trim().toLocaleLowerCase("ru-RU"));
}
batch.semanticCount = batch.items.reduce((sum, item) => sum + item.semanticCount, 0);
batch.uniqueCount = unique.size;
batch.partial = batch.items.length < batch.queries.length;
batch.snapshotAt = new Date().toISOString();
await mkdir(outputDir, { recursive: true });
const fileName = await createExcel(batch, path.join(root, batch.id), { outputDir,
  fileName: `wordstat-${batch.id}-${batch.items.length}${batch.partial ? "-partial" : ""}.xlsx` });
console.log(JSON.stringify({ file: path.join(outputDir, fileName), processed: batch.items.length, total: batch.queries.length,
  semanticRows: batch.semanticCount, errors: batch.items.filter(item => item.status === "error").length }));
