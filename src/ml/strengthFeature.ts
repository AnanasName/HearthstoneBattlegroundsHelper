import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { BattleSimulator } from '../advisors/battle/simulator.js';
import type { FieldSnapshot } from '../advisors/strength/boards.js';
import {
  DEFAULT_FIELD_STRENGTH_OPTIONS,
  fieldStrengthQuestion,
  runFieldStrength,
  type FieldStrengthOptions,
} from '../advisors/strength/strength.js';
import { readTavernTurns, type TavernTurn } from '../advisors/tavern/turns.js';
import { CARDS_PATH } from '../app/paths.js';
import { readFixtureGame } from '../data/fixtureGames.js';
import { DATASET_DIR, type DatasetRecord } from '../dataset/recorder.js';
import { EMPTY_GLOBAL_INFO, type GameState } from '../state/types.js';
import type { DatasetGame } from './dataset.js';
import type { FeatureExtractor } from './evaluate.js';
import { extractHistoryFeatures, HISTORY_FEATURE_NAMES } from './historyFeatures.js';

/**
 * Сила стола как признак прогноза места — замер 6б (docs/ml.md).
 *
 * Ни один признак замеров 1–4 не меняется от ПОКУПКИ (урок 02.09).
 * Сила стола (D195) — доля выигранных боёв нашего борда против поля чужих
 * бордов того же хода таверны — первый кандидат, который покупку видит,
 * и её калибровка проверена на исходах настоящих боёв (`spike:strength`).
 * Здесь она берётся в ТОЧКЕ РЕШЕНИЯ, то есть по борду на входе в ход,
 * до покупок: на таком борде калибровка D195 не проверялась, и число
 * занижено (docs/quality.md, «Сила стола»). Замер спрашивает только,
 * несёт ли это число сигнал о месте.
 *
 * ## Три столбца
 *
 * `сила − 50`, «борд пуст» и «поле узкое». Сила молчит по двум разным
 * причинам: пустой борд (первый ход до покупки) и поздний ход, где в поле
 * меньше `minBoards` бордов. Обе причины — флаги СТАДИИ партии, которых
 * у модели замера 4 нет, поэтому база замера 6б — модель замера 4 с этими
 * двумя флагами (`indicatorExtractor`), и разность с ней мерит именно
 * значение силы, а не флаг «истории ещё нет».
 *
 * ## Счётчики боя — с обеих сторон пустые
 *
 * У бордов поля счётчиков `globalInfo` нет вовсе, а у записей датасета
 * они есть лишь у немногих свежих. Отдавать симулятору свои счётчики при
 * пустых чужих — односторонняя точность, которая хуже двусторонней
 * слепоты (D205). Поэтому в замере свои счётчики обнуляются.
 *
 * ## Своя партия не мерится об себя
 *
 * Поле собрано из боёв наших фикстур. Точка партии partN считается против
 * поля БЕЗ бордов partN (`excludePart`). Номер фикстуры у записи досбора —
 * в имени файла, у живой записи — по первой точке: билд, ход и витрина
 * (без героя и места — у part10, part44 и part46 они разошлись
 * с сегодняшним разбором). Неоднозначный отпечаток и запись без фикстуры
 * вне списка известных делают прогон недействительным (`measure6.ts`).
 *
 * ## Кэш
 *
 * Числа кладутся в `data/dataset/cache/ml6-strength.json` (вне git)
 * под ключом из всего, от чего они зависят (D154): содержимое точек
 * партии, номер фикстуры, снапшот поля, опции силы, снапшот карт, версия
 * пакета симулятора и коммит кода с признаком грязного дерева.
 */

export const STRENGTH_FEATURE_NAMES: readonly string[] = [
  ...HISTORY_FEATURE_NAMES,
  'сила стола − 50',
  'борд пуст',
  'поле узкое',
];

export const INDICATOR_FEATURE_NAMES: readonly string[] = [...HISTORY_FEATURE_NAMES, 'борд пуст', 'поле узкое'];

/** Сила точки: проценты или причина молчания. */
export type StrengthPoint = number | 'board' | 'field';

