import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../../src/data/cards.js';
import type { GameState } from '../../../src/state/types.js';
import { recommendationLine } from '../../../src/ui/format.js';
import { frameAt, parseClock, sliceLogByClock } from '../../../src/ui/logSlice.js';
import { part78Game } from '../../fixtures.js';

const HAMMER_AURA = 'BG36_MagicItem_403e';
const DISCARD_MINION = 'BG36_308e';
const DARK_RITUAL_ENTITY = 197;

/**
 * part78 — Kith'ix (25.09.2026), 4-е место. Фактура партии — в `test/fixtures.ts`.
 */
describe('part78: кадры партии', () => {
  let cards: CardIndex;
  let text: string;

  beforeAll(() => {
    cards = loadCardIndex();
    text = part78Game();
  }, 120_000);

  const frame = (clock: string): GameState => {
    const at = parseClock(clock);
    if (at === null) throw new Error(`не часы: ${clock}`);
    const slice = sliceLogByClock(text, at);
    if (slice === null || !slice.inGame) throw new Error(`кадр ${clock} не в партии`);
    return frameAt(slice).state;
  };

  const lines = (state: GameState): string[] =>
    (adviseTavern(state, { cards })?.recommendations ?? []).map(
      (r) => `${recommendationLine(r, cards)} (${r.score.toFixed(1)})`,
    );

  /**
   * Ход таверны 2, сразу после второго нажатия Dark Ritual `BG36_HERO_002p`
   * («Get 2 random minions. When you play one, discard the other.»,
   * 20:52:33). В руке пара: Aureate Laureate и Joyous. Лог связывает её
   * энчантом `BG36_308e` «Discard Minion» («Discard after you play the other
   * minion(s)») на каждой карте, с id создателя в `TAG_SCRIPT_DATA_NUM_2`
   * (game.log:4733–4734 у первой пары: 197 — сама сила). Сбрасывает
   * вторую карту триггер игрока `BG36_307pe` при розыгрыше первой
   * (game.log:5197–5204: HAND → GRAVEYARD).
   *
   * До правки план разыгрывал обе: «РАЗЫГРАТЬ Aureate Laureate → РАЗЫГРАТЬ
   * Tavern Coin → КУПИТЬ Aureate Laureate → РАЗЫГРАТЬ Joyous». Последнего
   * шага в игре не бывает.
   */
  describe('20:52:35 — пара карт силы: розыгрыш одной сбрасывает другую', () => {
    it('кадр воспроизводится: пара в руке, энчант сброса с создателем-силой', () => {
      const state = frame('20:52:35');
      expect(state.hand.map((m) => cards.info(m.cardId)?.name)).toEqual(['Aureate Laureate', 'Joyous']);
      for (const m of state.hand) {
        const pair = m.enchantments.find((e) => e.cardId === DISCARD_MINION);
        expect(pair?.scriptDataNum2).toBe(DARK_RITUAL_ENTITY);
      }
    });

    it('план разыгрывает из пары одну карту, а совет называет сброс', () => {
      const state = frame('20:52:35');
      const plan = spendPlan(state, { cards });
      const played = plan.steps.filter(
        (s) => s.recommendation.action === 'play' && s.recommendation.minion !== null,
      );
      expect(played).toHaveLength(1);
      const recs = adviseTavern(state, { cards })?.recommendations ?? [];
      const laureate = recs.find((r) => r.action === 'play' && r.minion?.cardId.startsWith('BG32_236') === true);
      expect(laureate?.reason).toMatch(/Joyous сбросится/);
    });
  });

  /**
   * Ход таверны 6: тринкет Hammer of Twilight («Your minions have +{0}
   * Attack», растёт от сброса) взят в 20:57:07. Игра кладёт на КАЖДОГО
   * своего миньона энчант `BG36_MagicItem_403e` с надбавкой
   * в `TAG_SCRIPT_DATA_NUM_1` (game.log:52340–52364: `ATTACHED`, `CREATOR`
   * — тринкет, `TAG_SCRIPT_DATA_NUM_1=6`), и тег ATK её включает: борд стал
   * 9/3, 10/2 … 8/1.
   *
   * До правки советник сравнивал Cord Puller 8/1 с Drifting Sacrifice 2/1
   * витрины и снимал ВСЕ покупки через продажу и силу героя: в советах
   * остались тёмный дар, подъём и «НИЧЕГО». А купленный миньон получит
   * те же +6 — надбавка висит на игроке и достаётся любому следующему телу
   * (довод D059 и надбавки всей нежити, part50).
   */
  describe('20:57:24 — аура тринкета в ценности своего миньона', () => {
    it('кадр воспроизводится: борд несёт энчант ауры с надбавкой 6', () => {
      const state = frame('20:57:24');
      expect(state.gold).toBe(7);
      expect(state.board).toHaveLength(7);
      for (const m of state.board) {
        const aura = m.enchantments.find((e) => e.cardId === HAMMER_AURA);
        expect(aura?.scriptDataNum1).toBe(6);
      }
    });

    it('покупки через продажу стоят как до тринкета — надбавка их не глушит', () => {
      const before = lines(frame('20:57:05'));
      const after = lines(frame('20:57:24'));
      expect(before).toContain(
        'КУПИТЬ Drifting Sacrifice 2/1 (перерожд) за 3, продав Cord Puller 2/1 (щит) (15.0)',
      );
      // Строка называет продаваемого числами экрана (8/1), а цена та же.
      expect(after).toContain(
        'КУПИТЬ Drifting Sacrifice 2/1 (перерожд) за 3, продав Cord Puller 8/1 (щит) (15.0)',
      );
      expect(after.some((l) => l.startsWith('СИЛА ГЕРОЯ за 2'))).toBe(true);
    });
  });
});
