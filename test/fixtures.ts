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
