import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurns } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part42Game } from '../fixtures.js';

/**
 * part42 — Элиза Звездочёт, ПЕРВОЕ место (05.09.2026). Три пункта игрока:
 * два про метки на столе (геометрия держится в `test/overlay/layout.test.ts`,
 * здесь — фактура партии) и один про совет нажимать силу героя рано.
 *
 * Сила партии — «Ведущая исследовательница» `TB_BaconShop_HP_047`:
 * «Discover a minion from your Tier. Costs (1) more after each use».
 * Обе половины этого текста советник читал НЕВЕРНО: тир, названный
 * предлогом «from», не читался вовсе (ожидание бралось средним по витрине),
 * а лестница цен не читалась как лестница — сила выходила «дешёвой
 * покупкой миньона» на первом же ходу.
 */
describe('part42: сила, дорожающая от нажатий, и ряды на экране', () => {
  let text: string;
  let cards: CardIndex;
  let turns: ReturnType<typeof readTavernTurns>;

  beforeAll(() => {
    text = part42Game();
    cards = loadCardIndex();
    turns = readTavernTurns(text);
  }, 240_000);

  const at = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    expect(found, `точка решения хода ${String(turn)}`).toBeDefined();
    return found!.state;
  };

  const advice = (state: GameState) => {
    const a = adviseTavern(state, { cards });
    expect(a, 'совет на этом состоянии').not.toBeNull();
    return a!;
  };

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    // Урок обрезанной копии part38: место живёт всю партию как ТЕКУЩЕЕ,
    // и лог без `FINAL_GAMEOVER` даёт не «неполную правду», а другое число.
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
  });

  it('лестница цен силы читается тегом COST и растёт ровно по нажатиям', () => {
    // В логе цена меняется трижды — 15:30:11, 15:35:34 и 15:37:51, — и все
    // три раза сразу за блоком PLAY на самой силе. Это и есть основание
    // считать цену лестничной: не текст обещает рост, а лог его показывает.
    const presses = [...text.matchAll(/BLOCK_START BlockType=PLAY Entity=\[[^\]]*id=121 [^\]]*\]/g)];
    expect(presses.length, 'нажатий силы за партию (два канала лога)').toBe(6);

    expect(at(1).hero?.heroPowerCost).toBe(1);
    expect(at(19).hero?.heroPowerCost).toBe(1);
    expect(at(21).hero?.heroPowerCost).toBe(2);
  });

  it('ход 1: сила больше не стоит в советах — цена спешки съедает выгоду', () => {
    // Пункт 2 игрока. На тире 1 Discover даёт тело за 6.5 очка, а к концу
    // партии та же ступенька лестницы даст тело шестого тира за 21 —
    // и ждать при этом не стоит НИЧЕГО: цена растёт от нажатий, а не от
    // времени. Игрок нажал силу впервые на ходу 19.
    const state = at(1);
    expect(state.techLevel).toBe(1);
    expect(state.hero?.heroPowerCardId).toBe('TB_BaconShop_HP_047');
    expect(advice(state).recommendations.some((a) => a.action === 'heroPower')).toBe(false);
  });

  it('ход 5: сила ушла из видимых советов и из головы плана', () => {
    // Скриншот игрока: план был «СИЛА ГЕРОЯ за 1 → КУПИТЬ Aureate Laureate
    // → КУПИТЬ Leaf Through the Pages», а верхним советом стояла сила.
    // Совсем из списка она не исчезает — на 2.2 очка она шестая из семи,
    // то есть на экран (три строки) не попадает и золото у покупок
    // не забирает. Это и есть мера: правило не запрещает силу, оно ставит
    // ей ЦЕНУ, и цена решает.
    const state = at(5);
    expect(state.gold).toBe(5);

    const recs = advice(state).recommendations;
    const rank = recs.findIndex((a) => a.action === 'heroPower');
    expect(rank, 'сила не входит в три видимых совета').toBeGreaterThan(2);

    const plan = spendPlan(state, { cards });
    expect(plan.steps[0]?.recommendation.action).not.toBe('heroPower');
  });

  it('ход 21: на пятом тире сила возвращается в советы и называет цену спешки', () => {
    // Обратная сторона правила: чем выше тир, тем меньше разница между
    // «сейчас» и «потом», и на пятом тире она падает до долей очка.
    // Игрок нажал силу на ходах 19, 23 и 25 — здесь советник с ним сходится.
    const state = at(21);
    expect(state.techLevel).toBe(5);
    const hero = advice(state).recommendations.find((a) => a.action === 'heroPower');
    expect(hero, 'совет по силе на пятом тире').toBeDefined();
    expect(hero!.reason).toContain('цена растёт на 1 за нажатие');
    expect(hero!.reason).toContain('спешка стоит');
  });

  it('тир, названный предлогом «from», читается пулом СВОЕГО тира', () => {
    // Прежде шаблон знал только «of your Tier», и ожидание бралось средним
    // ПО ВИТРИНЕ — на пятом тире это около 14 очков вместо 18.5 у пула
    // своего тира, потому что витрина набирается с первого тира по свой.
    const hero = advice(at(21)).recommendations.find((a) => a.action === 'heroPower');
    expect(hero!.reason).toContain('средний миньон тира 5');
  });

  it('ход 5: ряд витрины — четыре миньона и заклинание ПЯТЫМ', () => {
    // Фактура пункта 1 part41, подтверждённая второй партией подряд:
    // витрина — одна зона со сквозной нумерацией.
    const state = at(5);
    expect(state.shop.map((m) => m.zonePos)).toEqual([1, 2, 3, 4]);
    expect(state.shopSpells[0]?.zonePos).toBe(5);
  });

  it('ход 11: порядок вариантов лавки в trinketOffer НЕ экранный', () => {
    // Пункт 3. Метка садится по каналу выборов (решение part41), и партия
    // это подтверждает: на экране первым стоит Booty Bay Brew
    // `BG30_MagicItem_924`, а обход сущностей даёт его ЧЕТВЁРТЫМ.
    const offer = at(11).trinketOffer;
    expect(offer.map((t) => t.cardId)).toEqual([
      'BG30_MagicItem_888',
      'BG32_MagicItem_951',
      'BG36_MagicItem_390',
      'BG30_MagicItem_924',
    ]);
    // Цена бывает не проставлена вовсе — на экране такой вариант стоит 0.
    expect(offer[0]?.cost).toBeNull();
    expect(offer[1]?.cost).toBe(1);
  });

  it('сила героя МЕНЯЕТСЯ посреди партии, и это факт лога, а не сбой', () => {
    // В 15:38:10 игрок выбирает «Мудрость Древних» BG32_HERO_001p, и с этого
    // момента сила в PLAY другая. Тест держит это утверждение: если чтение
    // силы однажды начнёт брать не ту сущность, он упадёт.
    expect(at(25).hero?.heroPowerCardId).toBe('TB_BaconShop_HP_047');
    expect(at(29).hero?.heroPowerCardId).toBe('BG32_HERO_001p');
  });

  it('партия выиграна: место 1 на конце лога', () => {
    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) reducer.step(event);
    expect(reducer.snapshot().finalPlace).toBe(1);
  });
});
