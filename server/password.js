import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hashPassword } from "./auth.js";

const envPath = fileURLToPath(new URL(".env", import.meta.url));
const password = randomBytes(24).toString("base64url");
const hash = await hashPassword(password);
let content = await readFile(envPath, "utf8").catch(error => {
  if (error.code !== "ENOENT") throw error;
  return "";
});
content = content.replace(/^\s*AUTH_PASSWORD_HASH\s*=.*(?:\r?\n|$)/gm, "").trimEnd();
await writeFile(envPath, `${content}\nAUTH_PASSWORD_HASH='${hash}'\n`, { mode: 0o600 });
console.log("Новый пароль (сохраните его в менеджере паролей):");
console.log(password);
console.log("В server/.env сохранён только scrypt-хеш. Перезапустите сервер; прежние сеансы завершатся.");