/** Два флага стадии: пустой борд, узкое поле. */
export function strengthIndicators(point: StrengthPoint): readonly number[] {
  return [point === 'board' ? 1 : 0, point === 'field' ? 1 : 0];
}

/** Три столбца силы: значение (0, если силы нет) и два флага. */
export function strengthColumns(point: StrengthPoint): readonly number[] {
  return [typeof point === 'number' ? point - 50 : 0, ...strengthIndicators(point)];
}

/** Признаки замера 4 плюс три столбца силы — модель B1. */
export function strengthExtractor(points: readonly StrengthPoint[]): FeatureExtractor {
  return (state, index, states) => [
    ...extractHistoryFeatures(state, index, states),
    ...strengthColumns(points[index] ?? 'field'),
  ];
}

/** Признаки замера 4 плюс только флаги — база B0 замера 6б. */
export function indicatorExtractor(points: readonly StrengthPoint[]): FeatureExtractor {
  return (state, index, states) => [
    ...extractHistoryFeatures(state, index, states),
    ...strengthIndicators(points[index] ?? 'field'),
  ];
}

/** Номер фикстуры у записи досбора: `backfill_part25_b248348_p3.json` → 25. */
export function partFromFileName(fileName: string): number | null {
  const m = /^backfill_part(\d+)_/.exec(fileName);
  return m === null ? null : Number(m[1]);
}

interface FirstPoint {
  readonly turn: number;
  readonly state: { readonly shop: readonly { readonly cardId: string }[] };
}

/** Отпечаток первой точки без героя и места: билд, ход, витрина. */
export function firstPointKey(build: number | null, first: FirstPoint | undefined): string {
  if (first === undefined) return '';
  const shop = first.state.shop
    .map((m) => m.cardId)
    .sort()
    .join(',');
  return [build ?? 'unknown', first.turn, shop].join('|');
}

export function recordKey(record: DatasetRecord): string {
  return firstPointKey(record.buildNumber, record.checkpoints[0]);
}

export interface FixtureIndex {
  /** Отпечаток первой точки → номер фикстуры; неоднозначные ключи сюда не входят. */
  readonly byKey: ReadonlyMap<string, number>;
  /** Отпечатки, которые дали две фикстуры и больше, с их номерами. */
  readonly ambiguous: ReadonlyMap<string, readonly number[]>;
  /** Фикстуры, у которых лога нет или нет ни одной точки решения. */
  readonly missing: readonly number[];
}

/** Первая точка решения фикстуры — разбор её лога целиком. */
export function fixtureFirstPoint(part: number): TavernTurn | undefined {
  const text = readFixtureGame(part);
  return text === null ? undefined : readTavernTurns(text)[0];
}

export function buildFixtureIndex(
  parts: readonly number[],
  firstOf: (part: number) => TavernTurn | undefined = fixtureFirstPoint,
): FixtureIndex {
  const found = new Map<string, number[]>();
  const missing: number[] = [];
  for (const part of parts) {
    const first = firstOf(part);
    if (first === undefined) {
      missing.push(part);
      continue;
    }
    const key = firstPointKey(first.state.buildNumber, first);
    found.set(key, [...(found.get(key) ?? []), part]);
  }
  const byKey = new Map<string, number>();
  const ambiguous = new Map<string, readonly number[]>();
  for (const [key, list] of found) {
    if (list.length === 1) byKey.set(key, list[0] ?? 0);
    else ambiguous.set(key, list);
  }
  return { byKey, ambiguous, missing };
}

/** Номер фикстуры партии датасета или `null` — сопоставить не с чем. */
export function partOfGame(game: DatasetGame, index: FixtureIndex): number | null {
  return partFromFileName(game.fileName) ?? index.byKey.get(recordKey(game.record)) ?? null;
}

/** Состояние, которое уходит в симулятор: свои счётчики боя обнулены (D205). */
export function symmetricState(state: GameState): GameState {
  return { ...state, globalInfo: EMPTY_GLOBAL_INFO };
}

