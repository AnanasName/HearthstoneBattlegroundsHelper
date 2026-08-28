import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_LOGS_ROOT } from './logPaths.js';

/**
 * Где установлен Hearthstone — чтобы не спрашивать игрока.
 *
 * Путь к логам жил константой `C:\Program Files (x86)\Hearthstone\Logs`
 * с пометкой «вынести в конфиг, когда появится CLI». Для одного игрока это
 * работало; у исполнителя игра стоит где угодно, а сообщение «логов
 * не нашлось, укажите --logs-root» он прочитать не сможет — у оверлея
 * и ключа такого нет, и стандартного вывода тоже (docs/live.md).
 *
 * Два источника, оба проверены на машине разработки 28.08:
 *
 * 1. Реестр. Инсталлятор Blizzard регистрирует игру в обычной ветке
 *    удаления программ, и там лежит `InstallLocation`:
 *
 *      HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Hearthstone
 *        InstallLocation    REG_SZ    C:\Program Files (x86)\Hearthstone
 *
 *    Ветки `Blizzard Entertainment` в HKLM/HKCU на той же машине нет —
 *    искать там нечего.
 *
 * 2. Перебор типичных каталогов по всем дискам — на случай, если реестр
 *    недоступен или запись снесена. Каталог считается игрой, только если
 *    в нём лежит `Hearthstone.exe`.
 *
 * Явный путь из настроек приложения стоит выше обоих: игрок, указавший
 * папку сам, знает лучше.
 */

export const UNINSTALL_KEY =
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hearthstone';
export const INSTALL_LOCATION_VALUE = 'InstallLocation';
export const GAME_EXE = 'Hearthstone.exe';
export const LOGS_DIR_NAME = 'Logs';

/** Где Battle.net обычно ставит игру, относительно корня диска. */
export const INSTALL_DIR_CANDIDATES: readonly string[] = [
  'Program Files (x86)\\Hearthstone',
  'Program Files\\Hearthstone',
  'Hearthstone',
  'Games\\Hearthstone',
  'Battle.net\\Hearthstone',
  'Blizzard\\Hearthstone',
];

export interface InstallProbe {
  /** Вывод `reg query <ключ> /v <значение>` или null, если запрос не удался. */
  readonly registryQuery: (key: string, value: string) => string | null;
  readonly exists: (path: string) => boolean;
  /** Корни дисков: `C:\`, `D:\`… */
  readonly drives: () => readonly string[];
}

/**
 * `reg query` печатает строку значения так:
 *
 *     InstallLocation    REG_SZ    C:\Program Files (x86)\Hearthstone
 *
 * Хвостовой `\r` съедает `\s*` перед концом строки.
 */
export function parseInstallLocation(output: string): string | null {
  const m = new RegExp(`${INSTALL_LOCATION_VALUE}\\s+REG_SZ\\s+(.+?)\\s*$`, 'm').exec(output);
  const value = m?.[1] ?? null;
  return value === null || value === '' ? null : value;
}

function queryRegistry(key: string, value: string): string | null {
  if (process.platform !== 'win32') return null;
  try {
    return execFileSync('reg', ['query', key, '/v', value], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Ключа нет (игра не установлена) либо `reg` недоступен — не ошибка.
    return null;
  }
}

function listDrives(): string[] {
  const drives: string[] = [];
  for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (existsSync(root)) drives.push(root);
  }
  return drives;
}

export function defaultInstallProbe(): InstallProbe {
  return { registryQuery: queryRegistry, exists: existsSync, drives: listDrives };
}

/** Каталог установки игры или null, если найти не удалось. */
export function findHearthstoneInstall(probe: InstallProbe = defaultInstallProbe()): string | null {
  const fromRegistry = parseInstallLocation(
    probe.registryQuery(UNINSTALL_KEY, INSTALL_LOCATION_VALUE) ?? '',
  );
  if (fromRegistry !== null && probe.exists(join(fromRegistry, GAME_EXE))) return fromRegistry;

  for (const drive of probe.drives()) {
    for (const candidate of INSTALL_DIR_CANDIDATES) {
      const dir = join(drive, candidate);
      if (probe.exists(join(dir, GAME_EXE))) return dir;
    }
  }
  return null;
}

export function logsRootOf(installDir: string): string {
  return join(installDir, LOGS_DIR_NAME);
}

/**
 * Каталог логов: явный путь → реестр → перебор → прежняя константа.
 *
 * Константа остаётся последней не из упрямства: с ней приложение хотя бы
 * скажет «логов не нашлось в C:\…» с конкретным путём, который игрок
 * может сверить, а не промолчит.
 */
export function detectLogsRoot(
  explicit: string | null = null,
  probe: InstallProbe = defaultInstallProbe(),
): string {
  if (explicit !== null && explicit !== '') return explicit;
  const install = findHearthstoneInstall(probe);
  return install === null ? DEFAULT_LOGS_ROOT : logsRootOf(install);
}
