import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const validHash = value => /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(value || "");

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64, options);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  if (!validHash(stored) || typeof password !== "string" || password.length > 256) return false;
  const [, salt, digest] = stored.split("$");
  const actual = await scrypt(password, salt, 64, options);
  return timingSafeEqual(actual, Buffer.from(digest, "hex"));
}

export function installAuth(app, { passwordHash, secureCookies = false, allowedOrigins = [], now = Date.now }) {
  const sessions = new Map();
  const attempts = new Map();
  let activeChecks = 0;
  const lifetime = 12 * 60 * 60 * 1000;
  const configured = validHash(passwordHash);
  const cookieOptions = { httpOnly: true, sameSite: "strict", secure: secureCookies, path: "/", maxAge: lifetime };
  const tokenOf = req => /(?:^|;\s*)wordstat_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || "")?.[1];

  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if ((origin && !allowedOrigins.includes(origin)) || req.headers["sec-fetch-site"] === "cross-site") {
        return res.status(403).json({ error: "Запрос с этого сайта запрещён" });
      }
    }
    for (const [key, expiry] of sessions) if (expiry <= now()) sessions.delete(key);
    req.authenticated = sessions.has(tokenOf(req));
    next();
  });

  app.get("/api/auth/session", (req, res) => res.json({ authenticated: req.authenticated, configured }));
  app.post("/api/auth/login", async (req, res) => {
    if (!configured) return res.status(503).json({ error: "Пароль не настроен. В папке server выполните npm run password и перезапустите сервер." });
    for (const [key, entry] of attempts) if (entry.until <= now()) attempts.delete(key);
    const key = req.ip;
    const entry = attempts.get(key) || { count: 0, until: now() + 15 * 60 * 1000 };
    if (entry.count >= 10 || activeChecks >= 2 || sessions.size >= 1000) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((entry.until - now()) / 1000))));
      return res.status(429).json({ error: "Слишком много попыток входа. Попробуйте позже." });
    }
    entry.count += 1;
    attempts.set(key, entry);
    activeChecks += 1;
    let verified;
    try { verified = await verifyPassword(req.body?.password, passwordHash); }
    finally { activeChecks -= 1; }
    if (!verified) return res.status(401).json({ error: "Неверный пароль" });
    attempts.delete(key);
    sessions.delete(tokenOf(req));
    const token = randomBytes(32).toString("hex");
    sessions.set(token, now() + lifetime);
    res.cookie("wordstat_session", token, cookieOptions);
    return res.json({ ok: true });
  });
  app.post("/api/auth/logout", (req, res) => {
    sessions.delete(tokenOf(req));
    const { maxAge, ...clearOptions } = cookieOptions;
    res.clearCookie("wordstat_session", clearOptions);
    res.json({ ok: true });
  });
  app.use("/api", (req, res, next) => {
    if (!req.authenticated) return res.status(401).json({ error: "Необходимо войти по паролю" });
    next();
  });
}
