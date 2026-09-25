import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import type { GameState } from '../../src/state/types.js';
import { frameAt, parseClock, sliceLogByClock } from '../../src/ui/logSlice.js';
import { createBreather } from '../breather.js';
import { part72Game } from '../fixtures.js';

/** Leaf Through the Pages: «Gain 2 free Refreshes». */
const LEAF = 'BG28_827';
/** Tricky Trousers: «Give a minion +{0}/+{1} and Taunt». */
const TROUSERS = 'BG28_520';

/**
 * part72 — Иллидан (24.09.2026), 6-е место. Фактура партии — в `test/fixtures.ts`.
 *
 * Вопрос игрока по кадру 19:40 дословно: «не очень понимаю, почему
 * заклинание надо разыгрывать именно в этот момент». На кадре золото 0/10,
 * в руке Leaf Through the Pages за 0, и верхний совет — «РАЗЫГРАТЬ Leaf
 * Through the Pages (6.0) ← 2 бесплатных обновлений по 1, запас не сгорает».
 *
 * Причина совета названа в нём самом, и она же его опровергает: запас
 * не сгорает, значит, обновления, положенные в него без золота, ждали бы
 * хода с золотом — это правило D244 для запаса («запасное бесплатное
 * обновление ждёт хода с золотом», part57). Но и карта в руке не сгорает.
 * Розыгрыш без золота на покупку не даёт ничего, кроме повода нажать
 * обновление, которое советник сам же тратить запрещает. Игрок держал
 * карту до хода 15 и сыграл её при 11 золотых, сразу потратив оба
 * обновления (D289).
 */
describe('part72: бесплатные обновления из руки при нуле золота', () => {
  let cards: CardIndex;
  let turns: TavernTurn[];
  let frame: GameState;

  beforeAll(async () => {
    cards = loadCardIndex();
    turns = await readTavernTurnsAsync(part72Game(), createBreather());
    const clock = parseClock('19:40:36');
    expect(clock).not.toBeNull();
    const slice = sliceLogByClock(part72Game(), clock!);
    expect(slice?.inGame).toBe(true);
    frame = frameAt(slice!).state;
  }, 600_000);

  const at = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    if (found === undefined) throw new Error(`нет точки решения на ходу ${String(turn)}`);
    return found.state;
  };

  it('кадр 19:40 воспроизводится: ход 13, тир 4, золото 0, Leaf за 0 в руке', () => {
    // Числа с картинки игрока: «ход 13 · таверна · тир 4 · золото 0/10 · hp 30+12».
    expect(frame.turn).toBe(13);
    expect(frame.techLevel).toBe(4);
    expect(frame.gold).toBe(0);
    expect(frame.goldTotal).toBe(10);
    expect(frame.handSpells.map((s) => [s.cardId, s.cost])).toEqual([[LEAF, 0]]);
  });

  it('без золота на покупку Leaf не советуется: совет — ничего', () => {
    const recs = adviseTavern(frame, { cards })?.recommendations ?? [];
    expect(recs.find((r) => r.spellCardId === LEAF)).toBeUndefined();
    expect(recs[0]?.action).toBe('pass');
  });

  it('ход 9: план не кладёт Leaf на последний золотой', () => {
    // Золото 7: две покупки по 3 — и остаётся 1. Прежде план ставил туда
    // «РАЗЫГРАТЬ Leaf Through the Pages» перед Tricky Trousers за 1:
    // два обновления, на находки которых не хватает ни на что. Игрок
    // в этот ход сделал ровно покупки и Trousers, карту придержал.
    //
    // Последний золотой с D308 (part79) план кладёт в активацию Suspicious
    // Prisonguard (+3/+3 на Cord Puller, 3.0), а не в Trousers (+2/+1
    // и провокация, 2.5): нажатие больше не платит цену дважды. Этот тест
    // о Leaf, и держит он одно: золотой уходит в усиление, а не в карту.
    const steps = spendPlan(at(9), { cards }).steps.map((s) => s.recommendation);
    expect(steps.map((r) => r.minion?.cardId ?? r.spellCardId)).not.toContain(LEAF);
    expect(steps.filter((r) => r.action === 'buy' && r.minion !== null)).toHaveLength(2);
    const last = steps.at(-1);
    expect(last?.cost).toBe(1);
    expect(last?.action === 'activate' || last?.spellCardId === TROUSERS).toBe(true);
  });

  it('ход 15: при 11 золотых Leaf советуется — там, где игрок его и сыграл', () => {
    const recs = adviseTavern(at(15), { cards })?.recommendations ?? [];
    const leaf = recs.find((r) => r.spellCardId === LEAF);
    expect(leaf?.action).toBe('play');
    expect(leaf?.grantsFreeRefreshes).toBe(2);
  });
});
