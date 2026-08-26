import { beforeAll, describe, expect, it } from 'vitest';

import { copiesForTriple, minionValue } from '../../src/advisors/tavern/advisor.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState, Minion } from '../../src/state/types.js';
import { part7Game } from '../fixtures.js';

/**
 * part7 — партия игрока за Double Time (`BG34_HERO_002`, 7-е место, билд
 * 248348), и она отвечает на вопрос, который до 26.08 никто не задавал:
 * СКОЛЬКО КОПИЙ собирают золотого.
 *
 * Наши правила считали три — правило игры, записанное константой. Сила
 * этого героя обещает «You only need 2 copies to make minions Golden»,
 * и лог подтверждает обещание: все три золотых партии собрались при ДВУХ
 * простых копиях. Контроль снят на обычных героях (part17, part19 — сила
 * «Feel Devastation»): там золотые собираются при трёх, то есть двойка
 * здесь — свойство героя, а не артефакт замера.
 *
 * Пока порог был константой, 12 очков «собирает тройку» стояли на второй
 * копии — на ход позже, чем надо, — и целую партию советник систематически
 * недооценивал ПЕРВУЮ копию.
 */
describe('part7: Double Time собирает золотого из двух копий', () => {
  let text: string;
  let cards: CardIndex;

  /** Базовая карта: золотые в этом логе идут с суффиксом `_G`. */
  const base = (cardId: string): string => cardId.replace(/_G$/, '');

  interface Golden {
    readonly cardId: string;
    readonly turn: number;
    /** Максимум простых копий, виденных до появления золотого. */
    readonly plainBefore: number;
  }

  /**
   * Когда в партии появлялись золотые и сколько простых копий было до этого.
   *
   * Максимум, а не состояние на предыдущем событии: копии исчезают в том же
   * пакете событий, в котором появляется золотой, и «сколько было» иначе
   * читается нулём.
   */
  function goldensOf(slice: string): Golden[] {
    const reducer = createReducer(readPlayers(slice));
    const maxPlain = new Map<string, number>();
    const seen = new Set<string>();
    const found: Golden[] = [];

    for (const event of readPowerEvents(slice)) {
      reducer.step(event);
      const state = reducer.snapshot();
      const plain = new Map<string, number>();
      const golden = new Set<string>();
      for (const m of [...state.board, ...state.hand]) {
        if (m.golden || m.cardId.endsWith('_G')) golden.add(base(m.cardId));
        else plain.set(base(m.cardId), (plain.get(base(m.cardId)) ?? 0) + 1);
      }
      for (const [id, n] of plain) maxPlain.set(id, Math.max(maxPlain.get(id) ?? 0, n));
      for (const id of golden) {
        if (seen.has(id)) continue;
        seen.add(id);
        found.push({ cardId: id, turn: state.turn, plainBefore: maxPlain.get(id) ?? 0 });
      }
    }
    return found;
  }

  let goldens: Golden[];
  let final: GameState;

  beforeAll(() => {
    text = part7Game();
    cards = loadCardIndex();
    goldens = goldensOf(text);
    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) reducer.step(event);
    final = reducer.snapshot();
  }, 300_000);

  it('герой партии — Double Time', () => {
    expect(final.hero?.cardId).toBe('BG34_HERO_002');
    expect(final.hero?.heroPowerCardId).toBe('BG34_HERO_002p');
    // Сила пассивная: нажимать нечего, и все три правила-действия молчат
    // законно. Читать из неё можно только текст.
    expect(final.hero?.heroPowerHasActivate).toBe(false);
    expect(cards.info('BG34_HERO_002p')?.text ?? '').toMatch(/only need 2 copies/i);
  });

  it('все золотые партии собрались из ДВУХ копий', () => {
    // Золотые, пришедшие не сборкой (награда за тройку, находка), в счёт
    // не идут: у них своя карта, а не суффикс `_G` от наших копий.
    const assembled = goldens.filter((g) => g.plainBefore > 0);
    expect(assembled.length).toBe(3);
    for (const g of assembled) expect(g.plainBefore).toBe(2);
  });

  it('порог тройки читается из силы героя, а не из константы', () => {
    expect(copiesForTriple(final, cards)).toBe(2);
    // Контроль: у обычного героя порог прежний. Сила «Feel Devastation» —
    // из part17/part19, где золотые и собирались при трёх копиях.
    const usual: GameState = {
      ...final,
      hero: final.hero === null ? null : { ...final.hero, heroPowerCardId: 'BG36_HERO_105p' },
    };
    expect(copiesForTriple(usual, cards)).toBe(3);
  });

  it('ставка на тройку переезжает на первую копию', () => {
    const owned: Minion = {
      ...(final.board[0] ?? { entityId: -1 } as Minion),
      entityId: 9001,
      cardId: 'BGS_039',
      golden: false,
    };
    const candidate: Minion = { ...owned, entityId: 9002 };
    const withOne: GameState = { ...final, board: [owned], hand: [] };

    const here = minionValue(candidate, withOne, { cards });
    expect(here.copiesOwned).toBe(1);
    expect(here.completesTriple).toBe(true);
    expect(here.tripleBet).toBe(false);
    expect(here.copies).toBe(DEFAULT_COPIES_TOP);

    // На обычном герое та же одна копия — всё ещё только ставка.
    const usual: GameState = {
      ...withOne,
      hero: withOne.hero === null ? null : { ...withOne.hero, heroPowerCardId: 'BG36_HERO_105p' },
    };
    const there = minionValue(candidate, usual, { cards });
    expect(there.completesTriple).toBe(false);
    expect(there.tripleBet).toBe(true);
    expect(there.copies).toBeLessThan(DEFAULT_COPIES_TOP);
  });
});

/** Верхний вес таблицы копий — «покупка собирает тройку». */
const DEFAULT_COPIES_TOP = 12;
