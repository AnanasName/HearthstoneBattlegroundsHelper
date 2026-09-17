import { createHash } from 'node:crypto';

import type { FieldSnapshot } from '../advisors/strength/boards.js';
import { tavernTurnOf } from '../advisors/tavern/rules.js';
import { createRng, summarize } from '../advisors/tavern/statAnalysis.js';
import type { DatasetGame } from './dataset.js';
import { pairedDeltas, signFlipQuantiles, type GameEval } from './evaluate.js';
import type { RidgeModel } from './ridge.js';

/**
 * Замер 6 фазы 6 — всё, что решает вердикт и годность, отдельно
 * от печати (`report6.ts`), чтобы это держали тесты. Условия — дословно
 * по предрегистрации docs/ml.md («Замер 6»).
 */

export const BAND_ITERATIONS = 10_000;
/** Две основные гипотезы — хвост 2.5 % вместо 5 % (Бонферрони). */
export const TAIL = 0.025;
/** МРЭ основных разностей — 1.96 стандартной ошибки, та же поправка. */
export const MDE_Z = 1.96;
/** МРЭ условий замера 4 (предварительное условие 6б) — как в замере 4. */
export const MDE_Z_M4 = 1.645;
/** Урок замера 4: порог утечки отрицательного контроля — 0.05 места. */
export const CONTROL_LEAK_THRESHOLD = 0.05;

export const SEED = {
  bandA: 20260917,
  controlA: 20260918,
  bandB: 20260919,
  controlB: 20260920,
  tableB: 20260921,
  b2B: 20260922,
} as const;

/**
 * Записи без фикстуры — партии, у которых нет лога. Их бордов в поле нет,
 * и считать их против полного поля честно. Любая ДРУГАЯ несопоставленная
 * запись — возможная утечка своих бордов, и прогон 6б недействителен.
 */
export const EXPECTED_UNMAPPED: readonly string[] = [
  '2026-08-28T14-43-31_b250339_p3.json',
  'own_2026-08-29T12-16-53_g1_b250339_p7.json',
];

/**
 * Двойники фикстур, которые дедуп по отпечатку не сводит (найдено
 * проверкой сопоставления 17.09, до прогона). Живая запись → запись
 * досбора той же партии, которая остаётся:
 *
 *  - part31: живая запись 27.08 хранит 7-е место, лог и `expected.json` —
 *    6-е; отпечаток включает место, поэтому пара не сводилась;
 *  - part35 и part41: обрывочные живые записи после перезапуска клиента
 *    (три точки с хода 21 и 25). 05.09 их сочли отдельными партиями,
 *    но в LOGO двойник отложенной партии остаётся в обучении с тем же
 *    исходом — это утечка.
 */
export const KNOWN_DUPLICATES: Readonly<Record<string, string>> = {
  '2026-08-27T18-49-39_b250339_p7.json': 'backfill_part31_b250339_p6.json',
  '2026-08-28T15-17-40_b250339_p5.json': 'backfill_part35_b250339_p5.json',
  '2026-09-04T22-42-32_b250339_p3.json': 'backfill_part41_b250339_p3.json',
};

/** Больше миньонов на борду не бывает. */
const MAX_BOARD = 7;

/**
 * Выборка замера 6 из выборки замеров 3–4: без двойников и без точек,
 * которых не бывает (борд больше семи миньонов — след склейки сегментов
 * part35 и part41: миньоны первого сегмента остаются на столе после
 * шва). Такие точки — последние в своих партиях, поэтому окна истории
 * у оставшихся точек не меняются.
 */
export function measure6Sample(games: readonly DatasetGame[]): {
  readonly games: readonly DatasetGame[];
  readonly dropped: readonly string[];
} {
  const dropped: string[] = [];
  const present = new Set(games.map((g) => g.fileName));
  const out: DatasetGame[] = [];
  for (const g of games) {
    const twin = KNOWN_DUPLICATES[g.fileName];
    if (twin !== undefined && present.has(twin)) {
      dropped.push(`двойник ${g.fileName} (остаётся ${twin})`);
      continue;
    }
    const checkpoints = g.record.checkpoints.filter((cp) => cp.state.board.length <= MAX_BOARD);
    if (checkpoints.length !== g.record.checkpoints.length) {
      const turns = g.record.checkpoints.filter((cp) => cp.state.board.length > MAX_BOARD).map((cp) => cp.turn);
      dropped.push(`${g.fileName}: точки ходов ${turns.join(', ')} — борд больше ${String(MAX_BOARD)}`);
    }
    if (checkpoints.length === 0) continue;
    out.push(checkpoints.length === g.record.checkpoints.length ? g : { ...g, record: { ...g.record, checkpoints } });
  }
  return { games: out, dropped };
}

/**
 * Поправки меток, известные ДО прогона: живая запись part44 сделана
 * до D235 и хранит 6-е место, а лог, разбор и `part44.expected.json`
 * дают 5-е (перезамер 17.09). Поправка — в памяти; файл датасета
 * не трогается.
 */
export const LABEL_CORRECTIONS: Readonly<Record<string, number>> = {
  '2026-09-06T10-20-08_b250339_p6.json': 5,
};

export function applyLabelCorrections(games: readonly DatasetGame[]): {
  readonly games: readonly DatasetGame[];
  readonly applied: readonly string[];
} {
  const applied: string[] = [];
  const out = games.map((g) => {
    const place = LABEL_CORRECTIONS[g.fileName];
    if (place === undefined || place === g.finalPlace) return g;
    applied.push(`${g.fileName}: ${String(g.finalPlace)} → ${String(place)}`);
    return { ...g, finalPlace: place, record: { ...g.record, finalPlace: place } };
  });
  return { games: out, applied };
}

