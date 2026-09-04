import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { paidSlotNote, paidSlots } from '../../../src/advisors/position/paidSlot.js';
import {
  CARDS_PATH,
  createCardIndex,
  normalizeCardText,
  type CardIndex,
} from '../../../src/data/cards.js';
import { EMPTY_STATE, type GameState } from '../../../src/state/types.js';

/**
 * Платный край борда (part39).
 *
 * Тринкет вида «At the end of your turn, cast Repair Job on your left-most
 * Mech» превращает крайний слот в слот ВЫПЛАТЫ: каждый ход туда падает
 * постоянное усиление, и расстановка решает, кому оно достанется.
 * Советник этого не считает — ни `endOfTurnAuraGains` (он ищет носителей
 * среди миньонов борда), ни симулятор (эффект тавернный) — и приписка
 * говорит об этом вслух, чтобы игрок мог возразить.
 *
 * Числа класса закреплены тестом НАМЕРЕННО: в прозе они разъезжаются
 * и от патча, и от наших же правок шаблона (урок «140 сил героя»).
 */
describe('платный край борда', () => {
  const GEARBLADE = 133695;
  /** Assembler Portrait — «Start of Combat», край не называет вовсе. */
  const ASSEMBLER = 133069;

  let cards: CardIndex;
  let trinkets: string[];

  beforeAll(() => {
    const raw = JSON.parse(readFileSync(CARDS_PATH, 'utf8')) as { id?: string; type?: string }[];
    cards = createCardIndex(raw);
    trinkets = raw
      .filter((c) => (c.type ?? '').toUpperCase() === 'BATTLEGROUND_TRINKET')
      .map((c) => c.id)
      .filter((id): id is string => typeof id === 'string');
  }, 120_000);

  const withTrinkets = (dbfIds: readonly number[]): GameState => ({
    ...EMPTY_STATE,
    playerId: 4,
    trinketsByPlayer: { 4: dbfIds },
  });

  it('край называют 24 тринкета, а «каждый ход» из них — семь', () => {
    const edge = /(left|right)-?\s*most/i;
    const eot = /at\s+the\s+end\s+of\s+(?:your|each)\s+turn/i;
    const named = trinkets.filter((id) => edge.test(normalizeCardText(cards.info(id)?.text ?? '')));
    expect(named).toHaveLength(24);

    const repeating = named.filter((id) => eot.test(normalizeCardText(cards.info(id)?.text ?? '')));
    expect(repeating).toHaveLength(7);
    // Берётся ТОЛЬКО повторяющийся класс: про «Start of Combat» обещать
    // «расстановка не считает» нельзя — часть таких эффектов симулятор
    // считает сам.
    expect(repeating).toContain('BG36_MagicItem_812');
    expect(named).toContain('BG30_MagicItem_972');
    expect(repeating).not.toContain('BG30_MagicItem_972');
  });

  /**
   * Пробел ПОСЛЕ дефиса — не теория: снапшот пишет «left and right- most
   * minions'» у Young Murk-Eye Sticker, и шаблон без `\s*` терял бы карту
   * молча, как терялись многословные шаблоны в part16.
   */
  it('шаблон терпит пробел после дефиса — «right- most»', () => {
    const info = cards.info('BG35_MagicItem_752');
    const text = normalizeCardText(info?.text ?? '');
    // Снапшот пишет именно так, с пробелом внутри слова.
    expect(text).toMatch(/right-\s+most/i);

    // И карта должна быть НАЙДЕНА, а не просто совпасть с регуляркой:
    // ровно этой проверки не хватало бы, чтобы поймать тихую потерю.
    const slots = paidSlots(withTrinkets([info?.dbfId ?? 0]), cards);
    expect(slots).toHaveLength(1);
    expect(slots[0]?.side).toBe('both');
  });

  it('Emergency Gearblade делает платным ЛЕВЫЙ край и называет источник', () => {
    const slots = paidSlots(withTrinkets([GEARBLADE]), cards);
    expect(slots).toHaveLength(1);
    expect(slots[0]?.side).toBe('left');
    expect(slots[0]?.source).toBe('Emergency Gearblade');

    const note = paidSlotNote(withTrinkets([GEARBLADE]), cards);
    expect(note).toMatch(/левый край/);
    expect(note).toMatch(/Emergency Gearblade/);
    // Главное в приписке — честность: советник этого не считает.
    expect(note).toMatch(/расстановка этого не считает/);
  });

  it('тринкет «Start of Combat» платным краем не считается', () => {
    expect(paidSlots(withTrinkets([ASSEMBLER]), cards)).toHaveLength(0);
    expect(paidSlotNote(withTrinkets([ASSEMBLER]), cards)).toBeNull();
    // И в паре с настоящим — назван только настоящий.
    const both = paidSlots(withTrinkets([GEARBLADE, ASSEMBLER]), cards);
    expect(both).toHaveLength(1);
    expect(both[0]?.source).toBe('Emergency Gearblade');
  });

  it('без тринкетов и без игрока приписки нет', () => {
    expect(paidSlotNote(withTrinkets([]), cards)).toBeNull();
    expect(paidSlotNote({ ...EMPTY_STATE, playerId: null }, cards)).toBeNull();
  });

  it('«left and right-most» читается как ОБА края', () => {
    // Accord-o-Tron Portrait: «At the end of each turn, Magnetize
    // an Accord-o-Tron to your left- and right-most Mechs».
    const info = cards.info('BG35_MagicItem_742');
    expect(info).not.toBeNull();
    const slots = paidSlots(withTrinkets([info?.dbfId ?? 0]), cards);
    expect(slots).toHaveLength(1);
    expect(slots[0]?.side).toBe('both');
    expect(paidSlotNote(withTrinkets([info?.dbfId ?? 0]), cards)).toMatch(/края борда/);
  });
});
