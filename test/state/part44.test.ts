import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  magnetDoublerOf,
  minionValue,
  playPlan,
  weakestOwn,
} from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurns } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part44Game } from '../fixtures.js';

/**
 * part44 — Артанис, ПЯТОЕ место (06.09.2026). Четыре пункта игрока; здесь
 * держатся два, оказавшиеся дефектами советника, и фактура, на которой
 * они разобраны.
 *
 * Оба кадра игрока сняты В СЕРЕДИНЕ хода, поэтому проверки идут по СРЕЗУ
 * ЛОГА до времени кадра, а не по точке решения: по точкам не воспроизводится
 * ни один пункт (тот же метод, что в part40 и part43). Это утверждение тоже
 * закреплено тестом — иначе «кадр не воспроизводится» осталось бы словами.
 */
describe('part44: жертва с активацией и удвоение примагничивания', () => {
  let text: string;
  let cards: CardIndex;
  let turns: ReturnType<typeof readTavernTurns>;

  beforeAll(() => {
    text = part44Game();
    cards = loadCardIndex();
    turns = readTavernTurns(text);
  }, 240_000);

  /** Состояние партии на момент времени кадра — срезом лога. */
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

  const nameOf = (cardId: string): string => cards.info(cardId)?.name ?? cardId;

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
  });

  it('ход 11: кадр игрока — это СЕРЕДИНА хода, а не точка решения', () => {
    // Точка решения стоит до первой траты: Созвучателя в руке ещё нет
    // (он куплен позже этого же хода), золото целое. Без среза по времени
    // пункты 1 и 2 не воспроизводятся вовсе.
    const point = decisionPoint(11);
    expect(point.gold).toBe(8);
    expect(point.hand.map((m) => m.cardId)).not.toContain('BG26_147');

    const frame = at('13:09:53');
    expect(frame.turn).toBe(11);
    expect(frame.gold).toBe(6);
    expect(frame.hand.map((m) => m.cardId)).toContain('BG26_147');
  });

  it('ход 11: жертвой становится тело без текста, а не носитель активации', () => {
    // Пункт 1 игрока. Тело Prisonguard тира 1 стоит по нашей шкале 5.0,
    // Oozeling тира 2 — 6.0, и до правки в жертву уходил Prisonguard: тир
    // весит вчетверо больше стата, а активация не весила ничего. Теперь
    // она весит РОВНО то, что кладёт на борд: +3/+3 = 6 статов = 3.0 очка.
    const state = at('13:09:53');
    const prisonguard = state.board.find((m) => m.cardId === 'BG36_345');
    expect(prisonguard, 'Suspicious Prisonguard на борде').toBeDefined();
    // Активация читается: тег на сущности и числа в плейсхолдерах.
    expect(prisonguard!.tags['HAS_ACTIVATE_POWER']).toBe(1);
    expect(prisonguard!.scriptData.slice(0, 3)).toEqual([3, 3, 1]);

    const rest = state.board.filter((m) => m.entityId !== prisonguard!.entityId);
    const value = minionValue(prisonguard!, { ...state, board: rest }, { cards });
    expect(value.activation).toBeCloseTo(3, 5);
    expect(value.total).toBeCloseTo(8, 5);

    const victim = weakestOwn(state, { cards }, DEFAULT_TAVERN_RULES);
    expect(victim, 'жертва на этом борде').not.toBeNull();
    expect(nameOf(victim!.minion.cardId)).toBe('Oozeling Gladiator');
    // И это ровно то, что сделал игрок: 13:09:59, продажа Слизнюченыша.
    const sold = reduceLog(text).actions.filter((a) => a.type === 'sell' && a.turn === 11);
    expect(sold.map((a) => a.cardId)).toEqual(['BG27_002']);
  });

  it('слагаемое активации СЧИТАЕТ только то, что читается точно', () => {
    // Это половина правила, и без неё оно опасно: запрет «носителя
    // активации не продавать» был написан первым, замерен на корпусе
    // (469 точек 41 партии) и ОТВЕРГНУТ — он предлагал продать Kalecgos
    // 190/159 ради Hired Mount 40/52. Курсовые эффекты в слагаемое
    // не входят, и вот проверка на карте самой партии: у Fruit Vendor
    // активация «Get {1} Tavern Dish Bananas», и она даёт РОВНО НОЛЬ.
    const state = at('13:09:53');
    const vendor = state.shop.find((m) => m.cardId === 'BG36_346');
    expect(vendor, 'Fruit Vendor в витрине').toBeDefined();
    expect(minionValue(vendor!, state, { cards }).activation).toBe(0);
  });

  it('ход 11: покупка Sand Swirler больше не оплачивается носителем активации', () => {
    // Пункт 2. Клич «Your Elementals give an extra +{0} Attack this game»
    // на борде без элементалей не даёт ничего, а платой за тело 3/2 был
    // миньон 3/3 с движком. После правки ветка гаснет сама: 8.5 не берёт
    // планку 6.0 + sellMargin.
    const state = at('13:09:53');
    const plan = spendPlan(state, { cards });
    const sells = plan.steps.filter((s) => s.recommendation.sellFirst !== null);
    expect(sells.map((s) => nameOf(s.recommendation.sellFirst!.cardId))).not.toContain(
      'Suspicious Prisonguard',
    );
    expect(plan.steps.map((s) => nameOf(s.recommendation.minion?.cardId ?? ''))).not.toContain(
      'Sand Swirler',
    );
  });

  it('ход 17: удвоение видно тегом и держится только на одном носителе', () => {
    // Пункт 3, фактура. Игрок нажал активацию на обоих дубликаторах
    // (13:15:55 и 13:15:56), но у #6598 удвоение уже погашено магнитом
    // Clunker Junker в 13:16:04 — к кадру осталось только у #7756.
    const state = at('13:16:30');
    const duplicators = state.board.filter((m) => m.cardId === 'BG36_506');
    expect(duplicators).toHaveLength(2);
    const byId = new Map(duplicators.map((m) => [m.entityId, m]));
    expect(byId.get(7756)!.tags['4945']).toBe(1);
    expect(byId.get(6598)!.tags['4945']).toBe(0);
    expect(magnetDoublerOf(byId.get(7756)!, cards)).toBe(2);
    expect(magnetDoublerOf(byId.get(6598)!, cards)).toBeNull();
    // Нажаты обе активации — это и есть «после применения активации карты».
    expect([...state.activatedEntityIds].sort((a, b) => a - b)).toEqual([6598, 7756]);
  });

  it('ход 17: удвоение достаётся КРУПНЕЙШЕМУ модулю, и первым шагом плана', () => {
    // Пункт 3. Прежде первым шагом стоял Annoy-o-Module 2/4 — его вело
    // правило ключевых слов (у #7756 нет провокации), — и удвоение
    // тратилось на 6 статов вместо 10.
    const state = at('13:16:30');
    const plan = spendPlan(state, { cards });
    const first = plan.steps[0]?.recommendation;
    expect(first, 'первый шаг плана').toBeDefined();
    expect(nameOf(first!.minion?.cardId ?? '')).toBe('Shield of the Legion');
    expect(first!.magnetizeTo?.entityId).toBe(7756);
    expect(first!.reason).toContain('удвоение');

    // Дальше по цепочке удвоения уже нет: тег гасится собственным шагом
    // плана, и второй модуль считается без него.
    const second = plan.steps[1]?.recommendation;
    expect(second?.reason ?? '').not.toContain('удвоение');
  });

  it('ход 17: строка «разыграть по порядку» кладёт щит на удвоенного первым', () => {
    // Отдельный план, отдельная строка на экране — и на кадре игрока
    // ошибался именно он: «РАЗЫГРАТЬ ПО ПОРЯДКУ: Annoy-o-Module …
    // примагнитить к Drone Duplicator 8/3». Правку надо было внести
    // в ОБА плана, и это тот самый случай, когда одна копия правила
    // разъезжается с другой молча.
    const state = at('13:16:30');
    const advice = adviseTavern(state, { cards });
    expect(advice).not.toBeNull();
    const plan = playPlan(state, { cards }, advice!.recommendations);
    const doubled = plan.filter((s) => s.magnetizeTo?.entityId === 7756);
    expect(doubled.length).toBeGreaterThan(0);
    expect(nameOf(doubled[0]!.minion.cardId)).toBe('Shield of the Legion');
  });

  it('ход 17: игрок сыграл ровно это — Щит Легиона первым магнитом', () => {
    // Единственная сверка совета с фактом, которая тут возможна: журнал
    // действий. Порядок в нём — порядок блоков PLAY.
    const actions = reduceLog(text).actions.filter((a) => a.turn === 17 && a.type === 'play');
    const magnets = actions.filter((a) =>
      ['BG25_807t4', 'BG_DEEP_015', 'BG_BOT_911'].includes(a.cardId ?? ''),
    );
    expect(magnets.map((a) => a.cardId)).toEqual(['BG25_807t4', 'BG_DEEP_015', 'BG_BOT_911']);
    // Тег 4945 гаснет в блоке ЭТОГО розыгрыша — то есть щит лёг именно
    // на удвоенного носителя.
    const shieldPlay = text.indexOf('13:16:33');
    const doubleOff = text.indexOf('id=7756 zone=PLAY zonePos=2 cardId=BG36_506 player=5] tag=4945 value=0');
    expect(shieldPlay).toBeGreaterThan(0);
    expect(doubleOff).toBeGreaterThan(shieldPlay);
  });

  it('ход 17: на точке решения удвоения нет вовсе — кадр снят позже', () => {
    // Та же оговорка, что у хода 11: активации нажимаются ПОСЛЕ первой
    // траты, поэтому точка решения про этот пункт не знает ничего.
    const point = decisionPoint(17);
    expect(point.board.filter((m) => m.cardId === 'BG36_506')).toHaveLength(1);
    expect(point.board.some((m) => (m.tags['4945'] ?? 0) > 0)).toBe(false);
  });
});
