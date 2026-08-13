import { beforeAll, describe, expect, it } from 'vitest';

import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part8Game } from '../fixtures.js';

/**
 * part8 — партия за Скаббса Маслореза (BG21_HERO_010, билд 248348),
 * сыгранная игроком специально для фактуры активной силы героя: во всех
 * прежних фикстурах сила не была нажата ни разу, и как выглядит её
 * применение в логе, было неизвестно.
 *
 * Контрольные значения сверены с логом руками: сила «I Spy» стоит 2,
 * нажата 10 раз (10 блоков `BlockType=PLAY` на её сущности id=136),
 * тег `EXHAUSTED` не встречается ни разу.
 */
describe('сила героя и блокировки на part8', () => {
  let text: string;

  const reduceTo = (slice: string): GameState => {
    const reducer = createReducer(readPlayers(slice));
    for (const event of readPowerEvents(slice)) reducer.step(event);
    return reducer.snapshot();
  };

  beforeAll(() => {
    text = part8Game();
  }, 120_000);

  it('цена силы читается из тега COST', () => {
    const state = reduceTo(text);
    expect(state.hero?.heroPowerCardId).toBe('BG21_HERO_010p');
    expect(state.hero?.heroPowerCost).toBe(2);
  });

  it('нажатие силы видно по блоку PLAY и держится до конца хода', () => {
    // Первое нажатие — 21:44:59. Отрезаем лог сразу после начала блока
    // (плюс кусок его содержимого) и смотрим состояние в этот момент.
    const press = text.indexOf('BlockType=PLAY Entity=[entityName');
    const pressAt = text.indexOf('cardId=BG21_HERO_010p player=4] EffectCardId');
    expect(pressAt).toBeGreaterThan(0);
    expect(press).toBeGreaterThan(0);

    const cut = text.indexOf('\n', pressAt + 4000);
    const state = reduceTo(text.slice(0, cut));

    expect(state.hero?.heroPowerUsedThisTurn).toBe(true);
  });

  it('к точке решения следующего хода флаг нажатия сброшен', () => {
    // Конец партии — заведомо другой ход, чем любое нажатие силы.
    const state = reduceTo(text);
    expect(state.hero?.heroPowerUsedThisTurn).toBe(false);
  });

  it('кнопка тёмного дара несёт цену, и цена читается', () => {
    // Кнопка создаётся с COST=3 (сущность 308, сверено с логом руками).
    const creation = text.indexOf('CardID=BG36_Button_DarkGift');
    const cut = text.indexOf('\n', creation + 2000);
    const state = reduceTo(text.slice(0, cut));

    expect(state.darkGiftCost).toBe(3);
  });

  it('заблокированная карта в руке несёт LITERALLY_UNPLAYABLE', () => {
    // Polarizing Beatboxer 5/10, выдан тринкетом с замком: ровно тот случай,
    // где советник предлагал разыграть то, что разыграть нельзя.
    const locked = text.indexOf('tag=LITERALLY_UNPLAYABLE value=1');
    let cut = locked;
    // Ищем момент, когда карта уже в руке с блокировкой: от первого
    // упоминания тега двигаемся вперёд, пока она не окажется в HAND.
    for (let i = 0; i < 40; i += 1) {
      cut = text.indexOf('\n', cut + 200_000);
      if (cut === -1) break;
      const state = reduceTo(text.slice(0, cut));
      const lockedInHand = state.hand.find(
        (m) => (m.tags['LITERALLY_UNPLAYABLE'] ?? 0) > 0,
      );
      if (lockedInHand !== undefined) {
        expect(lockedInHand.cardId).toBe('BG26_149');
        return;
      }
    }
    throw new Error('заблокированная карта в руке не нашлась ни в одном срезе');
  });
});
