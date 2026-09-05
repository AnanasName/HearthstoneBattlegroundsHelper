import { readFileSync } from 'node:fs';

import type { AllCardsService } from '@firestone-hs/reference-data';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  cardRallyCarriers,
  preferRallySwing,
  rallySwingNote,
} from '../../../src/advisors/position/rallySwing.js';
import type { Candidate } from '../../../src/advisors/position/search.js';
import { CARDS_PATH } from '../../../src/data/cards.js';
import { board, minion } from '../../minions.js';

/**
 * «Боевой раж», платящий КАРТОЙ (part41, жалоба игрока по ходу 13:
 * «предлагает поставить карту с боевым ражем на 5 место, кажется, что он
 * почти никогда не сработает»).
 *
 * Замер счётчиком на реализации карты в пакете симулятора, поле из пяти
 * виденных бордов, 10 000 боёв на расстановку: с первого места раж
 * срабатывал 10 000 раз из 10 000, со второго — 2813, с пятого — 102.
 * В исходе боя это не весит ничего (карта кладётся в руку,
 * `dmgDone… = 0`), поэтому советник платил ею за доли пункта, сам того
 * не зная.
 *
 * Числа охвата закреплены тестом намеренно: в прозе они разъезжаются
 * и от патча, и от наших же правок шаблона.
 */
describe('раж, платящий картой', () => {
  interface RawCard {
    readonly id?: string;
    readonly name?: string;
    readonly text?: string;
    readonly type?: string;
    readonly isBaconPool?: boolean;
    readonly mechanics?: readonly string[];
  }

  let raw: RawCard[];
  let cards: AllCardsService;

  beforeAll(() => {
    raw = JSON.parse(readFileSync(CARDS_PATH, 'utf8')) as RawCard[];
    const byId = new Map(raw.filter((c) => typeof c.id === 'string').map((c) => [c.id as string, c]));
    // Хватает одного метода: `cardRallyCarriers` читает только текст и имя,
    // как это делает `endOfTurnAuraGains` на том же снапшоте.
    cards = { getCard: (id: string) => byId.get(id) ?? null } as unknown as AllCardsService;
  });

  /** Bronze Timewalker — «Rally: Get a random Chromadrake». */
  const TIMEWALKER = 'BG36_242';
  /** Expert Aviator — «Rally: Summon the highest-Attack minion from your hand». */
  const AVIATOR = 'BG28_400';

  it('носителем считается раж с ДОБЫЧЕЙ, а не с призывом', () => {
    const carriers = cardRallyCarriers(
      [
        minion(1, { cardId: TIMEWALKER }),
        minion(2, { cardId: AVIATOR }),
        minion(3, { cardId: 'BG32_170' }),
      ],
      cards,
    );
    expect(carriers.map((m) => m.entityId)).toEqual([1]);
  });

  it('охват класса: сколько в пуле ражей и сколько из них платят картой', () => {
    const pool = raw.filter(
      (c) =>
        c.isBaconPool === true &&
        (c.type ?? '').toUpperCase() === 'MINION' &&
        !(c.id ?? '').endsWith('_G'),
    );
    const rally = pool.filter((c) => (c.mechanics ?? []).includes('BACON_RALLY'));
    const payers = pool.filter(
      (c) =>
        cardRallyCarriers([minion(1, { cardId: c.id as string })], cards).length > 0,
    );
    // 32 по МЕХАНИКЕ снапшота; текстовый поиск даёт 34 — лишние две карты
    // говорят о ЧУЖОМ раже («After a friendly Rally minion attacks…»),
    // и носителями не являются.
    expect(rally.length).toBe(32);
    expect(payers.every((c) => (c.mechanics ?? []).includes('BACON_RALLY'))).toBe(true);
    expect(payers.map((c) => c.name).sort()).toEqual([
      'Bigwig Bandit',
      'Bramble Tunneler',
      'Bronze Timewalker',
      'Headhunter Gryphon',
      'Highkeeper Ra',
      'Roadboar',
      'Timewarped Calligrapher',
      'Timewarped Vaelastrasz',
    ]);
  });

  /** Кандидат с заданной оценкой: важны только доли побед и число симуляций. */
  const candidate = (order: readonly number[], won: number, sims = 1000): Candidate => ({
    key: order.join(','),
    board: order.map((id) => minion(id, { cardId: id === 1 ? TIMEWALKER : `CARD_${String(id)}` })),
    estimate: {
      sims,
      won,
      tied: 0,
      lost: sims - won,
      wonLethal: 0,
      lostLethal: 0,
      damageWon: 0,
      damageLost: 0,
    },
    score: won / sims,
  });

  it('среди НЕРАЗЛИЧИМЫХ расстановок вперёд выходит та, где ражник левее', () => {
    // Разница в полпроцента при тысяче симуляций — заведомо внутри двух
    // стандартных ошибок, то есть ровно тот случайный бросок, который
    // и увозил носителя вправо.
    const carriers = cardRallyCarriers(candidate([1, 2, 3], 0).board, cards);
    const top = [candidate([2, 3, 1], 905), candidate([2, 1, 3], 900)];

    const ordered = preferRallySwing(top, carriers, 'winRate');
    expect(ordered[0]?.key).toBe('2,1,3');
    // Проигравший не пропадает: список остаётся полным и в прежнем порядке.
    expect(ordered.map((c) => c.key)).toEqual(['2,1,3', '2,3,1']);
  });

  it('РАЗЛИЧИМЫЙ по бою совет не трогается', () => {
    // 90 % против 50 % при тысяче симуляций различимы с запасом: тут мерка
    // знает ответ, и подменять его нечем — остаётся приписка в строке.
    const carriers = cardRallyCarriers(candidate([1, 2, 3], 0).board, cards);
    const top = [candidate([2, 3, 1], 900), candidate([2, 1, 3], 500)];
    expect(preferRallySwing(top, carriers, 'winRate')[0]?.key).toBe('2,3,1');
  });

  it('без носителей ража список возвращается как есть', () => {
    const top = [candidate([2, 3, 1], 905), candidate([2, 1, 3], 900)];
    expect(preferRallySwing(top, [], 'winRate')).toBe(top);
  });

  it('приписка появляется, когда совет двигает носителя ВПРАВО', () => {
    const now = [minion(1, { cardId: TIMEWALKER }), minion(2), minion(3)];
    const right = [minion(2), minion(3), minion(1, { cardId: TIMEWALKER })];
    const note = rallySwingNote(now, right, cards);
    expect(note).toContain('Bronze Timewalker 1→3');
    expect(note).toContain('раж');

    // Влево и на месте — молчание: приписка про то, что делает САМ совет,
    // иначе она висела бы на каждом кадре партии с таким миньоном.
    expect(rallySwingNote(right, now, cards)).toBeNull();
    expect(rallySwingNote(now, now, cards)).toBeNull();
    expect(rallySwingNote(board([7, 8]), board([8, 7]), cards)).toBeNull();
  });
});
