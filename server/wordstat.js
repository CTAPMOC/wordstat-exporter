export const PHRASE_LIMIT = 2000;
export const isWordstatConfigured = () => Boolean(process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID);
import { sleep, withAbort } from "./cancellation.js";

export class WordstatRateLimitError extends Error {
  constructor(retryAt, diagnostics = {}) {
    super("Wordstat временно ограничил запросы. Сбор продолжится автоматически.");
    this.name = "WordstatRateLimitError";
    this.retryAt = retryAt;
    this.diagnostics = diagnostics;
  }
}

function quotaRetry(header, data, now, quotaAttempt) {
  if (header !== null && header.trim() !== "") {
    const seconds = Number(header);
    const retryAt = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(header);
    if (Number.isFinite(retryAt) && retryAt <= 8.64e15) {
      return { retryAt: Math.max(now + 1000, retryAt), retrySource: "retry-after" };
    }
  }
  const details = Array.isArray(data?.details) ? data.details : [];
  for (const detail of details) {
    if (!String(detail?.["@type"] || "").endsWith("google.rpc.RetryInfo")) continue;
    const delay = detail.retryDelay;
    const seconds = typeof delay === "string" && /^\d+(?:\.\d+)?s$/.test(delay)
      ? Number(delay.slice(0, -1))
      : delay && typeof delay === "object" ? Number(delay.seconds || 0) + Number(delay.nanos || 0) / 1e9 : NaN;
    const retryAt = now + seconds * 1000;
    if (Number.isFinite(seconds) && seconds >= 0 && retryAt <= 8.64e15) {
      return { retryAt: Math.max(now + 1000, retryAt), retrySource: "retry-info" };
    }
  }
  // No reset time was supplied. Probe conservatively instead of inventing an hour.
  const attempt = Number.isSafeInteger(quotaAttempt) && quotaAttempt >= 0 ? quotaAttempt : 0;
  return { retryAt: now + Math.min(900, 60 * 2 ** Math.min(attempt, 4)) * 1000, retrySource: "fallback" };
}

export function normalizeWordstatResponse(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).some(key => !["totalCount", "results", "associations"].includes(key))) {
    throw new Error("Некорректный ответ Wordstat.");
  }
  const count = value => {
    if (value === undefined) return "0"; // ProtoJSON omits implicit scalar defaults.
    if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) throw new Error("Некорректная частотность Wordstat.");
    return value;
  };
  const rows = value => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("Некорректный список фраз Wordstat.");
    return value.map(row => {
      if (!row || typeof row.phrase !== "string" || !row.phrase.trim()) throw new Error("Некорректная строка Wordstat.");
      return { ...row, count: count(row.count) };
    });
  };
  return { ...data, totalCount: count(data.totalCount), results: rows(data.results), associations: rows(data.associations) };
}

export async function requestWordstatTop({ phrase, regionId = "all", quotaAttempt = 0, signal }, { fetchImpl = fetch, wait = sleep, now = Date.now } = {}) {
  if (!isWordstatConfigured()) throw new Error("Wordstat API не настроен: нужны YANDEX_API_KEY и YANDEX_FOLDER_ID.");
  const body = {
    phrase, numPhrases: PHRASE_LIMIT,
    regions: regionId === "all" ? [] : [String(regionId)],
    devices: ["DEVICE_ALL"], folderId: process.env.YANDEX_FOLDER_ID,
  };
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    signal?.throwIfAborted();
    let response;
    let data;
    try {
      response = await fetchImpl("https://searchapi.api.cloud.yandex.net/v2/wordstat/topRequests", {
        method: "POST",
        headers: { Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
      });
      if (response.status !== 429) data = await response.json();
    } catch {
      signal?.throwIfAborted();
      if (attempt === 4) throw new Error("Нет корректного ответа от Wordstat после четырёх попыток.");
      await withAbort(() => wait(1500 * attempt, signal), signal);
      continue;
    }
    if (response.status === 429) {
      // Inspect structured retry instructions only; never store or display raw errors.
      try { data = await response.json(); } catch { data = null; }
      const time = now();
      const retry = quotaRetry(response.headers.get("retry-after"), data, time, quotaAttempt);
      const requestId = response.headers.get("x-request-id");
      const explanation = JSON.stringify({ message: data?.message, details: data?.details });
      const reportedQuotaScope = /per.?hour|hourly|requests?.?hour|в час|часов/i.test(explanation) ? "hour"
        : /per.?second|requests?.?second|\brps\b|в секунду/i.test(explanation) ? "second" : "unknown";
      throw new WordstatRateLimitError(retry.retryAt, {
        httpStatus: 429, retrySource: retry.retrySource,
        reportedQuotaScope,
        retryDelaySeconds: Math.ceil((retry.retryAt - time) / 1000),
        requestId: /^[a-zA-Z0-9_-]{1,128}$/.test(requestId || "") ? requestId : null,
      });
    }
    if (response.ok) {
      return normalizeWordstatResponse(data);
    }
    if (response.status >= 500 && attempt < 4) {
      const header = response.headers.get("retry-after");
      const seconds = header === null ? NaN : Number(header);
      const dateDelay = header ? Date.parse(header) - Date.now() : NaN;
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(dateDelay) ? dateDelay : 2000 * attempt;
      await withAbort(() => wait(Math.min(60000, Math.max(1000, delay)), signal), signal);
      continue;
    }
    // Never pass upstream error bodies to the UI: they can contain credentials.
    throw new Error(`Wordstat API: HTTP ${response.status}. ${response.status === 401 || response.status === 403 ? "Проверьте API-ключ и права доступа." : "Повторите запрос позже."}`);
  }
}
