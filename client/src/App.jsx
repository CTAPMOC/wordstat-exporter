import {
  useEffect,
  useMemo,
  useState,
} from "react";

import "./App.css";

const API_URL =
  "http://127.0.0.1:8788";

const REQUEST_PRICE_RUB = 0.02;

const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function formatPrice(value) {
  return value
    .toFixed(2)
    .replace(".", ",");
}

function App() {
  const [queries, setQueries] =
    useState("");

  const [serverOnline, setServerOnline] =
    useState(false);

  const [
    wordstatConfigured,
    setWordstatConfigured,
  ] = useState(false);

  const [serverStatus, setServerStatus] =
    useState("Проверяем...");

  const [running, setRunning] =
    useState(false);

  const [completed, setCompleted] =
    useState(0);

  const [currentQuery, setCurrentQuery] =
    useState("");

  const [files, setFiles] =
    useState([]);

  const [emptyResults, setEmptyResults] =
    useState([]);

  const [errors, setErrors] =
    useState([]);

  const queryList = useMemo(() => {
    const unique = new Set();

    return queries
      .split("\n")
      .map((query) => query.trim())
      .filter(Boolean)
      .filter((query) => {
        if (unique.has(query)) {
          return false;
        }

        unique.add(query);

        return true;
      });
  }, [queries]);

  const queryCount = queryList.length;

  const estimatedPrice =
    queryCount * REQUEST_PRICE_RUB;

  const progress =
    queryCount > 0
      ? Math.min(
          100,
          Math.round(
            (completed / queryCount) * 100
          )
        )
      : 0;

  useEffect(() => {
    fetch(`${API_URL}/api/health`)
      .then((response) =>
        response.json()
      )
      .then((data) => {
        setServerOnline(true);

        setWordstatConfigured(
          Boolean(
            data.wordstatConfigured
          )
        );

        if (data.wordstatConfigured) {
          setServerStatus(
            "Wordstat API готов"
          );
        } else {
          setServerStatus(
            "Нужно настроить Wordstat API"
          );
        }
      })
      .catch(() => {
        setServerOnline(false);
        setWordstatConfigured(false);

        setServerStatus(
          "Сервер недоступен"
        );
      });
  }, []);

  function resetCollectionState() {
    setCompleted(0);
    setCurrentQuery("");
    setFiles([]);
    setEmptyResults([]);
    setErrors([]);
  }

  function handleQueriesChange(event) {
    setQueries(event.target.value);

    if (!running) {
      resetCollectionState();
    }
  }

  async function startCollection() {
    if (
      running ||
      queryList.length === 0
    ) {
      return;
    }

    if (!wordstatConfigured) {
      alert(
        "Сначала необходимо настроить доступ к Wordstat API."
      );

      return;
    }

    setRunning(true);
    resetCollectionState();

    for (
      let index = 0;
      index < queryList.length;
      index += 1
    ) {
      const phrase =
        queryList[index];

      setCurrentQuery(phrase);

      try {
        const response = await fetch(
          `${API_URL}/api/wordstat/export-one`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              phrase,
              regionId: "225",
              regionName: "Россия",
            }),
          }
        );

        const data =
          await response.json();

        if (!response.ok) {
          throw new Error(
            data.error ||
              `HTTP ${response.status}`
          );
        }

        if (
          data.status === "empty"
        ) {
          setEmptyResults(
            (previous) => [
              ...previous,
              data,
            ]
          );
        } else {
          setFiles((previous) => [
            ...previous,
            data,
          ]);
        }
      } catch (error) {
        setErrors((previous) => [
          ...previous,
          {
            phrase,
            message:
              error.message ||
              "Неизвестная ошибка",
          },
        ]);
      }

      setCompleted(index + 1);

      if (
        index <
        queryList.length - 1
      ) {
        await delay(500);
      }
    }

    setCurrentQuery("");
    setRunning(false);
  }

  return (
    <main className="app">
      <section className="panel">
        <div className="header">
          <div>
            <p className="eyebrow">
              LOCAL TOOL
            </p>

            <h1>
              Wordstat Exporter
            </h1>

            <p className="description">
              Массовый сбор поисковых
              запросов из Яндекс Wordstat
            </p>
          </div>

          <div
            className={`status ${
              !serverOnline
                ? "statusError"
                : !wordstatConfigured
                  ? "statusWarning"
                  : ""
            }`}
          >
            <span className="statusDot" />

            {serverStatus}
          </div>
        </div>

        <div className="formGroup">
          <div className="labelRow">
            <label htmlFor="queries">
              Поисковые запросы
            </label>

            <span>
              {queryCount} шт.
            </span>
          </div>

          <textarea
            id="queries"
            value={queries}
            disabled={running}
            onChange={handleQueriesChange}
            placeholder={`паспорт безопасности
категорирование объекта
электроизмерения
испытание кабеля`}
          />

          <div className="priceHint">
            <span>
              1 запрос ≈ 0,02 ₽
            </span>

            {queryCount > 0 && (
              <strong>
                Текущий запуск ≈{" "}
                {formatPrice(
                  estimatedPrice
                )}{" "}
                ₽
              </strong>
            )}
          </div>
        </div>

        <div className="controls">
          <div className="formGroup">
            <label htmlFor="region">
              Регион
            </label>

            <select
              id="region"
              disabled={running}
            >
              <option value="225">
                Россия
              </option>
            </select>
          </div>

          <div className="formGroup">
            <label htmlFor="exportType">
              Выгрузка
            </label>

            <select
              id="exportType"
              disabled={running}
            >
              <option value="separate">
                Отдельный XLSX для
                каждой фразы
              </option>
            </select>
          </div>
        </div>

        <button
          className="startButton"
          disabled={
            queryCount === 0 ||
            running ||
            !wordstatConfigured
          }
          type="button"
          onClick={startCollection}
        >
          {running
            ? "Идёт сбор..."
            : "Начать сбор"}
        </button>

        <div className="progress">
          <div className="progressHeader">
            <span>
              Прогресс
            </span>

            <span>
              {completed} /{" "}
              {queryCount}
            </span>
          </div>

          <div className="progressTrack">
            <div
              className="progressBar"
              style={{
                width: `${progress}%`,
              }}
            />
          </div>

          <p>
            {running
              ? `Сейчас: ${currentQuery}`
              : completed > 0
                ? "Сбор завершён"
                : "Ожидание запуска..."}
          </p>
        </div>

        {completed > 0 &&
          !running && (
            <div className="summaryPanel">
              <div>
                <strong>
                  {files.length}
                </strong>
                <span>
                  Найдено
                </span>
              </div>

              <div>
                <strong>
                  {
                    emptyResults.length
                  }
                </strong>
                <span>
                  Без результатов
                </span>
              </div>

              <div>
                <strong>
                  {errors.length}
                </strong>
                <span>
                  Ошибок
                </span>
              </div>
            </div>
          )}

        {files.length > 0 && (
          <div className="resultsPanel">
            <div className="resultsHeader">
              <strong>
                Готовые файлы
              </strong>

              <span>
                {files.length}
              </span>
            </div>

            <div className="resultList">
              {files.map(
                (file) => (
                  <div
                    className="resultItem"
                    key={
                      file.fileName
                    }
                  >
                    <div>
                      <strong>
                        ✓ {file.phrase}
                      </strong>

                      <span>
                        {
                          file.resultsCount
                        }{" "}
                        запросов ·{" "}
                        {
                          file.associationsCount
                        }{" "}
                        похожих
                      </span>
                    </div>

                    <a
                      href={`${API_URL}${file.downloadUrl}`}
                    >
                      Скачать XLSX
                    </a>
                  </div>
                )
              )}
            </div>
          </div>
        )}

        {emptyResults.length > 0 && (
          <div className="emptyPanel">
            <div className="resultsHeader">
              <strong>
                Ничего не найдено
              </strong>

              <span>
                {
                  emptyResults.length
                }
              </span>
            </div>

            {emptyResults.map(
              (item) => (
                <div
                  className="emptyItem"
                  key={item.phrase}
                >
                  <strong>
                    — {item.phrase}
                  </strong>

                  <span>
                    Wordstat не нашёл
                    статистику по этой
                    фразе
                  </span>
                </div>
              )
            )}
          </div>
        )}

        {errors.length > 0 && (
          <div className="errorPanel">
            <strong>
              Не удалось обработать:
            </strong>

            {errors.map(
              (item) => (
                <p
                  key={
                    item.phrase
                  }
                >
                  <b>
                    {item.phrase}
                  </b>
                  : {item.message}
                </p>
              )
            )}
          </div>
        )}
      </section>
    </main>
  );
}

export default App;