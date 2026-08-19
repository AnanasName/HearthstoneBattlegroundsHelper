import { mean } from '../advisors/tavern/statAnalysis.js';
import { buyCostOf, copiesOwned, tribeMates } from '../advisors/tavern/advisor.js';
import type { CardIndex } from '../data/cards.js';
import { EMPTY_STATE, type GameState, type Minion } from '../state/types.js';
import { fitRidge, predictRidge, type RidgeModel } from './ridge.js';
import type { DatasetGame } from './dataset.js';
import type { SignFlipBand, Verdict } from './evaluate.js';

/**
 * Замер 2 фазы 6: имитация покупок игрока (предрегистрация — docs/ml.md).
 *
 * Вопрос: предсказуем ли ВЫБОР ПОКУПКИ игрока сверх советника. Инстанс —
 * витрина точки решения плюс факт «что из неё куплено в этот ход» (join
 * журнала действий по entityId), модель — парная гребневая регрессия
 * на шести признаках-кирпичах советника: вопрос замера — порядок (веса
 * из данных против весов из правил), а не новые сигналы.
 *
 * Всё здесь — чистые функции; файлы, советник-бейзлайн и печать живут
 * в imitationReport.ts.
 */

/** Золотая копия — та же карта: совпадение считается ПО КАРТЕ (buyQuality). */
export function baseCardOf(cardId: string): string {
  return cardId.endsWith('_G') ? cardId.slice(0, -2) : cardId;
}

export interface ImitationInstance {
  readonly gameName: string;
  readonly finalPlace: number;
  readonly turn: number;
  readonly state: GameState;
  /** Кандидаты — миньоны показанной витрины, как их видел игрок. */
  readonly candidates: readonly Minion[];
  /** Базовые cardId купленных ИЗ ЭТОЙ витрины миньонов. */
  readonly boughtCardIds: ReadonlySet<string>;
}

export interface InstanceBuild {
  readonly instances: readonly ImitationInstance[];
  readonly turnsSeen: number;
  /** Ходы, где из показанной витрины не куплено ничего. */
  readonly skippedNoShownBuys: number;
  /** Ходы, где куплена вся витрина, — ранжировать нечего. */
  readonly skippedAllBought: number;
  /** Витрина из одного миньона — выбора не было. */
  readonly skippedFewCandidates: number;
  /** Покупки заклинаний витрины — кандидаты замера только миньоны. */
  readonly spellBuys: number;
  /** Покупки вне показанной витрины: после обновления выбор был из другой. */
  readonly offShopBuys: number;
  /**
   * Покупки на ходах БЕЗ точки решения — витрины, к которой их пришить,
   * в записи нет (точка решения хода не снялась). Молчать о них нельзя:
   * это купленные карты, которых замер не видел.
   */
  readonly buysOnMissingTurns: number;
  /** Записи без журнала действий — учиться в них не на чем. */
  readonly gamesWithoutActions: readonly string[];
}

