import { describe, expect, it } from 'vitest';

import { resolveOpponent } from '../../../src/advisors/position/opponent.js';
import { EMPTY_STATE, type GameState, type Minion } from '../../../src/state/types.js';
import { part3Game } from '../../fixtures.js';
import { readPowerEvents } from '../../../src/parser/blocks.js';
import { readPlayers } from '../../../src/state/players.js';
import { createReducer } from '../../../src/state/reducer.js';

function minion(entityId: number): Minion {
  return {
    entityId,
    cardId: `CARD_${String(entityId)}`,
    zonePos: entityId,
    attack: 3,
    health: 4,
    taunt: false,
    divineShield: false,
    poisonous: false,
    venomous: false,
    reborn: false,
    windfury: false,
    stealth: false,
    golden: false,
    maxHealth: 4,
    techLevel: 3,
    enchantments: [],
    scriptData: [null, null, null, null, null, null],
    tags: {},
  };
}

const state = (patch: Partial<GameState>): GameState => ({ ...EMPTY_STATE, ...patch });

describe('против кого считать расстановку', () => {
  it('в бою берётся тот борд, что виден прямо сейчас', () => {
    const resolved = resolveOpponent(
      state({
        phase: 'combat',
        turn: 10,
        opponentBoard: [minion(1), minion(2)],
        currentOpponentPlayerId: 5,
        // Устаревший снимок того же боя не должен перебить живой борд.
        nextOpponentPlayerId: 5,
        lastSeenBoards: { 5: [minion(9)] },
        lastSeenBoardTurns: { 5: 4 },
      }),
    );

    expect(resolved.source).toBe('combat');
    expect(resolved.playerId).toBe(5);
    expect(resolved.board).toHaveLength(2);
    expect(resolved.staleTurns).toBe(0);
    expect(resolved.usable).toBe(true);
  });

  it('в таверне берётся последний увиденный борд следующего противника', () => {
    const resolved = resolveOpponent(
      state({
        phase: 'tavern',
        turn: 11,
        nextOpponentPlayerId: 7,
        lastSeenBoards: { 3: [minion(1)], 7: [minion(2), minion(3)] },
        lastSeenBoardTurns: { 3: 6, 7: 5 },
      }),
    );

    expect(resolved.source).toBe('lastSeen');
    expect(resolved.playerId).toBe(7);
    expect(resolved.board).toHaveLength(2);
    expect(resolved.seenOnTurn).toBe(5);
    // Шесть ходов — это шесть покупок и, возможно, уровень таверны. Советник
    // обязан знать возраст картинки, иначе выдаёт устаревшее за текущее.
    expect(resolved.staleTurns).toBe(6);
    expect(resolved.usable).toBe(true);
  });

  it('противник известен, но его борда не видели — считать не на чем', () => {
    const resolved = resolveOpponent(
      state({ phase: 'tavern', turn: 4, nextOpponentPlayerId: 7, lastSeenBoards: {} }),
    );

    expect(resolved.source).toBe('unseen');
    expect(resolved.playerId).toBe(7);
    expect(resolved.usable).toBe(false);
  });

  it('противник неизвестен — тем более', () => {
    const resolved = resolveOpponent(state({ phase: 'tavern', turn: 2 }));
    expect(resolved.source).toBe('unknown');
    expect(resolved.usable).toBe(false);
  });

  it('пустой борд в бою не выдаётся за увиденный', () => {
    const resolved = resolveOpponent(
      state({ phase: 'combat', turn: 9, opponentBoard: [], nextOpponentPlayerId: 2 }),
    );
    expect(resolved.source).not.toBe('combat');
  });
});

describe('возраст увиденных бордов на реальной партии', () => {
  it('редьюсер помечает каждый борд ходом, на котором он снят', () => {
    const text = part3Game();
    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) reducer.step(event);
    const final = reducer.snapshot();

    const boards = Object.keys(final.lastSeenBoards);
    expect(boards.length).toBeGreaterThan(0);
    // Ход должен стоять у каждого запомненного борда, иначе мера устаревания
    // молча превращается в ноль и картинка выглядит свежей.
    for (const playerId of boards) {
      const turn = final.lastSeenBoardTurns[Number(playerId)];
      expect(turn).toBeGreaterThan(0);
      expect(turn).toBeLessThanOrEqual(final.turn);
    }
  });
});
