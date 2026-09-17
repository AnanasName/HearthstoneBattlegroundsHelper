import { beforeAll, describe, expect, it } from 'vitest';

import {
  activationRules,
  adviseTavern,
  choiceAdvice,
  rerollRule,
} from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState, Minion } from '../../src/state/types.js';
import { recommendationLine, spendPlanLine } from '../../src/ui/format.js';
import { createBreather } from '../breather.js';
import { part57Game } from '../fixtures.js';

/**
 * part57 — Мурлок Холмс (17.09.2026), 7-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Кадра два, оба в чат
 * (verifiedBy: скриншот из чата):
 *
 *  1. 18:03, ход 3 — открытый экран силы «Наемный детектив»: два миньона,
 *     надо угадать, какой был у следующего соперника. Оверлей ранжировал
 *     их ЦЕННОСТЬЮ («Cord Puller — тир 1, ценность 5.5»), и игрок сказал
 *     прямо: «я должен выбрать карту, которая у соперника, а не выбирать
 *     их по полезности».
 *  2. 18:12, ход 15 — «мне почему-то предлагает обновить таверну, хотя
 *     я не смогу купить существ из неё, так как нету монет». Обновление
 *     было бесплатным, но бесплатным ИЗ ЗАПАСА Leaf Through the Pages,
 *     а запас переходит на следующий ход.
 *
 * Третий пункт — разбор ходов, где игрок поступил иначе; из него вышла
 * активация Living Prison («Gain the stats of the next minion you buy
 * this turn»), которой советник не видел вовсе.
 */
