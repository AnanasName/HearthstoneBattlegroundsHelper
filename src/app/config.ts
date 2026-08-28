import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { CONFIG_PATH } from './paths.js';

/**
 * Настройки приложения — две штуки, и обе про то, что нельзя вывести.
 *
 * `overlay` — показывать ли советы. Сборщик логов идёт всегда; оверлей
 * у исполнителя выключен по умолчанию: он требует оконного режима игры,
 * свежего снапшота карт и, главное, меняет то, что мы собираем, — партия
 * по подсказкам это не «как играют люди» (docs/ml.md). Флаг пишется
 * в метаданные каждой архивной сессии.
 *
 * `logsRoot` — папка логов игры, если игрок указал её сам; null — искать
 * (`watcher/installDir.ts`).
 *
 * Незнакомые ключи и битый файл не роняют приложение: умолчания.
 */

export interface AppConfig {
  readonly overlay: boolean;
  readonly logsRoot: string | null;
}

export const DEFAULT_CONFIG: AppConfig = { overlay: false, logsRoot: null };

export function loadConfig(path: string = CONFIG_PATH): AppConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_CONFIG;
    const raw = parsed as Record<string, unknown>;
    return {
      overlay: typeof raw['overlay'] === 'boolean' ? raw['overlay'] : DEFAULT_CONFIG.overlay,
      logsRoot:
        typeof raw['logsRoot'] === 'string' && raw['logsRoot'] !== '' ? raw['logsRoot'] : DEFAULT_CONFIG.logsRoot,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: AppConfig, path: string = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
