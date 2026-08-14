import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, freezeRule, lobbyRaces, playRules } from '../../src/advisors/tavern/advisor.js';
import { readTavernTurns, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part11Game } from '../fixtures.js';

/**
 * part11 — третья партия с оверлеем (14.08.2026, Сильвана, 3-е место),
 * семь пунктов обратной связи. Контрольные значения — из советов на экране
 * игрока (`part11.expected.json`).
 *
 * Часть моментов — «после трат», между точками решения: их ловит
 * `reduceUntil` — прокрутка лога до первого состояния с нужными признаками.
 */
describe('part11: заряды дара, смертники из гробницы, заклинания витрины', () => {
  let text: string;
  let cards: CardIndex;
  let turns: TavernTurn[];

  const reduceTo = (slice: string): GameState => {
    const reducer = createReducer(readPlayers(slice));
    for (const event of readPowerEvents(slice)) reducer.step(event);
    return reducer.snapshot();
  };

  /** Первое состояние, удовлетворяющее предикату. Снимки прорежены — дорогие. */
  const reduceUntil = (want: (s: GameState) => boolean): GameState => {
    const reducer = createReducer(readPlayers(text));
    let events = 0;
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      events += 1;
      const { content } = event.line;
      if (!content.includes('RESOURCES_USED') && !content.includes('ZONE')) continue;
      if (events % 7 !== 0) continue;
      const s = reducer.snapshot();
      if (want(s)) return s;
    }
    throw new Error('состояние по предикату не нашлось');
  };

  beforeAll(() => {
    text = part11Game();
    cards = loadCardIndex();
    turns = readTavernTurns(text);
  }, 120_000);

  it('Сильвана, сила за 2 советуется как дающая миньона, итог — 3-е место', () => {
    const state = reduceTo(text);
    expect(state.hero?.cardId).toBe('BG23_HERO_306');
    expect(state.finalPlace).toBe(3);

    // «Reclaimed Souls» даёт миньона — совет по силе живёт и у Сильваны.
    const turn5 = turns.find((t) => t.turn === 5);
    const power = adviseTavern(turn5?.state ?? state, { cards })?.recommendations.find(
      (r) => r.action === 'heroPower',
    );
    expect(power).toBeDefined();
  });

  it('заряды тёмного дара: после третьего использования совет умолкает (жалоба 6)', () => {
    // TAG_SCRIPT_DATA_NUM_2 на кнопке: 3 → 2 → 1 → 0 по нажатиям.
    const turn5 = turns.find((t) => t.turn === 5);
    expect(turn5?.state.darkGiftCost).toBe(3);

    const turn21 = turns.find((t) => t.turn === 21);
    expect(turn21).toBeDefined();
    expect(turn21?.state.darkGiftCost).toBeNull();
    const gift = adviseTavern(turn21?.state ?? reduceTo(text), { cards })?.recommendations.find(
      (r) => r.action === 'darkGift',
    );
    expect(gift).toBeUndefined();
  });

  it('карта из гробницы не советуется в ход получения без хрипа (жалоба 7)', () => {
    // Срез после выбора из «Восстания из гробницы»: в руке карты с энчантом
    // TB_BaconShopBadsongE. Свежие (NUM_TURNS_IN_HAND=1) без хрипа молчат,
    // отлежавшие ход и с хрипом — советуются.
    const cut = text.indexOf('D 03:43:2');
    expect(cut).toBeGreaterThan(0);
    const state = reduceTo(text.slice(0, cut));

    const doomed = state.hand.filter((m) =>
      m.enchantments.some((e) => e.cardId === 'TB_BaconShopBadsongE'),
    );
    expect(doomed.length).toBeGreaterThan(0);

    const plays = playRules(state, { cards });
    for (const p of plays) {
      const minion = p.minion;
      if (minion === null) continue;
      const fresh =
        minion.enchantments.some((e) => e.cardId === 'TB_BaconShopBadsongE') &&
        (minion.tags['NUM_TURNS_IN_HAND'] ?? 1) <= 1;
      if (!fresh) continue;
      // Свежий смертник в советах — только ради хрипа или перерождения.
      const info = cards.info(minion.cardId);
      expect(
        minion.reborn || (info?.mechanics.some((m) => m === 'DEATHRATTLE' || m === 'REBORN') ?? false),
      ).toBe(true);
      expect(p.reason).toContain('умрёт при розыгрыше');
    }
  });

  it('заклинания витрины видны и советуются (жалоба 3)', () => {
    // Монетка таверны в витрине за 1 — CARDTYPE=BATTLEGROUND_SPELL.
    const turn3 = turns.find((t) => t.turn === 3);
    expect(turn3?.state.shopSpells.some((s) => s.cardId === 'BG28_810' && s.cost === 1)).toBe(
      true,
    );

    // Момент жалобы 5: ход 19, после трат осталось 5 золота — прежний совет
    // «НИЧЕГО». Теперь первым идёт покупка баффа из витрины.
    const state = reduceUntil((s) => s.phase === 'tavern' && s.turn === 19 && s.gold === 5);
    const advice = adviseTavern(state, { cards });
    const top = advice?.recommendations[0];
    expect(top?.action).not.toBe('pass');
    expect(top?.spellCardId).toBeDefined();
    expect(top?.reason).toContain('усиление');
  });

  it('в ход подъёма заморозка ради племени молчит (жалоба 2)', () => {
    // Ход 9: игрок поднял таверну на третий тир и потратился в ноль;
    // прежний совет — «ЗАМОРОЗИТЬ Shell Collector» ради двух наг.
    const state = reduceUntil(
      (s) => s.phase === 'tavern' && s.turn === 9 && s.techLevel === 3 && s.gold === 0,
    );
    expect(state.techLevelUpTurn).toBe(9);
    expect(freezeRule(state, { cards })).toBeNull();
  });

  it('состав племён по витрине: пять племён партии, фантомы отсеяны', () => {
    // Сырые теги CARDRACE в part11 называют и MECHANICAL, и DRAGON — оба
    // фантомы от двуплеменных карт пула: «Рука-протез» (MECH/UNDEAD, в пуле
    // из-за нежити) и Firescale Hoarder (DRAGON/NAGA, в пуле из-за наг).
    // Состав по однoплеменным миньонам витрины даёт ровно пять настоящих
    // племён партии.
    const state = reduceTo(text);
    expect(state.seenShopCardIds.length).toBeGreaterThan(10);

    const races = lobbyRaces(state, cards);
    expect([...races].sort()).toEqual(['DEMON', 'MURLOC', 'NAGA', 'QUILBOAR', 'UNDEAD']);
  });
});
