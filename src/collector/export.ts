import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { type ArchivedSession, type LogArchiver, type SessionMeta } from './archive.js';
import { writeTar, type TarSource } from './tar.js';

/**
 * Экспорт архива логов одним файлом — то, что исполнитель отправляет.
 *
 * Внутри: `manifest.json` с версией формата и списком сессий, сами
 * `<сессия>.Power.log.gz` и их `.meta.json`. Никакой сети: файл кладётся
 * на рабочий стол, а дальше любой файлообменник — правило «никаких сетевых
 * запросов в рантайме» распространяется и на это. Читает файл команда
 * `dataset:import` на нашей стороне.
 *
 * Перед сборкой живая сессия сжимается снимком: игрок нажимает «собрать»
 * обычно сразу после игры, и партии этого вечера лежат ровно в ней.
 * Повторный экспорт пришлёт ту же сессию полнее — импорт различает партии
 * по отпечатку, а не по файлу.
 */

export const EXPORT_FORMAT = 'hsbg-logs/1';
export const EXPORT_PREFIX = 'hsbg-logs';

export interface ManifestSession extends SessionMeta {
  /** Имя файла внутри контейнера. */
  readonly file: string;
  readonly gzBytes: number;
}

export interface ExportManifest {
  readonly format: typeof EXPORT_FORMAT;
  readonly appVersion: string;
  readonly exportedAt: string;
  readonly sessions: readonly ManifestSession[];
}

export interface ExportResult {
  readonly path: string;
  readonly sessions: number;
  readonly bytes: number;
}

/**
 * Имя — по МЕСТНОМУ времени: первый же экспорт игрока в 12:36 назвался
 * `09-36` (UTC), и сверить его с «я только что нажал» было нельзя.
 */
export function exportFileName(now: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${String(now.getFullYear())}-${two(now.getMonth() + 1)}-${two(now.getDate())}` +
    `_${two(now.getHours())}-${two(now.getMinutes())}`;
  return `${EXPORT_PREFIX}_${stamp}.tar`;
}

export function buildManifest(
  archived: readonly ArchivedSession[],
  appVersion: string,
  now: Date,
): ExportManifest {
  return {
    format: EXPORT_FORMAT,
    appVersion,
    exportedAt: now.toISOString(),
    sessions: archived.map((a) => ({ ...a.meta, file: basename(a.gzPath), gzBytes: a.gzBytes })),
  };
}

export async function exportArchive(
  archiver: LogArchiver,
  outDir: string,
  appVersion: string,
  now: Date = new Date(),
): Promise<ExportResult> {
  await archiver.snapshotLive();
  const archived = archiver.listArchived();
  const manifest = buildManifest(archived, appVersion, now);

  const sources: TarSource[] = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), mtime: now },
  ];
  for (const a of archived) {
    sources.push({ name: basename(a.gzPath), path: a.gzPath, mtime: now });
    sources.push({ name: basename(a.metaPath), path: a.metaPath, mtime: now });
  }

  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, exportFileName(now));
  const bytes = await writeTar(path, sources);
  return { path, sessions: archived.length, bytes };
}
