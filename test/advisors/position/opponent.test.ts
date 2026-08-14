import { describe, expect, it } from 'vitest';

import { resolveOpponent, resolveTarget } from '../../../src/advisors/position/opponent.js';
import { readTavernTurns } from '../../../src/advisors/tavern/turns.js';
import { EMPTY_STATE, type GameState } from '../../../src/state/types.js';
import { minion } from '../../minions.js';
import { part3Game } from '../../fixtures.js';
import { readPowerEvents } from '../../../src/parser/blocks.js';
import { readPlayers } from '../../../src/state/players.js';
import { createReducer } from '../../../src/state/reducer.js';

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

describe('цель счёта: один противник или поле', () => {
  it('когда противник известен и виден — цель-один, поле не подменяет его', () => {
    const target = resolveTarget(
      state({
        phase: 'tavern',
        turn: 11,
        nextOpponentPlayerId: 7,
        lastSeenBoards: { 3: [minion(1)], 7: [minion(2), minion(3)] },
        lastSeenBoardTurns: { 3: 6, 7: 5 },
      }),
    );

    expect(target?.kind).toBe('single');
    if (target?.kind === 'single') expect(target.opponent.playerId).toBe(7);
  });

  it('следующего не видели, но другие борды есть — цель-поле из всех виденных', () => {
    const target = resolveTarget(
      state({
        phase: 'tavern',
        turn: 9,
        nextOpponentPlayerId: 7,
        lastSeenBoards: { 5: [minion(1)], 3: [minion(2), minion(3)], 8: [] },
        lastSeenBoardTurns: { 5: 8, 3: 4 },
      }),
    );

    expect(target?.kind).toBe('field');
    if (target?.kind !== 'field') return;
    // Пустой борд игрока 8 в поле не входит: против пустоты считать нечего.
    expect(target.boards).toHaveLength(2);
    // Порядок фиксирован по PlayerID: от него зависят раздача симуляций
    // и зёрна, а совет обязан быть воспроизводимым.
    expect(target.boards.map((b) => b.playerId)).toEqual([3, 5]);
    expect(target.boards.map((b) => b.staleTurns)).toEqual([5, 1]);
  });

  it('ни противника, ни бордов — считать не на чем', () => {
    expect(resolveTarget(state({ phase: 'tavern', turn: 2 }))).toBeNull();
    expect(
      resolveTarget(state({ phase: 'tavern', turn: 4, nextOpponentPlayerId: 7 })),
    ).toBeNull();
  });

  it('в бою цель-один с живым бордом, как раньше', () => {
    const target = resolveTarget(
      state({
        phase: 'combat',
        turn: 10,
        opponentBoard: [minion(1), minion(2)],
        currentOpponentPlayerId: 5,
        lastSeenBoards: { 6: [minion(9)] },
        lastSeenBoardTurns: { 6: 4 },
      }),
    );

    expect(target?.kind).toBe('single');
    if (target?.kind === 'single') expect(target.opponent.source).toBe('combat');
  });
});

describe('цель-поле на реальной партии', () => {
  it('первая половина партии перестаёт быть немой', () => {
    // Ради этого всё и затевалось: до 13-го хода следующий противник ни разу
    // не из числа виденных (замерено на обеих полных фикстурах), и цель-один
    // молчала всю первую половину партии. Поле из виденных бордов появляется
    // после первого же боя — и с ним появляется цель.
    const turns = readTavernTurns(part3Game()).filter(({ state: s }) => s.board.length >= 2);
    expect(turns.length).toBeGreaterThan(5);

    const singleOnly = turns.filter(({ state: s }) => resolveOpponent(s).usable);
    const withTarget = turns.filter(({ state: s }) => resolveTarget(s) !== null);
    const fieldOnly = turns.filter(
      ({ state: s }) => !resolveOpponent(s).usable && resolveTarget(s)?.kind === 'field',
    );

    // Поле обязано добавлять ходы, а не переименовывать старые.
    expect(fieldOnly.length).toBeGreaterThan(0);
    expect(withTarget.length).toBe(singleOnly.length + fieldOnly.length);
    expect(withTarget.length).toBeGreaterThan(singleOnly.length);

    // Каждый борд поля непуст и помечен возрастом — без возраста устаревший
    // снимок выглядит так же достоверно, как свежий.
    for (const { state: s } of fieldOnly) {
      const target = resolveTarget(s);
      if (target?.kind !== 'field') continue;
      for (const seen of target.boards) {
        expect(seen.board.length).toBeGreaterThan(0);
        expect(seen.seenOnTurn).not.toBeNull();
        expect(seen.staleTurns).toBeGreaterThanOrEqual(0);
      }
    }
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
