import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import ExcelJS from "exceljs";

import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 8788;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXPORTS_DIR = path.join(__dirname, "exports");
const batches = new Map();

await mkdir(EXPORTS_DIR, {
  recursive: true,
});

app.use(cors());
app.use(express.json());

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function isWordstatConfigured() {
  return Boolean(
    process.env.YANDEX_API_KEY &&
      process.env.YANDEX_FOLDER_ID
  );
}

function sanitizeFileName(value) {
  const cleaned = value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);

  return cleaned || "wordstat";
}

async function requestWordstatTop({
  phrase,
  regionId = "225",
}) {
  if (!isWordstatConfigured()) {
    throw new Error(
      "Wordstat API не настроен. Укажите YANDEX_API_KEY и YANDEX_FOLDER_ID в .env"
    );
  }

  const body = {
    phrase,
    numPhrases: 1,
    regions: [String(regionId)],
    devices: ["DEVICE_ALL"],
    folderId: process.env.YANDEX_FOLDER_ID,
  };

  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;

    try {
      response = await fetch(
        "https://searchapi.api.cloud.yandex.net/v2/wordstat/topRequests",
        {
          method: "POST",
          headers: {
            Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(
          `Не удалось подключиться к Yandex API: ${error.message}`
        );
      }

      await sleep(1500 * attempt);
      continue;
    }

    const rawResponse = await response.text();

    let data;

    try {
      data = rawResponse
        ? JSON.parse(rawResponse)
        : {};
    } catch {
      data = {
        raw: rawResponse,
      };
    }

    if (response.ok) {
      return data;
    }

    if (
      (response.status === 429 ||
        response.status === 503) &&
      attempt < maxAttempts
    ) {
      const retryAfter = Number(
        response.headers.get("retry-after")
      );

      const delay = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : 2000 * attempt;

      console.log(
        `Yandex API вернул ${response.status}. Повтор через ${delay} мс...`
      );

      await sleep(delay);
      continue;
    }

    const message =
      data?.message ||
      data?.error?.message ||
      data?.details?.[0]?.message ||
      rawResponse ||
      `HTTP ${response.status}`;

    throw new Error(
      `Yandex API: ${response.status} — ${message}`
    );
  }

  throw new Error(
    "Не удалось получить ответ от Wordstat"
  );
}

function formatSheet({
  sheet,
  sourcePhrase,
  regionName,
  totalCount,
  rows,
}) {
  sheet.addRow([
    "Исходный запрос",
    sourcePhrase,
  ]);

  sheet.addRow([
    "Регион",
    regionName,
  ]);

  sheet.addRow([
    "Общая частотность",
    Number(totalCount || 0),
  ]);

  sheet.addRow([]);

  const headerRow = sheet.addRow([
    "Запрос",
    "Показы за 30 дней",
  ]);

  headerRow.font = {
    bold: true,
  };

  headerRow.height = 24;

  for (const item of rows) {
    sheet.addRow([
      item.phrase,
      Number(item.count || 0),
    ]);
  }

  sheet.getColumn(1).width = 65;
  sheet.getColumn(2).width = 22;

  sheet.getColumn(2).numFmt = "#,##0";

  sheet.views = [
    {
      state: "frozen",
      ySplit: 5,
    },
  ];

  sheet.autoFilter = {
    from: {
      row: 5,
      column: 1,
    },
    to: {
      row: 5,
      column: 2,
    },
  };
}

async function createExcelFile({
  phrase,
  regionName,
  data,
}) {
  const workbook = new ExcelJS.Workbook();

  workbook.creator = "Wordstat Exporter";
  workbook.created = new Date();

  const results = Array.isArray(data.results)
    ? data.results
    : [];

  const associations = Array.isArray(
    data.associations
  )
    ? data.associations
    : [];

  const topSheet =
    workbook.addWorksheet("Топ запросов");

  formatSheet({
    sheet: topSheet,
    sourcePhrase: phrase,
    regionName,
    totalCount: data.totalCount,
    rows: results,
  });

  const associationsSheet =
    workbook.addWorksheet("Похожие запросы");

  formatSheet({
    sheet: associationsSheet,
    sourcePhrase: phrase,
    regionName,
    totalCount: data.totalCount,
    rows: associations,
  });

  const fileName = `${sanitizeFileName(
    phrase
  )}.xlsx`;

  const filePath = path.join(
    EXPORTS_DIR,
    fileName
  );

  await workbook.xlsx.writeFile(filePath);

  return {
    fileName,
    filePath,
  };
}

function styleHeader(row) {
  row.font = {
    bold: true,
  };

  row.height = 24;
}

function createBatchWorkbook() {
  const workbook = new ExcelJS.Workbook();

  workbook.creator = "Wordstat Exporter";
  workbook.created = new Date();

  const semanticSheet =
    workbook.addWorksheet("Семантика");

  const headerRow = semanticSheet.addRow([
    "№",
    "Запрос",
    "Частотность",
    "Статус",
  ]);

  styleHeader(headerRow);

  semanticSheet.columns = [
    { width: 8 },
    { width: 70 },
    { width: 22 },
    { width: 22 },
  ];

  semanticSheet.views = [
    {
      state: "frozen",
      ySplit: 1,
    },
  ];

  semanticSheet.autoFilter = {
    from: "A1",
    to: "D1",
  };

  semanticSheet.getColumn(3).numFmt =
    "#,##0";

  return {
    workbook,
    semanticSheet,
  };
}

function createBatchFileName() {
  const timestamp = new Date()
    .toISOString()
    .replace("T", "_")
    .replace(/\.\d{3}Z$/, "")
    .replace(/:/g, "-");

  return `wordstat-export-${timestamp}.xlsx`;
}

function cleanupOldBatches() {
  const now = Date.now();

  const maxAge =
    2 * 60 * 60 * 1000;

  for (const [batchId, batch] of batches) {
    if (
      now - batch.createdAt >
      maxAge
    ) {
      batches.delete(batchId);
    }
  }
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    wordstatConfigured:
      isWordstatConfigured(),
    message: "Wordstat Exporter API работает",
    time: new Date().toISOString(),
  });
});

