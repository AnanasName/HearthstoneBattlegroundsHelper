import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { fixtureLogPaths, readFixtureGame } from '../../src/data/fixtureGames.js';
import { createBreather } from '../breather.js';

/**
 * Склейка сегментов партии даёт те же точки решения, что сегменты порознь.
 *
 * Сегмент после перезапуска клиента начинается дампом переподключения —
 * повторным CREATE_GAME, который перечисляет живые сущности заново,
 * а умерших за разрыв не называет. Редьюсер, читавший склейку подряд,
 * держал их прежние записи в PLAY: после шва на борду было 12–20 миньонов,
 * в витрине 10–16 (part1 ходы 15–21, part35 ходы 23–25, part41 ходы 27–29),
 * а точка решения хода шва пропадала вовсе (D023: part1 ходы 13 и 23,
 * part35 ход 21, part41 ход 25). Советы и расстановка на этих точках
 * считались по несуществующему столу.
 */
const cardsOf = (list: readonly { cardId: string }[]): string[] => list.map((m) => m.cardId);

const fingerprint = (t: TavernTurn): unknown => ({
  turn: t.turn,
  board: cardsOf(t.state.board),
  hand: cardsOf(t.state.hand),
  shop: cardsOf(t.state.shop),
  gold: t.state.gold,
  techLevel: t.state.techLevel,
  hero: t.state.hero?.cardId ?? null,
});

describe.each([1, 35, 41])('part%i: склейка сегментов', (part) => {
  it('точки решения склейки совпадают с точками сегментов порознь, включая ход шва', async () => {
    const segments = fixtureLogPaths(part);
    expect(segments.length).toBeGreaterThan(1);
    const breather = createBreather();
    const stitched = await readTavernTurnsAsync(readFixtureGame(part) ?? '', breather);
    const separate: TavernTurn[] = [];
    for (const path of segments) {
      separate.push(...(await readTavernTurnsAsync(readFileSync(path, 'utf8'), breather)));
    }
    expect(stitched.map(fingerprint)).toEqual(separate.map(fingerprint));
    for (const t of stitched) {
      expect(t.state.board.length).toBeLessThanOrEqual(7);
    }
  }, 900_000);
});
