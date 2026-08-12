import type { GameState, Minion } from '../../state/types.js';

/**
 * Против кого считать расстановку.
 *
 * Вопрос не праздный: советник нужен в таверне, до боя, когда чужого борда
 * на столе ещё нет. Ответ собирается из двух фактов, проверенных на фикстурах
 * (см. docs/power-log.md):
 *
 *  - `NEXT_OPPONENT_PLAYER_ID` называет следующего противника ещё в таверне,
 *    и совпал с фактическим 18 раз из 18;
 *  - борд каждого соперника запоминается в бою с ним и лежит
 *    в `lastSeenBoards` по его `PlayerID`.
 *
 * Из чего следует главное ограничение, которое нельзя прятать: борд известен
 * не текущий, а тот, что был в последнем бою с этим игроком. За прошедшие ходы
 * он покупал, продавал и левелился. Поэтому источник и возраст картинки идут
 * в ответе наружу, а не остаются деталью реализации.
 */

export type OpponentSource =
  /** Бой уже идёт, борд противника виден прямо сейчас. */
  | 'combat'
  /** Таверна: следующий противник известен, борд — из прошлого боя с ним. */
  | 'lastSeen'
  /** Следующий противник известен, но его борда мы ещё не видели. */
  | 'unseen'
  /** Даже противник неизвестен. */
  | 'unknown';

export interface ResolvedOpponent {
  readonly source: OpponentSource;
  readonly playerId: number | null;
  readonly board: readonly Minion[];
  /** Ход, на котором снят борд. `null`, если борда нет или он текущий. */
  readonly seenOnTurn: number | null;
  /** Сколько ходов прошло с момента снимка. 0 — картинка свежая. */
  readonly staleTurns: number;
  /** Можно ли на этом считать бой. */
  readonly usable: boolean;
}

export function resolveOpponent(state: GameState): ResolvedOpponent {
  if (state.phase === 'combat' && state.opponentBoard.length > 0) {
    return {
      source: 'combat',
      playerId: state.currentOpponentPlayerId,
      board: state.opponentBoard,
      seenOnTurn: state.turn,
      staleTurns: 0,
      usable: true,
    };
  }

  const next = state.nextOpponentPlayerId;
  if (next === null) {
    return { source: 'unknown', playerId: null, board: [], seenOnTurn: null, staleTurns: 0, usable: false };
  }

  const board = state.lastSeenBoards[next];
  if (board === undefined || board.length === 0) {
    return { source: 'unseen', playerId: next, board: [], seenOnTurn: null, staleTurns: 0, usable: false };
  }

  const seenOnTurn = state.lastSeenBoardTurns[next] ?? null;
  return {
    source: 'lastSeen',
    playerId: next,
    board,
    seenOnTurn,
    staleTurns: seenOnTurn === null ? 0 : Math.max(0, state.turn - seenOnTurn),
    usable: true,
  };
}
