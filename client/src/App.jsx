import { useEffect, useMemo, useState } from "react";
import "./App.css";

const number = value => Number(value || 0).toLocaleString("ru-RU");

async function requestJSON(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Не удалось выполнить запрос");
    error.status = response.status;
    throw error;
  }
  return data;
}

export default function App() {
  const [auth, setAuth] = useState(null);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [queries, setQueries] = useState("");
  const [regionId, setRegionId] = useState("all");
  const [batch, setBatch] = useState(null);
  const [history, setHistory] = useState([]);
  const [connectionError, setConnectionError] = useState("");
  const queryList = useMemo(() => [...new Set(queries.split("\n").map(value => value.trim()).filter(Boolean))], [queries]);
  const running = batch && ["running", "exporting"].includes(batch.status);
  const progress = batch?.total ? Math.round(batch.processed / batch.total * 100) : 0;
  const invalidQueries = queryList.length > 2000 || queryList.some(value => value.length > 400);

  async function api(url, options = {}) {
    try { return await requestJSON(url, options); }
    catch (error) {
      if (error.status === 401 && url !== "/api/auth/login") setAuth({ authenticated: false, configured: true });
      throw error;
    }
  }

  async function checkSession() {
    try { setAuth(await api("/api/auth/session")); setMessage(""); }
    catch { setMessage("Сервер недоступен. Проверьте, что он запущен."); }
  }

  useEffect(() => {
    let cancelled = false;
    requestJSON("/api/auth/session").then(data => { if (!cancelled) setAuth(data); })
      .catch(() => { if (!cancelled) setMessage("Сервер недоступен. Проверьте, что он запущен."); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!auth?.authenticated) return;
    let cancelled = false;
    Promise.all([requestJSON("/api/health"), requestJSON("/api/wordstat/batches")]).then(([health, data]) => {
      if (cancelled) return;
      setConfigured(health.wordstatConfigured);
      setHistory(data.batches);
      setBatch(data.batches.find(item => ["running", "exporting", "paused"].includes(item.status)) || data.batches[0] || null);
      setConnectionError("");
    }).catch(error => {
      if (cancelled) return;
      if (error.status === 401) setAuth({ authenticated: false, configured: true });
      setConnectionError(error.message);
    });
    return () => { cancelled = true; };
  }, [auth?.authenticated]);

  useEffect(() => {
    if (!auth?.authenticated || !batch?.id || !running) return;
    let cancelled = false;
    let timer;
    async function poll() {
      try {
        const data = await api(`/api/wordstat/batch/${batch.id}`);
        if (cancelled) return;
        setBatch(data);
        setConnectionError("");
        setHistory(previous => [data, ...previous.filter(item => item.id !== data.id)]);
      } catch (error) { if (!cancelled) setConnectionError(`${error.message}. Сохранённый прогресс появится после восстановления связи.`); }
      if (!cancelled) timer = setTimeout(poll, 1500);
    }
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [auth?.authenticated, batch?.id, running]);

  async function login(event) {
    event.preventDefault();
    setSubmitting(true);
    setMessage("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      setPassword("");
      setAuth({ authenticated: true, configured: true });
    } catch (error) { setMessage(error.message); }
    finally { setSubmitting(false); }
  }

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      setAuth({ authenticated: false, configured: true });
      setBatch(null); setHistory([]); setQueries(""); setMessage("");
    } catch (error) { setMessage(error.message); }
  }

  async function start() {
    setSubmitting(true); setMessage("");
    try {
      const data = await api("/api/wordstat/batch/start", { method: "POST", body: JSON.stringify({ queries: queryList, regionId }) });
      setBatch(data); setHistory(previous => [data, ...previous]);
    } catch (error) { setMessage(error.message); }
    finally { setSubmitting(false); }
  }

  async function resume() {
    setSubmitting(true); setMessage("");
    try { setBatch(await api(`/api/wordstat/batch/${batch.id}/resume`, { method: "POST" })); }
    catch (error) { setMessage(error.message); }
    finally { setSubmitting(false); }
  }

  if (!auth?.authenticated) return (
    <main className="app"><section className="panel loginPanel">
      <p className="eyebrow">ДОСТУП ПО ПАРОЛЮ</p><h1>Wordstat Exporter</h1>
      <p className="description">Войдите, чтобы собрать семантику и скачать Excel.</p>
      {auth ? <form onSubmit={login}>
        <div className="formGroup"><label htmlFor="password">Пароль</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={256} autoFocus />
        </div>
        {!auth.configured && <p className="errorPanel">Пароль ещё не настроен. В папке server выполните npm run password и перезапустите сервер.</p>}
        <button className="startButton" disabled={submitting || !password || !auth.configured}>{submitting ? "Проверяем…" : "Войти"}</button>
      </form> : <button className="startButton" onClick={checkSession}>Проверить подключение</button>}
      {message && <p className="errorPanel" role="alert">{message}</p>}
    </section></main>
  );

  return (
    <main className="app"><section className="panel">
      <div className="header"><div><p className="eyebrow">СЕМАНТИКА WORDSTAT</p><h1>Wordstat Exporter</h1>
        <p className="description">Популярные и похожие фразы — в одном Excel.</p></div>
        <button className="secondaryButton" onClick={logout}>Выйти</button>
      </div>
      <div className={`status ${configured ? "" : "statusWarning"}`}><span className="statusDot" />{configured ? "Wordstat API готов" : "Нужно настроить Wordstat API в server/.env"}</div>
      <div className="formGroup queryForm"><div className="labelRow"><label htmlFor="queries">Исходные запросы — по одному на строку</label><span>{queryList.length} шт.</span></div>
        <textarea id="queries" value={queries} disabled={running || submitting} onChange={event => setQueries(event.target.value)} placeholder={'паспорт безопасности\nкатегорирование объекта\nэлектроизмерения\nиспытание кабеля'} />
        <p className="hint">До 2 000 фраз в параметре запроса API. Сохраняем все возвращённые популярные и похожие фразы. Совпадения между исходными запросами сохраняются с указанием источника.</p>
      </div>
      <div className="controls"><div className="formGroup"><label htmlFor="region">Регион</label>
        <select id="region" value={regionId} disabled={running || submitting} onChange={event => setRegionId(event.target.value)}><option value="all">Все регионы</option><option value="225">Россия</option><option value="213">Москва</option><option value="2">Санкт-Петербург</option></select>
      </div><div className="formGroup"><label>Выгрузка</label><p className="hint">Один XLSX на весь запуск · последние 30 дней · все устройства</p></div></div>
      {invalidQueries && <p className="errorPanel">Можно передать до 2 000 исходных запросов, не длиннее 400 символов каждый.</p>}
      <button className="startButton" disabled={running || submitting || !configured || !queryList.length || invalidQueries} onClick={start}>{running ? "Идёт сбор…" : submitting ? "Создаём запуск…" : "Начать сбор"}</button>
      {message && <p className="errorPanel" role="alert">{message}</p>}
      {connectionError && <p className="errorPanel" role="alert">{connectionError}</p>}
      {batch && <>
        <div className="progress" aria-live="polite"><div className="progressHeader"><span>{batch.regionName} · {new Date(batch.createdAt).toLocaleString("ru-RU")}</span><span>{batch.processed} / {batch.total}</span></div>
          <div className="progressTrack"><div className="progressBar" style={{ width: `${progress}%` }} /></div>
          <p>{batch.status === "completed" ? "Сбор завершён" : batch.status === "paused" ? "Сбор приостановлен. Данные сохранены." : batch.currentQuery || "Начинаем сбор…"}</p>
          {running && <p>Можно обновить или закрыть вкладку: сбор продолжится, пока работает сервер.</p>}
        </div>
        <div className="summaryPanel"><div><strong>{number(batch.semanticCount)}</strong><span>Строк семантики</span></div><div><strong>{number(batch.uniqueCount)}</strong><span>Уникальных фраз</span></div><div><strong>{batch.items.filter(item => item.status === "error").length}</strong><span>Ошибок</span></div></div>
        {batch.items.some(item => item.limitReached) && <p className="emptyPanel">Для части запросов достигнут лимит API. Полученная семантика сохранена; список по этим запросам может быть неполным.</p>}
        {batch.error && <p className="errorPanel">{batch.error}</p>}
        {batch.status === "paused" && <button className="startButton" disabled={submitting || !configured} onClick={resume}>Продолжить сохранённый сбор</button>}
        {batch.downloadUrl && <div className="batchDownload"><div><span className="batchLabel">ГОТОВО</span><strong>Единый Excel-файл</strong><p>{batch.processed} исходных запросов · {number(batch.semanticCount)} строк семантики</p></div><a href={batch.downloadUrl}>Скачать XLSX</a></div>}
        {batch.items.length > 0 && <div className="resultsPanel"><div className="resultsHeader"><strong>Обработанные запросы</strong><span>{batch.items.length}</span></div><div className="resultList">
          {batch.items.map((item, index) => <div className={`resultItem ${item.status === "error" ? "resultError" : ""}`} key={`${index}-${item.phrase}`}><div><strong>{item.phrase}</strong>
            <span>{item.status === "error" ? item.error : `Общая частотность: ${number(item.totalCount)} · популярных: ${number(item.resultsCount)} · похожих: ${number(item.associationsCount)}`}</span>
            {item.fallback && <span>{item.status === "empty" ? "Нет статистики. Исходный запрос сохранён с частотностью 0." : "Нет списка популярных фраз. Сохранены исходный запрос и общая частотность."}</span>}
          </div></div>)}
        </div></div>}
      </>}
      {history.length > 0 && <div className="resultsPanel"><div className="resultsHeader"><strong>Последние запуски</strong></div><div className="resultList">{history.map(item => <button key={item.id} className="historyItem" disabled={running && item.id !== batch.id} onClick={() => setBatch(item)}><span>{new Date(item.createdAt).toLocaleString("ru-RU")} · {item.regionName}</span><span>{item.processed}/{item.total} запросов · {number(item.semanticCount)} строк · {{ running: "Сбор", exporting: "Создание Excel", completed: "Готово", paused: "Приостановлен" }[item.status]}</span></button>)}</div></div>}
    </section></main>
  );
}
