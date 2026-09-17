import { beforeAll, describe, expect, it } from 'vitest';

import {
  activationRules,
  adviseTavern,
  heroPowerShareAttackRule,
} from '../../src/advisors/tavern/advisor.js';
import { applyRecommendation, spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState, Minion } from '../../src/state/types.js';
import { spendPlanLine } from '../../src/ui/format.js';
import { createBreather } from '../breather.js';
import { part56Game } from '../fixtures.js';

/**
 * part56 — Вольджин (17.09.2026), 6-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Кадр игрок прислал один, в чат
 * (verifiedBy: скриншот из чата): 17:34 — ход 7, план «Search Through Time →
 * Humming Bird, остаётся 1 — сгорит». Пунктов два: оверлей не звал нажать
 * силу героя (D240) и советовал ход со сгорающим золотом (D242); третий —
 * разбор ходов, где игрок поступил иначе (активация Lurking Lionfish, D241).
 */
describe('part56: Вольджин, обмен атакой и приманка Lionfish', () => {
  let text: string;
  let lines: string[];
  let cards: CardIndex;
  let turns: TavernTurn[];
  let final: GameState;

  beforeAll(async () => {
    text = part56Game();
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
    expect(final.finalPlace).toBe(6);
    expect(turns).toHaveLength(9);
    expect(final.hero?.cardId).toBe('BG20_HERO_201');
  });

  /**
   * Кадр 17:34 (скриншот из чата): ход 7, тир 2, золото 6/6, 30 здоровья
   * и 14 брони; на борде Glim Guardian 1/4, Forest Rover 1/1, Humming Bird
   * 1/4, в витрине 2/1, 2/3, 1/4, 3/4 и Search Through Time за 2, у силы
   * на кнопке 0. Первая трата хода — покупка в 17:34:0x, так что кадр
   * совпадает с точкой решения.
   */
  it('кадр хода 7 совпадает со скриншотом и с точкой решения', () => {
    const frame = at('17:34:00.0');
    expect(frame.turn).toBe(7);
    expect(frame.techLevel).toBe(2);
    expect([frame.gold, frame.goldTotal]).toEqual([6, 6]);
    expect(frame.hero?.armor).toBe(14);
    expect(label(frame.board)).toEqual(['Glim Guardian 1/4', 'Forest Rover 1/1', 'Humming Bird 1/4']);
    expect(label(frame.shop)).toEqual([
      'Ominous Seer 2/1',
      'Tusked Camper 2/3',
      'Humming Bird 1/4',
      'Intrepid Botanist 3/4',
    ]);
    expect(frame.shopSpells.map((s) => [name(s), s.cost])).toEqual([['Search Through Time', 2]]);
    expect(frame.hero?.heroPowerCost).toBeNull();

    const point = decisionPoint(7);
    expect(label(point.board)).toEqual(label(frame.board));
    expect(label(point.shop)).toEqual(label(frame.shop));
  });

  /**
   * Сила двухшаговая, и второй шаг — другая карта:
   *
   *   D 17:31:32.50… BLOCK_START BlockType=PLAY Entity=[… cardId=BG20_HERO_201p …] Target=[… id=455 … cardId=BG29_888 player=6]
   *   D 17:31:32.50…   CHANGE_ENTITY - Updating Entity=[… id=166 … cardId=BG20_HERO_201p …] CardID=BG20_HERO_201p2
   *   D 17:31:32.50…   TAG_CHANGE Entity=[… id=166 …] tag=TAG_SCRIPT_DATA_NUM_1 value=455
   *   D 17:31:34.89… BLOCK_START BlockType=PLAY Entity=[… cardId=BG20_HERO_201p2 …] Target=[… id=453 … cardId=BG36_921 player=14]
   *   D 17:31:34.89…   TAG_CHANGE Entity=[… id=453 … cardId=BG36_921 player=14] tag=ATK value=6
   *   D 17:31:34.89…   TAG_CHANGE Entity=[… id=455 … cardId=BG29_888 player=6] tag=ATK value=6
   *
   * `player=14` — Боб: второй миньон пары взят из ВИТРИНЫ.
   */
  it('сила Вольджина: первое нажатие, второе и итог — по логу', () => {
    const before = at('17:31:32.0');
    expect(before.hero?.heroPowerCardId).toBe('BG20_HERO_201p');
    expect(label(before.board)).toEqual(['Glim Guardian 1/4']);

    const mid = at('17:31:33.0');
    expect(mid.hero?.heroPowerCardId).toBe('BG20_HERO_201p2');
    expect(mid.hero?.heroPowerScriptData[0]).toBe(455);
    expect(mid.hero?.heroPowerExhausted).toBe(false);

    const after = at('17:31:36.0');
    expect(after.hero?.heroPowerCardId).toBe('BG20_HERO_201p');
    expect(after.hero?.heroPowerExhausted).toBe(true);
    expect(label(after.board)).toEqual(['Glim Guardian 6/4']);
  });

  /**
   * D240: до правки советник молчал о силе на всех девяти точках решения,
   * а игрок жал её каждый ход. Совет повторяет то, что сделал игрок
   * на первом ходу: свой Glim Guardian берёт атаку Fleeing Fugitive 5/2
   * из витрины, и план даёт ровно борд лога — 6/4.
   */
  it('D240: первое нажатие — свой плюс самый атакующий из витрины, борд как в логе', () => {
    const before = at('17:31:32.0');
    const rec = heroPowerShareAttackRule(before, { cards });
    expect(rec).not.toBeNull();
    expect(name(rec!.targetMinion!)).toBe('Glim Guardian');
    expect(rec!.sharesAttack?.partner === null ? null : name(rec!.sharesAttack!.partner)).toBe(
      'Fleeing Fugitive',
    );
    expect(rec!.sharesAttack?.last).toBe(true);
    const applied = applyRecommendation(before, rec!);
    expect(label(applied!.state.board)).toEqual(label(at('17:31:36.0').board));
    expect(applied!.state.hero?.heroPowerExhausted).toBe(true);
  });

  it('D240: второе нажатие знает первую цель и называет вторую', () => {
    const mid = at('17:31:33.0');
    const rec = heroPowerShareAttackRule(mid, { cards });
    expect(rec).not.toBeNull();
    expect(name(rec!.targetMinion!)).toBe('Fleeing Fugitive');
    expect(rec!.sharesAttack).toEqual({ partner: null, last: false });
    expect(rec!.boardGains).toEqual([{ entityId: 455, attack: 5, health: 0 }]);

    // Ход 17: первая цель — свой золотой Lionfish 30/14; своя атака крупнее
    // витрины, и пара — двое своих, растут оба (игрок взял Tasty Lobster).
    const late = at('17:44:25.0');
    expect(late.hero?.heroPowerScriptData[0]).toBe(8142);
    const second = heroPowerShareAttackRule(late, { cards });
    expect(late.board.some((m) => m.entityId === second!.targetMinion!.entityId)).toBe(true);
    expect(second!.boardGains?.map((g) => g.entityId)).toContain(8142);
    expect(second!.boardGains).toHaveLength(2);
  });

  it('D240: сила стоит в плане на каждой точке решения и после всех покупок', () => {
    for (const { turn, state } of turns) {
      const plan = spendPlan(state, { cards });
      const actions = plan.steps.map((s) => s.recommendation.action);
      const power = actions.indexOf('heroPower');
      expect(power, `ход ${String(turn)}: ${spendPlanLine(plan, cards)}`).toBeGreaterThanOrEqual(0);
      expect(actions.slice(power + 1).filter((a) => a === 'buy' || a === 'play'), `ход ${String(turn)}`).toEqual(
        [],
      );
    }
  });

  /**
   * D241: активация Lurking Lionfish — приманка в витрине и удар своего
   * самого левого зверя по ней:
   *
   *   D 17:41:37.63… BLOCK_START BlockType=PLAY Entity=[… id=5301 … cardId=BG36_201 player=6]
   *   D 17:41:37.63…   TAG_CHANGE Entity=AngryMem#2886 tag=RESOURCES_USED value=7
   *   D 17:41:37.63…     CHANGE_ENTITY - Updating Entity=[… id=6078 … cardId=BG33_430 player=14] CardID=BG36_205
   *   D 17:41:37.63…         tag=TAG_SCRIPT_DATA_NUM_1 value=5
   *   D 17:41:37.63…     BLOCK_START BlockType=ATTACK Entity=[… id=6086 … cardId=BG36_207 player=6]
   *
   * Rally Wolf Pup кладёт +4/+1 шести соседям, хрип приманки — +5/+5
   * ему самому: сорок статов за 2 золота. Советник молчал, игрок нажал
   * дважды подряд — и план теперь даёт ровно борд лога.
   */
  it('D241: активация Lionfish считается ударом Wolf Pup по приманке, борд как в логе', () => {
    const before = at('17:41:37.0');
    const after = at('17:41:38.0');
    const recs = activationRules(before, { cards });
    const bait = recs.find((r) => r.minion?.entityId === 5301);
    expect(bait, recs.map((r) => r.reason).join('\n')).toBeDefined();
    expect(bait!.cost).toBe(2);
    expect(bait!.boardGains?.reduce((s, g) => s + g.attack + g.health, 0)).toBe(40);
    expect(bait!.reason).toContain('Wolf Pup');
    // Wolf Pup уже самый левый — переставлять не надо.
    expect(bait!.reason).not.toContain('левее');
    const applied = applyRecommendation(before, bait!);
    expect(label(applied!.state.board)).toEqual(label(after.board));
  });

  it('D241: на точке решения хода 15 активация входит в план после покупки Wolf Pup', () => {
    const plan = spendPlan(decisionPoint(15), { cards });
    const steps = plan.steps.map((s) => s.recommendation);
    const wolf = steps.findIndex((r) => r.action === 'buy' && r.minion !== null && name(r.minion) === 'Wolf Pup');
    const bait = steps.findIndex((r) => r.action === 'activate');
    expect(wolf, spendPlanLine(plan, cards)).toBeGreaterThanOrEqual(0);
    expect(bait, spendPlanLine(plan, cards)).toBeGreaterThan(wolf);
  });

  /**
   * D242, кадр игрока: «Search Through Time → Humming Bird, остаётся 1 —
   * сгорит». Замок в руке теперь стоит долю тела, и план тратит всё золото
   * на два тела, которые сыграют в ближайшем бою.
   */
  it('D242: на кадре хода 7 план без сгорающего золота, замок назван в причине', () => {
    const state = decisionPoint(7);
    const plan = spendPlan(state, { cards });
    expect(plan.goldLeft, spendPlanLine(plan, cards)).toBe(0);
    expect(plan.steps.some((s) => s.recommendation.spellCardId === 'BG34_330')).toBe(false);
    const stt = adviseTavern(state, { cards })!.recommendations.find((r) => r.spellCardId === 'BG34_330');
    expect(stt?.reason).toContain('замок в руке на 1 ход');
  });
});
