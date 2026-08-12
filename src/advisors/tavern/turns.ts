import { readPowerEvents } from '../../parser/blocks.js';
import { readPlayers } from '../../state/players.js';
import { createReducer } from '../../state/reducer.js';
import type { GameState } from '../../state/types.js';

/**
 * Точки решения в таверне — состояния, в которых советник имеет смысл.
 *
 * Нужно по той же причине, что и `readBattleEpisodes` для фазы 2: тесты
 * и демо должны работать на реальных состояниях, а не на выдуманных.
 *
 * Момент выбран началом фазы таверны, и это не мелочь. Демо фазы 1 печатает
 * КОНЕЦ фазы, где золото всегда 0 из 10: человек к тому времени всё потратил.
 * Советовать в этой точке нечего. Решения принимаются в начале хода, когда
 * витрина только что обновилась, а золото ещё целое.
 */

export interface TavernTurn {
  readonly turn: number;
  /** Состояние на момент, когда ходить ещё не начали. */
  readonly state: GameState;
}

/**
 * Точка решения — ПОСЛЕДНЕЕ состояние хода, в котором золото ещё не тронуто.
 *
 * Первая версия брала первое такое состояние и оказалась негодной: витрина
 * наполняется не мгновенно, и снимок заставал в ней одного миньона вместо
 * трёх-пяти. Демо это показало сразу, а тесты бы не заметили — они не знают,
 * сколько миньонов в магазине должно быть.
 *
 * Ждать «полной витрины» по числу мест нельзя: размер магазина зависит от тира
 * и меняется с патчами, а таблицы этого в логе нет. Зато момент, когда игрок
 * впервые тратит золото, в логе есть, и он же и есть точка решения — всё, что
 * игра успела показать к этому моменту, игрок видел.
 */
export function readTavernTurns(text: string): TavernTurn[] {
  const reducer = createReducer(readPlayers(text));
  const turns: TavernTurn[] = [];

  let pending: TavernTurn | null = null;

  const commit = (): void => {
    if (pending !== null && pending.state.shop.length > 0) turns.push(pending);
    pending = null;
  };

  for (const event of readPowerEvents(text)) {
    reducer.step(event);

    // Снимок дорогой: берётся только на событиях, которые могут изменить
    // витрину, золото или борд.
    const { content } = event.line;
    if (
      !content.includes('ZONE') &&
      !content.includes('RESOURCES') &&
      !content.includes('BOARD_VISUAL_STATE')
    ) {
      continue;
    }

    const state = reducer.snapshot();

    if (state.phase !== 'tavern' || state.turn === 0 || state.hero === null) {
      commit();
      continue;
    }
    if (pending !== null && pending.turn !== state.turn) commit();
    // Золото тронуто — решение уже принято, дальше состояние не наше.
    if (state.goldSpent > 0 || state.goldTotal === 0) continue;

    pending = { turn: state.turn, state };
  }

  commit();
  return turns;
}
