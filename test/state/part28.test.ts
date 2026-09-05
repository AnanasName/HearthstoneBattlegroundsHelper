import { beforeAll, describe, expect, it } from 'vitest';

import {
  modalBranchAdvice,
  playRules,
  remainingTurns,
  shopSpellRules,
  spellEffect,
} from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import { EMPTY_STATE, type GameState } from '../../src/state/types.js';
import { recommendationLine } from '../../src/ui/format.js';
import { part28Game } from '../fixtures.js';
import { minion } from '../minions.js';
import { changesAdvisorState } from '../snapshots.js';

/**
 * part28 — двадцатая партия с оверлеем (26.08.2026, Galakrond, квилбоары,
 * 8-е место), вторая на билде 250339. Пункт обратной связи один: «на 1
 * скриншоте мне не предложило лучший выбор» — открытый модальный выбор
 * Snare Trapper, про который советник молчал.
 *
 * Момент ловится условием на состояние, а не номером хода: это состояние
 * ПОСРЕДИ хода (после покупки и продажи), которого точки решения не видят.
 */
describe('part28: ветвь модального миньона и предел золота', () => {
  let cards: CardIndex;
  /** Ход 13, момент скриншота: золото 4/9, борд полон, ловушник в руке. */
  let screenshot: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part28Game();
    cards = loadCardIndex();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      if (!changesAdvisorState(event.line.content)) continue;
      const s = reducer.snapshot();
      if (s.phase !== 'tavern' || s.hero === null) continue;
      if (
        s.turn === 13 &&
        s.gold === 4 &&
        s.board.length === 7 &&
        s.hand.some((m) => m.cardId === 'BG36_332')
      ) {
        screenshot ??= s;
      }
    }
    finalState = reducer.snapshot();
  }, 600_000);

  it('партия дочитывается до конца: 8-е место, Galakrond, билд 250339', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(8);
    expect(finalState.hero?.cardId).toBe('TB_BaconShop_HERO_02');
    expect(finalState.buildNumber).toBe(250339);
  });

  it('момент скриншота найден: ход 13, тир 4, золото 4/9, борд полон', () => {
    expect(screenshot).not.toBeNull();
    const s = screenshot as GameState;
    expect(s.techLevel).toBe(4);
    expect(s.goldTotal).toBe(9);
    expect(s.board).toHaveLength(7);
    expect(s.hand.map((m) => m.cardId)).toEqual(['BG36_332']);
    expect(s.shop.map((m) => m.cardId)).toEqual(['BG34_925', 'BG23_000', 'BG36_508']);
  });

  /**
   * Канал выборов при модальном миньоне молчит — и это не дефект разбора,
   * а свойство лога: ветви лежат в SETASIDE с `PARENT_CARD` с самого
   * появления карты в витрине. Тест держит это утверждение: если игра
   * когда-нибудь начнёт слать выбор каналом, он упадёт и правило про
   * «называть ветвь заранее» будет пересмотрено, а не унаследовано молча.
   */
  it('открытого выбора в состоянии НЕТ: ветви приходят не каналом выборов', () => {
    expect((screenshot as GameState).openChoice).toBeNull();
  });

  it('совет на розыгрыш называет ветвь — Collect the Bounty', () => {
    const s = screenshot as GameState;
    const play = playRules(s, { cards }, DEFAULT_TAVERN_RULES).find(
      (r) => r.minion?.cardId === 'BG36_332',
    );
    expect(play).toBeDefined();
    expect(play?.spellBranches?.map((b) => b.cardId)).toEqual(['BG36_332t2']);
    expect(recommendationLine(play!, cards)).toContain('Collect the Bounty');
    // Числа обеих ветвей — в причине: игрок должен видеть, чем совет обоснован.
    expect(play?.reason).toContain('Ensnare the Target');
    expect(play?.reason).toContain('к пределу золота');
  });

  it('ветви считаются на борде ПОСЛЕ розыгрыша, и предел золота выигрывает', () => {
    const s = screenshot as GameState;
    const trapper = s.hand.find((m) => m.cardId === 'BG36_332');
    expect(trapper).toBeDefined();

    // Тот же борд, что видит playRules: ловушник уже стоит, слабейший продан.
    const boardAfter = [...s.board.filter((m) => m.cardId !== 'BG23_000'), trapper!];
    const advice = modalBranchAdvice(
      trapper!,
      { ...s, board: boardAfter },
      { cards },
      DEFAULT_TAVERN_RULES,
    );
    expect(advice?.branches.map((b) => b.name)).toEqual(['Collect the Bounty']);
    expect(advice?.note).toMatch(/Ensnare the Target \d+\.\d/);
    expect(advice?.note).toMatch(/Collect the Bounty 1\d\.\d/);
  });

  /**
   * Разбор ветвей по отдельности: до правки обе возвращали `null` целиком,
   * то есть выбор был невидим не наполовину, а полностью.
   */
  it('обе ветви разбираются: племя у первой, предел золота у второй', () => {
    const quilboar = spellEffect('BG36_332t', [1], cards);
    expect(quilboar).toBeNull(); // «Get a random Quilboar» — не статы и не золото
    const bounty = spellEffect('BG36_332t2', [1], cards);
    expect(bounty?.maxGold).toBe(1);

    // Плейсхолдер читается из тегов сущности, а не литералом из «{0}».
    expect(spellEffect('BG36_332t2', [3], cards)?.maxGold).toBe(3);
  });

  it('предел золота у заклинания витрины: Strike Oil перестал быть невидимым', () => {
    const state: GameState = {
      ...EMPTY_STATE,
      phase: 'tavern',
      turn: 5,
      techLevel: 2,
      gold: 4,
      goldTotal: 4,
      board: [minion(1)],
      shopSpells: [
        { entityId: 90, cardId: 'BG28_805', cost: 2, scriptData: [], zonePos: 0, unplayable: false, costsHealth: false },
      ],
    };
    const advice = shopSpellRules(state, { cards }, DEFAULT_TAVERN_RULES);
    expect(advice).toHaveLength(1);
    expect(advice[0]?.spellCardId).toBe('BG28_805');
    // Третий ход таверны: впереди 9.3 хода, чистыми 7.3 золота по курсу 3.
    expect(advice[0]?.score).toBeCloseTo((1 * 9.3 - 2) * 3, 5);
    expect(advice[0]?.reason).toContain('предел золота');
  });

  it('горизонт партии: таблица замера, за её концом — ноль', () => {
    const at = (turn: number): number =>
      remainingTurns({ ...EMPTY_STATE, turn }, DEFAULT_TAVERN_RULES);
    // Ход таверны N — это turn = 2N − 1 (part20).
    expect(at(1)).toBe(11.5);
    expect(at(13)).toBe(5.3); // 7-й ход таверны — момент скриншота part28
    expect(at(29)).toBe(0); // 15-й ход таверны — конец таблицы
    expect(at(99)).toBe(0);
  });
  it('журнал действий помнит ВЫБРАННУЮ ветвь модальной карты (SubOption)', () => {
    // Ветвь — единственный след выбора в логе: у модального миньона ветви
    // создаются в SETASIDE ещё при появлении карты в витрине, а канал
    // выборов для него молчит вовсе (docs/power-log.md, part28).
    const plays = finalState.actions.filter((a) => a.type === 'play');
    const trapper = plays.find((a) => a.cardId === 'BG36_332');
    expect(trapper?.subOption).toBe(0); // «Get a random Quilboar» — пришёл Roadboar

    // «День самоцветов» разыгран за партию дважды, и ветви РАЗНЫЕ: если бы
    // поле читалось не из своего блока, оба выбора вышли бы одинаковыми.
    const gemDays = plays.filter((a) => a.cardId === 'BG31_893').map((a) => a.subOption);
    expect(gemDays).toContain(0);
    expect(gemDays).toContain(1);

    // У действий без выбора — null, а не ноль: ноль это ПЕРВАЯ ветвь.
    expect(finalState.actions.filter((a) => a.type === 'buy').every((a) => a.subOption === null)).toBe(
      true,
    );
  });
});
