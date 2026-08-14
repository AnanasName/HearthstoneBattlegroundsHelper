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

/** Один виденный борд поля: чей он, каков и насколько устарел. */
export interface SeenBoard {
  readonly playerId: number;
  readonly board: readonly Minion[];
  /** Ход, на котором борд снят. `null`, если редьюсер хода не записал. */
  readonly seenOnTurn: number | null;
  readonly staleTurns: number;
}

/**
 * Против чего считать расстановку: один противник или всё поле.
 *
 * Цель-один — когда противник известен и его борд видели: это строго лучше
 * любого усреднения. Но так бывает редко: замер по четырём партиям текущего
 * патча (`npm run spike:field`) — из 27 точек решения цель-один есть в 11,
 * а в 16 советник молчал, хотя на руках было от 3 до 7 виденных бордов.
 * Следующий противник берётся из этого же множества — соперников семеро,
 * и к середине партии мы видели почти всех. Поэтому вторая цель — поле:
 * средний исход по всем виденным бордам.
 */
export type PositionTarget =
  | { readonly kind: 'single'; readonly opponent: ResolvedOpponent }
  | { readonly kind: 'field'; readonly boards: readonly SeenBoard[] };

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

/**
 * Все виденные борды соперников — поле, по которому считается средний исход.
 *
 * Порядок фиксирован по `PlayerID`: от него зависят раздача симуляций
 * по бордам и зёрна, а совет обязан быть воспроизводимым.
 *
 * Мёртвые соперники отсюда не выкидываются — редьюсер не знает, кто выбыл.
 * Это не так страшно, как звучит: их борды перестают обновляться, давность
 * растёт и видна в `staleTurns`, а бой с призраком играет ровно последний
 * борд умершего.
 */
function seenBoards(state: GameState): SeenBoard[] {
  return Object.entries(state.lastSeenBoards)
    .filter(([, board]) => board.length > 0)
    .map(([id, board]) => {
      const playerId = Number(id);
      const seenOnTurn = state.lastSeenBoardTurns[playerId] ?? null;
      return {
        playerId,
        board,
        seenOnTurn,
        staleTurns: seenOnTurn === null ? 0 : Math.max(0, state.turn - seenOnTurn),
      };
    })
    .sort((a, b) => a.playerId - b.playerId);
}

/**
 * Цель счёта. `null` — считать не на чем: ни противника, ни единого
 * виденного борда (первые ходы партии).
 */
export function resolveTarget(state: GameState): PositionTarget | null {
  const opponent = resolveOpponent(state);
  if (opponent.usable) return { kind: 'single', opponent };

  const boards = seenBoards(state);
  if (boards.length === 0) return null;
  return { kind: 'field', boards };
}