app.post(
  "/api/wordstat/batch/start",
  (req, res) => {
    cleanupOldBatches();

    if (!isWordstatConfigured()) {
      return res.status(500).json({
        ok: false,
        error:
          "Wordstat API не настроен",
      });
    }

    const batchId = randomUUID();

    const workbookData =
      createBatchWorkbook();

    batches.set(batchId, {
      ...workbookData,

      createdAt: Date.now(),

      processed: 0,
      successCount: 0,
      emptyCount: 0,
      errorCount: 0,
    });

    return res.json({
      ok: true,
      batchId,
    });
  }
);

app.post(
  "/api/wordstat/batch/:batchId/process",
  async (req, res) => {
    const batch = batches.get(
      req.params.batchId
    );

    if (!batch) {
      return res.status(404).json({
        ok: false,
        error:
          "Пакет выгрузки не найден или устарел",
      });
    }

    const phrase = String(
      req.body.phrase || ""
    ).trim();

    const regionId = String(
      req.body.regionId || "225"
    );

    if (!phrase) {
      return res.status(400).json({
        ok: false,
        error:
          "Не передан поисковый запрос",
      });
    }

    const rowNumber =
      batch.processed + 1;

    try {
      console.log(
        `Wordstat batch: "${phrase}"`
      );

      const data =
        await requestWordstatTop({
          phrase,
          regionId,
        });

      const totalCount = Number(
        data.totalCount || 0
      );

      if (totalCount === 0) {
        batch.semanticSheet.addRow([
          rowNumber,
          phrase,
          0,
          "Нет данных",
        ]);

        batch.processed += 1;
        batch.emptyCount += 1;

        return res.json({
          ok: true,
          status: "empty",
          phrase,
          totalCount: 0,
        });
      }

      batch.semanticSheet.addRow([
        rowNumber,
        phrase,
        totalCount,
        "Готово",
      ]);

      batch.processed += 1;
      batch.successCount += 1;

      return res.json({
        ok: true,
        status: "success",
        phrase,
        totalCount,
      });
    } catch (error) {
      console.error(
        `Wordstat batch error "${phrase}":`,
        error
      );

      batch.semanticSheet.addRow([
        rowNumber,
        phrase,
        "",
        "Ошибка",
      ]);

      batch.processed += 1;
      batch.errorCount += 1;

      return res.json({
        ok: true,
        status: "error",
        phrase,

        error:
          error.message ||
          "Неизвестная ошибка",
      });
    }
  }
);

