import ExcelJS from "exceljs";
import path from "node:path";
import { readFile, rename } from "node:fs/promises";
import { PHRASE_LIMIT } from "./wordstat.js";

export function countValue(value) {
  const text = String(value ?? "0");
  if (!/^\d+$/.test(text)) throw new Error("Некорректная частотность в ответе Wordstat");
  return text.length <= 15 ? Number(text) : text;
}

export function semanticRows(record) {
  if (record.error) return [{ phrase: record.phrase, count: null, type: "Исходный запрос", status: "Ошибка" }];
  const { results = [], associations = [], totalCount } = record.data;
  if (!Array.isArray(results) || !Array.isArray(associations)) throw new Error("Некорректный список фраз Wordstat");
  const rows = [
    ...results.map(row => ({ ...row, type: "Популярные", status: "Готово" })),
    ...associations.map(row => ({ ...row, type: "Похожие", status: "Готово" })),
  ];
  for (const row of rows) {
    if (typeof row.phrase !== "string" || !row.phrase.trim() || row.count == null) throw new Error("Некорректная строка Wordstat");
    row.count = countValue(row.count);
  }
  if (results.length === 0) rows.unshift({ phrase: record.phrase, count: countValue(totalCount), type: "Исходный запрос", status: String(totalCount) === "0" && !associations.length ? "Нет данных" : "Только общая частотность" });
  return rows;
}

export function summarize(record) {
  const rows = semanticRows(record);
  const resultsCount = record.data?.results?.length || 0;
  const associationsCount = record.data?.associations?.length || 0;
  return {
    phrase: record.phrase, collectedAt: record.collectedAt,
    totalCount: record.error ? null : countValue(record.data.totalCount),
    status: record.error ? "error" : String(record.data.totalCount) === "0" && !resultsCount && !associationsCount ? "empty" : "success",
    error: record.error || null, resultsCount, associationsCount,
    semanticCount: record.error ? 0 : rows.length,
    limitReached: resultsCount >= PHRASE_LIMIT || associationsCount >= PHRASE_LIMIT,
    fallback: !record.error && !resultsCount,
  };
}

function table(workbook, name, headers, widths, rowLimit) {
  let page = 0;
  let sheet;
  let size = 0;
  return values => {
    if (!sheet || size >= rowLimit) {
      if (sheet) sheet.commit();
      page += 1;
      sheet = workbook.addWorksheet(page === 1 ? name : `${name} ${page}`, { views: [{ state: "frozen", ySplit: 1 }] });
      sheet.columns = widths.map(width => ({ width }));
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
      const header = sheet.addRow(headers);
      header.font = { bold: true, color: { argb: "FFFFFFFF" } };
      header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF243649" } };
      header.height = 24;
      header.commit();
      size = 1;
    }
    sheet.addRow(values).commit();
    size += 1;
  };
}

export async function createExcel(batch, directory, { rowLimit = 1048576 } = {}) {
  const fileName = `wordstat-${batch.id}.xlsx`;
  const temporary = path.join(directory, `${fileName}.tmp`);
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: temporary, useStyles: true, useSharedStrings: false });
  workbook.creator = "Wordstat Exporter";
  workbook.created = new Date();
  const source = table(workbook, "Исходные запросы", ["№", "Исходный запрос", "Общая частотность", "Статус", "Популярные", "Похожие", "Строк семантики", "Достигнут лимит API", "Регион", "Собрано (UTC)", "Комментарий"], [8, 60, 23, 20, 15, 15, 20, 25, 22, 27, 70], rowLimit);
  const semantic = table(workbook, "Семантика", ["№", "Исходный запрос", "Фраза", "Частотность", "Группа", "Статус", "Регион", "Собрано (UTC)"], [10, 50, 70, 22, 25, 30, 22, 27], rowLimit);
  let number = 0;
  for (let index = 0; index < batch.items.length; index += 1) {
    const record = JSON.parse(await readFile(path.join(directory, `${index}.json`), "utf8"));
    const item = batch.items[index];
    source([index + 1, item.phrase, item.totalCount, { success: "Готово", empty: "Нет данных", error: "Ошибка" }[item.status], item.resultsCount, item.associationsCount, item.semanticCount, item.limitReached ? "Да" : "Нет", batch.regionName, item.collectedAt, item.error || (item.fallback ? "Сохранены исходная фраза и общая частотность" : "")]);
    for (const row of semanticRows(record)) {
      number += 1;
      semantic([number, record.phrase, row.phrase, row.count, row.type, row.status, batch.regionName, record.collectedAt]);
    }
  }
  const info = workbook.addWorksheet("О выгрузке");
  for (const row of [
    ["Период", "Последние 30 дней по данным Wordstat API"],
    ["Устройства", "Все устройства"],
    ["Регион", batch.regionName],
    ["Исходных запросов", batch.queries.length],
    ["Обработано", batch.items.length],
    ["Строк семантики без ошибок", batch.semanticCount],
    ["Уникальных фраз без ошибок", batch.uniqueCount],
    ["Лимит numPhrases", PHRASE_LIMIT],
    ["Ограничения", "Сохранены все популярные и похожие фразы из ответа API. При достижении лимита список может быть неполным; API не предоставляет пагинацию."],
    ["Повторы", "Фразы разных исходных запросов и групп сохранены без удаления и суммирования частотностей."],
    ["Исходные данные", "Полные ответы API сохранены рядом с Excel в отдельных JSON-файлах по каждому запросу."],
  ]) info.addRow(row).commit();
  info.commit();
  await workbook.commit();
  await rename(temporary, path.join(directory, fileName));
  return fileName;
}
