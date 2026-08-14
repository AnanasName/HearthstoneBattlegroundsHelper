import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../src/advisors/tavern/advisor.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { situationKey } from '../../src/live/advisor.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part13Game } from '../fixtures.js';

/**
 * part13 — пятая партия с оверлеем (14.08.2026, Хроми, 4-е место), первая
 * после цели-поля. Пять пунктов обратной связи — четыре скриншота из чата
 * плюс жалоба на молчание силы героя (`part13.expected.json`).
 */
describe('part13: сила Хроми, ключ выбора, дар магнита, заклинание-жертва', () => {
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
    text = part13Game();
    cards = loadCardIndex();
  }, 120_000);

  it('Хроми, 4-е место; сила активная и бесплатная', () => {
    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) reducer.step(event);
    const state = reducer.snapshot();

    expect(state.hero?.cardId).toBe('BG34_HERO_001');
    expect(state.finalPlace).toBe(4);
    // Фактура жалобы 1: «Мана в минуту» — HAS_ACTIVATE_POWER=1 без тега COST.
    expect(state.hero?.heroPowerCardId).toBe('BG34_HERO_001p');
    expect(state.hero?.heroPowerCost).toBeNull();
    expect(state.hero?.heroPowerHasActivate).toBe(true);
  });

  it('ход 5: раскопка видна и ранжирована, а её открытие — новое положение (жалоба 2)', () => {
    // Срез перед SendChoices id=2 — момент скриншота 16:07: три варианта
    // «Нового ростка» на экране, золото уже потрачено.
    const state = reduceTo('D 16:07:10.5417725');
    expect(state.turn).toBe(5);
    expect(state.phase).toBe('tavern');

    expect(state.openChoice?.id).toBe(2);
    expect(state.openChoice?.sourceCardId).toBe('BG33_101');
    expect(state.openChoice?.options.map((o) => o.cardId)).toEqual([
      'BG26_146',
      'BG25_001',
      'BGS_127',
    ]);

    // Жалоба была не «выбор ранжирован неверно», а «выбора не видно вовсе»:
    // открытие не меняло ключ положения, и советник не пересчитывался.
    expect(situationKey(state)).not.toBe(situationKey({ ...state, openChoice: null }));

    const advice = adviseTavern(state, { cards });
    expect(advice?.choice).toHaveLength(3);
  });

  it('ход 5: бесплатная сила советуется даже при нуле золота (жалоба 1)', () => {
    const state = reduceTo('D 16:07:10.5417725');
    expect(state.gold).toBe(0);
    expect(state.hero?.heroPowerUsedThisTurn).toBe(false);

    const advice = adviseTavern(state, { cards });
    const power = advice?.recommendations.find((r) => r.action === 'heroPower');
    expect(power?.cost).toBe(0);
    expect(power?.reason).toContain('обновляет витрину');
  });

  it('ход 19: рука-протез магнитится к меху БЕЗ перерождения, и носитель назван (жалобы 3–4)', () => {
    // Срез перед розыгрышем руки-протеза (16:21:13) — момент скриншота:
    // она куплена в руку, Rescue Bot уже перерождён прошлой такой же рукой.
    const state = reduceTo('D 16:21:13.1844756');
    expect(state.turn).toBe(19);
    expect(state.hand.some((m) => m.cardId === 'BG_DEEP_015')).toBe(true);

    const rescueBot = state.board.find((m) => m.cardId === 'BG36_854');
    expect(rescueBot?.reborn).toBe(true);

    const advice = adviseTavern(state, { cards });
    const play = advice?.recommendations.find(
      (r) => r.action === 'play' && r.minion?.cardId === 'BG_DEEP_015',
    );
    // Носитель назван (прежде на неполном борде он не назывался вовсе)
    // и дар не пропадает: перерождения у носителя ещё нет.
    expect(play?.magnetizeTo).toBeTruthy();
    expect(play?.magnetizeTo?.reborn).toBe(false);
  });

  it('ход 21: «Разделка туши» без нежити на борде не советуется (жалоба 5)', () => {
    const state = reduceTo('D 16:24:10.1798859');
    expect(state.turn).toBe(21);
    // Заклинание в витрине есть — его положила сила Хроми на этом же ходу.
    expect(state.shopSpells.some((s) => s.cardId === 'BG28_604')).toBe(true);
    // А нежити на борде нет: жертвы для «Destroy a friendly Undead» не найти.
    const races = (id: string): readonly string[] => cards.info(id)?.races ?? [];
    expect(state.board.every((m) => !races(m.cardId).includes('UNDEAD'))).toBe(true);

    const advice = adviseTavern(state, { cards });
    expect(advice?.recommendations.some((r) => r.spellCardId === 'BG28_604')).toBe(false);
  });
});
