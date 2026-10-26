import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
const directory = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(directory, ".env"), quiet: true });
const port = Number(process.env.PORT || 8788);
const app = await createApp({
  exportsDir: path.join(directory, "exports"),
  clientDir: path.join(directory, "../client/dist"),
  passwordHash: process.env.AUTH_PASSWORD_HASH,
  secureCookies: process.env.COOKIE_SECURE === "true",
  allowedOrigins: (process.env.APP_ORIGINS || `http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:${port},http://localhost:${port}`).split(",").map(value => value.trim()),
});
app.listen(port, "127.0.0.1", () => {
  console.log(`Wordstat Exporter: http://127.0.0.1:${port}`);
  if (!process.env.AUTH_PASSWORD_HASH) console.log("Для настройки пароля выполните npm run password в папке server.");
});
