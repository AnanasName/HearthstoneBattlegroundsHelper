import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { BattleSimulator } from '../advisors/battle/simulator.js';
import type { FieldSnapshot } from '../advisors/strength/boards.js';
import type { CardIndex } from '../data/cards.js';
import { passportsOf, type GamePassport } from '../ui/passport.js';
import { buildPostGameReport } from './build.js';
import { reportFileBase, writeReport, type WrittenReport } from './store.js';
import { REPORT_SCHEMA } from './types.js';

/**
 * Разбор партии из файла лога — общий для терминала и приложения.
 *
 * Приложение зовёт его в отдельном потоке после конца партии (`worker.ts`),
 * терминал — напрямую (`npm run postgame`). Партия выбирается по паспортам
 * (`passportsOf`): в одной сессии клиента их бывает несколько (part64 и
 * part65 — один лог на 133 МБ), а разбирать надо последнюю доигранную.
 */

/**
 * Версия пакета симулятора — в шапку анализа отчёта: после её смены
 * числа боёв сдвигаются, и тренд через разные версии строить нельзя.
 */
export function simulatorVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return (require('@firestone-hs/simulate-bgs-battle/package.json') as { version: string }).version;
  } catch {
    return null;
  }
}

/** Текст лога: `Power.log`, живая копия `.Power.log.part`, архив `.gz`, папка сессии. */
export function readLogText(path: string): { readonly text: string; readonly file: string } {
  const file = existsSync(path) && statSync(path).isDirectory() ? join(path, 'Power.log') : path;
  const raw = readFileSync(file);
  return { text: file.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8'), file };
}

const SESSION_RE = /Hearthstone_(\d{4})_(\d{2})_(\d{2})(?:_\d{2}){3}/;

/** Имя сессии из пути — ради имени отчёта: `Power.log` одинаков у всех сессий. */
export function sessionRefOf(path: string): string {
  return SESSION_RE.exec(path)?.[0] ?? basename(path);
}

/** Дата партии `ГГГГ-ММ-ДД` из имени сессии; в самом логе даты нет. */
export function sessionDateOf(path: string): string | null {
  const m = SESSION_RE.exec(path);
  return m === null ? null : `${m[1] ?? ''}-${m[2] ?? ''}-${m[3] ?? ''}`;
}

/**
 * Какую партию разбирать: названную номером или последнюю доигранную
 * партию Battlegrounds. Недоигранная берётся, только если другой нет.
 */
export function pickGame(text: string, wanted: number | null = null): {
  readonly passport: GamePassport;
  readonly total: number;
} | null {
  const passports = passportsOf(text);
  const passport =
    wanted !== null
      ? passports.find((p) => p.index === wanted)
      : (passports.filter((p) => p.battlegrounds && p.finished).at(-1) ?? passports.at(-1));
  return passport === undefined ? null : { passport, total: passports.length };
}

export interface ReportJobRequest {
  readonly path: string;
  readonly outDir: string;
  readonly generatedAt: string;
  readonly appVersion: string | null;
  /** Не пересобирать, если отчёт этой партии уже лежит (догон при старте видит старый конец партии). */
  readonly skipExisting: boolean;
}

export type ReportJobResult =
  | { readonly kind: 'written'; readonly written: WrittenReport; readonly facts: number; readonly assumptions: number; readonly place: number | null }
  | { readonly kind: 'exists'; readonly htmlPath: string }
  | { readonly kind: 'none'; readonly reason: string };

export interface ReportJobDeps {
  readonly cards: CardIndex;
  readonly simulator: BattleSimulator;
  readonly field: FieldSnapshot | null;
}

export async function runReportJob(request: ReportJobRequest, deps: ReportJobDeps): Promise<ReportJobResult> {
  const { text } = readLogText(request.path);
  const picked = pickGame(text);
  if (picked === null) return { kind: 'none', reason: 'в логе нет партии' };
  const { passport, total } = picked;
  if (!passport.battlegrounds) return { kind: 'none', reason: 'последняя партия — не Battlegrounds' };

  const ref = sessionRefOf(request.path);
  const gameIndex = total > 1 ? passport.index : null;
  const base = reportFileBase({ ref, gameIndex });
  const jsonPath = join(request.outDir, `${base}.json`);
  if (request.skipExisting && existsSync(jsonPath)) {
    try {
      const old = JSON.parse(readFileSync(jsonPath, 'utf8')) as { schema?: number };
      if (old.schema === REPORT_SCHEMA) return { kind: 'exists', htmlPath: join(request.outDir, `${base}.html`) };
    } catch {
      // битый JSON — пересобрать
    }
  }

  const report = await buildPostGameReport(text.slice(passport.from, passport.to), deps, {
    ref,
    gameIndex,
    date: sessionDateOf(request.path),
    excludePart: null,
    generatedAt: request.generatedAt,
    appVersion: request.appVersion,
    simulatorVersion: simulatorVersion(),
  });
  const written = writeReport(report, request.outDir);
  return {
    kind: 'written',
    written,
    facts: report.facts.length,
    assumptions: report.assumptions.length,
    place: report.game.place,
  };
}

/**
 * Конец партии в дописанных байтах лога: строка канала-источника
 * `STEP value=FINAL_GAMEOVER` (part72:228011, part73:603537). Строка
 * `PowerTaskList` дублирует её позже — её не ждём, отчёт читает источник.
 *
 * Порция приходит произвольной границей, поэтому хвост прошлой порции
 * склеивается со следующей.
 */
export function createGameOverWatch(): { push(chunk: Buffer | string): boolean } {
  const MARK = /GameState\.DebugPrintPower\(\) -\s+TAG_CHANGE Entity=GameEntity tag=STEP value=FINAL_GAMEOVER/;
  const CARRY = 160;
  let tail = '';
  return {
    push(chunk) {
      const text = tail + (typeof chunk === 'string' ? chunk : chunk.toString('latin1'));
      const hit = MARK.exec(text);
      // Хвост берётся ПОСЛЕ найденной строки: иначе та же строка, оставшись
      // в хвосте, сработала бы второй раз на следующей порции.
      tail = (hit === null ? text : text.slice(hit.index + hit[0].length)).slice(-CARRY);
      return hit !== null;
    },
  };
}
