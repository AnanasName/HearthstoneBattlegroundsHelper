import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, freezeRule, minionValue } from '../../src/advisors/tavern/advisor.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { createBreather } from '../breather.js';
import { part62Game } from '../fixtures.js';

/**
 * part62 — Sire Denathrius (20.09.2026), 5-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Кадр один (11:34, ход 3), и он же
 * второй вопрос игрока: «почему не рекомендует заморозить карту, которая
 * даёт использовать золото следующего хода полностью». Ответ оказался
 * числом: планка заморозки требовала с заклинания цену ВЫТЕСНЕННОЙ покупки,
 * которой в этой ветке не бывает (D270).
 *
 * Первый вопрос — про квесты Денатрия — этим тестом только ЗАКРЕПЛЁН
 * фактурой лога: выбор, прогресс и награда в логе есть, и здесь записано,
 * где именно они лежат.
 */
describe('part62: Sire Denathrius — квесты силы героя, заморозка ради лассо', () => {
  let text: string;
  let lines: string[];
  let cards: CardIndex;
  let turns: TavernTurn[];
  let final: GameState;

  beforeAll(async () => {
    text = part62Game();
    lines = text.split(/\r?\n/);
    cards = loadCardIndex();
    turns = await readTavernTurnsAsync(text, createBreather());
    const reducer = createReducer(readPlayers(text));
    const breather = createBreather();
    for (const event of readPowerEvents(text)) {
      if (breather.due()) await breather.pause();
      reducer.step(event);
    }
    final = reducer.snapshot();
  }, 600_000);

  /** Состояние на момент времени — срезом лога, как на кадре игрока. */
  const at = (until: string): GameState => {
    const taken: string[] = [];
    for (const line of lines) {
      const m = /^D (\d\d:\d\d:\d\d\.\d+)/.exec(line);
      if (m !== null && (m[1] ?? '') > until) break;
      taken.push(line);
    }
    return reduceLog(taken.join('\n'));
  };

  const name = (id: string): string => cards.info(id)?.name ?? id;

  it('партия целая: один матч Battlegrounds, доигранный до конца, 5-е место, Денатрий', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.match(/GameState\.DebugPrintPower\(\) - CREATE_GAME/g)).toHaveLength(1);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
    expect(final.buildNumber).toBe(251952);
    expect(final.finalPlace).toBe(5);
    expect(final.hero?.cardId).toBe('BG24_HERO_100');
  });

  /**
   * Вопрос 1: учитывал ли советник механику квестов. Не учитывал — и вот
   * ровно то, чего он не читает. Сам выбор приходит ТЕМ ЖЕ каналом выборов,
   * что раскопка и лавка (D112), с источником-энчантом квестов, а прогресс
   * живёт тегом на сущности квеста в зоне SECRET.
   */
  it('вопрос 1: квест силы героя виден в логе целиком — выбор, прогресс, награда', () => {
    const choice = lines.findIndex((l) => l.includes('cardId=BG24_QuestsPlayerEnch_t'));
    expect(choice).toBeGreaterThan(0);
    // Два варианта одного предложения: счёт у каждого свой, награда — своя.
    expect(text).toContain('cardId=BG28_Quest_500');
    expect(text).toContain('cardId=BG24_Quest_124');
    expect(name('BG28_Quest_500')).toBe('Fill the Cauldron');
    expect(cards.info('BG28_Quest_500')?.text).toContain('Cast {0} spells');
    expect(name('BG24_Quest_124')).toBe('Reenact the Murder');

    // Взят «Наполнить котел»: строка SendChoices называет сущность квеста.
    expect(text).toContain(
      'SendChoices() -   m_chosenEntities[0]=[entityName=Наполнить котел id=455',
    );
    // Счёт и награда — теги на этой же сущности.
    expect(text).toContain('id=455 zone=SETASIDE zonePos=0 cardId=BG28_Quest_500 player=7] tag=QUEST_PROGRESS_TOTAL value=12');
    expect(text).toContain('id=455 zone=SETASIDE zonePos=0 cardId=BG28_Quest_500 player=7] tag=QUEST_REWARD_DATABASE_ID value=97966');
    // 97966 — Kidnap Sack, и он же лёг в руку заклинанием после выполнения.
    expect(cards.infoByDbfId(97966)?.id).toBe('BG24_Reward_718');
    expect(text).toContain('tag=BACON_QUEST_COMPLETED value=1');
  });

  /**
   * Кадр 11:34 (скриншот игрока), ход 3: после подъёма в тир 2 золота 0,
   * в витрине Enchanted Lasso за 2.
   *
   * Сверяется то, что от момента внутри хода не зависит: состав борда
   * и витрины, тир, золото, живые цены кнопок. `verifiedBy: скриншот`.
   */
  it('кадр 11:34: тир 2, золото 0, борд из наги, витрина с лассо за 2', () => {
    const s = at('11:34:00');
    expect(s.turn).toBe(3);
    expect(s.phase).toBe('tavern');
    expect(s.techLevel).toBe(2);
    expect(s.gold).toBe(0);
    expect(s.goldTotal).toBe(4);
    expect(s.board.map((m) => m.cardId)).toEqual(['BG36_921']);
    expect(name('BG36_921')).toBe('Fleeing Fugitive');
    expect(s.board[0]?.attack).toBe(5);
    expect(s.board[0]?.health).toBe(2);
    expect(s.hero?.heroPowerCardId).toBe('BG24_HERO_100p');
    expect(s.shop.map((m) => m.cardId)).toEqual(['BG33_886', 'BG26_146', 'BG20_100']);
    expect(s.shopSpells.map((x) => x.cardId)).toEqual(['BG28_512']);
    expect(s.shopSpells[0]?.cost).toBe(2);
    // Живые цены кнопок с того же кадра: «подъём до 3 за 7», обновление за 1.
    expect(s.tavernUpgradeCost).toBe(7);
    expect(s.tavernUpgradeTarget).toBe(3);
    expect(s.rerollCost).toBe(1);
  });

  /**
   * Вопрос 2. Заморозка ради заклинания дешевле покупки молчала: планка
   * требовала с лассо целую свежую карту (6.93) сверх его собственной
   * ценности, а давало оно 6.75 — промах в 0.18 при том, что покупку
   * заклинание не вытесняет (D270).
   *
   * Игрок в этой точке заморозил витрину сам, и на ходу 5 сыграл ровно то,
   * ради чего ветка существует: пять золота, лассо за 2 и покупка за 3 —
   * ДВА тела вместо одного и двух сгоревших монет.
   */
  it('вопрос 2: на нулевом золоте витрина морозится ради лассо', () => {
    const s = at('11:34:00');
    const freeze = freezeRule(s, { cards });
    expect(freeze?.action).toBe('freeze');
    expect(freeze?.spellCardId).toBe('BG28_512');
    expect(freeze?.minion).toBeNull();
    expect(freeze?.cost).toBe(0);
    expect(freeze?.reason).toContain('два тела вместо одного');

    // И это верхняя строка совета: на нулевом золоте платного нет вовсе.
    const advice = adviseTavern(s, { cards });
    expect(advice?.recommendations[0]?.action).toBe('freeze');
  });

  it('вопрос 2: игрок заморозил сам, а на ходу 5 разменял пятёрку на два тела', () => {
    const third = final.actions.filter((a) => a.turn === 3);
    expect(third.map((a) => a.type)).toEqual(['levelUp', 'freeze']);

    // Ход 5: лассо за 2 и Razorfen Geomancer за 3 — ровно пять золота.
    const fifth = final.actions.filter((a) => a.turn === 5);
    const bought = fifth.filter((a) => a.type === 'buy').map((a) => a.cardId);
    expect(bought).toEqual(['BG28_512', 'BG20_100']);
    const point = turns.find((t) => t.turn === 5)?.state;
    expect(point?.gold).toBe(5);
    // Украденное лассо тело — Lullabot из той же витрины: он разыгран
    // в том же ходу, хотя куплен не был.
    expect(fifth.some((a) => a.type === 'play' && a.cardId === 'BG26_146')).toBe(true);
  });

  /**
   * ГРАНИЦА правила D278 (Mind Muck `BG23_357`): «Battlecry: Choose
   * a friendly Demon. It consumes a minion in the Tavern to gain its stats».
   *
   * В этой партии он дважды лежал в витрине — на ходах 15 и 17, — и оба
   * раза кормить было НЕКОГО: своих демонов на борде ноль. Клич без цели
   * не отыгрывает, и слагаемое обязано молчать (та же граница, что у D272).
   * Партия целиком держит эту сторону правила: положительная — в part65.
   */
  it('D278: клич-пожиратель без своих демонов молчит (ходы 15 и 17)', () => {
    for (const turn of [15, 17]) {
      const state = turns.find((t) => t.turn === turn)?.state;
      expect(state).toBeDefined();
      const muck = state!.shop.find((m) => m.cardId === 'BG23_357');
      expect(muck, `ход ${String(turn)}: Mind Muck в витрине`).toBeDefined();

      const demons = state!.board.filter((m) => {
        const races = cards.info(m.cardId)?.races ?? [];
        return races.includes('DEMON') || races.includes('ALL');
      });
      expect(demons).toEqual([]);
      expect(minionValue(muck!, state!, { cards }).battlecryEater).toBe(0);
    }
  });
});