export function buildInstances(games: readonly DatasetGame[]): InstanceBuild {
  const instances: ImitationInstance[] = [];
  const gamesWithoutActions: string[] = [];
  let turnsSeen = 0;
  let skippedNoShownBuys = 0;
  let skippedAllBought = 0;
  let skippedFewCandidates = 0;
  let spellBuys = 0;
  let offShopBuys = 0;
  let buysOnMissingTurns = 0;

  for (const game of games) {
    const actions = game.record.actions;
    if (actions === undefined) {
      gamesWithoutActions.push(game.fileName);
      continue;
    }
    const buysByTurn = new Map<number, number[]>();
    for (const a of actions) {
      if (a.type !== 'buy' || a.entityId === null) continue;
      const list = buysByTurn.get(a.turn);
      if (list === undefined) buysByTurn.set(a.turn, [a.entityId]);
      else list.push(a.entityId);
    }
    // Покупки хода, у которого нет точки решения, пришить не к чему —
    // считаются вслух, а не выбрасываются молча.
    const checkpointTurns = new Set(game.record.checkpoints.map((cp) => cp.turn));
    for (const [turn, buys] of buysByTurn) {
      if (!checkpointTurns.has(turn)) buysOnMissingTurns += buys.length;
    }

    for (const cp of game.record.checkpoints) {
      turnsSeen += 1;
      // Старые записи не несут полей, добавленных в состояние позже, —
      // нормализация поверх EMPTY_STATE даёт им честные умолчания.
      const state: GameState = { ...EMPTY_STATE, ...cp.state };
      const shop = state.shop;
      const shopById = new Map(shop.map((m) => [m.entityId, m]));
      const spellIds = new Set(state.shopSpells.map((s) => s.entityId));

      const bought = new Set<string>();
      for (const entityId of buysByTurn.get(cp.turn) ?? []) {
        const shown = shopById.get(entityId);
        if (shown !== undefined) bought.add(baseCardOf(shown.cardId));
        else if (spellIds.has(entityId)) spellBuys += 1;
        else offShopBuys += 1;
      }

      if (shop.length < 2) {
        skippedFewCandidates += 1;
        continue;
      }
      if (bought.size === 0) {
        skippedNoShownBuys += 1;
        continue;
      }
      if (shop.every((m) => bought.has(baseCardOf(m.cardId)))) {
        skippedAllBought += 1;
        continue;
      }

      instances.push({
        gameName: game.fileName,
        finalPlace: game.finalPlace,
        turn: cp.turn,
        state,
        candidates: shop,
        boughtCardIds: bought,
      });
    }
  }

  return {
    instances,
    turnsSeen,
    skippedNoShownBuys,
    skippedAllBought,
    skippedFewCandidates,
    spellBuys,
    offShopBuys,
    buysOnMissingTurns,
    gamesWithoutActions,
  };
}

/** Имена признаков — порядок совпадает с `candidateFeatures`. */
export const IMITATION_FEATURES: readonly string[] = [
  'тир',
  'статы',
  'золотой',
  'соплеменники на борде',
  'свои копии',
  'цена покупки',
];

export function candidateFeatures(
  candidate: Minion,
  state: GameState,
  cards: CardIndex,
): readonly number[] {
  return [
    cards.info(candidate.cardId)?.techLevel ?? candidate.techLevel ?? 1,
    (candidate.attack ?? 0) + (candidate.health ?? 0),
    candidate.golden ? 1 : 0,
    tribeMates(candidate, state.board, cards),
    copiesOwned(candidate, state),
    buyCostOf(candidate),
  ];
}

const isBought = (inst: ImitationInstance, candidate: Minion): boolean =>
  inst.boughtCardIds.has(baseCardOf(candidate.cardId));

/**
 * Парное обучение: внутри инстанса каждая пара «куплен × не куплен» даёт
 * разность признаков с меткой +1 и зеркальную с −1. Симметрия делает
 * интерсепт нулевым сама, а `fitRidge` остаётся единственной обучающей
 * арифметикой фазы 6 — вторая копия разошлась бы молча.
 */
export function trainImitation(
  instances: readonly ImitationInstance[],
  cards: CardIndex,
  lambda: number,
): RidgeModel {
  const rows: (readonly number[])[] = [];
  const ys: number[] = [];
  for (const inst of instances) {
    const features = inst.candidates.map((c) => candidateFeatures(c, inst.state, cards));
    inst.candidates.forEach((a, i) => {
      if (!isBought(inst, a)) return;
      inst.candidates.forEach((b, j) => {
        if (isBought(inst, b)) return;
        const fa = features[i] ?? [];
        const fb = features[j] ?? [];
        const diff = fa.map((v, k) => v - (fb[k] ?? 0));
        rows.push(diff);
        rows.push(diff.map((v) => -v));
        ys.push(1);
        ys.push(-1);
      });
    });
  }
  return fitRidge(rows, ys, lambda);
}

