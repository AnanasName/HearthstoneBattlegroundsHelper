import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderIndexHtml, renderReportHtml, type IndexEntry } from './html.js';
import { REPORT_SCHEMA, type PostGameReport } from './types.js';

/**
 * Отчёты на диске: `<имя>.html` и `<имя>.json` на партию, и общий
 * `index.html`, пересобираемый из всех JSON каталога.
 *
 * Имя — от источника, а не от времени сборки: повторная сборка той же
 * партии (после обновления правил) заменяет отчёт, а не плодит двойника.
 */

export const INDEX_FILE = 'index.html';

/** Имя файла без расширения: `part73`, `Hearthstone_2026_09_24_19_26_35_g2`. */
export function reportFileBase(source: PostGameReport['source']): string {
  const tail = source.ref.split(/[\\/]/).filter((s) => s !== '' && !/^power\.log/i.test(s)).at(-1) ?? 'game';
  const safe = tail.replace(/\.(?:log|part|gz)$/gi, '').replace(/[^\w.-]+/g, '_');
  return source.gameIndex === null ? safe : `${safe}_g${String(source.gameIndex)}`;
}

export interface WrittenReport {
  readonly htmlPath: string;
  readonly jsonPath: string;
  readonly indexPath: string;
}

export function writeReport(report: PostGameReport, dir: string): WrittenReport {
  mkdirSync(dir, { recursive: true });
  const base = reportFileBase(report.source);
  const htmlPath = join(dir, `${base}.html`);
  const jsonPath = join(dir, `${base}.json`);
  writeFileSync(htmlPath, renderReportHtml(report), 'utf8');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 1)}\n`, 'utf8');
  return { htmlPath, jsonPath, indexPath: rebuildIndex(dir) };
}

/** Отчёты каталога: только своей схемы — чужие и битые пропускаются молча. */
export function readReports(dir: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  for (const file of files) {
    try {
      const report = JSON.parse(readFileSync(join(dir, file), 'utf8')) as PostGameReport;
      if (report.schema !== REPORT_SCHEMA) continue;
      entries.push({ file: file.replace(/\.json$/, '.html'), report });
    } catch {
      continue;
    }
  }
  // Свежие сверху: дата и часы партии, у фикстур (без даты) — номер.
  const key = (e: IndexEntry): string =>
    `${e.report.game.date ?? ''} ${e.report.game.startedAt ?? ''} ${e.report.source.ref.padStart(12, '0')}`;
  return entries.sort((a, b) => key(b).localeCompare(key(a)));
}

export function rebuildIndex(dir: string): string {
  const path = join(dir, INDEX_FILE);
  writeFileSync(path, renderIndexHtml(readReports(dir)), 'utf8');
  return path;
}