/**
 * Числа перезамера 17.09 на тех же 57 партиях (вывод `ml:eval3`
 * и `ml:eval4`): прибор 6 обязан их воспроизвести ДО поправок меток,
 * иначе он считает не то же, что прежние замеры.
 */
export interface ReproTarget {
  readonly mae: number;
  readonly dTable: number;
  readonly d2: number;
}

export const REPRODUCE_17_09: { readonly m3: ReproTarget; readonly m4: ReproTarget } = {
  m3: { mae: 1.677, dTable: 0.439, d2: 0.05 },
  m4: { mae: 1.629, dTable: 0.487, d2: 0.098 },
};

export function reproduces(actual: ReproTarget, expected: ReproTarget): boolean {
  const close = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;
  return close(actual.mae, expected.mae) && close(actual.dTable, expected.dTable) && close(actual.d2, expected.d2);
}

/** Отпечаток выборки: имена, число точек и места — порядок не важен. */
export function sampleFingerprint(games: readonly DatasetGame[]): string {
  const lines = games
    .map((g) => `${g.fileName}:${String(g.record.checkpoints.length)}:${String(g.finalPlace)}`)
    .sort();
  return createHash('sha1').update(lines.join('\n')).digest('hex');
}

export interface MappingFacts {
  /** Партии выборки без фикстуры. */
  readonly unmapped: readonly string[];
  /** Номер фикстуры → записи, которым он достался. */
  readonly byPart: ReadonlyMap<number, readonly string[]>;
  /** Записи выборки, чей отпечаток дали две фикстуры и больше. */
  readonly ambiguous: readonly string[];
  /** Сопоставленные фикстуры, чьих бордов нет в поле. */
  readonly notInField: readonly number[];
  /** Фикстуры без лога при построении индекса. */
  readonly missingLogs: readonly number[];
}

/** Причины, по которым прогон 6б недействителен; пустой список — годен. */
export function mappingProblems(facts: MappingFacts): string[] {
  const problems: string[] = [];
  const expected = new Set(EXPECTED_UNMAPPED);
  for (const name of facts.unmapped) {
    if (!expected.has(name)) problems.push(`запись без фикстуры вне известного списка: ${name}`);
  }
  for (const [part, names] of facts.byPart) {
    if (names.length > 1) problems.push(`part${String(part)} досталась нескольким записям: ${names.join(', ')}`);
  }
  for (const name of facts.ambiguous) problems.push(`отпечаток записи дали несколько фикстур: ${name}`);
  for (const part of facts.notInField) problems.push(`бордов part${String(part)} нет в поле`);
  for (const part of facts.missingLogs) problems.push(`у фикстуры part${String(part)} нет лога`);
  return problems;
}

export interface AdditionResult {
  readonly deltas: readonly number[];
  readonly mean: number;
  readonly se: number;
  readonly mde: number;
  readonly low: number;
  readonly high: number;
}

/**
 * Парные разности `MAE_g(без) − MAE_g(с)` (положительное — добавка
 * помогает), полоса sign-flip с хвостом 2.5 % и МРЭ 1.96·SE.
 */
export function additionResult(
  without: readonly GameEval[],
  withIt: readonly GameEval[],
  seed: number,
): AdditionResult {
  const deltas = pairedDeltas(withIt, without);
  const s = summarize(deltas);
  const band = signFlipQuantiles(deltas, BAND_ITERATIONS, createRng(seed), TAIL);
  return { deltas, mean: s.mean, se: s.se, mde: MDE_Z * s.se, low: band.low, high: band.high };
}

/** На сколько мест сдвигают прогноз +10 п.п. силы: вес на исходной шкале. */
export function placeShiftPerTenPoints(model: RidgeModel, strengthIndex: number): number {
  return ((model.weights[strengthIndex] ?? 0) / (model.sds[strengthIndex] ?? 1)) * 10;
}

/**
 * Сколько пар «отложенная партия × обучающая точка» сменили бы флаг
 * «поле узкое», если бы из поля обучающей точки убрали ещё и борды
 * отложенной партии (предрегистрация, «Чего не докажет», п. 5). Счёт
 * без симуляций — по числу бордов хода.
 */
export function fieldFlipCount(
  snapshot: FieldSnapshot,
  games: readonly { readonly part: number | null; readonly game: DatasetGame }[],
  minBoards: number,
): { readonly flips: number; readonly pairs: number } {
  const count = new Map<number, number>();
  const byPartTurn = new Map<string, number>();
  for (const b of snapshot.boards) {
    if (b.board.length === 0) continue;
    count.set(b.tavernTurn, (count.get(b.tavernTurn) ?? 0) + 1);
    const key = `${String(b.part)}|${String(b.tavernTurn)}`;
    byPartTurn.set(key, (byPartTurn.get(key) ?? 0) + 1);
  }
  const has = (part: number | null, turn: number): number =>
    part === null ? 0 : (byPartTurn.get(`${String(part)}|${String(turn)}`) ?? 0);

  let flips = 0;
  let pairs = 0;
  for (const held of games) {
    for (const train of games) {
      if (train === held) continue;
      for (const cp of train.game.record.checkpoints) {
        if (cp.state.board.length === 0) continue;
        pairs += 1;
        const turn = tavernTurnOf(cp.state.turn);
        const own = (count.get(turn) ?? 0) - has(train.part, turn);
        if (own >= minBoards && own - has(held.part, turn) < minBoards) flips += 1;
      }
    }
  }
  return { flips, pairs };
}
