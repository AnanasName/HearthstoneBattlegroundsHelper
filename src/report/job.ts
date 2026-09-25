import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { BattleSimulator } from '../advisors/battle/simulator.js';
import type { FieldSnapshot } from '../advisors/strength/boards.js';
import type { CardIndex } from '../data/cards.js';
import { passportOf, type GamePassport } from '../ui/passport.js';
import { buildPostGameReport } from './build.js';
import { reportFileBase, writeReport, type WrittenReport } from './store.js';
import { REPORT_SCHEMA } from './types.js';

/**
 * Разбор партии из файла лога — общий для терминала и приложения.
 *
 * Приложение зовёт его в отдельном потоке после конца партии (`worker.ts`),
 * терминал — напрямую (`npm run postgame`). В одной сессии клиента партий
 * бывает несколько (part64 и part65 — один лог на 133 МБ), а за долгий
 * вечер сессия дорастает до гигабайта (`client.config` разрешает столько):
 * строкой такой файл не прочитать — предел строки V8 около 512 млн
 * символов (ревью: `ERR_STRING_TOO_LONG` на седьмой партии). Поэтому
 * партии режутся по БАЙТАМ, и в строку превращается только выбранная.
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

/** Байты лога: `Power.log`, живая копия `.Power.log.part`, архив `.gz`, папка сессии. */
export function readLogBytes(path: string): { readonly bytes: Buffer; readonly file: string } {
  const file = existsSync(path) && statSync(path).isDirectory() ? join(path, 'Power.log') : path;
  const raw = readFileSync(file);
  return { bytes: file.endsWith('.gz') ? gunzipSync(raw) : raw, file };
}

/**
 * Начало партии — строка канала-источника `CREATE_GAME` на верхнем уровне,
 * то же правило, что у `splitGames` (dataset/import.ts). В `PowerTaskList`
 * то же слово дублируется — его не считаем.
 */
const CREATE_GAME = Buffer.from('GameState.DebugPrintPower() - CREATE_GAME');

export interface GameRangeBytes {
  /** Номер партии в файле, с единицы: от последующих партий не меняется. */
  readonly index: number;
  readonly from: number;
  readonly to: number;
}

export function gameByteRanges(bytes: Buffer): GameRangeBytes[] {
  const starts: number[] = [];
  let at = bytes.indexOf(CREATE_GAME);
  while (at >= 0) {
    const end = at + CREATE_GAME.length;
    const next = bytes[end];
    // Строка кончается сразу после слова (иногда с пробелом) — не «CREATE_GAME_…».
    if (next === undefined || next === 0x0d || next === 0x0a || next === 0x20) {
      starts.push(bytes.lastIndexOf(0x0a, at) + 1);
    }
    at = bytes.indexOf(CREATE_GAME, end);
  }
  if (starts.length === 0) return bytes.length === 0 ? [] : [{ index: 1, from: 0, to: bytes.length }];
  return starts.map((from, i) => ({ index: i + 1, from, to: starts[i + 1] ?? bytes.length }));
}

export interface PickedGame {
  readonly text: string;
  readonly index: number;
  readonly total: number;
  readonly passport: GamePassport;
}

/**
 * Какую партию разбирать: названную номером или последнюю доигранную
 * партию Battlegrounds, а если доигранной нет — последнюю Battlegrounds.
 * Партия другого режима не берётся никогда: лента прочла бы ману как
 * золото (ревью: сессия 24.09 01:35 с одной рейтинговой партией).
 * Кандидаты перебираются с конца — обычно в строку превращается одна.
 */
export function pickGame(bytes: Buffer, wanted: number | null = null): PickedGame | null {
  const ranges = gameByteRanges(bytes);
  const read = (r: GameRangeBytes): PickedGame => {
    const text = bytes.toString('utf8', r.from, r.to);
    return { text, index: r.index, total: ranges.length, passport: passportOf(text, { index: r.index, from: 0, to: text.length }) };
  };
  if (wanted !== null) {
    const r = ranges.find((x) => x.index === wanted);
    return r === undefined ? null : read(r);
  }
  let fallback: PickedGame | null = null;
  for (const r of [...ranges].reverse()) {
    const game = read(r);
    if (!game.passport.battlegrounds) continue;
    if (game.passport.finished) return game;
    fallback ??= game;
  }
  return fallback;
}

