import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../src/advisors/tavern/advisor.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { recommendationLine } from '../../src/ui/format.js';
import { part12Game } from '../fixtures.js';

/**
 * part12 — четвёртая партия с оверлеем (14.08.2026, E.T.C., 2-е место),
 * три пункта обратной связи по трём скриншотам из чата
 * (`part12.expected.json`).
 */
describe('part12: сила E.T.C., племя тринкета тегом, цель заклинания', () => {
  let text: string;
  let cards: CardIndex;

  const reduceTo = (mark: string): GameState => {
    const cut = text.indexOf(mark);
    expect(cut, `метка ${mark} должна быть в логе`).toBeGreaterThan(0);
    const slice = text.slice(0, cut);
    const reducer = createReducer(readPlayers(slice));
    for (const event of readPowerEvents(slice)) reducer.step(event);
    return reducer.snapshot();
  };

  beforeAll(() => {
    text = part12Game();
    cards = loadCardIndex();
  }, 120_000);

  it('E.T.C., 2-е место', () => {
    const slice = text;
    const reducer = createReducer(readPlayers(slice));
    for (const event of readPowerEvents(slice)) reducer.step(event);
    const state = reducer.snapshot();
    expect(state.hero?.cardId).toBe('BG25_HERO_105');
    expect(state.finalPlace).toBe(2);
  });

  it('сила «Discover a Buddy» советуется при золоте на неё (жалоба 1)', () => {
    // Момент скриншота: ход 7, золото 6, сила за 3 доступна — совет молчал,
    // потому что в тексте силы нет слова «minion».
    const state = reduceTo('D 14:03:0');
    expect(state.turn).toBe(7);
    expect(state.hero?.heroPowerCost).toBe(3);
    expect(state.hero?.heroPowerUsedThisTurn).toBe(false);

    const power = adviseTavern(state, { cards })?.recommendations.find(
      (r) => r.action === 'heroPower',
    );
    expect(power).toBeDefined();
    expect(power?.reason).toContain('даёт миньона');
  });

  it('племя тринкета читается тегом: компас с плейсхолдером видит драконов (жалоба 2)', () => {
    // «Разноцветный компас»: в тексте снапшота «Get a random {0}», и текстовый
    // разбор её не видел — «эффект вне племён». Тег BACON_SUBSET_DRAGON
    // называет племя прямо.
    const state = reduceTo('D 14:06:1');
    expect(state.turn).toBe(11);
    const compass = state.trinketOffer.find((o) => o.cardId === 'BG30_MagicItem_426');
    expect(compass?.subsetRaces).toContain('DRAGON');

    const advice = adviseTavern(state, { cards });
    const compassAdvice = advice?.trinkets.find((t) => t.offer.cardId === 'BG30_MagicItem_426');
    expect(compassAdvice?.tribeMinions).toBeGreaterThan(0);
    expect(compassAdvice?.reason).toContain('DRAGON');
  });

  it('заклинание-усиление называет цель прямо в строке совета (жалоба 3)', () => {
    // «РАЗЫГРАТЬ Fortify» без цели перекладывал выбор на игрока. Теперь
    // строка действия несёт цель: «→ на <крупнейший свой>».
    const state = reduceTo('D 14:09:1');
    expect(state.turn).toBe(13);

    const advice = adviseTavern(state, { cards });
    const fortify = advice?.recommendations.find((r) => r.spellCardId === 'BG28_503');
    expect(fortify).toBeDefined();
    expect(fortify?.targetMinion).not.toBeNull();
    expect(recommendationLine(fortify ?? advice!.recommendations[0]!, cards)).toContain('→ на');
  });
});
