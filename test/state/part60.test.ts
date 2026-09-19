import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, minionValue, type Recommendation } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState, Minion } from '../../src/state/types.js';
import { createBreather } from '../breather.js';
import { part60Game } from '../fixtures.js';

/**
 * part60 — Val'kyr Varden (18.09.2026), 1-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Кадр один, в чат (verifiedBy:
 * скриншот из чата): 14:51, ход 21, оверлей советует «ПРОДАТЬ Nomi,
 * Kitchen Nightmare 21/16 (зол) → КУПИТЬ Meteorite Crasher 118/128».
 *
 * Пункты игрока: учитывал ли советник силу героя (нет — D258), верно ли
 * продавать Nomi (нет — D259), и где игрок поступил иначе и был прав
 * (Kelp Keeper — D260; разбор ходов — в журнале, j-0918-3).
 */
describe('part60: Varden — заморозка силы, плательщики за розыгрыш, Kelp Keeper', () => {
  let text: string;
  let lines: string[];
  let cards: CardIndex;
  let turns: TavernTurn[];
  let final: GameState;

  beforeAll(async () => {
    text = part60Game();
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
    list.map((m) => `${name(m)} ${String(m.attack)}/${String(m.health)}${m.frozen ? ' [заморожен]' : ''}`);
  const touches = (r: Recommendation, m: Minion): boolean =>
    r.sellFirst?.entityId === m.entityId || (r.action === 'sell' && r.minion?.entityId === m.entityId);
  const boardOf = (s: GameState, cardName: string): Minion => {
    const found = s.board.find((m) => name(m) === cardName);
    expect(found, cardName).toBeDefined();
    return found!;
  };

  /**
   * Кнопка заморозки одна на оба направления, и блок PLAY у них одинаковый;
   * различает их витрина внутри блока: 14:35:34 — `FROZEN value=1` трём
   * картам (четвёртую уже держала сила Varden), 14:35:35 — `value=0` всем
   * четырём. Игрок жал «заморозить всё + снять всё» ради пары силы.
   */
  it('журнал различает заморозку и её снятие: 14 из 16 нажатий — пары', () => {
    const presses = final.actions
      .filter((a) => a.type === 'freeze' || a.type === 'unfreeze')
      .map((a) => `${String(a.turn)}${a.type === 'freeze' ? '+' : '-'}`);
    expect(presses).toEqual([
      '1+', '1-', '3+', '3-', '11+', '13+', '13-', '15+', '15-', '21+', '21-', '23+', '23-', '27+', '27-', '33+',
    ]);
  });

  it('партия целая: один матч Battlegrounds, доигранный до конца, 1-е место', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.match(/GameState\.DebugPrintPower\(\) - CREATE_GAME/g)).toHaveLength(1);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
    expect(final.buildNumber).toBe(251952);
    expect(final.finalPlace).toBe(1);
    expect(turns).toHaveLength(18);
    expect(final.hero?.cardId).toBe('BG22_HERO_004_SKIN_C');
    expect(final.hero?.heroPowerCardId).toBe('BG22_HERO_004p');
  });

  /**
   * «Twice as Nice»: «After the Tavern is Refreshed, copy its highest-Tier
   * minion and Freeze them both». Блок TRIGGER на сущности силы — в начале
   * каждого хода таверны (свежая витрина тоже «Refreshed») и после каждого
   * обновления: 18 ходов таверны без хода 35 (витрина удержана целиком —
   * обновления нет) и 48 обновлений.
   */
  it('сила Varden срабатывает 65 раз, и заморозка ложится на ОТДЕЛЬНЫХ миньонов', () => {
    const triggers = lines.filter(
      (l) =>
        l.includes('GameState.DebugPrintPower()') &&
        l.includes('BLOCK_START BlockType=TRIGGER') &&
        l.includes('cardId=BG22_HERO_004p'),
    );
    expect(triggers).toHaveLength(65);
    // Ход 5, 14:36:38: копия Sellemental (CREATOR=166 — сущность силы),
    // и заморожены ровно оригинал и копия, а не вся витрина.
    const turn5 = at('14:36:39.0');
    expect(label(turn5.shop)).toEqual([
      'Sellemental 3/3 [заморожен]',
      'Sellemental 3/3 [заморожен]',
      'Razorfen Geomancer 2/1',
      'Razorfen Geomancer 2/1',
      'Southsea Busker 3/1',
    ]);
  });

  /**
   * Кадр 14:51 (в чат) совпадает со срезом 14:51:30: ход 21, тир 5, золото
   * 10/10, 14 здоровья, пара Felboar под заморозкой силы, Time Management
   * за 4. Прежний оверлей на этом кадре советовал продать Nomi (D259).
   */
  it('кадр 14:51 совпадает со срезом лога', () => {
    const frame = at('14:51:30.0');
    expect(frame.turn).toBe(21);
    expect(frame.techLevel).toBe(5);
    expect([frame.gold, frame.goldTotal]).toEqual([10, 10]);
    expect((frame.hero?.health ?? 0) - (frame.hero?.damage ?? 0) + (frame.hero?.armor ?? 0)).toBe(14);
    expect(label(frame.board)).toEqual([
      'Waveling 38/23',
      'Unbound Tempest 160/169',
      'Flourishing Frostling 113/105',
      'Unbound Tempest 77/82',
      'Snow Baller 101/108',
      'Tavern Tempest 42/42',
      'Nomi, Kitchen Nightmare 21/16',
    ]);
    expect(label(frame.shop)).toEqual([
      'Razorfen Flapper 6/2',
      'Razorfen Flapper 6/2',
      'Intrepid Botanist 3/4',
      'Meteorite Crasher 118/128',
      'Felboar 2/6 [заморожен]',
      'Felboar 2/6 [заморожен]',
    ]);
    expect(frame.shopSpells.map((s) => [name(s), s.cost])).toEqual([['Time Management', 4]]);
  });

  /**
   * D258. Цель, которую уже держит заморозка силы (сама или её копия),
   * нажатия кнопки не требует: кнопка — переключатель на всю витрину,
   * и при частичной заморозке морозит ВСЁ. Прежде на этих трёх моментах
   * советовалось «ЗАМОРОЗИТЬ» — Tusked Camper, Winterfinner и Nomi.
   */
  it('заморозку ради миньона, которого держит сила, не советует (D258)', () => {
    for (const [until, frozen] of [
      ['14:35:34.2', 'Tusked Camper'],
      ['14:38:52.2', 'Very Hungry Winterfinner'],
      ['14:48:42.6', 'Nomi, Kitchen Nightmare'],
    ] as const) {
      const state = at(until);
      expect(state.shop.some((m) => m.frozen && name(m) === frozen), until).toBe(true);
      const advice = adviseTavern(state, { cards });
      expect(advice?.recommendations.some((r) => r.action === 'freeze'), until).toBe(false);
      const plan = spendPlan(state, { cards });
      expect(plan.steps.some((s) => s.recommendation.action === 'freeze'), until).toBe(false);
    }
  });

  /**
   * D259. Золотая Nomi — плательщик за розыгрыш элементаля: +8/+8 витрине
   * «this game» за каждый. Её ценность считается розыгрышами племени
   * за ход таверны (журнал действий), и на кадре игрока она больше
   * не жертва продажи.
   */
  it('Nomi на кадре не продаётся: её держит число розыгрышей (D259)', () => {
    const frame = at('14:51:30.0');
    const nomi = boardOf(frame, 'Nomi, Kitchen Nightmare');
    expect(nomi.scriptData.slice(0, 2)).toEqual([8, 8]);
    expect(minionValue(nomi, frame, { cards }).playEngine).toBeGreaterThan(300);
    const advice = adviseTavern(frame, { cards });
    expect(advice?.recommendations.some((r) => touches(r, nomi))).toBe(false);
    const plan = spendPlan(frame, { cards });
    expect(plan.steps.some((s) => touches(s.recommendation, nomi))).toBe(false);
  });

  /**
   * D259, ход 19. Две Nomi в витрине (одна — копия силы) и одна на борде:
   * прежний план продавал Nomi с борда ради Leeroy между двумя покупками
   * и оставался с двумя обычными в руке. Теперь — золотая, как у игрока.
   */
  it('ход 19: план собирает золотую Nomi, а не продаёт копию', () => {
    const plan = spendPlan(decisionPoint(19), { cards });
    const nomiBuys = plan.steps.filter(
      (s) => s.recommendation.action === 'buy' && s.recommendation.minion !== null && name(s.recommendation.minion) === 'Nomi, Kitchen Nightmare',
    );
    expect(nomiBuys).toHaveLength(2);
    const last = plan.steps.at(-1)?.stateAfter;
    expect(last?.board.some((m) => name(m) === 'Nomi, Kitchen Nightmare' && m.golden)).toBe(true);
  });

  /**
   * D259, ход 29: только что выставленная Unbound Tempest 3/12 («After you
   * play {1} Elementals, gain the stats of the highest-Health minion in the
   * Tavern») советовалась в продажу ради Moat Custodian — игрок её оставил,
   * и к ходу 35 она выросла до 4059/3793. Розыгрыш Water Droplet 3/3 при
   * двух бурях со счётчиком 1 (+921/+924 в логе) стоил 11.0 очка.
   */
  it('буря не продаётся, розыгрыш элементаля при бурях стоит их платы (D259)', () => {
    const t29 = at('15:01:14.2');
    const fresh = t29.board.find((m) => m.cardId === 'BG36_352' && m.attack === 3 && m.health === 12);
    expect(fresh).toBeDefined();
    expect(minionValue(fresh!, t29, { cards }).playEngine).toBeGreaterThan(400);
    expect(adviseTavern(t29, { cards })?.recommendations.some((r) => touches(r, fresh!))).toBe(false);

    const drop = at('15:01:55.5');
    const play = adviseTavern(drop, { cards })?.recommendations.find(
      (r) => r.action === 'play' && r.minion !== null && name(r.minion) === 'Water Droplet',
    );
    expect(play?.score ?? 0).toBeGreaterThan(300);
    expect(play?.reason).toContain('розыгрыш кормит: Unbound Tempest');
  });

  /**
   * План считает бурю ТОЧНО: на последнем из трёх розыгрышей она забирает
   * статы самого здорового тела витрины (у золотой — вдвое) и заводит
   * счётчик заново. 15:01:55: покупка Sand Swirler — розыгрыш элементаля
   * при счётчике 1 — и буря берёт Cataclysmic Harbinger 120/134, оставшийся
   * самым здоровым в витрине.
   */
  it('шаг плана с элементалем кормит бурю: счётчик и статы витрины', () => {
    const state = at('15:01:55.5');
    const [golden, plain] = state.board.filter((m) => m.cardId.startsWith('BG36_352'));
    expect([golden?.attack, golden?.health, plain?.attack, plain?.health]).toEqual([4173, 4316, 425, 417]);
    expect([golden?.scriptData[0], plain?.scriptData[0]]).toEqual([1, 1]);
    const plan = spendPlan(state, { cards });
    const first = plan.steps[0];
    expect(first?.recommendation.minion === null ? null : name(first!.recommendation.minion)).toBe('Sand Swirler');
    const after = first!.stateAfter.board.filter((m) => m.cardId.startsWith('BG36_352'));
    expect(after.map((m) => [m.attack, m.health, m.scriptData[0]])).toEqual([
      [4173 + 240, 4316 + 268, 3],
      [425 + 120, 417 + 134, 3],
    ]);
  });

  /**
   * D260. Kelp Keeper («Activate: Trigger a friendly minion's Battlecry»)
   * семь раз нажат на Tavern Tempest («Battlecry: Get a random Elemental»):
   * принесённого элементаля игрок разыгрывал при Nomi и бурях и продавал.
   * Прежде у нажатия было 0 очков, а Kelp шёл в жертвы продажи.
   */
  it('Kelp Keeper советуется нажать на Tavern Tempest (D260)', () => {
    const t23 = at('14:54:41.4');
    const plan = spendPlan(t23, { cards });
    const first = plan.steps[0]?.recommendation;
    expect(first?.action).toBe('activate');
    expect(first?.minion === null || first?.minion === undefined ? null : name(first.minion)).toBe('Kelp Keeper');
    expect(first?.targetMinion === null || first?.targetMinion === undefined ? null : name(first.targetMinion)).toBe('Tavern Tempest');

    // Ход 33, при Бранне клич срабатывает дважды: две карты за нажатие.
    const t33 = at('15:05:45.1');
    const top = adviseTavern(t33, { cards })?.recommendations[0];
    expect(top?.action).toBe('activate');
    expect(top?.targetMinion === null || top?.targetMinion === undefined ? null : name(top.targetMinion)).toBe('Tavern Tempest');
    expect(top?.reason).toContain('принесёт 2 карт.');
    const kelp = boardOf(t33, 'Kelp Keeper');
    expect(minionValue(kelp, t33, { cards }).activation).toBeGreaterThan(500);
  });
});