const SESSION_RE = /Hearthstone_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})/;

/** Имя сессии из пути — ради имени отчёта: `Power.log` одинаков у всех сессий. */
export function sessionRefOf(path: string): string {
  return SESSION_RE.exec(path)?.[0] ?? basename(path);
}

/**
 * Дата партии `ГГГГ-ММ-ДД`: в логе даты нет, есть имя сессии — дата
 * и часы ЗАПУСКА клиента. Партия, начатая по часам раньше запуска,
 * идёт уже на следующие сутки (ревью: клиент с 23:05, партия в 00:40 —
 * иначе «вчерашняя» дата, и индекс ставил свежую партию ниже).
 */
export function sessionDateOf(path: string, gameStart: string | null = null): string | null {
  const m = SESSION_RE.exec(path);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d));
  const clock = /^(\d{2}):(\d{2}):(\d{2})/.exec(gameStart ?? '');
  if (clock !== null) {
    const game = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
    if (game < h * 3600 + mi * 60 + s) date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString().slice(0, 10);
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
  | {
      readonly kind: 'written';
      readonly written: WrittenReport;
      readonly facts: number;
      readonly assumptions: number;
      readonly place: number | null;
    }
  | { readonly kind: 'exists'; readonly htmlPath: string }
  | { readonly kind: 'none'; readonly reason: string };

export interface ReportJobDeps {
  readonly cards: CardIndex;
  readonly simulator: BattleSimulator;
  readonly field: FieldSnapshot | null;
}

export async function runReportJob(request: ReportJobRequest, deps: ReportJobDeps): Promise<ReportJobResult> {
  const { bytes, file } = readLogBytes(request.path);
  const picked = pickGame(bytes);
  if (picked === null) return { kind: 'none', reason: 'в логе нет партии Battlegrounds' };

  // Номер партии в имени — всегда: он не зависит от того, сколько партий
  // успело лечь в файл после этой. Условный номер («только если партий
  // больше одной») давал одной партии два имени, и индекс считал её дважды.
  const ref = sessionRefOf(file);
  const gameIndex = picked.index;
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

  const report = await buildPostGameReport(picked.text, deps, {
    ref,
    gameIndex,
    date: sessionDateOf(file, picked.passport.start),
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
 * Ищется в байтах, без перевода в строку: первая порция после старта
 * приложения — весь файл сессии, и строкой он может не поместиться.
 * Порция приходит произвольной границей, поэтому хвост прошлой порции
 * склеивается со следующей.
 */
const GAME_OVER = Buffer.from('tag=STEP value=FINAL_GAMEOVER');
const SOURCE_PREFIX = Buffer.from('GameState.DebugPrintPower()');
const CARRY = 256;

export function createGameOverWatch(): { push(chunk: Buffer | string): boolean } {
  let tail = Buffer.alloc(0);
  return {
    push(chunk) {
      const data = Buffer.concat([tail, typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk]);
      let found = -1;
      let at = data.indexOf(GAME_OVER);
      while (at >= 0) {
        const lineStart = data.lastIndexOf(0x0a, at) + 1;
        if (data.subarray(lineStart, at).includes(SOURCE_PREFIX)) found = at;
        at = data.indexOf(GAME_OVER, at + GAME_OVER.length);
      }
      // Хвост берётся ПОСЛЕ найденной строки: иначе та же строка, оставшись
      // в хвосте, сработала бы второй раз на следующей порции.
      const rest = found < 0 ? data : data.subarray(found + GAME_OVER.length);
      tail = Buffer.from(rest.subarray(Math.max(0, rest.length - CARRY)));
      return found >= 0;
    },
  };
}
