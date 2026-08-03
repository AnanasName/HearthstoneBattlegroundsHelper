import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Настройка предела размера логов Hearthstone.
 *
 * По умолчанию клиент обрывает файловое логирование на 10000 КБ и больше его
 * не возобновляет, а полная партия Battlegrounds столько не влезает. Предел
 * читается из client.config при старте клиента:
 *
 *   Log.Initialize
 *     -> Log.PopulateLogSessionConfigOptions
 *          ConfigFile.FullLoad(PlatformFilePaths.GetClientConfigPath())
 *          ConfigFile.Get("Log.FileSizeLimit.Int", 10000)
 *          LogSessionConfig.set_MaxFileSizeKilobytes(...)
 *
 * Файл лежит рядом с игрой, а НЕ в AppData — в отличие от log.config.
 * Подтверждено экспериментом, см. docs/power-log.md.
 */

export const CLIENT_CONFIG_NAME = 'client.config';

/** Полный ключ, который ищет клиент: секция `[Log]` плюс имя `FileSizeLimit.Int`. */
export const FILE_SIZE_LIMIT_KEY = 'Log.FileSizeLimit.Int';

/** Значение клиента по умолчанию, в килобайтах. */
export const DEFAULT_LIMIT_KB = 10_000;

/**
 * Наш предел: около гигабайта, то есть практически без ограничения, но с защитой
 * от бесконечного роста файла.
 *
 * Отрицательное значение формально тоже отключает лимит
 * (`MayLimitMaxFileSize = MaxFileSizeKilobytes > -1`), но разбор значения идёт
 * через самописный `TryParseInt` с фолбэком в 0, а 0 включает лимит нулевого
 * размера. Большое положительное значение даёт тот же эффект без этого риска.
 */
export const DESIRED_LIMIT_KB = 1_000_000;

export interface ClientConfigStatus {
  readonly path: string;
  readonly exists: boolean;
  /** Действующий предел в килобайтах: из файла либо клиентский дефолт. */
  readonly limitKb: number;
  /** Хватит ли предела на полную партию. */
  readonly sufficient: boolean;
}

export function clientConfigPath(installDir: string): string {
  return join(installDir, CLIENT_CONFIG_NAME);
}

/**
 * Разбирает client.config так же, как это делает клиент: строки `ключ=значение`,
 * заголовки секций `[Секция]`, комментарии с `;`. Полный ключ склеивается из
 * имени секции и имени ключа через точку, поэтому оба варианта записи равносильны:
 * `[Log]` + `FileSizeLimit.Int=…` и плоское `Log.FileSizeLimit.Int=…`.
 */
export function readLimitKb(text: string): number | null {
  let section = '';

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';')) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim();
      continue;
    }

    const eq = line.indexOf('=');
    if (eq < 0) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    const fullKey = section === '' ? key : `${section}.${key}`;
    if (fullKey !== FILE_SIZE_LIMIT_KEY) continue;

    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

/**
 * Что сейчас с настройкой. Отсутствие файла — это не ошибка, а действующий
 * дефолт клиента в 10000 КБ.
 */
export function inspectClientConfig(installDir: string): ClientConfigStatus {
  const path = clientConfigPath(installDir);
  if (!existsSync(path)) {
    return { path, exists: false, limitKb: DEFAULT_LIMIT_KB, sufficient: false };
  }

  const limit = readLimitKb(readFileSync(path, 'utf8'));
  const limitKb = limit ?? DEFAULT_LIMIT_KB;
  return {
    path,
    exists: true,
    limitKb,
    sufficient: limitKb < 0 || limitKb >= DESIRED_LIMIT_KB,
  };
}

/**
 * Прописывает нужный предел, если он ещё не выставлен.
 *
 * Возвращает true, если файл был изменён — тогда нужен перезапуск клиента:
 * предел читается один раз при старте.
 *
 * Файл переписывается целиком: посторонних ключей в нём у нас не бывает,
 * а обновление игры может снести его вместе с каталогом установки, поэтому
 * проверку стоит делать при каждом запуске приложения.
 */
export function ensureLogSizeLimit(installDir: string): boolean {
  const status = inspectClientConfig(installDir);
  if (status.sufficient) return false;

  writeFileSync(
    status.path,
    `[Log]\r\n${FILE_SIZE_LIMIT_KEY.split('.').slice(1).join('.')}=${String(DESIRED_LIMIT_KB)}\r\n`,
    'utf8',
  );
  return true;
}
