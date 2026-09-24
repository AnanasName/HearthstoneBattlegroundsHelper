import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../../src/advisors/tavern/advisor.js';
import { loadCardIndex, type CardIndex } from '../../../src/data/cards.js';
import type { GameState } from '../../../src/state/types.js';
import { recommendationLine } from '../../../src/ui/format.js';
import { frameAt, parseClock, sliceLogByClock } from '../../../src/ui/logSlice.js';
import { part75Game } from '../../fixtures.js';

const RED_CHROMADRAKE = 'BG34_638t';
const DRACONIC_WARDEN = 'BG34_633';

/**
 * part75 — Изера (25.09.2026), 5-е место. Фактура партии — в `test/fixtures.ts`.
 */
describe('part75: кадры игрока', () => {
  let cards: CardIndex;
  let text: string;

  beforeAll(() => {
    cards = loadCardIndex();
    text = part75Game();
  }, 120_000);

  const frame = (clock: string): GameState => {
    const at = parseClock(clock);
    if (at === null) throw new Error(`не часы: ${clock}`);
    const slice = sliceLogByClock(text, at);
    if (slice === null || !slice.inGame) throw new Error(`кадр ${clock} не в партии`);
    return frameAt(slice).state;
  };

  /**
   * Кадр `00_24.png`, ход 21, золото 0/10, hp 7, три секунды до боя.
   * Совет: «РАЗЫГРАТЬ Red Chromadrake 6/4, продав Draconic Warden 14/8».
   * Игрок: «рекомендует продать карту, хотя я ничего за это не получу».
   *
   * Получает он вот что: клич Chromadrake запускает золотого Kalecgos,
   * Arcane Aspect («After you trigger a Battlecry, give your Dragons
   * +{0}/+{1}»), и драконы растут ПЕРЕД этим боем — 28 из 50.5 очков
   * совета. В причине же стояло «своих по племени 6, борд полон, продать
   * Draconic Warden (32.5)»: выгода считалась, но не называлась ни у
   * покупки, ни у розыгрыша — только у прокрутки кличевых (D224).
   */
  describe('00:24:20 — розыгрыш из руки называет, что даст клич', () => {
    it('кадр воспроизводится: борд полон, в руке Red Chromadrake, золота 0', () => {
      const state = frame('00:24:20');
      expect(state.gold).toBe(0);
      expect(state.board).toHaveLength(7);
      expect(state.board.map((m) => m.cardId)).toContain(DRACONIC_WARDEN);
      expect(state.hand.map((m) => m.cardId)).toEqual([RED_CHROMADRAKE]);
    });

    it('совет «разыграть Red Chromadrake» называет Kalecgos и статы клича', () => {
      const recs = adviseTavern(frame('00:24:20'), { cards })?.recommendations ?? [];
      const play = recs.find((r) => r.action === 'play' && r.minion?.cardId === RED_CHROMADRAKE);
      expect(play).toBeDefined();
      expect(play?.reason).toMatch(/Kalecgos, Arcane Aspect: DRAGON \+\d+\/\+\d+ за клич/);
      expect(play?.reason).toMatch(/\+\d+ статов/);
    });

    it('и на экране: строка действия несёт выгоду клича, а не одну продажу', () => {
      // Причину оверлей не показывает (part37, part64) — показывает строку.
      const recs = adviseTavern(frame('00:24:20'), { cards })?.recommendations ?? [];
      const play = recs.find((r) => r.action === 'play' && r.minion?.cardId === RED_CHROMADRAKE);
      if (play === undefined) throw new Error('нет совета разыграть Red Chromadrake');
      expect(recommendationLine(play, cards)).toMatch(
        /^РАЗЫГРАТЬ Red Chromadrake 6\/4, продав Draconic Warden 14\/8 — клич: Kalecgos, Arcane Aspect: \+\d+ статов$/,
      );
    });
  });
});
