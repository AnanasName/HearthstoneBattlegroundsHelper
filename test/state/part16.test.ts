import { beforeAll, describe, expect, it } from 'vitest';

import type { AllCardsService } from '@firestone-hs/reference-data';

import { endOfTurnAuraGains } from '../../src/advisors/battle/endOfTurn.js';
import { adviseTavern, playRules, spellRules } from '../../src/advisors/tavern/advisor.js';
import { readTavernTurns, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part16Game } from '../fixtures.js';

/**
 * part16 — восьмая партия с оверлеем (14.08.2026, АПМ-пираты, 4-е место),
 * четыре пункта обратной связи. Контрольные значения —
 * `part16.expected.json`; три скриншота из чата плюс пункт словами.
 *
 * Моменты жалоб лежат посреди ходов, между точками решения, — они
 * собираются одним потоковым проходом по предикатам.
 */
describe('part16: прокрутка, бафф соседям, нецелевое числительное, Badsong-источники', () => {
  let text: string;
  let cards: CardIndex;
  let turns: TavernTurn[];

  // Моменты жалоб, собранные одним проходом.
  let sylvarTurn7: GameState | null = null;
  let bountyTurn11: GameState | null = null;
  let stuckTurn21: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    text = part16Game();
    cards = loadCardIndex();
    turns = readTavernTurns(text);

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      const { content } = event.line;
      if (!content.includes('ZONE') && !content.includes('RESOURCES')) continue;
      const s = reducer.snapshot();
      if (s.phase !== 'tavern') continue;
      if (s.turn === 7 && sylvarTurn7 === null && s.board.some((m) => m.cardId.startsWith('BG32_235'))) {
        sylvarTurn7 = s;
      }
      // Последнее состояние с заклинанием в руке: при первом появлении его
      // плейсхолдеры (TAG_SCRIPT_DATA_NUM) ещё не заполнены.
      if (s.turn === 11 && s.handSpells.some((h) => h.cardId === 'BG33_811')) {
        bountyTurn11 = s;
      }
      if (s.turn === 21 && s.gold === 0 && s.board.length === 6) {
        stuckTurn21 = s;
      }
    }
    finalState = reducer.snapshot();
  }, 240_000);

  it('партия дочитывается до конца: 4-е место, билд из лога', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(4);
    expect(finalState.hero?.cardId).toBe('BG33_HERO_001');
    // Номер билда — строка `BuildNumber=…` канала метаданных (239-я строка
    // партии): по нему предупреждение о снапшоте называет патч, а датасет
    // отличает партии разных билдов.
    expect(finalState.buildNumber).toBe(248348);
  });

  it('ход 5: прокрутка Oozeling первым советом, с покупкой следом (жалоба 1)', () => {
    // Oozeling Gladiator за 3 → клич даст два Slimy Shield → продать за 1:
    // чистая цена 2, и золотой лауреат всё ещё по карману. Прежний совет
    // «сразу лауреата» оставлял два золота сгорать.
    const turn5 = turns.find((t) => t.turn === 5);
    expect(turn5).toBeDefined();
    if (turn5 === undefined) return;

    expect(turn5.state.gold).toBe(5);
    const base = (id: string): string => (id.endsWith('_G') ? id.slice(0, -2) : id);
    expect(turn5.state.shop.map((m) => base(m.cardId))).toEqual(
      expect.arrayContaining(['BG27_002', 'BG32_236']),
    );

    const advice = adviseTavern(turn5.state, { cards });
    const top = advice?.recommendations[0];
    expect(top?.action).toBe('spin');
    expect(top?.minion?.cardId).toBe('BG27_002');
    expect(top?.reason).toContain('потом');
  });

  it('ход 7: Сильвар-серфер даёт соседям атаку — бафф виден счёту боя (жалоба 2)', () => {
    // «At the end of your turn, give adjacent minions +{0} Attack. Repeat
    // for each friendly Golden minion» — на борде золотой лауреат, значит
    // каждый сосед получает не меньше двух атак. Бафф применяется к каждому
    // кандидату расстановки перед симуляцией — польза центра входит в счёт.
    expect(sylvarTurn7).not.toBeNull();
    if (sylvarTurn7 === null) return;

    const golden = sylvarTurn7.board.filter((m) => m.golden).length;
    expect(golden).toBeGreaterThanOrEqual(1);

    // Сервис карт — адаптер нашего справочника: тексты в снапшоте одни.
    const textCards = {
      getCard: (id: string) => ({ text: cards.info(id)?.text ?? undefined }),
    } as unknown as AllCardsService;
    const sylvar = sylvarTurn7.board.find((m) => m.cardId.startsWith('BG32_235'));
    const gains = endOfTurnAuraGains(sylvarTurn7.board, textCards);
    expect(gains.get(sylvar?.entityId ?? -1)).toBeGreaterThanOrEqual(2);
  });

  it('ход 11: Healthy Bounty раздаёт сама — цель не называется (жалоба 3)', () => {
    // «Give four friendly minions +{1} Health»: совет писал «→ на Aureate
    // Laureate», показывая выбор, которого у игрока нет.
    expect(bountyTurn11).not.toBeNull();
    if (bountyTurn11 === null) return;

    const rec = spellRules(bountyTurn11, { cards }).find((r) => r.spellCardId === 'BG33_811');
    expect(rec).toBeDefined();
    expect(rec?.targetMinion).toBeNull();
    expect(rec?.reason).toContain('не выбирается');
  });

  it('ход 21: рука с Badsong от безобидных источников советуется (жалоба 4)', () => {
    // Место на борде (6 из 7), в руке три миньона от Friendly Bounty,
    // Chef's Choice и награды за тройку — все с энчантом Badsong, ни один
    // не смертник. Прежний совет — «НИЧЕГО».
    expect(stuckTurn21).not.toBeNull();
    if (stuckTurn21 === null) return;

    expect(stuckTurn21.hand.map((m) => m.cardId)).toEqual(
      expect.arrayContaining(['BG26_814', 'BG31_824', 'BG28_595']),
    );
    // Заклинание-замок честно вне советов.
    expect(stuckTurn21.handSpells.find((h) => h.cardId === 'BG36_520t')?.unplayable).toBe(true);

    const plays = playRules(stuckTurn21, { cards });
    expect(plays.length).toBeGreaterThanOrEqual(3);
    expect(plays.some((p) => p.minion?.cardId === 'BG26_814')).toBe(true);
  });
});
