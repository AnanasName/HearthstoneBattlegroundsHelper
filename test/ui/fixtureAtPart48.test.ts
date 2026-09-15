import { beforeAll, describe, expect, it } from 'vitest';

import { readFixtureGame } from '../../src/data/fixtureGames.js';
import { frameAt, parseClock, sliceLogByClock, type Frame, type LogSlice } from '../../src/ui/logSlice.js';

/**
 * Кадр part48 восстанавливается срезом лога — ровно тот, по которому шёл
 * разбор 07.09 (CLAUDE.md, «сороковая партия»): снят В СЕРЕДИНЕ хода,
 * между покупкой «Кратерного старателя» и его розыгрышем. Точка решения
 * этот кадр не воспроизводит: там золото целое 6/6, а карта ещё в витрине.
 * На кадре золото 0/6 и здоровье 30+12.
 */
describe('fixture:at на part48', () => {
  const CRATER_MINER = 'BG31_320';
  let text: string;
  let slice: LogSlice;
  let frame: Frame;

  beforeAll(() => {
    text = readFixtureGame(48)!;
    slice = sliceLogByClock(text, parseClock('13:12:57')!)!;
    frame = frameAt(slice);
  }, 240_000);

  it('кадр внутри партии', () => {
    expect(slice.inGame).toBe(true);
  });

  it('состояние на кадре совпадает с записанным разбором', () => {
    const { state } = frame;
    expect(state.phase).toBe('tavern');
    expect(state.gold).toBe(0);
    expect(state.goldTotal).toBe(6);
    expect(state.hand.map((m) => m.cardId)).toContain(CRATER_MINER);
    expect(state.hero).not.toBeNull();
    expect((state.hero!.health ?? 0) - state.hero!.damage).toBe(30);
    expect(state.hero!.armor).toBe(12);
  });

  it('точка решения того же хода — до покупки', () => {
    const point = frame.decisionPoint;
    expect(point).not.toBeNull();
    expect(point!.turn).toBe(frame.state.turn);
    expect(point!.gold).toBe(6);
    expect(point!.shop.map((m) => m.cardId)).toContain(CRATER_MINER);
  });

  it('покупка внутри минуты кадра видна с секундами', () => {
    const buy = frame.actions.find((t) => t.action.type === 'buy' && t.action.cardId === CRATER_MINER);
    expect(buy).toBeDefined();
    expect(buy!.time).toBe('13:12:53');
  });

  it('кадр из соседней партии в эту не попадает (урок part49)', () => {
    // Кадры part49 сняты в 13:53 и 13:57, а part48 идёт 13:09–13:33.
    expect(sliceLogByClock(text, parseClock('13:53')!)!.inGame).toBe(false);
  });
});
