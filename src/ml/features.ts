import { tavernTurnOf } from '../advisors/tavern/rules.js';
import type { GameState } from '../state/types.js';

/**
 * Признаки точки решения для предсказания финального места.
 *
 * Семь штук, и все — «свои»: `lobby` пуст во ВСЁМ накопленном датасете
 * (таблица игроков вошла в состояние 18.08, после последней записанной
 * партии), поэтому относительные признаки («моё hp против стола») сюда
 * не входят — это записанная граница замера, а не забывчивость
 * (docs/ml.md). Список и политика пропусков предрегистрированы; менять их
 * — значит перезапускать замер, а не подкручивать до результата.
 *
 * Седьмой признак — индикатор «ещё без побед»: тег BACON_WON_LAST_COMBAT
 * пишется логом только при СМЕНЕ значения, поэтому null у «прошлого боя»
 * значит «не выиграл ещё ни одного боя» (у part7, 7-е место, поле null
 * всю партию), а не «до первого боя». Пропуск информативен, и без
 * индикатора кодировка «null → 0» приукрашивала бы проигрывающих.
 */
export const FEATURE_NAMES: readonly string[] = [
  'ход таверны',
  'тир таверны',
  'здоровье с бронёй',
  'текущее место',
  'лог-статы борда',
  'прошлый бой',
  'ещё без побед',
];

/** Пропуск текущего места — середина таблицы, а не ноль: ноль здесь ложь. */
export const MISSING_PLACE = 4.5;

export function extractFeatures(state: GameState): readonly number[] {
  const hero = state.hero;
  const hp =
    hero === null || hero.health === null ? 0 : hero.health - hero.damage + hero.armor;
  const boardStats = state.board.reduce((sum, m) => sum + (m.attack ?? 0) + (m.health ?? 0), 0);
  return [
    tavernTurnOf(state.turn),
    state.techLevel,
    hp,
    state.finalPlace ?? MISSING_PLACE,
    // Статы борда растут по партии экспоненциально — логарифм, чтобы
    // поздний борд не съедал линейную модель целиком.
    Math.log1p(boardStats),
    state.wonLastCombat === null ? 0 : state.wonLastCombat ? 1 : -1,
    state.wonLastCombat === null ? 1 : 0,
  ];
}