app.post(
  "/api/wordstat/batch/:batchId/finish",
  async (req, res) => {
    const batch = batches.get(
      req.params.batchId
    );

    if (!batch) {
      return res.status(404).json({
        ok: false,
        error:
          "Пакет выгрузки не найден или устарел",
      });
    }

    try {
      const fileName =
        createBatchFileName();

      const filePath = path.join(
        EXPORTS_DIR,
        fileName
      );

      await batch.workbook.xlsx.writeFile(
        filePath
      );

      const result = {
        ok: true,

        fileName,

        downloadUrl:
          `/api/files/${encodeURIComponent(
            fileName
          )}`,

        processed:
          batch.processed,

        successCount:
          batch.successCount,

        emptyCount:
          batch.emptyCount,

        errorCount:
          batch.errorCount,
      };

      batches.delete(
        req.params.batchId
      );

      console.log(
        `Wordstat batch готов: ${fileName}`
      );

      return res.json(result);
    } catch (error) {
      console.error(error);

      return res.status(500).json({
        ok: false,

        error:
          error.message ||
          "Не удалось создать общий XLSX",
      });
    }
  }
);

app.post(
  "/api/wordstat/export-one",
  async (req, res) => {
    try {
      const phrase = String(
        req.body.phrase || ""
      ).trim();

      const regionId = String(
        req.body.regionId || "225"
      );

      const regionName = String(
        req.body.regionName || "Россия"
      );

      if (!phrase) {
        return res.status(400).json({
          ok: false,
          error: "Не передан поисковый запрос",
        });
      }

      if (phrase.length > 400) {
        return res.status(400).json({
          ok: false,
          error:
            "Поисковый запрос не должен превышать 400 символов",
        });
      }

      console.log(
        `Wordstat: начинаем "${phrase}"`
      );

      const data =
        await requestWordstatTop({
          phrase,
          regionId,
        });

      const resultsCount =
        Array.isArray(data.results)
          ? data.results.length
          : 0;

      const associationsCount =
        Array.isArray(data.associations)
          ? data.associations.length
          : 0;

      const totalCount = Number(
        data.totalCount || 0
      );

      const nothingFound =
        totalCount === 0 &&
        resultsCount === 0 &&
        associationsCount === 0;

      if (nothingFound) {
        console.log(
          `Wordstat: ничего не найдено "${phrase}"`
        );

        return res.json({
          ok: true,
          status: "empty",
          phrase,
          totalCount: 0,
          resultsCount: 0,
          associationsCount: 0,
        });
      }

      const { fileName } =
        await createExcelFile({
          phrase,
          regionName,
          data,
        });

      console.log(
        `Wordstat: готово "${phrase}"`
      );

      return res.json({
        ok: true,
        status: "success",

        phrase,
        totalCount,
        resultsCount,
        associationsCount,

        fileName,

        downloadUrl: `/api/files/${encodeURIComponent(
          fileName
        )}`,
      });
    } catch (error) {
      console.error(error);

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Неизвестная ошибка",
      });
    }
  }
);

app.get(
  "/api/files/:fileName",
  (req, res) => {
    const fileName = path.basename(
      req.params.fileName
    );

    if (fileName !== req.params.fileName) {
      return res.status(400).json({
        error: "Некорректное имя файла",
      });
    }

    const filePath = path.join(
      EXPORTS_DIR,
      fileName
    );

    return res.download(
      filePath,
      fileName,
      (error) => {
        if (
          error &&
          !res.headersSent
        ) {
          res.status(404).json({
            error: "Файл не найден",
          });
        }
      }
    );
  }
);

app.listen(PORT, "127.0.0.1", () => {
  console.log(
    `Wordstat Exporter API: http://127.0.0.1:${PORT}`
  );

  console.log(
    `Wordstat API: ${
      isWordstatConfigured()
        ? "настроен"
        : "НЕ настроен"
    }`
  );
});