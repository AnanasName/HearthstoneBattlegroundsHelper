import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, type Recommendation } from '../../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../../src/data/cards.js';
import { readPowerEvents } from '../../../src/parser/blocks.js';
import { readPlayers } from '../../../src/state/players.js';
import { createReducer } from '../../../src/state/reducer.js';
import type { GameState } from '../../../src/state/types.js';
import { recommendationLine } from '../../../src/ui/format.js';
import { parseClock, sliceLogByClock } from '../../../src/ui/logSlice.js';
import { createBreather } from '../../breather.js';
import { part74Game } from '../../fixtures.js';

const MAW_CASTER = 'BG32_340';
const ETERNAL_KNIGHT = 'BG25_008';
const SCARLET_SKULL = 'BG25_022';
/** Тёмный дар «Deathrattle: Gain 2 free Refreshes». */
const FRESH_PERSPECTIVE = 'BG36_MidGameEffect_000t52e';

/** Scarlet Skull с даром: `HAS_DARK_GIFT=1` (game.log:74694), энчант 4905 (74667). */
const GIFTED_SKULL = 4904;
/** Та же карта без дара — её игрок и продал в 23:41:15 (game.log:106731). */
const PLAIN_SKULL = 4911;
/** Цель клича Maw Caster, выбранная игроком в 23:38:31 (game.log:69519). */
const DEATHSWARMER = 3592;

/**
 * Состояние на конец секунды кадра, с паузами для воркера: партия весит
 * 78 МБ, и синхронный разбор двух срезов держал бы поток дольше минуты.
 */
async function stateAt(text: string, clockText: string): Promise<GameState> {
  const clock = parseClock(clockText);
  if (clock === null) throw new Error(`часы ${clockText}`);
  const slice = sliceLogByClock(text, clock);
  if (slice === null || !slice.inGame) throw new Error(`кадр ${clockText} не в партии`);
  const reducer = createReducer(readPlayers(slice.text));
  const breather = createBreather();
  for (const event of readPowerEvents(slice.text)) {
    if (breather.due()) await breather.pause();
    reducer.step(event);
  }
  return reducer.snapshot();
}

const playOf = (recs: readonly Recommendation[], cardId: string): Recommendation | undefined =>
  recs.find((r) => r.action === 'play' && r.minion?.cardId === cardId);

/**
 * part74 — Тамсин (24.09.2026), 2-е место. Фактура партии — в `test/fixtures.ts`.
 *
 * Две жалобы игрока про одну и ту же карту — Scarlet Skull с тёмным даром
 * Fresh Perspective, доставшуюся раскопкой тёмного дара на ходу 7.
 *
 * Кадр 23:41 дословно: «предлагает продать карту, у которой полезный
 * эффект, хотя рядом есть аналогичная с менее полезным». На борде две
 * Scarlet Skull 7/1 с перерождением, по шкале равные (19.0), и ничья
 * решалась местом: продавалась левая — та, что с даром. Игрок продал правую.
 *
 * Кадр 23:38 дословно: «не показывает, на какую карту лучше применить
 * существо, которое я только купил». Maw Caster — «Battlecry: Destroy
 * a friendly Undead to Discover an Undead», а совет «РАЗЫГРАТЬ Maw Caster
 * 5/5» жертвы не называл. Игрок отдал Nerubian Deathswarmer 2/4 — клич его
 * уже отыгран, — а не наименьшую Scarlet Skull 3/1, которая с даром.
 */
describe('part74: тёмный дар при выборе жертвы', () => {
  let cards: CardIndex;
  let skulls: GameState;
  let maw: GameState;

  beforeAll(async () => {
    cards = loadCardIndex();
    const text = part74Game();
    skulls = await stateAt(text, '23:41:10');
    maw = await stateAt(text, '23:38:25');
  }, 600_000);

  it('кадр 23:41 воспроизводится: две Scarlet Skull 7/1, дар у левой', () => {
    // С картинки: «ход 15 · таверна · тир 4 · золото 0/10 · hp 23», семь на борде.
    expect(skulls.turn).toBe(15);
    expect(skulls.techLevel).toBe(4);
    expect(skulls.gold).toBe(0);
    expect(skulls.board).toHaveLength(7);
    const both = skulls.board.filter((m) => m.cardId === SCARLET_SKULL);
    expect(both.map((m) => [m.entityId, m.attack, m.health, m.reborn])).toEqual([
      [GIFTED_SKULL, 7, 1, true],
      [PLAIN_SKULL, 7, 1, true],
    ]);
    const gifts = (id: number): string[] =>
      skulls.board.find((m) => m.entityId === id)?.enchantments.map((e) => e.cardId) ?? [];
    expect(gifts(GIFTED_SKULL)).toContain(FRESH_PERSPECTIVE);
    expect(gifts(PLAIN_SKULL)).not.toContain(FRESH_PERSPECTIVE);
    expect(skulls.hand.map((m) => m.cardId)).toContain(ETERNAL_KNIGHT);
  });

  it('23:41: розыгрыш Eternal Knight продаёт копию БЕЗ дара', () => {
    const recs = adviseTavern(skulls, { cards })?.recommendations ?? [];
    const knight = playOf(recs, ETERNAL_KNIGHT);
    expect(knight?.sellFirst?.cardId).toBe(SCARLET_SKULL);
    expect(knight?.sellFirst?.entityId).toBe(PLAIN_SKULL);
  });

  it('23:41: план хода продаёт ту же копию', () => {
    const steps = spendPlan(skulls, { cards }).steps.map((s) => s.recommendation);
    const sold = steps.map((r) => r.sellFirst?.entityId).filter((id) => id !== undefined);
    expect(sold).toContain(PLAIN_SKULL);
    expect(sold).not.toContain(GIFTED_SKULL);
  });

  it('кадр 23:38 воспроизводится: Maw Caster в руке, три своих нежити', () => {
    // С картинки: «ход 13 · таверна · тир 4 · золото 0/9 · hp 30+3».
    expect(maw.turn).toBe(13);
    expect(maw.techLevel).toBe(4);
    expect(maw.gold).toBe(0);
    expect(maw.hand.map((m) => m.cardId)).toEqual([MAW_CASTER]);
    expect(maw.board.map((m) => m.entityId)).toContain(DEATHSWARMER);
  });

  it('23:38: РАЗЫГРАТЬ Maw Caster называет жертву — Nerubian Deathswarmer, а не Scarlet Skull с даром', () => {
    const recs = adviseTavern(maw, { cards })?.recommendations ?? [];
    const play = playOf(recs, MAW_CASTER);
    expect(play?.targetMinion?.entityId).toBe(DEATHSWARMER);
    // Жертва погибает насовсем: перерождения у неё нет.
    expect(play?.destroysTarget).toEqual({ rebornCopy: null });
    expect(recommendationLine(play!, cards)).toContain('→ на Nerubian Deathswarmer');
  });
});
