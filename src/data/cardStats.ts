import { readFileSync } from 'node:fs';

import { MIN_DATA_POINTS, BG_STATS_DIR } from './bgStats.js';
import type { CardIndex } from './cards.js';

/**
 * Статистика мест ОТДЕЛЬНЫХ МИНЬОНОВ — снапшот Firestone.
 *
 * Отдельный модуль, а не третья карта в `bgStats.ts`, СОЗНАТЕЛЬНО: bgStats
 * лежит на рантайм-пути через `sharedBgStats()`, и до вердикта замера
 * рантайм не должен меняться ни на байт. Здесь — только чтение и арифметика
 * для замера; в советник ничего не подаётся, пока замер не скажет, что оно
 * того стоит (CLAUDE.md, «Отложено сознательно»: вливать глобальные
 * винрейты в наш контекстный расчёт без замера нельзя).
 *
 * ## Что в источнике
 *
 * `averagePlacement` — среднее место тех, кто карту играл. `impact`
 * Firestone считает как `averagePlacement − averagePlacementOther`, где
 * «other» — партии, где карту не играли ВООБЩЕ. Место тем лучше, чем
 * меньше, поэтому у сильной карты impact ОТРИЦАТЕЛЕН.
 *
 * ## Почему обязательно центрирование по тиру
 *
 * Глобальный impact коллинеарен тиру: карты старших тиров играют
 * на выигрышных бордах и в поздних партиях. Без вычитания среднего по тиру
 * свободный вес молча перекручивал бы наш собственный `perTechLevel`,
 * и замер мерил бы подгонку веса тира на тринадцати партиях, а не пользу
 * статистики. Остаток `residual = impact − среднее по тиру` — это то,
 * чего наша шкала ещё не знает.
 *
 * ## Чего эти данные не доказывают
 *
 * Даже impact не причинный: контроль — «партии без этой карты», а не
 * «та же позиция, другая покупка». Карта, до которой доигрывают только
 * с сильного борда, выглядит хорошо и после центрирования. Это чужие
 * агрегаты со смещением выживания, и подписывать их в советах положено
 * словами «по статистике».
 */

export const CARD_STATS_PATH = `${BG_STATS_DIR}/card-stats.json`;

export interface CardStat {
  readonly cardId: string;
  /** Розыгрышей (не партий): карту могут играть по нескольку копий. */
  readonly totalPlayed: number;
  readonly averagePlacement: number;
  readonly averagePlacementOther: number;
  /** `averagePlacement − averagePlacementOther`; отрицательный — карта сильна. */
  readonly impact: number;
  /** Тир карты по нашему справочнику — по нему и центрируем. */
  readonly techLevel: number;
  /** `impact` минус среднее по своему тиру. */
  readonly residual: number;
}

export interface CardStats {
  readonly size: number;
  readonly stat: (cardId: string) => CardStat | null;
  /** Среднее `impact` по тиру — то, что вычитается. */
  readonly tierMean: (techLevel: number) => number;
  /** Стандартное отклонение остатка: курс перевода мест в очки. */
  readonly sigmaResidual: number;
  /** Сырое отклонение impact до центрирования — для отчёта. */
  readonly sigmaImpact: number;
  /** Сколько карт по тирам — для отчёта о покрытии. */
  readonly countByTier: ReadonlyMap<number, number>;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Разбор снапшота. Берутся только миньоны пула с известным тиром: тринкеты
 * и заклинания живут в своих источниках, а карты вне пула нам не предлагают.
 * Порог малой выборки — общий с героями и тринкетами (`MIN_DATA_POINTS`).
 */
export function createCardStats(raw: unknown, cards: CardIndex): CardStats {
  const rows: { cardId: string; totalPlayed: number; placement: number; other: number; tier: number }[] =
    [];

  const list = (raw as Record<string, unknown> | null)?.['cardStats'];
  if (Array.isArray(list)) {
    for (const item of list) {
      const row = item as Record<string, unknown>;
      const cardId = row['cardId'];
      const placement = asNumber(row['averagePlacement']);
      const other = asNumber(row['averagePlacementOther']);
      const totalPlayed = asNumber(row['totalPlayed']) ?? 0;
      if (typeof cardId !== 'string' || placement === null || other === null) continue;
      if (totalPlayed < MIN_DATA_POINTS) continue;

      const info = cards.info(cardId);
      if (info === null || info.techLevel === null) continue;
      if (!info.isBaconPool || info.type !== 'MINION') continue;

      rows.push({ cardId, totalPlayed, placement, other, tier: info.techLevel });
    }
  }

  // Среднее по тиру — то, что мы уже знаем через `perTechLevel`.
  const byTier = new Map<number, number[]>();
  for (const r of rows) {
    const impact = r.placement - r.other;
    const list_ = byTier.get(r.tier) ?? [];
    list_.push(impact);
    byTier.set(r.tier, list_);
  }
  const tierMeans = new Map<number, number>();
  const countByTier = new Map<number, number>();
  for (const [tier, impacts] of byTier) {
    tierMeans.set(tier, impacts.reduce((a, b) => a + b, 0) / impacts.length);
    countByTier.set(tier, impacts.length);
  }

  const stats = new Map<string, CardStat>();
  const residuals: number[] = [];
  const impacts: number[] = [];
  for (const r of rows) {
    const impact = r.placement - r.other;
    const residual = impact - (tierMeans.get(r.tier) ?? 0);
    impacts.push(impact);
    residuals.push(residual);
    stats.set(r.cardId, {
      cardId: r.cardId,
      totalPlayed: r.totalPlayed,
      averagePlacement: r.placement,
      averagePlacementOther: r.other,
      impact,
      techLevel: r.tier,
      residual,
    });
  }

  return {
    size: stats.size,
    // Золотая копия к базовой НЕ приводится: золотых в источнике нет вовсе
    // (агрегатор их отбрасывает), и подставлять базовую статистику золотому
    // значило бы выдумать число. Такой кандидат честно остаётся без данных.
    stat: (cardId) => stats.get(cardId) ?? null,
    tierMean: (techLevel) => tierMeans.get(techLevel) ?? 0,
    sigmaResidual: standardDeviation(residuals),
    sigmaImpact: standardDeviation(impacts),
    countByTier,
  };
}

export function loadCardStats(cards: CardIndex, path: string = CARD_STATS_PATH): CardStats {
  return createCardStats(JSON.parse(readFileSync(path, 'utf8')), cards);
}

/**
 * Очки за статистику: насколько карта лучше среднего по своему тиру,
 * в местах, с капом.
 *
 * Знак перевёрнут (место тем лучше, чем меньше), кап — чтобы одиночная
 * карта с экзотическим остатком не перевешивала всю остальную оценку.
 * Тот же приём, что у щита/вихря/перерождения: их ценность капается телом
 * (part7, цена промаха 50 п.п.).
 */
export function statGainOf(stat: CardStat | null, capPlaces: number): number {
  if (stat === null) return 0;
  return Math.max(-capPlaces, Math.min(capPlaces, -stat.residual));
}
