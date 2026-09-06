import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  heroPowerReady,
  heroPowerStatsRule,
} from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurns } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part45Game } from '../fixtures.js';

/**
 * part45 — Инге Стальной Гимн, квилбоары (06.09.2026). Два пункта игрока.
 *
 * Оба кадра сняты В СЕРЕДИНЕ хода, поэтому проверки идут по СРЕЗУ ЛОГА
 * до времени кадра, а не по точке решения (метод part40, part43, part44).
 * Это утверждение тоже закреплено тестом: на точке решения хода 1 борд
 * ПУСТ, и правило силы там молчит законно — усиливать некого.
 */
describe('part45: сила героя на два нажатия и величина словом', () => {
  let text: string;
  let cards: CardIndex;
  let turns: ReturnType<typeof readTavernTurns>;

  beforeAll(() => {
    text = part45Game();
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
    expect(found, 'точка решения хода ' + String(turn)).toBeDefined();
    return found!.state;
  };

  const nameOf = (cardId: string): string => cards.info(cardId)?.name ?? cardId;

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
  });

  /**
   * Пункт 1 (кадр хода 1, 15:27): «не предлагает нажать силу героя, которую
   * можно нажимать дважды за ход».
   *
   * Сила БЕСПЛАТНА (тега COST нет вовсе, как у Хроми в part13), активна
   * и не под замком — молчание было чисто ТЕКСТОВЫМ: величина прибавки
   * названа СЛОВОМ («Attack equal to your Tier»), а не цифрой, и ни один
   * из шести каналов чтения силы её не видел.
   */
  it('пункт 1: сила Инге читается и даёт совет на кадре игрока', () => {
    const s = at('15:27:55');
    expect(s.turn).toBe(1);
    expect(s.techLevel).toBe(1);
    // Кадр: золото потрачено целиком, на борде один Клыкастый походник 2/3.
    expect(s.gold).toBe(0);
    expect(s.board).toHaveLength(1);
    expect(s.board[0]?.cardId).toBe('BG33_886');
    expect(s.board[0]?.attack).toBe(2);

    const hero = s.hero!;
    expect(hero.heroPowerCardId).toBe('BG26_HERO_102p');
    // Бесплатная и активная: цены нет вовсе, а не ноль.
    expect(hero.heroPowerCost).toBeNull();
    expect(hero.heroPowerHasActivate).toBe(true);
    expect(hero.heroPowerLocked).toBe(false);

    const rec = heroPowerStatsRule(s, { cards }, DEFAULT_TAVERN_RULES);
    expect(rec).not.toBeNull();
    expect(rec?.action).toBe('heroPower');
    expect(rec?.cost).toBe(0);
    // Прибавка равна ТИРУ таверны, а не числу из текста: числа там нет.
    expect(rec?.grantsStats).toEqual({ stat: 'attack', amount: 1 });
    expect(rec?.targetMinion?.cardId).toBe('BG33_886');

    // На кадре это ЕДИНСТВЕННОЕ действие: прежде оверлей печатал «НИЧЕГО».
    const advice = adviseTavern(s, { cards });
    expect(advice).not.toBeNull();
    expect(advice?.recommendations[0]?.action).toBe('heroPower');
    expect(spendPlan(s, { cards }).steps[0]?.recommendation.action).toBe('heroPower');
  });

  /**
   * ДВА нажатия за ход, и различает их только EXHAUSTED.
   *
   * Игра возвращает тег в ноль ВНУТРИ блока первого нажатия (15:27:59,
   * строки подряд) и оставляет в единице после второго (15:28:04).
   * По «нажата ли в этом ходу» эти состояния тождественны, поэтому
   * heroPowerReady верит тегу, когда тот есть.
   */
  it('пункт 1: после первого нажатия совет остаётся, после второго молчит', () => {
    const afterFirst = at('15:28:02');
    const h1 = afterFirst.hero!;
    expect(h1.heroPowerUsedThisTurn).toBe(true);
    expect(h1.heroPowerExhausted).toBe(false);
    expect(heroPowerReady(h1)).toBe(true);
    // Первое нажатие уже легло на борд: 2/3 стало 3/3.
    expect(afterFirst.board[0]?.attack).toBe(3);
    expect(heroPowerStatsRule(afterFirst, { cards }, DEFAULT_TAVERN_RULES)).not.toBeNull();

    const afterSecond = at('15:28:10');
    const h2 = afterSecond.hero!;
    expect(h2.heroPowerUsedThisTurn).toBe(true);
    expect(h2.heroPowerExhausted).toBe(true);
    expect(heroPowerReady(h2)).toBe(false);
    expect(afterSecond.board[0]?.attack).toBe(4);
    expect(heroPowerStatsRule(afterSecond, { cards }, DEFAULT_TAVERN_RULES)).toBeNull();
  });

  /**
   * Счётчик игры подтверждает предел независимо от нашего чтения:
   * HEROPOWER_ACTIVATIONS_THIS_TURN за партию доходит до 2 и НИ РАЗУ
   * до 3, а третье нажатие игра запрещает своим каналом опций. Сколько
   * нажатий положено, в логе не написано нигде — поэтому правило читает
   * факт «можно ли сейчас», а не выдуманный лимит.
   */
  it('пункт 1: игра сама называет предел — два нажатия и REQ_NOT_EXHAUSTED', () => {
    const values = [...text.matchAll(/tag=HEROPOWER_ACTIVATIONS_THIS_TURN value=(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(values.length).toBeGreaterThan(0);
    expect(Math.max(...values)).toBe(2);
    expect(text).toContain('REQ_NOT_EXHAUSTED_HERO_POWER');
  });

  /**
   * Прибавка ПОСТОЯННА и равна тиру НА МОМЕНТ НАЖАТИЯ — это видно бордом,
   * а не текстом: два нажатия на тире 1 дали 2/3 → 4/3, а два нажатия
   * второй половины силы на тире 2 — 4/3 → 4/7.
   */
  it('пункт 1: прибавка постоянна и равна тиру момента нажатия', () => {
    const t3 = decisionPoint(3);
    expect(t3.board[0]?.cardId).toBe('BG33_886');
    expect(t3.board[0]?.attack).toBe(4);
    expect(t3.board[0]?.health).toBe(3);
    // Половины меняются местами каждый ход: на ходу 3 это уже Minor Hymn.
    expect(t3.hero?.heroPowerCardId).toBe('BG26_HERO_102p2');

    const t5 = decisionPoint(5);
    expect(t5.techLevel).toBe(2);
    expect(t5.board[0]?.attack).toBe(4);
    expect(t5.board[0]?.health).toBe(7);
  });

  /**
   * Метод: на ТОЧКЕ РЕШЕНИЯ хода 1 пункт не воспроизводится вовсе — борд
   * там пуст, и правило молчит законно. Кадр снят позже, уже с телом.
   */
  it('метод: на точке решения хода 1 борд пуст и правило молчит законно', () => {
    const s = decisionPoint(1);
    expect(s.board).toHaveLength(0);
    expect(s.gold).toBe(3);
    expect(heroPowerStatsRule(s, { cards }, DEFAULT_TAVERN_RULES)).toBeNull();
  });

  /**
   * Пункт 2 (кадр хода 13, 15:36): «не понимаю, почему предлагает поставить
   * карту, которая улучшает атакующие существа».
   *
   * Карта названа верно — Prodigious Tusker BG33_430 («Whenever another
   * friendly minion attacks, this plays a Blood Gem on it»), и советник
   * двигал её с пятого места на третье. Здесь закрепляется ФАКТУРА кадра;
   * числа замера — в docs/tavern.md.
   */
  it('пункт 2: кадр хода 13 восстанавливается срезом, Tusker стоит последним', () => {
    const s = at('15:36:20');
    expect(s.turn).toBe(13);
    // На кадре тир уже ПЯТЫЙ: игрок поднялся посреди хода, а точка решения
    // хода 13 стоит на четвёртом — по ней пункт не воспроизводится.
    expect(s.techLevel).toBe(5);
    expect(decisionPoint(13).techLevel).toBe(4);
    expect(s.gold).toBe(0);
    expect(s.board.map((m) => nameOf(m.cardId))).toEqual([
      'Roadboar',
      'Tusked Camper',
      'Tusked Camper',
      'Deepwater Chieftain',
      'Prodigious Tusker',
    ]);
    // Эффект карты — про АТАКУЮЩИХ, и симулятор его реализует, то есть
    // слепотой мерки (как «раж» в part41) пункт не объясняется.
    expect(cards.info('BG33_430')?.text).toContain('Whenever another friendly minion attacks');
  });
});
