import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, spellEffect, type Recommendation } from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurns } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part51Game, part6Game } from '../fixtures.js';

const MINI_MYRMIDON = 'BG23_000';
const FLEEING_FUGITIVE = 'BG36_921';
const LAB_ASSISTANT = 'BG35_150';
const SOUL_REWINDER = 'BG26_174';
const BLUE_WHELP = 'BG33_924';
const SHINY_RING = 'BG28_168';
const TIME_MANAGEMENT = 'BG31_881';
const FORESTS_BOUNTY = 'BG31_886';

/**
 * part51 — Overlord Saurfang (07.09.2026, 2-е место). Два пункта игрока,
 * и оба сводятся к тому, что советник НЕ ВИДЕЛ ход, который видно глазами.
 *
 * Первый — продажа как оплата покупки на НЕполном борде: кадр хода 11
 * снят посреди хода, золота 2 при витрине по три, и советник предлагал
 * заклинание за два. Второй нашёлся при разборе того же кадра: это
 * заклинание, Shiny Ring, бьёт ВЕСЬ борд, а считалось на одного миньона.
 *
 * Фактура лога держится отдельно от чтения, как в part48: сначала то, что
 * игра написала, потом — что из этого делает советник, и отдельно границы.
 */
describe('part51: продажа ради покупки на неполном борде и массовое усиление', () => {
  let text: string;
  let cards: CardIndex;
  let turns: ReturnType<typeof readTavernTurns>;

  beforeAll(() => {
    text = part51Game();
    cards = loadCardIndex();
    turns = readTavernTurns(text);
  }, 240_000);

  /** Состояние на момент времени — срезом лога (метод part40, part43–part48). */
  const at = (until: string): GameState => {
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^D (\d\d:\d\d:\d\d)/.exec(line);
      if (m !== null && (m[1] ?? '') > until) break;
      lines.push(line);
    }
    return reduceLog(lines.join('\n'));
  };

  const decisionPoint = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    expect(found, `точка решения хода ${String(turn)}`).toBeDefined();
    return found!.state;
  };

  const swapsOf = (recs: readonly Recommendation[]): Recommendation[] =>
    recs.filter((r) => r.action === 'buy' && r.minion !== null && r.sellFirst !== null);

  /**
   * Второй случай класса, найденного на part52 (ход 23): при hp 2 порог
   * `levellingHpFloor` обнуляет подъём, и план кончался словами «остаётся
   * 13 — сгорит». Игрок поднялся сам, в 17:31:45:
   *
   *   D 17:31:45.2021894 … BLOCK_START BlockType=PLAY Entity=[entityName=Таверна
   *   6-го уровня … cardId=TB_BaconShopTechUp06_Button player=1]
   *
   * Строка лога здесь не проверяется намеренно: файл и так держит в памяти
   * партию целиком, а лишний проход по 43 мегабайтам роняет воркер.
   */
  it('ход 29: сгорающее золото уходит в подъём, обнулённый порогом здоровья', () => {
    const state = decisionPoint(29);
    expect(state.tavernUpgradeCost).toBe(4);
    const plan = spendPlan(state, { cards });
    expect(plan.steps.map((s) => s.recommendation.action)).toContain('levelUp');
    expect(plan.goldLeft).toBeLessThan(state.gold - 4);
  }, 240_000);

  it('партия целая: один матч Battlegrounds билда 250339, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
    const final = reduceLog(text);
    expect(final.buildNumber).toBe(250339);
    expect(final.hero?.cardId).toBe('BG20_HERO_102');
    expect(final.finalPlace).toBe(2);
  }, 240_000);

  describe('кадр хода 11 (17:12:20)', () => {
    let frame: GameState;
    beforeAll(() => {
      frame = at('17:12:20');
    }, 240_000);

    it('воспроизводится дословно: золото 2 из 8, борд 6 из 7, заклинание третьим в ряду', () => {
      expect(frame.turn).toBe(11);
      expect(frame.phase).toBe('tavern');
      expect(frame.gold).toBe(2);
      expect(frame.goldTotal).toBe(8);
      expect(frame.board.map((m) => `${m.cardId} ${String(m.attack)}/${String(m.health)}`)).toEqual([
        `${FLEEING_FUGITIVE} 8/7`,
        'BGS_004 29/31',
        `${LAB_ASSISTANT} 32/33`,
        `${LAB_ASSISTANT} 15/16`,
        `${FLEEING_FUGITIVE} 6/3`,
        `${MINI_MYRMIDON} 2/5`,
      ]);
      // Витрина одной зоной: миньоны на 1, 2, 4, 5 и Shiny Ring на третьем
      // месте — ровно как на кадре (part41, сквозная ZONE_POSITION).
      expect(frame.shop.map((m) => `${m.cardId}@${String(m.zonePos)}`)).toEqual([
        `${BLUE_WHELP}@1`,
        'BG31_818@2',
        'BG29_810@4',
        `${SOUL_REWINDER}@5`,
      ]);
      expect(frame.shop.every((m) => m.buyCost === 3)).toBe(true);
      expect(frame.shopSpells.map((s) => `${s.cardId}@${String(s.zonePos)}=${String(s.cost)}`)).toEqual([
        `${SHINY_RING}@3=2`,
      ]);
    });

    it('журнал: игрок трижды обновил витрину, продал Mini-Myrmidon и купил Soul Rewinder', () => {
      const played = reduceLog(text)
        .actions.filter((a) => a.turn === 11)
        .map((a) => `${a.type}:${a.cardId ?? ''}`);
      expect(played).toEqual([
        // Выбор тринкета — каналом SendChoices, мимо блоков PLAY (с 17.09).
        'trinket:BG35_MagicItem_150',
        'roll:',
        'roll:',
        'roll:',
        'play:BG23_000t',
        `sell:${MINI_MYRMIDON}`,
        `buy:${SOUL_REWINDER}`,
        `play:${SOUL_REWINDER}`,
      ]);
    }, 240_000);

    it('советник называет размен: продать Mini-Myrmidon ради покупки за три — выше Shiny Ring', () => {
      const advice = adviseTavern(frame, { cards });
      expect(advice).not.toBeNull();
      const recs = advice!.recommendations;
      const swaps = swapsOf(recs);
      // Жертва — та, что продал игрок. Тела витрины по нашей шкале равны
      // (Blue Whelp и Soul Rewinder — по 22.5 на борде без жертвы), и по полю
      // бордов шестого хода таверны они тоже неразличимы — поэтому тест
      // держит обе покупки, а не одну.
      expect(swaps.map((r) => r.sellFirst?.cardId)).toContain(MINI_MYRMIDON);
      const bought = swaps.map((r) => r.minion?.cardId);
      expect(bought).toContain(SOUL_REWINDER);
      expect(bought).toContain(BLUE_WHELP);
      expect(swaps.every((r) => r.cost === 3)).toBe(true);

      const top = recs[0];
      expect(top?.action).toBe('buy');
      expect(top?.sellFirst?.cardId).toBe(MINI_MYRMIDON);
      const ring = recs.findIndex((r) => r.spellCardId === SHINY_RING);
      expect(ring).toBeGreaterThan(0);

      const plan = spendPlan(frame, { cards });
      expect(plan.steps[0]?.recommendation.sellFirst?.cardId).toBe(MINI_MYRMIDON);
      expect(plan.steps[0]?.goldAfter).toBe(0);
    });

    it('продажа по выбору не разбивает пару под тройку: копии Fleeing Fugitive и лаборанта не жертвы', () => {
      // Слабейшим телом по шкале выходит Fleeing Fugitive 6/3 (11.0 против
      // 11.5 у Mini-Myrmidon) — но на борде две его копии, как и две копии
      // лаборанта. На полном борде продажа вынуждена и жертва берётся как
      // есть; здесь она ВЫБОР и подчиняется правилу продажи по выбору
      // (`sellForGoldRule`: копия, из которой собирается тройка, не продаётся).
      const advice = adviseTavern(frame, { cards });
      const victims = swapsOf(advice!.recommendations).map((r) => r.sellFirst?.cardId);
      expect(victims).not.toContain(FLEEING_FUGITIVE);
      expect(victims).not.toContain(LAB_ASSISTANT);
    });

    it('граница: хватает золота — продажи нет; нет превосходства на sellMargin — продажи нет', () => {
      const rich = adviseTavern({ ...frame, gold: 3 }, { cards });
      expect(swapsOf(rich!.recommendations)).toHaveLength(0);
      expect(rich!.recommendations.some((r) => r.action === 'buy' && r.minion !== null)).toBe(true);

      const weakShop = frame.shop.map((m) => ({ ...m, attack: 1, health: 1 }));
      const poor = adviseTavern({ ...frame, shop: weakShop }, { cards });
      expect(swapsOf(poor!.recommendations)).toHaveLength(0);
    });

    it('Shiny Ring раздаёт +1/+1 КАЖДОМУ из шести: +12 статов, а не +2', () => {
      const effect = spellEffect(SHINY_RING, [1, 1], cards);
      expect(effect?.boardWide).toBe(true);
      expect(effect?.stats).toBe(2);

      const ring = adviseTavern(frame, { cards })!.recommendations.find(
        (r) => r.spellCardId === SHINY_RING,
      );
      expect(ring?.score).toBeCloseTo(12 * DEFAULT_TAVERN_RULES.value.perStatPoint, 5);
      expect(ring?.reason).toContain('+12 статов');
      expect(ring?.reason).toContain('весь борд');
    });
  });

  describe('усиление всего борда: узкая форма, прочитанная из текста', () => {
    it('лог part6: один розыгрыш Time Management вешает семь энчантов на семь разных миньонов', () => {
      const lines = part6Game().split(/\r?\n/);
      const start = lines.findIndex(
        (l) =>
          l.includes('GameState.DebugPrintPower() - BLOCK_START BlockType=PLAY') &&
          l.includes(`cardId=${TIME_MANAGEMENT} `),
      );
      expect(start).toBeGreaterThan(0);
      const body = (l: string): string => l.replace(/^D \S+ \S+ - /, '');
      const indent = (l: string): number => body(l).length - body(l).trimStart().length;
      const base = indent(lines[start]!);
      const attached: string[] = [];
      for (let i = start + 1; i < lines.length; i++) {
        const l = lines[i]!;
        if (!l.includes('GameState.DebugPrintPower()')) continue;
        if (body(l).trim() === 'BLOCK_END' && indent(l) === base) break;
        const m = /tag=ATTACHED value=(\d+)/.exec(l);
        if (m !== null) attached.push(m[1]!);
      }
      expect(attached).toHaveLength(7);
      expect(new Set(attached).size).toBe(7);
    }, 240_000);

    it('весь борд — только у простой формы; уточнение, повтор и отложенность из неё выводят', () => {
      const wide = (id: string, data: readonly number[] = [1, 1, 1, 1]): boolean | undefined =>
        spellEffect(id, data, cards)?.boardWide;
      expect(wide(SHINY_RING)).toBe(true);
      expect(wide('BG31_881t')).toBe(true); // Hurry Up
      expect(wide('BG31_886t2')).toBe(true); // One For All
      expect(wide('BG28_169')).toBe(true); // Azerite Empowerment: «… twice»
      expect(wide('BG33_817')).toBe(false); // Sanctify: «minions with Divine Shield»
      expect(wide('BG34_990')).toBe(false); // Wave of Gold: «Give Golden ones another»
      expect(wide('BG35_922')).toBe(false); // Queen's Command: «Give all your Naga another»
      expect(wide('BG34_272')).toBe(false); // Menagerie Tableware: «Repeat for each»
      expect(wide('BG36_246')).toBe(false); // Mighty Dragonbreath: «Repeat for your Dragons»
      // Healthy Bounty: «four friendly minions» — множитель из фразы с потолком
      // в четыре тела (D227, part55), а не весь борд.
      expect(wide('BG33_811')).toBe(true);
      expect(spellEffect('BG33_811', [1, 1, 1, 1], cards)?.boardCount).toBe(4);
      expect(wide('BG23_000t')).toBe(false); // Mini-Trident: одна цель
    });

    it('«twice» удваивает немедленное усиление, а «в начале следующего хода» не оценивается', () => {
      expect(spellEffect('BG28_169', [2, 3], cards)?.stats).toBe(10);
      expect(spellEffect('BG31_886t', [6, 6, 3, 3], cards)?.stats).toBe(24); // All For One
      // Do It Later: статы придут только к следующему бою — числа у шкалы
      // для этого нет, и ветвь честно остаётся неоценённой (part48).
      expect(spellEffect('BG31_881t2', [6, 10], cards)).toBeNull();
    });

    it('ход 25: Time Management — +16 статов на каждого из семи, 56 очков; ветви не разделяются', () => {
      const state = decisionPoint(25);
      expect(state.board).toHaveLength(7);
      const tm = adviseTavern(state, { cards })!.recommendations.find(
        (r) => r.spellCardId === TIME_MANAGEMENT,
      );
      expect(tm?.score).toBeCloseTo(16 * 7 * DEFAULT_TAVERN_RULES.value.perStatPoint, 5);
      expect(tm?.reason).toContain('+112 статов');
      // Отложенную ветвь оценить нечем — совет называет обе, как у part48.
      expect(tm?.spellBranches?.map((b) => b.name)).toEqual(['Hurry Up', 'Do It Later']);
    });

    it('Forest\'s Bounty: ветвь выбирается ПО БОРДУ — на шести телах весь борд, на одном «дважды»', () => {
      const frame = at('17:12:20');
      const bounty = { ...frame.shopSpells[0]!, cardId: FORESTS_BOUNTY, cost: 2, scriptData: [6, 6, 3, 3] };
      const pick = (board: GameState['board']): string | undefined =>
        adviseTavern({ ...frame, board, shopSpells: [bounty] }, { cards })!
          .recommendations.find((r) => r.spellCardId === FORESTS_BOUNTY)
          ?.spellBranches?.map((b) => b.name)
          .join('/');
      // Шесть тел: One For All +3/+3 каждому = 36 статов против 24 у All For One.
      expect(pick(frame.board)).toBe('One For All');
      // Одно тело: 6 против 24 — «Give a minion +6/+6 twice».
      expect(pick(frame.board.slice(0, 1))).toBe('All For One');
    }, 240_000);
  });
});