describe('part57: Мурлок Холмс, угадывание соперника и запас обновлений', () => {
  let text: string;
  let lines: string[];
  let cards: CardIndex;
  let turns: TavernTurn[];
  let final: GameState;

  beforeAll(async () => {
    text = part57Game();
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

  const decisionPoint = (turn: number): TavernTurn => {
    const found = turns.find((t) => t.turn === turn);
    expect(found, `точка решения хода ${String(turn)}`).toBeDefined();
    return found!;
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
    expect(final.finalPlace).toBe(7);
    expect(turns).toHaveLength(9);
    expect(final.hero?.cardId).toBe('BG23_HERO_303');
  });

  /**
   * Пункт 1, кадр 18:03. Экран открыт каналом выборов:
   *
   *   D 18:03:18.73… DebugPrintEntityChoices() -   Source=[… cardId=BG23_HERO_303p2 …]
   *   D 18:03:18.73… DebugPrintEntityChoices() -   Entities[0]=[… id=809 … cardId=BG29_611 …]
   *   D 18:03:18.73… DebugPrintEntityChoices() -   Entities[1]=[… id=808 … cardId=BG26_146 …]
   *
   * Борда следующего соперника мы к этому ходу не видели ни разу, и это
   * НОРМА: до 13-го хода следующий противник почти никогда не из виденных
   * (docs/position.md). Значит, доказательства нет — и порядок вариантов
   * не выдумывается: ни «ценности», ни очков.
   */
  it('кадр хода 3: угадывание судится доказательством, а не ценностью карт', () => {
    const frame = at('18:03:20.0');
    expect(frame.turn).toBe(3);
    expect(frame.techLevel).toBe(2);
    expect([frame.gold, frame.goldTotal]).toEqual([0, 4]);
    expect(frame.hero?.armor).toBe(12);
    expect(label(frame.board)).toEqual(['Buzzing Vermin 1/1']);
    expect(frame.openChoice?.sourceCardId).toBe('BG23_HERO_303p2');
    expect(frame.openChoice?.options.map((o) => o.cardId)).toEqual(['BG29_611', 'BG26_146']);

    // Борда соперника не видели — оба варианта без очков и без «ценности».
    expect(frame.nextOpponentPlayerId).not.toBeNull();
    expect(frame.lastSeenBoards[frame.nextOpponentPlayerId ?? 0]).toBeUndefined();
    const advice = choiceAdvice(frame, { cards });
    expect(advice).toHaveLength(2);
    for (const option of advice) {
      expect(option.score).toBeNull();
      expect(option.reason).toContain('угадывание на монету');
      expect(option.reason).not.toContain('ценность');
    }
  });

  /**
   * Тот же ход, ответ игры. Лог называет верный вариант ДВАЖДЫ: заранее —
   * тегом `3257` на правильной сущности, и после ответа — `META_DATA
   * Meta=TARGET`. Первый способ не читается НИКОГДА (D243): экран игры
   * его не показывает. Тест держит оба факта, чтобы решение не потерялось
   * молча: если тег однажды перестанет совпадать с ответом, это увидят.
   */
  it('ответ игры лежит в логе заранее — и советником не читается', () => {
    const start = lines.findIndex((l) => l.includes('id=2 Player=') && l.includes('ChoiceType=GENERAL'));
    expect(start).toBeGreaterThan(0);
    const before = lines.slice(Math.max(0, start - 200), start).join('\n');
    const marked = /TAG_CHANGE Entity=(\d+) tag=3257 value=1/.exec(before)?.[1];
    const after = lines.slice(start, start + 400).join('\n');
    const revealed = /Meta=TARGET[\s\S]*?Info\[0\] = \[entityName=.*? id=(\d+) /.exec(after)?.[1];
    expect(marked).toBe('808');
    expect(revealed).toBe(marked);

    // Совет про этот тег не знает: ни очков, ни имени варианта в очках.
    const frame = at('18:03:20.0');
    expect(choiceAdvice(frame, { cards }).every((c) => c.score === null)).toBe(true);
  });

  /**
   * Ход 17, 18:14:41 — единственное из восьми угадываний партии, где
   * доказательство есть: с этим соперником (игрок 6, Scourgewind
   * Chenvaala) мы дрались на ходу 8, и Molten Rock стоял на его борде.
   * Игра подтвердила: `Meta=TARGET` назвал ту же сущность, монета пришла.
   */
  it('ход 17: вариант с виденного борда соперника назван первым', () => {
    const frame = at('18:14:45.0');
    expect(frame.turn).toBe(17);
    const next = frame.nextOpponentPlayerId ?? 0;
    expect(frame.lastSeenBoardTurns[next]).toBe(8);
    expect((frame.lastSeenBoards[next] ?? []).map((m) => m.cardId)).toContain('BGS_127');
    expect(frame.openChoice?.options.map((o) => o.cardId).sort()).toEqual(['BG36_640', 'BGS_127']);

    const advice = choiceAdvice(frame, { cards });
    expect(advice[0]?.option.cardId).toBe('BGS_127');
    expect(advice[0]?.score).toBe(1);
    expect(advice[0]?.reason).toContain('был на борде');
    expect(advice[1]?.score).toBeNull();
  });

  /**
   * Пункт 2, кадр 18:12 (18:12:10 — на 18:12:30 игрок уже переставил
   * Glowing Cinder 4/12, а кадр показывает его четвёртым).
   *
   * Обновление бесплатно, но это ЗАПАС: игрок разыграл Leaf Through
   * the Pages в 18:11:46 (`BACON_FREE_REFRESH_COUNT=2`), одно обновление
   * потратил сразу, второе осталось — и дожило до хода 17, где было
   * потрачено в 18:15:01 при десяти золотых. Совет молчит.
   */
  it('кадр хода 15: запасное бесплатное обновление не советуется при нуле золота', () => {
    const frame = at('18:12:10.0');
    expect(frame.turn).toBe(15);
    expect(frame.techLevel).toBe(5);
    expect([frame.gold, frame.goldTotal]).toEqual([0, 10]);
    expect((frame.hero?.health ?? 0) - (frame.hero?.damage ?? 0)).toBe(14);
    expect(label(frame.board)).toEqual([
      'Living Prison 69/62',
      'Flaming Enforcer 38/54',
      'Glowing Cinder 17/22',
      'Glowing Cinder 4/12',
      'Waveling 5/12',
      'Waveling 5/12',
      'Fire Baller 28/19',
    ]);

    expect(frame.rerollCost).toBe(0);
    expect(frame.freeRefreshes).toBe(1);
    expect(rerollRule(frame, { cards })).toBeNull();
    const advice = adviseTavern(frame, { cards });
    expect(advice?.recommendations.some((r) => r.action === 'reroll')).toBe(false);
    expect(advice?.recommendations[0]?.action).toBe('pass');

    // Ветка D025 жива: бесплатное обновление БЕЗ запаса цель по-прежнему
    // называет — здесь это третья копия Glowing Cinder. Совет приходит
    // веткой «делать нечего, а обновление бесплатно», а не `rerollRule`:
    // витрина хороша, и правило обновления молчит само.
    const unstocked: GameState = { ...frame, freeRefreshes: 0 };
    const idle = adviseTavern(unstocked, { cards })?.recommendations.find(
      (r) => r.action === 'reroll',
    );
    expect(idle?.searchGoal).toContain('Glowing Cinder');
  });

  /** Запас пережил бой: на ходу 17 он всё ещё единица, и потрачен уже с золотом. */
  it('запас бесплатных обновлений переживает смену хода', () => {
    expect(at('18:13:35.0').freeRefreshes).toBe(1);
    expect(at('18:14:45.0').freeRefreshes).toBe(1);
    // Потрачен на ходу 17 при десяти золотых — 18:15:01, кнопка ушла в ноль.
    expect(at('18:15:05.0').freeRefreshes).toBe(0);
  });

  /**
   * Почему читается ЭНЧАНТ, а не кнопка: на бою кнопка обнуляется
   * (18:13:29.50, id=5422 → 0) и уходит из PLAY, а новая приходит только
   * в новом ходу (18:13:31.58, id=7244 = 1). В срезе между ними у кнопки
   * запаса нет, а у игрока он есть.
   */
  it('на бою кнопка обнуляется, а запас игрока остаётся', () => {
    const inCombat = at('18:13:30.5');
    expect(inCombat.phase).not.toBe('tavern');
    expect(inCombat.rerollCost).toBeNull();
    expect(inCombat.freeRefreshes).toBe(1);
  });

  /**
   * Пункт 3. Living Prison `BG36_180` — «Activate ({0}): Gain the stats
   * of the next minion you buy this turn», цена 1
   * (`INTERACTABLE_OBJECT_COST`). Игрок жал её на ходах 13, 15 и 17 перед
   * крупной покупкой; лог 18:11:56 — купил Fire Baller 28/19, тело 41/43
   * стало 69/62. Советник активацию не видел вовсе.
   *
   * Теперь это ОДИН шаг «нажать, затем купить»: купленное ДО нажатия
   * статов не отдаёт, а план выбирает шаги по очкам и покупку поставил бы
   * первой.
   */
  it('ход 15: план начинается с активации Living Prison и названной покупки', () => {
    const point = decisionPoint(15).state;
    const prison = point.board.find((m) => m.cardId === 'BG36_180');
    expect(prison?.tags['INTERACTABLE_OBJECT_COST']).toBe(1);

    const step = activationRules(point, { cards }).find((r) => r.minion?.cardId === 'BG36_180');
    expect(step?.thenBuys?.minion.cardId).toBe('BG36_332'); // Snare Trapper 20/38
    expect(step?.boardGains).toEqual([{ entityId: prison?.entityId, attack: 20, health: 38 }]);
    // Цена шага — обе половины: активация 1 плюс покупка 3.
    expect(step?.cost).toBe(4);

    const line = recommendationLine(step!, cards);
    expect(line).toContain('АКТИВИРОВАТЬ Living Prison');
    expect(line).toContain('затем КУПИТЬ Snare Trapper');

    const plan = spendPlan(point, { cards });
    expect(plan.steps[0]?.recommendation.minion?.cardId).toBe('BG36_180');
    // Прибавка доехала до следующего шага: тело считается уже усиленным.
    const after = plan.steps[0]?.stateAfter.board.find((m) => m.cardId === 'BG36_180');
    expect([after?.attack, after?.health]).toEqual([61, 70]);
    expect(spendPlanLine(plan, cards)).toContain('затем КУПИТЬ Snare Trapper');
  });

  /**
   * ОКНО между половинами хода: активация нажата в 18:11:49, покупка —
   * в 18:11:56, и всё это время оверлей пересчитывается. Прибавка «висит»,
   * и покупки обязаны судиться той же арифметикой, что внутри шага, —
   * иначе совет ПОСЛЕ нажатия хуже совета ДО него.
   *
   * Висящая прибавка читается журналом действий: активация этого хода,
   * после которой покупки не было.
   */
  it('между нажатием и покупкой висящая прибавка входит в очки покупок', () => {
    // Момент между продажей Snow Baller (18:11:55.9) и покупкой Fire Baller
    // (18:11:56.9): активация нажата, золота на покупку хватает.
    const frame = at('18:11:56.5');
    expect(frame.turn).toBe(15);
    expect(frame.gold).toBe(3);
    // Активация этого хода уже в журнале, покупки после неё ещё нет.
    const inTurn = frame.actions.filter((a) => a.turn === 15);
    const pressed = inTurn.findIndex((a) => a.type === 'activate' && a.cardId === 'BG36_180');
    expect(pressed).toBeGreaterThanOrEqual(0);
    expect(inTurn.slice(pressed + 1).some((a) => a.type === 'buy')).toBe(false);

    const top = adviseTavern(frame, { cards })?.recommendations[0];
    expect(top?.action).toBe('buy');
    // Самое крупное тело витрины — Motley Phalanx 43/53: его статы и заберёт
    // нажатая активация.
    expect(top?.minion?.cardId).toBe('BG27_080');
    expect(top?.reason).toContain('активация уже нажата');

    // Прибавка входит в очки ровно теми же статами и тем же курсом, что
    // внутри шага: без журнала действий совет тот же, но дешевле на них.
    const blind: GameState = { ...frame, actions: [] };
    const same = adviseTavern(blind, { cards })?.recommendations.find(
      (r) => r.minion?.cardId === 'BG27_080',
    );
    expect((top?.score ?? 0) - (same?.score ?? 0)).toBeCloseTo(
      (43 + 53) * DEFAULT_TAVERN_RULES.value.perStatPoint,
      6,
    );
  });

  /**
   * Доказательство угадывания сверяется по БАЗОВОЙ карте: на чужих бордах
   * поздних ходов золотые тела — норма (в логах они идут суффиксом `_G`,
   * например `BGS_115t_G` в part17), а варианты приходят простыми картами.
   * Сырое сравнение отрицало бы ровно ту карту, которая у соперника была.
   */
  it('золотая копия на виденном борде остаётся доказательством', () => {
    const frame = at('18:14:45.0');
    const next = frame.nextOpponentPlayerId ?? 0;
    const golden: GameState = {
      ...frame,
      lastSeenBoards: {
        ...frame.lastSeenBoards,
        [next]: (frame.lastSeenBoards[next] ?? []).map((m) =>
          m.cardId === 'BGS_127' ? { ...m, cardId: 'BGS_127_G', golden: true } : m,
        ),
      },
    };
    expect((golden.lastSeenBoards[next] ?? []).map((m) => m.cardId)).toContain('BGS_127_G');

    const advice = choiceAdvice(golden, { cards });
    expect(advice[0]?.option.cardId).toBe('BGS_127');
    expect(advice[0]?.score).toBe(1);
  });

  /**
   * Что игрок сделал на самом деле — журналом, а не пересказом: активация
   * перед покупкой на трёх ходах подряд.
   */
  it('журнал партии: активация Living Prison на ходах 13, 15 и 17', () => {
    const activations = final.actions
      .filter((a) => a.type === 'activate' && a.cardId === 'BG36_180')
      .map((a) => a.turn);
    expect(activations).toEqual([13, 15, 17]);
    // И каждая — перед покупкой в том же ходу.
    for (const turn of activations) {
      const inTurn = final.actions.filter((a) => a.turn === turn);
      const i = inTurn.findIndex((a) => a.type === 'activate' && a.cardId === 'BG36_180');
      expect(inTurn.slice(i + 1).some((a) => a.type === 'buy')).toBe(true);
    }
  });
});
