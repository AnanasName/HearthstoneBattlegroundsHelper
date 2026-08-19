import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  minionValue,
  spellEffect,
  spellMagnetGain,
} from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { toBattleInfo, withPlayerBoard } from '../../src/advisors/battle/mapper.js';
import { sharedBattleSimulator } from '../../src/advisors/battle/simulator.js';
import { battleQuestion } from '../../src/advisors/position/advisor.js';
import { withSeededRandom } from '../../src/advisors/position/rng.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState, Minion } from '../../src/state/types.js';
import { part21Game } from '../fixtures.js';
import { changesAdvisorState } from '../snapshots.js';

/**
 * part21 — тринадцатая партия с оверлеем (17.08.2026, наги на заклинаниях,
 * 2-е место). Два пункта обратной связи по двум скриншотам, и оба про одно:
 * КУДА КЛАСТЬ ЗАКЛИНАНИЕ и чего стоит миньон, к которому его применяют.
 *
 * Контрольные значения — `part21.expected.json`.
 */
describe('part21: магниты заклинаний, временное усиление, рука в бою', () => {
  let cards: CardIndex;

  let turn5: GameState | null = null;
  let turn9: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part21Game();
    cards = loadCardIndex();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      // Снимок состояния стоит девяти проходов по карте сущностей, а событий
      // в логе полтораста тысяч: снимаем только там, где менялось что-то
      // из читаемого селекторами (тот же приём, что в part18 и part19).
      const { content } = event.line;
      if (!changesAdvisorState(content)) continue;
      const s = reducer.snapshot();
      if (s.phase !== 'tavern') continue;

      // Ход 5, момент скриншота: прокрутка Oozeling уже сделана (отсюда
      // 3 золота из 5 и два «Slimy Shield» в руке), покупка ещё нет.
      if (s.turn === 5 && s.gold === 3 && s.board.length === 1 && s.handSpells.length === 3) {
        turn5 = s;
      }
      // Ход 9, момент скриншота: таверна поднята до 3, осталось 3 золота.
      if (s.turn === 9 && s.gold === 3 && s.techLevel === 3 && s.board.length === 4) turn9 = s;
    }
    finalState = reducer.snapshot();
  }, 240_000);

  it('партия дочитывается до конца: 2-е место, билд из лога', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(2);
    expect(finalState.hero?.cardId).toBe('BG36_HERO_101');
    expect(finalState.buildNumber).toBe(248348);
  });

  it('оба состояния скриншотов воспроизводятся из лога', () => {
    expect(turn5).not.toBeNull();
    expect(turn9).not.toBeNull();
    if (turn5 === null || turn9 === null) return;

    expect(turn5.board.map((m) => m.cardId)).toEqual(['BG23_000']);
    expect(turn5.shop.map((m) => m.cardId)).toEqual(['BG31_803', 'BG34_140', 'BG36_921']);
    expect(turn5.handSpells.map((s) => s.cardId)).toEqual([
      'BG23_000t',
      'BG27_002t',
      'BG27_002t',
    ]);
    expect(turn5.hand.map((m) => m.cardId)).toEqual(['BG_LOE_077']);

    expect(turn9.board.map((m) => m.cardId)).toEqual([
      'BG_TTN_401',
      'BG23_000',
      'BG29_300',
      'BG36_921',
    ]);
    expect(turn9.shop.map((m) => m.cardId)).toEqual([
      'BG36_201',
      'BG23_009',
      'BG31_330',
      'BG32_170',
    ]);
  });

  it('усиление «until next turn» отделено от постоянного', () => {
    // Mini-Trident — чародейский токен Mini-Myrmidon: «Give a minion
    // +2 Attack UNTIL NEXT TURN». Прежде разбор видел просто «+2 статов»,
    // и весь смысл второго пункта обратной связи был ему невидим.
    const trident = spellEffect('BG23_000t', [], cards);
    expect(trident?.stats).toBe(2);
    expect(trident?.temporaryStats).toBe(2);

    // Slimy Shield — «+1/+1 and Taunt», навсегда.
    const shield = spellEffect('BG27_002t', [], cards);
    expect(shield?.stats).toBe(2);
    expect(shield?.temporaryStats).toBe(0);

    // И главная ловушка: у Undersea Mount временна ТОЛЬКО вихревая часть
    // («Give a minion +{0}/+{1}. If it's a Naga, also give it Windfury
    // until next turn»). Поиск слов по всему тексту объявил бы временными
    // и статы — тихо и неверно, как склеенный золотой текст в part17.
    const mount = spellEffect('BG23_007t', [2, 2], cards);
    expect(mount?.stats).toBe(4);
    expect(mount?.temporaryStats).toBe(0);
  });

  it('ход 9: заклинание идёт на магнит, а не в крупнейшее тело (пункт 2)', () => {
    // «Предлагает купить нагу 2 таверны, которая сохраняет на себе
    // чародейские заклинания, и при этом применить чародейское заклинание
    // на другую карту». Так и было: цель выбиралась по размеру тела,
    // и трезубец шёл на Fleeing Fugitive 5/8 мимо только что купленного
    // Lava Lurker, где остался бы навсегда.
    expect(turn9).not.toBeNull();
    if (turn9 === null) return;
    const state = turn9;

    const plan = spendPlan(state, { cards, bgStats: null });
    const buy = plan.steps.find((s) => s.recommendation.action === 'buy');
    expect(buy?.recommendation.minion?.cardId).toBe('BG23_009');

    const play = plan.steps.find((s) => s.recommendation.spellCardId === 'BG23_000t');
    expect(play?.recommendation.targetMinion?.cardId).toBe('BG23_009');
    expect(play?.recommendation.reason).toContain('навсегда');
  });

  it('выгода магнита считается числом из тегов, а не на глаз', () => {
    expect(turn9).not.toBeNull();
    if (turn9 === null) return;

    const trident = spellEffect('BG23_000t', [], cards);
    expect(trident).not.toBeNull();
    if (trident === null) return;

    const lurker = turn9.shop.find((m) => m.cardId === 'BG23_009');
    const fugitive = turn9.board.find((m) => m.cardId === 'BG36_921');
    expect(lurker).toBeDefined();
    expect(fugitive).toBeDefined();
    if (lurker === undefined || fugitive === undefined) return;

    // Заряд хранителя — живой тег сущности, «({0} left!)» в тексте.
    expect(lurker.scriptData[0]).toBe(1);
    // На скрытне временные +2 становятся постоянными…
    expect(spellMagnetGain(lurker, trident, 'BG23_000t', cards)?.gain).toBe(2);
    // …а беглец даёт свой +1 здоровья с любого заклинания. Двойки против
    // единицы и хватило, чтобы цель сменилась: это счёт, а не мнение.
    expect(fugitive.scriptData[0]).toBe(1);
    expect(spellMagnetGain(fugitive, trident, 'BG23_000t', cards)?.gain).toBe(1);

    // Не-чародейское заклинание хранитель не удерживает: так написано
    // в его тексте, и щит на нём постоянен и без него.
    const shield = spellEffect('BG27_002t', [], cards);
    expect(shield).not.toBeNull();
    if (shield === null) return;
    expect(spellMagnetGain(lurker, shield, 'BG27_002t', cards)?.gain).toBe(0);
  });

  it('дневной заряд хранителя тратится один раз за ход', () => {
    // «The first Spellcraft spell … EACH TURN is permanent»: заряд один.
    // В самой партии второго чародейского заклинания в руке не было,
    // поэтому проверка идёт на реальном состоянии с дописанной второй
    // копией трезубца — так видно, что план не обещает постоянство дважды.
    expect(turn9).not.toBeNull();
    if (turn9 === null) return;
    const twoSpells: GameState = {
      ...turn9,
      handSpells: [...turn9.handSpells, ...turn9.handSpells],
    };

    const plan = spendPlan(twoSpells, { cards, bgStats: null });
    const plays = plan.steps.filter((s) => s.recommendation.spellCardId === 'BG23_000t');
    expect(plays.length).toBeGreaterThan(1);
    expect(plays[0]?.recommendation.targetMinion?.cardId).toBe('BG23_009');
    expect(plays[0]?.recommendation.spendsMagnetCharge).toBe(true);
    // Второе заклинание постоянным на скрытне уже не станет — и совет
    // уходит на растущего беглеца, где +1 здоровья ему достанется.
    expect(plays[1]?.recommendation.targetMinion?.cardId).toBe('BG36_921');
  });

  it('ход 5: заклинания руки идут в ценность магнита из витрины (пункт 1)', () => {
    // «Почему-то предлагало купить мурлока, хотя от наги было бы больше
    // смысла: она улучшается от применения на неё заклинаний». Связь
    // читаемая — три заклинания в руке, беглец даёт по +1 здоровья
    // за каждое, — и советник её не видел вовсе.
    expect(turn5).not.toBeNull();
    if (turn5 === null) return;
    const state = turn5;

    const fugitive = state.shop.find((m) => m.cardId === 'BG36_921');
    expect(fugitive).toBeDefined();
    if (fugitive === undefined) return;

    const value = minionValue(fugitive, state, { cards, bgStats: null });
    // Три заклинания × +1 здоровья = 3 стата по цене статов.
    expect(value.spellMagnet).toBeCloseTo(3 * DEFAULT_TAVERN_RULES.value.perStatPoint, 5);

    // Но верхней покупкой это его не делает, и придумывать обратное нельзя:
    // Expert Aviator — тир 2 против тира 1, 3/4 против 3/2 и боевой эффект
    // ралли. Ответ игроку — с числами, а не «советник был прав».
    const aviator = state.shop.find((m) => m.cardId === 'BG34_140');
    expect(aviator).toBeDefined();
    if (aviator === undefined) return;
    expect(minionValue(aviator, state, { cards, bgStats: null }).total).toBeGreaterThan(
      value.total,
    );

    const advice = adviseTavern(state, { cards, bgStats: null });
    const topBuy = advice?.recommendations.find((r) => r.action === 'buy' && r.minion !== null);
    expect(topBuy?.minion?.cardId).toBe('BG34_140');
  });

  it('ход 5: рука доходит до симулятора и ралли призывает из неё', () => {
    // Expert Aviator — «Rally: Summon the highest-Attack minion from your
    // hand for this combat only». Симулятор это умеет и читает
    // `attackingHero.hand`, а наш маппер руку не передавал вовсе: строка
    // «по бою» оценивала носителя ралли как голое тело.
    expect(turn5).not.toBeNull();
    if (turn5 === null) return;
    const state = turn5;

    const question = battleQuestion(state);
    expect(question).not.toBeNull();
    if (question === null) return;
    // В руке лежит Бранн 2/4 — его ралли и призывает.
    expect(question.setups[0]?.playerHand?.map((m) => m.cardId)).toEqual(['BG_LOE_077']);

    const aviator = state.shop.find((m) => m.cardId === 'BG34_140');
    expect(aviator).toBeDefined();
    if (aviator === undefined) return;
    const board: readonly Minion[] = [...state.board, aviator];

    const simulator = sharedBattleSimulator();
    const outcome = (hand: boolean): number => {
      let sum = 0;
      for (const [i, setup] of question.setups.entries()) {
        const base = toBattleInfo(hand ? setup : { ...setup, playerHand: undefined }, 1);
        const r = withSeededRandom(31_337 + i, () =>
          simulator.run(withPlayerBoard(base, board), 2000),
        );
        sum += r.wonPercent + r.tiedPercent / 2;
      }
      return sum / question.setups.length;
    };

    // Разница и есть цена дыры: без руки ралли не давало НИЧЕГО.
    expect(outcome(true)).toBeGreaterThan(outcome(false) + 10);
  }, 120_000);
});