/** Детерминированный выбор лучшего: счёт, затем zonePos, затем entityId. */
function pickBest(
  candidates: readonly Minion[],
  scoreOf: (candidate: Minion) => number,
): Minion | null {
  let best: Minion | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const score = scoreOf(c);
    if (
      best === null ||
      score > bestScore ||
      (score === bestScore &&
        (c.zonePos < best.zonePos || (c.zonePos === best.zonePos && c.entityId < best.entityId)))
    ) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Кандидаты, разделившие максимум счёта, — точным равенством. */
function topSet(
  candidates: readonly Minion[],
  scoreOf: (candidate: Minion) => number,
): readonly Minion[] {
  let max = -Infinity;
  for (const c of candidates) {
    const score = scoreOf(c);
    if (score > max) max = score;
  }
  return candidates.filter((c) => scoreOf(c) === max);
}

/**
 * Hit с честными ничьими: доля купленных среди разделивших максимум.
 *
 * В витринах бывают кандидаты с ТОЖДЕСТВЕННЫМИ векторами признаков —
 * линейной модели их не развести, и целый hit решал бы тай-брейк
 * по позиции, а не модель. Урок cardstats («попал в любой максимум»)
 * здесь принимает форму ожидания по равным: подарка тай-брейку нет,
 * и наказания за неразличимое — тоже.
 */
export function tieAwareHit(
  inst: ImitationInstance,
  scoreOf: (candidate: Minion) => number,
): number {
  const top = topSet(inst.candidates, scoreOf);
  if (top.length === 0) return 0;
  return top.filter((c) => isBought(inst, c)).length / top.length;
}

/**
 * Ожидание того же hit при метке, НЕ зависящей от выбора: «куплена карта
 * случайного кандидата». Нужен отрицательному контролю: сравнение
 * с `randomHitRate` смещено дублями карт в витрине (у выбора с дублем
 * шанс выше 1/n), а с ожиданием СОБСТВЕННОГО выбора нуль точный.
 */
export function tieAwareChance(
  inst: ImitationInstance,
  scoreOf: (candidate: Minion) => number,
): number {
  const n = inst.candidates.length;
  if (n === 0) return 0;
  const copies = new Map<string, number>();
  for (const c of inst.candidates) {
    const card = baseCardOf(c.cardId);
    copies.set(card, (copies.get(card) ?? 0) + 1);
  }
  const top = topSet(inst.candidates, scoreOf);
  if (top.length === 0) return 0;
  const sum = top.reduce((acc, c) => acc + (copies.get(baseCardOf(c.cardId)) ?? 0) / n, 0);
  return sum / top.length;
}

/** Топ-выбор модели с тай-брейком — для диагностики расхождений в отчёте. */
export function pickByModel(
  model: RidgeModel,
  inst: ImitationInstance,
  cards: CardIndex,
): Minion | null {
  return pickBest(inst.candidates, (c) =>
    predictRidge(model, candidateFeatures(c, inst.state, cards)),
  );
}

const statsScore = (c: Minion): number => (c.attack ?? 0) + (c.health ?? 0);

// Тир решает, статы разводят равных: тысячная доля стата тир не перебьёт.
const tierScore =
  (cards: CardIndex) =>
  (c: Minion): number =>
    (cards.info(c.cardId)?.techLevel ?? c.techLevel ?? 1) + statsScore(c) / 10_000;

/** Аналитический random: доля кандидатов, чья карта куплена. */
export function randomHitRate(inst: ImitationInstance): number {
  const hits = inst.candidates.filter((c) => isBought(inst, c)).length;
  return inst.candidates.length === 0 ? 0 : hits / inst.candidates.length;
}

/** Выбор советника: базовый cardId верхней покупки, null — совета нет. */
export type AdvisorPick = (inst: ImitationInstance) => string | null;

export interface ImitationGameEval {
  readonly name: string;
  readonly finalPlace: number;
  readonly instances: number;
  readonly hitModel: number;
  readonly hitAdvisor: number;
  readonly hitRandom: number;
  readonly hitStats: number;
  readonly hitTier: number;
  /** Ожидание hit модели при метке, не зависящей от выбора, — нуль контроля. */
  readonly modelChance: number;
}

export interface ImitationEvalResult {
  readonly evals: readonly ImitationGameEval[];
  /** Инстансы без выбора советника — исключены из ВСЕХ метрик, вслух. */
  readonly droppedNoAdvisor: number;
}

/**
 * LOGO по партиям. `trainFilter` — вторичная ветка «имитация из побед»:
 * обучение только на инстансах, прошедших фильтр (сам оцениваемый
 * инстанс из обучения исключён всегда — он в вынесенной партии).
 */
export function evaluateImitationLogo(
  instances: readonly ImitationInstance[],
  cards: CardIndex,
  lambda: number,
  advisorPick: AdvisorPick,
  trainFilter: (inst: ImitationInstance) => boolean = () => true,
): ImitationEvalResult {
  const byGame = new Map<string, ImitationInstance[]>();
  for (const inst of instances) {
    const list = byGame.get(inst.gameName);
    if (list === undefined) byGame.set(inst.gameName, [inst]);
    else list.push(inst);
  }

  const evals: ImitationGameEval[] = [];
  let droppedNoAdvisor = 0;

  for (const [name, own] of byGame) {
    const train = instances.filter((i) => i.gameName !== name && trainFilter(i));
    const model = trainImitation(train, cards, lambda);

    const scored = own
      .map((inst) => ({ inst, advisor: advisorPick(inst) }))
      .filter(({ advisor }) => {
        if (advisor === null) {
          droppedNoAdvisor += 1;
          return false;
        }
        return true;
      });
    if (scored.length === 0) continue;

    const modelScore =
      (inst: ImitationInstance) =>
      (c: Minion): number =>
        predictRidge(model, candidateFeatures(c, inst.state, cards));

    evals.push({
      name,
      finalPlace: own[0]?.finalPlace ?? 0,
      instances: scored.length,
      hitModel: mean(scored.map(({ inst }) => tieAwareHit(inst, modelScore(inst)))),
      hitAdvisor: mean(
        scored.map(({ inst, advisor }) => (advisor !== null && inst.boughtCardIds.has(advisor) ? 1 : 0)),
      ),
      hitRandom: mean(scored.map(({ inst }) => randomHitRate(inst))),
      hitStats: mean(scored.map(({ inst }) => tieAwareHit(inst, statsScore))),
      hitTier: mean(scored.map(({ inst }) => tieAwareHit(inst, tierScore(cards)))),
      modelChance: mean(scored.map(({ inst }) => tieAwareChance(inst, modelScore(inst)))),
    });
  }

  return { evals, droppedNoAdvisor };
}

/**
 * Отрицательный контроль: метки — случайный кандидат инстанса. Модель
 * на таких метках обязана выйти ≈ random; разрыв — утечка в конвейере.
 */
export function shuffleLabels(
  instances: readonly ImitationInstance[],
  rng: () => number,
): ImitationInstance[] {
  return instances.map((inst) => {
    const pick = inst.candidates[Math.floor(rng() * inst.candidates.length)];
    return {
      ...inst,
      boughtCardIds: new Set(pick === undefined ? [] : [baseCardOf(pick.cardId)]),
    };
  });
}

/** Порог приёмки в долях hit — предрегистрирован (docs/ml.md, замер 2). */
export const IMITATION_ACCEPT_THRESHOLD = 0.05;

/** Вердикт замера 2 — дословно по предрегистрации. */
export function imitationVerdict(
  dMean: number,
  band: SignFlipBand,
  mde: number,
  hitModel: number,
  hitRandom: number,
): Verdict {
  if (
    dMean >= IMITATION_ACCEPT_THRESHOLD &&
    dMean > band.p95 &&
    dMean > mde &&
    hitModel > hitRandom
  ) {
    return 'ПРИНЯТЬ';
  }
  if (dMean < band.p05) return 'ОТВЕРГНУТЬ';
  return 'НЕ ДОКАЗАНО';
}
