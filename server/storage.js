import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const transient = new Set(["EBUSY", "EPERM", "EACCES"]);
export function createJsonStorage({ read = readFile, write = writeFile, replace = rename, wait = sleep, attempts = 10 } = {}) {
  async function perform(operation, action) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await action(); }
      catch (error) {
        error.storageOperation = operation;
        if (!transient.has(error.code) || attempt >= attempts - 1) throw error;
        await wait(Math.min(1000, 50 * 2 ** attempt));
      }
    }
  }
  return {
    readJson: async file => JSON.parse(await perform("read", () => read(file, "utf8"))),
    writeJson: async (file, value) => {
      const temporary = `${file}.tmp-${randomUUID()}`;
      const content = JSON.stringify(value);
      await perform("write", () => write(temporary, content, "utf8"));
      // Retry the rename using the same durable response, without re-querying Wordstat.
      await perform("rename", () => replace(temporary, file));
    },
  };
}
