import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { splitLogLines } from '../src/parser/logLine.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Корень с фикстурами: реальные Power.log, снятые с игры. */
export const FIXTURES_DIR = join(here, '..', 'data', 'fixtures');

/**
 * Партия 1 — полная партия Battlegrounds от выбора героя до финального места,
 * снятая 03.08.2026 в четыре приёма через перезапуск клиента посреди игры
 * (обход предела 10000 КБ, см. docs/power-log.md).
 */
export function part1Segment(n: 1 | 2 | 3 | 4): string {
  return readFileSync(join(FIXTURES_DIR, 'part1', `segment${String(n)}.log`), 'utf8');
}

/** Строки сегмента. Разбиение через splitLogLines — в логе смешаны CRLF и LF. */
export function part1SegmentLines(n: 1 | 2 | 3 | 4): string[] {
  return splitLogLines(part1Segment(n));
}

/**
 * Партия 2 — эталонная: полная партия Battlegrounds одним файлом, без
 * переподключений и без провалов. 41 МБ, 301 289 строк, 23 минуты.
 * Снята после снятия предела размера логов через client.config.
 */
export function part2Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part2', 'game.log'), 'utf8');
}

/**
 * Партия 3 — снята вместе со скриншотами игрока, поэтому её контрольные точки
 * проверены изображением, а не памятью. Скриншоты в data/screenshots/.
 */
export function part3Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part3', 'game.log'), 'utf8');
}
