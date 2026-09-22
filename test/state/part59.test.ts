import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  copiesOwned,
  heroPowerRule,
  isStandIn,
} from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState, Minion } from '../../src/state/types.js';
import { spendPlanLine } from '../../src/ui/format.js';
import { createBreather } from '../breather.js';
import { part59Game } from '../fixtures.js';

/**
 * part59 — Крысиный король (18.09.2026), 4-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Кадров нет, пункт игрока словами:
 * «на 1 ходу на мой взгляд советовало более слабый ход с учётом того, что
 * я сделал в итоге». Сделал он ту же цепочку, что в part30: сила
 * «Discover a <Tribe>» за 2, найденный миньон из руки, банан за 1 на него.
 * Разбор ходов, где игрок поступил иначе, — в журнале (j-0918-2).
 */
describe('part59: Крысиный король, сила-Discover и банан на найденного', () => {
  let text: string;
  let lines: string[];
  let cards: CardIndex;
  let turns: TavernTurn[];
  let final: GameState;

  beforeAll(async () => {
    text = part59Game();
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

  /** Состояние на момент времени — срезом лога, с долями секунды. */
  const at = (until: string): GameState => {
    const taken: string[] = [];
    for (const line of lines) {
      const m = /^D (\d\d:\d\d:\d\d\.\d+)/.exec(line);
      if (m !== null && (m[1] ?? '') > until) break;
      taken.push(line);
    }
    return reduceLog(taken.join('\n'));
  };

  const decisionPoint = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    expect(found, `точка решения хода ${String(turn)}`).toBeDefined();
    return found!.state;
  };

  const name = (m: { cardId: string }): string => cards.info(m.cardId)?.name ?? m.cardId;
  const label = (list: readonly Minion[]): string[] =>
    list.map((m) => `${name(m)} ${String(m.attack)}/${String(m.health)}`);

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.match(/GameState\.DebugPrintPower\(\) - CREATE_GAME/g)).toHaveLength(1);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
    expect(final.buildNumber).toBe(251952);
    expect(final.finalPlace).toBe(4);
    expect(turns).toHaveLength(12);
    expect(final.hero?.cardId).toBe('TB_BaconShop_HERO_12');
  });

  /**
   * Что сыграно на ходу 1 (строки лога):
   *
   *   13:32:09 BLOCK_START BlockType=PLAY … cardId=TB_BaconShop_HP_041k  (King of Undead)
   *   13:32:15 розыгрыш найденного Harmless Bonehead из руки
   *   13:32:15 покупка Tavern Dish Banana BG28_897 за 1 → на Harmless Bonehead
   *
   * К концу хода на борде один Harmless Bonehead 3/3 — 1/1 базы и +2/+2
   * банана. Бой хода 2 выигран.
   */
  it('ход 1 в логе: сила, найденный Harmless Bonehead и банан на него', () => {
    const start = decisionPoint(1);
    expect([start.gold, start.goldTotal]).toEqual([3, 3]);
    expect(start.board).toHaveLength(0);
    expect(start.hero?.heroPowerCardId).toBe('TB_BaconShop_HP_041k');
    expect(start.hero?.heroPowerCost).toBe(2);
    expect(label(start.shop)).toEqual(['Tusked Camper 2/3', 'Southsea Busker 3/1', 'Risen Rider 2/1']);
    expect(start.shopSpells.map((s) => [s.cardId, s.cost])).toEqual([['BG28_897', 1]]);

    const end = at('13:32:20.0');
    expect(label(end.board)).toEqual(['Harmless Bonehead 3/3']);
    expect(end.gold).toBe(0);
  });

  /**
   * Пункт игрока. Прежде: «КУПИТЬ Tusked Camper за 3» (7.0) верхней строкой
   * и планом, сила — третьей при тех же 7.0. Скидка силы («на 1 золота
   * дешевле покупки») не засчитывалась: остатку 1 не хватало на миньона,
   * а банан на пустом борде не играется — золотой считался сгоревшим.
   *
   * Мерка хода (борд плана против борда игрока, поле хода, 200 симуляций
   * на борд): Tusked Camper 2/3 — 50.8 %, Harmless Bonehead 3/3 — 91.3 %.
   */
  it('пункт: сила верхней строкой, остаток — на банан', () => {
    const state = decisionPoint(1);
    const rec = heroPowerRule(state, { cards });
    expect(rec).not.toBeNull();
    // Лучший из трёх UNDEAD тира 1 — 7.0, и сэкономленный золотой по курсу.
    expect(rec?.score).toBeCloseTo(10.0, 1);
    expect(rec?.reason).toContain('остаток на Tavern Dish Banana');
    expect(adviseTavern(state, { cards })?.recommendations[0]?.action).toBe('heroPower');
  });

  /**
   * План: шаг силы кладёт на борд ЗАГОТОВКУ найденного миньона
   * (`bringsMinion`), и банану есть на кого лечь. Заготовка называется
   * племенем, а не картой, — карты игрок ещё не видел.
   */
  it('пункт: план — сила, затем банан на найденного, золото целиком', () => {
    const state = decisionPoint(1);
    const plan = spendPlan(state, { cards });
    const steps = plan.steps.map((s) => s.recommendation);
    expect(steps.map((r) => r.action)).toEqual(['heroPower', 'buy']);
    expect(steps[1]?.spellCardId).toBe('BG28_897');
    const target = steps[1]?.targetMinion ?? null;
    expect(target).not.toBeNull();
    expect(isStandIn(target!)).toBe(true);
    expect(cards.info(target!.cardId)?.races).toContain('UNDEAD');
    expect(plan.goldLeft).toBe(0);
    expect(spendPlanLine(plan, cards)).toContain('на найденного UNDEAD');
  });

  /**
   * Заготовка — типичный выбор пула, а не карта игрока: копией она
   * не считается нигде. Иначе вторая копия её карты в витрине стала бы
   * «парой под тройку» с картой, которой у нас нет.
   */
  it('заготовка копией не считается', () => {
    const state = decisionPoint(1);
    const plan = spendPlan(state, { cards });
    const after = plan.steps[0]!.stateAfter;
    const standIn = after.board.find(isStandIn);
    expect(standIn).toBeDefined();
    const twin: Minion = { ...standIn!, entityId: 99_999 };
    expect(copiesOwned(twin, after)).toBe(0);
  });

  /**
   * Ход 5: после подъёма при двух золотых план продавал Razorfen Geomancer
   * ради второй копии Harmless Bonehead (продажа по выбору, D212), хотя
   * сила King of Pirates за 2 даёт тело без продажи. Игрок: подъём → сила
   * (Bilgewater Breakout) → оба Blood Gem. По полю 91.5 % против 87.8 %.
   */
  it('ход 5: сила вместо продажи ради второй копии', () => {
    const plan = spendPlan(decisionPoint(5), { cards });
    const steps = plan.steps.map((s) => s.recommendation);
    expect(steps.slice(0, 2).map((r) => r.action)).toEqual(['levelUp', 'heroPower']);
    expect(steps.every((r) => r.sellFirst === null)).toBe(true);
  });

  /**
   * Ход 11, 13:38:13 — после силы в руке Mechagnome Interpreter («Whenever
   * you play or Magnetize a Mech, give it +3/+1»). Игрок сыграл его ДО
   * магнита Enchanted Sentinel (строки 53211, 53257–53258: Lullabot 10/14),
   * план ставил последним. На том же составе +6.3 п.п. по полю.
   */
  it('ход 11: Interpreter разыгрывается раньше магнита меха', () => {
    const plan = spendPlan(at('13:38:13.5'), { cards });
    const steps = plan.steps.map((s) => s.recommendation);
    const payer = steps.findIndex((r) => r.action === 'play' && r.minion?.cardId === 'BG31_177');
    const magnet = steps.findIndex((r) => r.magnetizeTo != null);
    expect(payer).toBeGreaterThanOrEqual(0);
    expect(magnet).toBeGreaterThan(payer);
  });

  /**
   * Ход 13: тир награды за тройку фиксируется в блоке розыгрыша ЗОЛОТОГО
   * (строка 70653: `TB_BaconShop_Triples_01` с `TAG_SCRIPT_DATA_NUM_1=6`
   * сразу после подъёма до 5 в 13:39:34). Когда цепочка и так поднимается,
   * подъём идёт раньше золотого. Сам подъём по графику стоит 0 — чтобы
   * он попал в цепочку, кривая сдвинута: тир 5 положен уже на 7-м ходу
   * таверны.
   */
  it('ход 13: подъём в цепочке — раньше розыгрыша золотого', () => {
    const rules = {
      ...DEFAULT_TAVERN_RULES,
      levelling: DEFAULT_TAVERN_RULES.levelling.map((r) =>
        r.tier === 5 ? { ...r, fromTavernTurn: 7 } : r,
      ),
    };
    const plan = spendPlan(decisionPoint(13), { cards }, rules);
    const actions = plan.steps.map((s) => s.recommendation);
    const level = actions.findIndex((r) => r.action === 'levelUp');
    const golden = actions.findIndex(
      (r) => r.action === 'play' && r.minion?.cardId === 'BG36_764_G',
    );
    expect(level).toBeGreaterThanOrEqual(0);
    expect(golden).toBeGreaterThan(level);
  });

  /**
   * Ходы 15 и 17: Careful Investment («Gain 2 Gold next turn») в руке
   * советник не видел — разбор проваливался в ветку усиления с нулём.
   * Игрок разыграл четыре штуки сразу (строка 100359, тег
   * `BACON_PLAYER_EXTRA_GOLD_NEXT_TURN` 2 → 4 → 6): золото 12/10 и 16/10.
   * Leaf Through the Pages в руке тоже был невидим, и план платил
   * «ОБНОВИТЬ за 1» при двух бесплатных.
   */
  it('ход 15: Careful Investment и Leaf из руки советуются, обновление бесплатно', () => {
    const state = decisionPoint(15);
    const recs = adviseTavern(state, { cards })?.recommendations ?? [];
    const invest = recs.find((r) => r.spellCardId === 'BG28_800');
    expect(invest?.action).toBe('play');
    expect(invest?.score).toBeCloseTo(6.0, 5);
    expect(invest?.grantsGoldNextTurn).toBe(2);
    expect(invest?.grantsGold).toBeUndefined();
    const leaf = recs.find((r) => r.spellCardId === 'BG28_827');
    expect(leaf?.grantsFreeRefreshes).toBe(2);

    const plan = spendPlan(state, { cards });
    const steps = plan.steps.map((s) => s.recommendation);
    const leafAt = steps.findIndex((r) => r.spellCardId === 'BG28_827');
    const reroll = steps.findIndex((r) => r.action === 'reroll');
    expect(leafAt).toBeGreaterThanOrEqual(0);
    if (reroll >= 0) {
      expect(reroll).toBeGreaterThan(leafAt);
      expect(steps[reroll]?.cost).toBe(0);
    }
    const invested = plan.steps.at(-1)?.stateAfter.extraGoldNextTurn ?? 0;
    expect(invested).toBeGreaterThanOrEqual(state.extraGoldNextTurn + 2);
  });

  it('ход 17: план разыгрывает все три Careful Investment', () => {
    const plan = spendPlan(decisionPoint(17), { cards });
    const invests = plan.steps.filter((s) => s.recommendation.spellCardId === 'BG28_800');
    expect(invests).toHaveLength(3);
  });

  /**
   * Tricky Trousers `BG28_520`: «Give a minion +{0}/+{1} and Taunt. If it
   * already has Taunt, remove it.» План клал оба на золотой Gearfin, и второе
   * снимало провокацию, данную первым (D267).
   */
  it('ход 17: вторые Tricky Trousers идут на другую цель — провокацию с Gearfin они сняли бы', () => {
    const plan = spendPlan(decisionPoint(17), { cards });
    const trousers = plan.steps.filter((s) => s.recommendation.spellCardId === 'BG28_520');
    expect(trousers).toHaveLength(2);
    const [first, second] = trousers.map((s) => s.recommendation);
    expect(first?.setsTaunt).toBe(true);
    expect(second?.targetMinion?.entityId).not.toBe(first?.targetMinion?.entityId);
    expect(second?.targetMinion?.taunt).toBe(false);
    expect(second?.reason).toContain('провокация уже есть');
  });

  /**
   * Ход 19: пять бесплатных заклинаний руки съедали все восемь шагов
   * плана, и он печатал «остаётся 10 — сгорит» при подъёме-хвосте D214
   * в списке (hp 13 при пороге 15). Игрок поднялся до 6.
   */
  it('ход 19: бесплатные шаги предел не съедают, остаток уходит в подъём', () => {
    const plan = spendPlan(decisionPoint(19), { cards });
    const tail = plan.steps.find((s) => s.recommendation.action === 'levelUp');
    expect(tail?.recommendation.blockedByHp).toBe(true);
    // Хвост плана — подъём за 8, после него сгорает 2. Прежде последнее
    // золото уходило в обновление за 1, и остаток был 1; с D279 такое
    // обновление молчит — после него на руках остаётся ровно 1 золото,
    // а покупка за 1 есть лишь в 32% витрин (на шестом тире — в 15%).
    // Порог считает ОСТАТОК ПОСЛЕ обновления, поэтому правило снимает
    // не только бесплатный реролл на единственном золоте (part68), но
    // и платный, оставляющий единицу.
    expect(plan.goldLeft).toBeLessThanOrEqual(2);
  });

  /**
   * Ход 21: Butchering целился в Snazzy Phantom 13/3 — единственного, кто
   * платит за перерождения, — пять раз подряд, не убирая его с борда.
   * Игрок первым бил Handless Forsaken с перерождением (13:49:14), Snazzy —
   * только дав ему перерождение (13:49:55).
   */
  it('ход 21: Butchering бьёт не плательщика, и жертва уходит с борда плана', () => {
    const state = decisionPoint(21);
    const recs = adviseTavern(state, { cards })?.recommendations ?? [];
    const butcher = recs.find((r) => r.spellCardId === 'BG28_604');
    expect(butcher?.targetMinion?.cardId).toBe('BG25_010');
    expect(butcher?.targetMinion?.reborn).toBe(true);

    const plan = spendPlan(state, { cards });
    for (const [k, s] of plan.steps.entries()) {
      const target = s.recommendation.targetMinion ?? null;
      if (s.recommendation.destroysTarget === undefined || target === null) continue;
      const before = k === 0 ? state : plan.steps[k - 1]!.stateAfter;
      expect(before.board.some((m) => m.entityId === target.entityId)).toBe(true);
      if (s.recommendation.destroysTarget.rebornCopy === null) {
        expect(s.stateAfter.board.some((m) => m.entityId === target.entityId)).toBe(false);
      }
    }
  });

  /**
   * Ход 23: две активации Dead Bellringer в Eternal Knight (13:51:23,
   * 13:51:26) — Snazzy Phantom отдал Deathly Striker +77/+77 и +81/+81
   * (энчант `BG36_515e`, NUM_1=77, строка 268044). Совет стоил 1.0 и целил
   * в самого Snazzy, чьё перерождение ничего не запускает. Атака копии
   * рыцаря — 4 + 4 × (7 + 1) + 41 = 77, выплата Snazzy — 2 × 77.
   */
  it('ход 23: Bellringer целит в Eternal Knight и считает выплату Snazzy', () => {
    const state = decisionPoint(23);
    expect(state.globalInfo.undeadAttackBuff).toBe(41);
    expect(state.globalInfo.eternalKnightsDead).toBe(7);
    const recs = adviseTavern(state, { cards })?.recommendations ?? [];
    const presses = recs.filter((r) => r.action === 'activate' && r.minion?.cardId === 'BG36_511');
    expect(presses.length).toBeGreaterThan(0);
    for (const press of presses) {
      expect(press.targetMinion?.cardId).toBe('BG25_008');
      expect(press.reason).toContain('+154 статов');
      expect(press.score).toBeGreaterThan(70);
    }
    const plan = spendPlan(state, { cards });
    expect(plan.steps[0]?.recommendation.action).toBe('activate');
  });
});
