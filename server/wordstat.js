export const PHRASE_LIMIT = 2000;
export const isWordstatConfigured = () => Boolean(process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function requestWordstatTop({ phrase, regionId = "all" }, { fetchImpl = fetch, wait = sleep } = {}) {
  if (!isWordstatConfigured()) throw new Error("Wordstat API не настроен: нужны YANDEX_API_KEY и YANDEX_FOLDER_ID.");
  const body = {
    phrase, numPhrases: PHRASE_LIMIT,
    regions: regionId === "all" ? [] : [String(regionId)],
    devices: ["DEVICE_ALL"], folderId: process.env.YANDEX_FOLDER_ID,
  };
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    let response;
    let data;
    try {
      response = await fetchImpl("https://searchapi.api.cloud.yandex.net/v2/wordstat/topRequests", {
        method: "POST",
        headers: { Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
      });
      data = await response.json();
    } catch {
      if (attempt === 4) throw new Error("Нет корректного ответа от Wordstat после четырёх попыток.");
      await wait(1500 * attempt);
      continue;
    }
    if (response.ok) {
      if (!data || typeof data !== "object" || Array.isArray(data) || data.totalCount == null) {
        throw new Error("Wordstat вернул ответ без общей частотности.");
      }
      return data;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      const header = response.headers.get("retry-after");
      const seconds = header === null ? NaN : Number(header);
      const dateDelay = header ? Date.parse(header) - Date.now() : NaN;
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(dateDelay) ? dateDelay : 2000 * attempt;
      await wait(Math.min(60000, Math.max(1000, delay)));
      continue;
    }
    // Never pass upstream error bodies to the UI: they can contain credentials.
    throw new Error(`Wordstat API: HTTP ${response.status}. ${response.status === 401 || response.status === 403 ? "Проверьте API-ключ и права доступа." : "Повторите запрос позже."}`);
  }
}
