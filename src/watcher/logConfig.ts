import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Включение записи Power.log.
 *
 * Второй из двух конфигов, и путать их легко: этот лежит в `%LOCALAPPDATA%`
 * и решает, ЧТО логировать, а `client.config` — в каталоге игры и решает,
 * до какого размера. Без первого файла не будет вовсе, без второго он
 * оборвётся на десяти мегабайтах.
 *
 * Проверять при каждом запуске стоит оба: этот переживает обновление игры,
 * но его сносит переустановка и правит кто угодно.
 */

export const LOG_CONFIG_NAME = 'log.config';

/** Канал, ради которого всё и затевалось. */
export const POWER_SECTION = 'Power';

export interface LogConfigStatus {
  readonly path: string;
  readonly exists: boolean;
  /** Пишется ли канал Power в файл. */
  readonly powerToFile: boolean;
}

/**
 * Путь к log.config.
 *
 * `%LOCALAPPDATA%\Blizzard\Hearthstone\log.config`. Каталог берётся из
 * окружения, а не собирается из имени пользователя: на нестандартных
 * установках Windows он не там, где ожидается.
 */
export function logConfigPath(localAppData: string | undefined = process.env['LOCALAPPDATA']): string {
  const root = localAppData ?? join(process.env['USERPROFILE'] ?? '.', 'AppData', 'Local');
  return join(root, 'Blizzard', 'Hearthstone', LOG_CONFIG_NAME);
}

/**
 * Значение ключа в секции. Формат тот же, что у client.config: строки
 * `ключ=значение`, заголовки `[Секция]`, комментарии с `;`.
 */
export function readSectionKey(text: string, section: string, key: string): string | null {
  let current = '';

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';')) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      current = line.slice(1, -1).trim();
      continue;
    }

    const eq = line.indexOf('=');
    if (eq < 0) continue;
    if (current !== section) continue;
    if (line.slice(0, eq).trim() !== key) continue;

    return line.slice(eq + 1).trim();
  }

  return null;
}

export function inspectLogConfig(path: string = logConfigPath()): LogConfigStatus {
  if (!existsSync(path)) return { path, exists: false, powerToFile: false };

  const value = readSectionKey(readFileSync(path, 'utf8'), POWER_SECTION, 'FilePrinting');
  return { path, exists: true, powerToFile: value?.toLowerCase() === 'true' };
}

/**
 * Секция Power, дописываемая, если её нет.
 *
 * `Verbose` проверен на двух партиях и на содержимое Power.log не влияет;
 * оставлен как заведомо рабочее значение. `TruncatePos` — не размер файла,
 * а предел длины одного сообщения: без него длинные строки `FULL_ENTITY`
 * режутся. Подробности в docs/power-log.md.
 */
const POWER_BLOCK = [
  '[Power]',
  'FilePrinting=true',
  'ConsolePrinting=false',
  'ScreenPrinting=false',
  'Verbose=true',
  'TruncatePos=200000',
  '',
].join('\r\n');

/**
 * Включает запись Power.log, если она выключена.
 *
 * Возвращает true, если файл менялся — тогда нужен перезапуск клиента:
 * log.config читается один раз при старте.
 *
 * В отличие от client.config файл НЕ переписывается целиком: в нём живут
 * секции других каналов, и сносить чужие настройки мы права не имеем.
 * Добавляется только своя секция.
 */
export function ensurePowerLogging(path: string = logConfigPath()): boolean {
  const status = inspectLogConfig(path);
  if (status.powerToFile) return false;

  if (!status.exists) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, POWER_BLOCK, 'utf8');
    return true;
  }

  const text = readFileSync(path, 'utf8');
  const hasSection = /^\s*\[Power\]\s*$/m.test(text);
  if (!hasSection) {
    const separator = text.endsWith('\n') ? '' : '\r\n';
    writeFileSync(path, `${text}${separator}\r\n${POWER_BLOCK}`, 'utf8');
    return true;
  }

  // Секция есть, но печать в файл выключена — правим только эту строку.
  const fixed = replaceInSection(text, POWER_SECTION, 'FilePrinting', 'true');
  writeFileSync(path, fixed, 'utf8');
  return true;
}

function replaceInSection(text: string, section: string, key: string, value: string): string {
  const lines = text.split(/\r?\n/);
  let current = '';
  let inserted = false;

  const out = lines.map((raw) => {
    const line = raw.trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim();
      // Секция кончилась, а ключа в ней не было — дописываем перед следующей.
      if (current === section && !inserted) {
        inserted = true;
        current = name;
        return `${key}=${value}\r\n${raw}`;
      }
      current = name;
      return raw;
    }

    if (current === section && line.startsWith(`${key}=`)) {
      inserted = true;
      return `${key}=${value}`;
    }
    return raw;
  });

  return (inserted ? out : [...out, `${key}=${value}`]).join('\r\n');
}
