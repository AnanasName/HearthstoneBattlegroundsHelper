import { beforeAll, describe, expect, it } from 'vitest';

import { toBattleInfo } from '../../src/advisors/battle/mapper.js';
import { sharedBattleSimulator, type BattleSimulator } from '../../src/advisors/battle/simulator.js';
import { battleQuestion } from '../../src/advisors/position/advisor.js';
import { withSeededRandom } from '../../src/advisors/position/rng.js';
import { buyRules, minionValue } from '../../src/advisors/tavern/advisor.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part33Game } from '../fixtures.js';
import { changesAdvisorState } from '../snapshots.js';

/**
 * part33 — двадцать пятая партия с оверлеем (28.08.2026, 01:08–01:29,
 * Ал'акир, элементали, 5-е место), седьмая на билде 250339. Вопрос
 * игрока один: «учитывал ли ты при советах силу героя» — «Назойливые
 * мухи» `TB_BaconShop_HP_086`, пассивная «Start of Combat: Give your
 * left-most minion Windfury, Divine Shield, and Taunt».
 *
 * Ответ делится надвое, и тест держит обе половины: в БОЮ сила
 * учитывается (маппер передаёт её симулятору, тот её реализует), в ТАВЕРНЕ
 * — нет (ценность покупки читает текст силы только на племя, продажу,
 * статы за розыгрыш и активное «give a minion <слово>»). Вторая половина
 * закреплена как ЗАПИСАННАЯ ГРАНИЦА, а не как желаемое поведение: когда
 * пассивная сила войдёт в ценность покупки, этот тест обязан упасть,
 * чтобы правило пересмотрели, а не унаследовали молча.
 */
describe('part33: пассивная сила героя «крайний левый получает вихрь, щит и провокацию»', () => {
  let cards: CardIndex;
  let simulator: BattleSimulator;
  /** Точка решения хода 9: тир 3, золото 7/7, борд из четырёх, витрина из четырёх. */
  let decision9: GameState | null = null;
  /** Скриншот — ход 9 после подъёма на тир 4 за все семь золотых. */
  let shot9: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part33Game();
    cards = loadCardIndex();
    simulator = sharedBattleSimulator();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      if (!changesAdvisorState(event.line.content)) continue;
      const s = reducer.snapshot();
      if (s.phase !== 'tavern' || s.turn !== 9) continue;
      if (s.gold === 7 && s.board.length === 4 && s.shop.length === 4) decision9 = s;
      if (s.techLevel === 4 && s.gold === 0 && s.board.length === 4 && shot9 === null) shot9 = s;
    }
    finalState = reducer.snapshot();
  }, 900_000);

  it('партия дочитывается до конца: 5-е место, Ал\'акир, билд 250339', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(5);
    expect(finalState.hero?.cardId).toBe('TB_BaconShop_HERO_76');
    expect(finalState.buildNumber).toBe(250339);
  });

  /**
   * Пассивность читается тегами: `HAS_ACTIVATE_POWER` нет, `COST` нет,
   * блоков PLAY на силе за партию — ноль. Срабатывает она сама, блоком
   * TRIGGER в начале каждого боя (11 боёв, всегда `zonePos=1`).
   */
  it('сила читается из лога как пассивная: без активации, без цены, ни одного нажатия', () => {
    expect(finalState.hero?.heroPowerCardId).toBe('TB_BaconShop_HP_086');
    expect(finalState.hero?.heroPowerHasActivate).toBe(false);
    expect(finalState.hero?.heroPowerCost).toBeNull();
    expect(finalState.actions.filter((a) => a.type === 'heroPower')).toHaveLength(0);
    expect(cards.info('TB_BaconShop_HP_086')?.text).toMatch(/Start of Combat/);
  });

  it('скриншот: ход 9 после подъёма — тир 4, золото 0/7, hp 30+6, тот же борд', () => {
    expect(shot9).not.toBeNull();
    const s = shot9 as GameState;
    expect(s.techLevel).toBe(4);
    expect(s.goldTotal).toBe(7);
    expect(s.hero?.armor).toBe(6);
    expect(s.board.map((m) => m.cardId)).toEqual(['BGS_127', 'BGS_119', 'BG31_330', 'BG31_803']);
    // В таверне слов от силы на крайнем левом нет: она даёт их в бою и на бой.
    const left = s.board[0];
    expect(left?.taunt).toBe(false);
    expect(left?.divineShield).toBe(false);
    expect(left?.windfury).toBe(false);
    expect(s.hero?.heroPowerUsedThisTurn).toBe(false);
  });

  /**
   * Половина первая — БОЙ. Сила уезжает в симулятор полем `heroPowers`,
   * и симулятор её знает (`swatting-insects.js`: pre-combat, первый миньон
   * борда). Проверка числом на том самом состоянии: против Fleeing Fugitive
   * 7/10 с Bonehead «как стоит» с силой выигрывает каждый пятый бой
   * (крайний левый Molten Rock 3/4 с вихрем и щитом), без силы — ни разу.
   * Именно эта разница даёт 55% со скриншота вместо 50%.
   */
  it('в бою сила учитывается: симулятор получает её, и исход против поля меняется', () => {
    expect(decision9).not.toBeNull();
    const s = decision9 as GameState;
    const question = battleQuestion(s);
    expect(question).not.toBeNull();
    if (question === null) throw new Error('unreachable');
    expect(question.target.kind).toBe('field');
    expect(question.setups).toHaveLength(4);

    const fugitive = question.setups.find((x) => x.opponentBoard.some((m) => m.cardId === 'BG36_921'));
    expect(fugitive).toBeDefined();
    if (fugitive === undefined) throw new Error('unreachable');

    const withPower = toBattleInfo(fugitive, 600);
    expect(withPower.playerBoard.player.heroPowers?.[0]?.cardId).toBe('TB_BaconShop_HP_086');
    const withoutPower = toBattleInfo(
      { ...fugitive, playerHero: { ...fugitive.playerHero, heroPowerCardId: null } },
      600,
    );
    expect(withoutPower.playerBoard.player.heroPowers).toHaveLength(0);

    const seed = 20260828;
    const a = withSeededRandom(seed, () => simulator.run(withPower, 600));
    const b = withSeededRandom(seed, () => simulator.run(withoutPower, 600));
    expect(a.wonPercent).toBeGreaterThan(10);
    expect(b.wonPercent).toBe(0);
    expect(a.lostPercent).toBeLessThan(b.lostPercent);
  }, 120_000);

  /**
   * Половина вторая — ТАВЕРНА. У всех кандидатов витрины слагаемое «герой»
   * равно нулю: пассивную силу правила покупки не читают. Это граница,
   * а не поведение по умолчанию: правила для неё не выдумываются без хода,
   * где игрок покажет, чем совет был неверен.
   */
  it('в таверне сила не учитывается: слагаемое «герой» у всех покупок — ноль', () => {
    const s = decision9 as GameState;
    expect(s.shop).toHaveLength(4);
    for (const m of s.shop) {
      expect(minionValue(m, s, { cards }).heroPower).toBe(0);
    }
    expect(buyRules(s, { cards }).length).toBeGreaterThan(0);
  });
});
