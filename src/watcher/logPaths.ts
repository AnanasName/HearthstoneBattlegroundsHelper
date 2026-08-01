import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Hearthstone создаёт отдельную папку логов на каждый запуск клиента и НЕ дописывает
 * файлы предыдущей сессии. Подтверждено на C:\Program Files (x86)\Hearthstone\Logs,
 * где лежат шесть папок вида Hearthstone_2026_08_01_22_30_56 — см. docs/power-log.md.
 */
const SESSION_DIR_RE = /^Hearthstone_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})$/;

/** Путь установки на целевой машине. Вынести в конфиг, когда появится CLI. */
export const DEFAULT_LOGS_ROOT = 'C:\\Program Files (x86)\\Hearthstone\\Logs';

export const POWER_LOG_NAME = 'Power.log';

export interface LogSession {
  /** Имя папки, например Hearthstone_2026_08_01_22_30_56. */
  readonly name: string;
  /** Полный путь к папке сессии. */
  readonly dir: string;
  /** Момент запуска клиента, разобранный из имени папки (локальное время). */
  readonly startedAt: Date;
}

/**
 * Сессии, отсортированные от старых к новым.
 *
 * Порядок берётся из имени папки, а не из mtime: mtime меняется при любой записи
 * в старую сессию и не годится как признак «самой свежей».
 */
export function listSessions(logsRoot: string): LogSession[] {
  if (!existsSync(logsRoot)) return [];

  const sessions: LogSession[] = [];
  for (const entry of readdirSync(logsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const m = SESSION_DIR_RE.exec(entry.name);
    if (!m) continue;

    const [, year, month, day, hour, minute, second] = m;
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      hour === undefined ||
      minute === undefined ||
      second === undefined
    ) {
      continue;
    }

    sessions.push({
      name: entry.name,
      dir: join(logsRoot, entry.name),
      startedAt: new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      ),
    });
  }

  sessions.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  return sessions;
}

/** Самая свежая сессия, или null если папки логов нет и логирование не включено. */
export function findLatestSession(logsRoot: string): LogSession | null {
  const sessions = listSessions(logsRoot);
  return sessions.at(-1) ?? null;
}

/**
 * Путь к Power.log самой свежей сессии.
 *
 * null означает одно из двух: логирование выключено (log.config не создан либо клиент
 * не перезапускали) или сессий ещё нет. Различать эти случаи должен вызывающий код.
 */
export function findLatestPowerLog(logsRoot: string): string | null {
  const session = findLatestSession(logsRoot);
  if (session === null) return null;

  const powerLog = join(session.dir, POWER_LOG_NAME);
  return existsSync(powerLog) ? powerLog : null;
}
