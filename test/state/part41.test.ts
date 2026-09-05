import { beforeAll, describe, expect, it } from 'vitest';

import { cardRallyCarriers } from '../../src/advisors/position/rallySwing.js';
import { adviseTavern } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { buildView } from '../../src/overlay/view.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part41Segment } from '../fixtures.js';

/**
 * part41 — первая партия, сыгранная с МЕТКАМИ поверх карт игры
 * (05.09.2026, Дорнозму Освобождённый, 3-е место). Пять пунктов игрока,
 * и все пять про новый слой оверлея.
 *
 * Скриншоты сняты в середине хода, поэтому состояния восстанавливаются
 * срезом лога по времени — тем же приёмом, что в part40.
 */
describe('part41: метки поверх карт — ряд витрины, кнопки, лавка и раж', () => {
  let text: string;
  let cards: CardIndex;

  beforeAll(() => {
    text = part41Segment(1);
    cards = loadCardIndex();
  }, 120_000);

  /** Состояние на конец указанной секунды лога. */
  const reduceTo = (second: string): GameState => {
    const lines = text.split(/\r?\n/);
    let cut = lines.length;
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^D (\d\d:\d\d:\d\d)/.exec(lines[i] ?? '');
      if (m !== null && (m[1] as string) > second) {
        cut = i;
        break;
      }
    }
    expect(cut, `в логе должны быть строки после ${second}`).toBeLessThan(lines.length);
    const slice = lines.slice(0, cut).join('\n');
    const reducer = createReducer(readPlayers(slice));
    for (const event of readPowerEvents(slice)) reducer.step(event);
    return reducer.snapshot();
  };

  /** Вид оверлея на этом состоянии — с планом трат, как в живом режиме. */
  const view = (state: GameState) => {
    const tavern = adviseTavern(state, { cards });
    return buildView(
      { state, tavern, spendPlan: spendPlan(state, { cards }), thinking: false, position: null },
      cards,
    );
  };

  it('ход 5: заклинание витрины стоит ТРЕТЬИМ в ряду из четырёх карт', () => {
    // Скриншот 01:16: тир 2, золото 2/5, витрина «Lullabot · Glim Guardian ·
    // Recruit a Trainee · Mind Muck». Позиции в зоне сквозные, и заклинание
    // стоит между миньонами — «последнее заклинание» было бы догадкой.
    const state = reduceTo('01:16:30');
    expect(state.turn).toBe(5);
    expect(state.gold).toBe(2);
    expect(state.shop.map((m) => m.zonePos)).toEqual([1, 2, 4]);
    expect(state.shopSpells).toHaveLength(1);
    expect(state.shopSpells[0]?.cardId).toBe('BG28_504');
    expect(state.shopSpells[0]?.zonePos).toBe(3);

    // Верхний совет — покупка этого заклинания, и теперь у неё есть кольцо.
    const v = view(state);
    expect(v.actions[0]?.text).toContain('Recruit a Trainee');
    const mark = v.marks.find((m) => m.row === 'shop');
    expect(mark?.count).toBe(4);
    expect(mark?.index).toBe(2);
  });

  it('ход 7: кольцо покупки садится по центру ряда из ПЯТИ карт', () => {
    // Скриншот 01:17: план «КУПИТЬ Enchanted Lasso за 2 → КУПИТЬ Tarecgosa
    // 4/4 за 3». Tarecgosa стоит третьей из пяти, то есть ровно по центру
    // стола; пока ряд считался по четырём миньонам, кольцо уезжало вправо
    // на полшага — это и есть «съехала обводка».
    const state = reduceTo('01:17:40');
    expect(state.turn).toBe(7);
    const v = view(state);

    const lasso = v.marks.find((m) => m.step === 1);
    const tarecgosa = v.marks.find((m) => m.step === 2);
    expect(lasso?.index).toBe(4);
    expect(lasso?.count).toBe(5);
    expect(tarecgosa?.index).toBe(2);
    expect(tarecgosa?.count).toBe(5);
    // Центр среднего слота нечётного ряда — центр стола.
    const center = tarecgosa!.rect.x + tarecgosa!.rect.w / 2;
    expect(center).toBeCloseTo(0.498, 3);
  });

  it('ход 9: кнопка подъёма помечена своим цветом, а карта — цветом покупки', () => {
    // Скриншот 01:18: план «ПОДНЯТЬ ТАВЕРНУ за 4 → КУПИТЬ Fleeing Fugitive
    // 5/2 за 3 → …». Зелёное кольцо на зелёно-золотой кнопке сливалось.
    const state = reduceTo('01:18:14');
    expect(state.turn).toBe(9);
    const v = view(state);

    expect(v.marks.find((m) => m.button === 'levelUp')?.tone).toBe('tavern');
    expect(v.marks.find((m) => m.row === 'shop' && m.step === 2)?.tone).toBe('buy');
    // Ряд снова из пяти: четыре миньона и «Alliance Flag».
    expect(v.marks.find((m) => m.row === 'shop')?.count).toBe(5);
  });

  it('ход 13: носитель ража, платящего картой, опознаётся на борде', () => {
    // Скриншот 01:22: борд «Bronze Timewalker 7/6 · Metallic Hunter 4/2 ·
    // Fleeing Fugitive 31/25 (зол) · Black Chromadrake 7/7 · Scarlet
    // Survivor 6/4», и советник увёз ражника на пятое место.
    const state = reduceTo('01:22:30');
    expect(state.turn).toBe(13);
    expect(state.board.map((m) => m.cardId)[0]).toBe('BG36_242');

    // Справочник симулятора здесь не нужен: проверяется, что карта партии
    // попадает в класс, ради которого правило и заведено.
    const fake = {
      getCard: (id: string) => ({ id, text: cards.info(id)?.text ?? '', name: cards.info(id)?.name ?? id }),
    } as never;
    expect(cardRallyCarriers(state.board, fake).map((m) => m.cardId)).toEqual(['BG36_242']);
  });

  it('ход 17: лавка аксессуаров помечает советуемый вариант по порядку экрана', () => {
    // Скриншот 01:26: «Путеводная свеча · Восковое копьё · Удочка Пэгла ·
    // Чешуя волшебного дракона», советник ставит первой «Чешую» (упоминает
    // DRAGON, своих 5). На экране она ЧЕТВЁРТАЯ, а в `trinketOffer` —
    // вторая: порядок знает только канал выборов.
    const state = reduceTo('01:26:20');
    expect(state.turn).toBe(17);
    expect(state.trinketOffer.map((t) => t.cardId)).toEqual([
      'BG30_MagicItem_993',
      'BG32_MagicItem_363',
      'BG36_MagicItem_309',
      'BG32_MagicItem_366',
    ]);
    expect(state.openChoice?.options.map((o) => o.cardId)).toEqual([
      'BG32_MagicItem_366',
      'BG36_MagicItem_309',
      'BG30_MagicItem_993',
      'BG32_MagicItem_363',
    ]);
    // Позиции в зоне у тринкетов нет вовсе — потому и канал выборов.
    expect(state.trinketOffer.every((t) => t.entityId > 0)).toBe(true);

    const v = view(state);
    expect(v.actions[0]?.text).toContain('Faerie Dragon Scale');
    expect(v.marks).toHaveLength(1);
    expect(v.marks[0]?.row).toBe('trinket');
    expect(v.marks[0]?.index).toBe(3);
    expect(v.marks[0]?.count).toBe(4);
    expect(v.marks[0]?.label).toBe('ВЗЯТЬ · 3');
  });
});
