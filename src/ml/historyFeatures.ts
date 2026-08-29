import { tavernTurnOf } from '../advisors/tavern/rules.js';
import type { GameState } from '../state/types.js';
import {
  extractRelativeFeatures,
  isAlive,
  lobbyHp,
  RELATIVE_FEATURE_NAMES,
} from './relativeFeatures.js';

/**
 * Признаки по ИСТОРИИ партии — замер 4 фазы 6 (docs/ml.md).
 *
 * Замер 3 показал, что относительные признаки с одной точки выигрывают
 * у таблицы, но не у её сжатия (B2): модель читала стадию партии, которую
 * таблица почти знает сама. Одна точка не видит, КУДА партия движется:
 * место 3 при потере 15 hp за бой и место 3 при потере 3 — разные
 * прогнозы. История лежит в самой записи — точки решения идут ход
 * за ходом, и у каждой есть таблица лобби всех восьми игроков.
 *
 * Три признака к пяти относительным; все считаются только по точкам
 * НЕ ПОЗЖЕ текущей — будущего в признаке нет:
 *
 *   5. потеря hp за бой — (hp две точки назад − hp сейчас) / число боёв
 *      между ними; на первой точке 0, на второй — по одному бою. Знак
 *      сохраняется: рост hp (броня, лечение) — тоже информация;
 *   6. ранг времени жизни — среди живых: время жизни = hp / темп потерь
 *      (темп ≤ 0 — бесконечность), для соперников то же по таблице лобби
 *      в тех же двух точках; ранг 1 — живу дольше всех, ничьи — по
 *      половине, нормировка (ранг − 1) / (живых − 1). Пока истории нет,
 *      у всех бесконечность и ранг 0.5;
 *   7. доля выигранных боёв — точек с `wonLastCombat === true` среди
 *      точек до текущей, делённых на число боёв (ход таверны − 1). Тег
 *      пишется только при смене значения, и до первой победы он null —
 *      значит ранние поражения в счёт не входят явно, но знаменатель их
 *      считает: доля честно мала.
 *
 * Оглядка на две точки (`HISTORY_LOOKBACK`) — компромисс между шумом
 * одного боя и «историей», которой на ранних ходах ещё нет: партия
 * длится 9–15 ходов таверны. Пропуск точки в записи (ход без точки
 * решения) растягивает окно — темп делится на фактическое число боёв
 * по ходам таверны, а не на число точек.
 */
export const HISTORY_FEATURE_NAMES: readonly string[] = [
  ...RELATIVE_FEATURE_NAMES,
  'потеря hp за бой',
  'ранг времени жизни',
  'доля выигранных боёв',
];

export const HISTORY_LOOKBACK = 2;

function heroHp(state: GameState): number {
  const hero = state.hero;
  return hero === null || hero.health === null ? 0 : hero.health - hero.damage + hero.armor;
}

/** Индекс точки, с которой смотрим назад: не раньше первой. */
function lookbackIndex(index: number): number {
  return Math.max(0, index - HISTORY_LOOKBACK);
}

/** Боёв между двумя точками — по ходам таверны, не по числу точек. */
function combatsBetween(states: readonly GameState[], from: number, to: number): number {
  const a = states[from];
  const b = states[to];
  if (a === undefined || b === undefined) return 0;
  return Math.max(0, tavernTurnOf(b.turn) - tavernTurnOf(a.turn));
}

/** Темп потери своего hp за бой; 0, пока истории нет. */
export function ownLossRate(states: readonly GameState[], index: number): number {
  const from = lookbackIndex(index);
  const combats = combatsBetween(states, from, index);
  if (combats === 0) return 0;
  const now = states[index];
  const then = states[from];
  if (now === undefined || then === undefined) return 0;
  return (heroHp(then) - heroHp(now)) / combats;
}

/** Темп потери hp соперника по таблице лобби; null — его нет в одной из точек. */
export function rivalLossRate(
  states: readonly GameState[],
  index: number,
  playerId: number,
): number | null {
  const from = lookbackIndex(index);
  const combats = combatsBetween(states, from, index);
  if (combats === 0) return 0;
  const now = states[index]?.lobby[playerId];
  const then = states[from]?.lobby[playerId];
  if (now === undefined || then === undefined) return null;
  const hpNow = lobbyHp(now);
  const hpThen = lobbyHp(then);
  if (hpNow === null || hpThen === null) return null;
  return (hpThen - hpNow) / combats;
}

/** Время жизни в боях: hp / темп; темп не выше нуля — бесконечность. */
export function timeToLive(hp: number, lossRate: number): number {
  return lossRate > 0 ? hp / lossRate : Number.POSITIVE_INFINITY;
}

/**
 * Ранг своего времени жизни среди живых, нормированный в [0, 1]:
 * 0 — живу дольше всех, 1 — умру первым; ничьи — по половине.
 */
export function ttlRankNorm(states: readonly GameState[], index: number): number {
  const state = states[index];
  if (state === undefined) return 0.5;
  const players = Object.values(state.lobby).filter(isAlive);
  const rivals = players.filter((p) => p.playerId !== state.playerId);
  if (players.length <= 1) return 0;
  if (Object.keys(state.lobby).length === 0) return 0.5;

  const mine = timeToLive(heroHp(state), ownLossRate(states, index));
  let above = 0;
  let equal = 0;
  for (const rival of rivals) {
    const rate = rivalLossRate(states, index, rival.playerId) ?? 0;
    const ttl = timeToLive(lobbyHp(rival) ?? 0, rate);
    if (ttl > mine) above += 1;
    else if (ttl === mine) equal += 1;
  }
  const rank = 1 + above + equal / 2;
  return (rank - 1) / (players.length - 1);
}

/** Доля выигранных боёв среди боёв до этой точки; без боёв — 0. */
export function winShare(states: readonly GameState[], index: number): number {
  const state = states[index];
  if (state === undefined) return 0;
  const combats = tavernTurnOf(state.turn) - 1;
  if (combats <= 0) return 0;
  let wins = 0;
  for (let i = 0; i <= index; i += 1) {
    if (states[i]?.wonLastCombat === true) wins += 1;
  }
  return Math.min(1, wins / combats);
}

export function extractHistoryFeatures(
  state: GameState,
  index: number,
  states: readonly GameState[],
): readonly number[] {
  return [
    ...extractRelativeFeatures(state),
    ownLossRate(states, index),
    ttlRankNorm(states, index),
    winShare(states, index),
  ];
}
