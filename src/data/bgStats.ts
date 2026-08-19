import { readFileSync } from 'node:fs';

/**
 * Статистика Battlegrounds: средние места героев и тринкетов.
 *
 * Источник — снапшот открытых данных Firestone (`npm run update:bgstats`),
 * та же экосистема, что симулятор и справочник карт: идентификаторы карт
 * совпадают. Статистика привязана к патчу и обновляется вместе с ним.
 *
 * Это ЧУЖИЕ агрегированные данные, и советник говорит о них так: «по
 * статистике среднее место N» — не выдавая за собственный расчёт. Малые
 * выборки отфильтрованы порогом `MIN_DATA_POINTS`: среднее по полусотне
 * партий — шум, а не знание.
 */

export const BG_STATS_DIR = 'data/bgstats';
export const HERO_STATS_PATH = `${BG_STATS_DIR}/hero-stats.json`;
export const TRINKET_STATS_PATH = `${BG_STATS_DIR}/trinket-stats.json`;

/** Ниже этого числа партий среднее место не показывается вовсе. */
export const MIN_DATA_POINTS = 500;

export interface HeroStat {
  readonly cardId: string;
  readonly averagePosition: number;
  readonly dataPoints: number;
  /** Как часто героя берут, когда предлагают. */
  readonly pickRate: number | null;
}

export interface TrinketStat {
  readonly cardId: string;
  readonly averagePlacement: number;
  readonly dataPoints: number;
  readonly pickRate: number | null;
}

export interface BgStats {
  readonly heroCount: number;
  readonly trinketCount: number;
  /** Статистика героя; скин приводится к базовой карте. `null` — нет данных. */
  readonly hero: (cardId: string) => HeroStat | null;
  readonly trinket: (cardId: string) => TrinketStat | null;
}

/**
 * Скин героя — отдельный cardId с суффиксом `_SKIN_x` (part13: в выборе
 * пришёл `BG27_HERO_801_SKIN_A`; в лобби part25 встречается и `_SKIN_C4`),
 * а статистика живёт на базовой карте.
 *
 * Экспортируется затем, что сводить героя к базовой карте приходится
 * не только статистике: варианты «Дружеской ставки» приходят БАЗОВЫМИ
 * картами, а герой того же игрока в таблице лобби — своим скином, и сырое
 * сравнение их не сводит (part26). Второе определение того же правила
 * рядом — ровно тот способ, которым расходятся списки фикстур.
 */
export function baseHeroCardId(cardId: string): string {
  return cardId.replace(/_SKIN_\w+$/, '');
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function createBgStats(heroRaw: unknown, trinketRaw: unknown): BgStats {
  const heroes = new Map<string, HeroStat>();
  const heroList = (heroRaw as Record<string, unknown> | null)?.['heroStats'];
  if (Array.isArray(heroList)) {
    for (const item of heroList) {
      const row = item as Record<string, unknown>;
      const cardId = row['heroCardId'];
      const averagePosition = asNumber(row['averagePosition']);
      const dataPoints = asNumber(row['dataPoints']) ?? 0;
      if (typeof cardId !== 'string' || averagePosition === null) continue;
      if (dataPoints < MIN_DATA_POINTS) continue;
      const offered = asNumber(row['totalOffered']);
      const picked = asNumber(row['totalPicked']);
      heroes.set(cardId, {
        cardId,
        averagePosition,
        dataPoints,
        pickRate: offered !== null && picked !== null && offered > 0 ? picked / offered : null,
      });
    }
  }

  const trinkets = new Map<string, TrinketStat>();
  const trinketList = (trinketRaw as Record<string, unknown> | null)?.['trinketStats'];
  if (Array.isArray(trinketList)) {
    for (const item of trinketList) {
      const row = item as Record<string, unknown>;
      const cardId = row['trinketCardId'];
      const averagePlacement = asNumber(row['averagePlacement']);
      const dataPoints = asNumber(row['dataPoints']) ?? 0;
      if (typeof cardId !== 'string' || averagePlacement === null) continue;
      if (dataPoints < MIN_DATA_POINTS) continue;
      trinkets.set(cardId, {
        cardId,
        averagePlacement,
        dataPoints,
        pickRate: asNumber(row['pickRate']),
      });
    }
  }

  return {
    heroCount: heroes.size,
    trinketCount: trinkets.size,
    hero: (cardId) => heroes.get(cardId) ?? heroes.get(baseHeroCardId(cardId)) ?? null,
    trinket: (cardId) => trinkets.get(cardId) ?? null,
  };
}

export function loadBgStats(
  heroPath: string = HERO_STATS_PATH,
  trinketPath: string = TRINKET_STATS_PATH,
): BgStats {
  const parse = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
  return createBgStats(parse(heroPath), parse(trinketPath));
}

/**
 * Ленивый синглтон с честным отсутствием: снапшота может не быть вовсе
 * (свежий клон до первого `update:bgstats`), и советник тогда живёт
 * как раньше — статистика необязательна.
 */
let shared: BgStats | null | undefined;

export function sharedBgStats(): BgStats | null {
  if (shared !== undefined) return shared;
  try {
    shared = loadBgStats();
  } catch {
    shared = null;
  }
  return shared;
}