/** Сила по каждой точке партии против поля без её собственных бордов. */
export function gameStrengths(
  game: DatasetGame,
  part: number | null,
  snapshot: FieldSnapshot,
  simulator: BattleSimulator,
  options: FieldStrengthOptions = DEFAULT_FIELD_STRENGTH_OPTIONS,
): StrengthPoint[] {
  return game.record.checkpoints.map((cp): StrengthPoint => {
    if (cp.state.board.length === 0) return 'board';
    const question = fieldStrengthQuestion(symmetricState(cp.state), snapshot, options, part);
    if (question === null) return 'field';
    return runFieldStrength(question, { simulator }, snapshot, options).percent;
  });
}

export const STRENGTH_CACHE_PATH = join(DATASET_DIR, 'cache', 'ml6-strength.json');

interface CacheEntry {
  readonly key: string;
  readonly points: readonly StrengthPoint[];
}

interface CacheFile {
  readonly version: 2;
  readonly fixtureIndex: {
    readonly parts: readonly number[];
    readonly byKey: Record<string, number>;
    readonly ambiguous: Record<string, readonly number[]>;
  } | null;
  readonly games: Record<string, CacheEntry>;
}

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

/** Отпечаток содержимого точек партии — пересобранная запись с тем же именем даст другой. */
export function checkpointsHash(record: DatasetRecord): string {
  return sha1(JSON.stringify(record.checkpoints));
}

/**
 * Всё, от чего зависит сила точки, кроме самой точки и номера партии.
 * `codeStamp` — коммит кода и признак грязного дерева: маппер боя правят
 * соседние сессии, и старое число после такой правки отдавать нельзя.
 */
export function strengthStamp(
  snapshot: FieldSnapshot,
  options: FieldStrengthOptions,
  codeStamp: string,
  simulatorVersion: string,
  cardsPath: string = CARDS_PATH,
): string {
  const cards = existsSync(cardsPath) ? statSync(cardsPath) : null;
  return [
    snapshot.builtAt,
    sha1(JSON.stringify(snapshot.boards)),
    options.simulations,
    options.minBoards,
    options.seed,
    cards === null ? 'no-cards' : `${String(cards.size)}@${String(cards.mtimeMs)}`,
    simulatorVersion,
    codeStamp,
  ].join('|');
}

export class StrengthCache {
  readonly #path: string;
  /** Пересчитать всё, не глядя в кэш: и силу, и индекс фикстур. */
  readonly #fresh: boolean;
  #file: CacheFile;

  constructor(path: string = STRENGTH_CACHE_PATH, fresh = false) {
    this.#path = path;
    this.#fresh = fresh;
    const stored = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { version?: number }) : null;
    this.#file =
      stored?.version === 2 ? (stored as CacheFile) : { version: 2, fixtureIndex: null, games: {} };
  }

  fixtureIndex(parts: readonly number[], build: () => FixtureIndex): FixtureIndex {
    const cached = this.#file.fixtureIndex;
    if (!this.#fresh && cached !== null && cached.parts.join(',') === parts.join(',')) {
      return {
        byKey: new Map(Object.entries(cached.byKey)),
        ambiguous: new Map(Object.entries(cached.ambiguous)),
        missing: [],
      };
    }
    const index = build();
    // Индекс без части логов не кэшируется: вернувшийся лог обязан
    // попасть в следующий индекс, а не остаться «без фикстуры» навсегда.
    if (index.missing.length === 0) {
      this.#file = {
        ...this.#file,
        fixtureIndex: {
          parts: [...parts],
          byKey: Object.fromEntries(index.byKey),
          ambiguous: Object.fromEntries(index.ambiguous),
        },
      };
      this.#save();
    }
    return index;
  }

  strengths(
    game: DatasetGame,
    part: number | null,
    stamp: string,
    compute: () => StrengthPoint[],
  ): readonly StrengthPoint[] {
    const key = [stamp, part ?? 'no-part', checkpointsHash(game.record)].join('|');
    const hit = this.#file.games[game.fileName];
    if (!this.#fresh && hit?.key === key) return hit.points;
    const points = compute();
    this.#file = { ...this.#file, games: { ...this.#file.games, [game.fileName]: { key, points } } };
    this.#save();
    return points;
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify(this.#file), 'utf8');
  }
}
