import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { readTavernTurns } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, normalizeCardText, type CardIndex } from '../../src/data/cards.js';
import { reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part46Game } from '../fixtures.js';

/**
 * part46 — Инге Стальной Гимн (06.09.2026, 4-е место). Четыре пункта игрока;
 * тестами закрыты те два, что про ЧТЕНИЕ ЛОГА и текста карт.
 *
 * Третий пункт (кольцо силы героя выше кнопки) — геометрия, и живёт он
 * в `test/overlay/layout.test.ts`: там кадр, а не лог. Четвёртый (метка
 * только у текущего шага) — в `test/overlay/view.test.ts`.
 */
describe('part46: замена героя жетоном и открытый сейф', () => {
  let text: string;
  let cards: CardIndex;
  let turns: ReturnType<typeof readTavernTurns>;

  beforeAll(() => {
    text = part46Game();
    cards = loadCardIndex();
    turns = readTavernTurns(text);
  }, 240_000);

  /** Состояние на момент времени — срезом лога (метод part40, part43–part45). */
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

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
  });

  /**
   * Пункт 1: «показал, что можно заменить героя с помощью жетонов,
   * ui не перерисовался для нового героя».
   *
   * Замена приходит `CHANGE_ENTITY` на ТОЙ ЖЕ сущности (23:04:55): `id=115`
   * был Зиреллой `BG20_HERO_101`, стал Инге `BG26_HERO_102`. Дескриптор
   * строки по общему правилу показывает карту ДО замены, новая — в хвосте
   * после `CardID=`.
   */
  it('замена героя жетоном: вариант выбора показывает НОВОГО героя', () => {
    // Строка замены в логе есть, и она одна на этой сущности.
    const changes = text.match(/CHANGE_ENTITY - Updating Entity=\[[^\]]*id=115[^\]]*\] CardID=(\S+)/g);
    expect(changes, 'строка замены героя в логе').not.toBeNull();
    expect(changes!.every((line) => line.endsWith('CardID=BG26_HERO_102'))).toBe(true);

    // Срез взят ДО выбора (SendChoices идёт в 23:05:01): экран выбора открыт,
    // и на нём стоит уже заменённый герой.
    const state = at('23:05:00');
    expect(state.heroChoice, 'открытый выбор героя').not.toBeNull();
    const ids = state.heroChoice!.options.map((o) => o.cardId);
    expect(ids).toContain('BG26_HERO_102');
    // Прежний герой из варианта ушёл совсем: пока строка замены не читалась,
    // советник предлагал взять его, а на столе его уже не было.
    expect(ids).not.toContain('BG20_HERO_101');
    // Сущность та же — заменилась карта, а не вариант.
    expect(state.heroChoice!.options.find((o) => o.cardId === 'BG26_HERO_102')?.entityId).toBe(115);

    // И партия подтверждает выбор: игрок взял именно этого героя.
    expect(text.includes('m_chosenEntities[0]=[entityName=Инге Стальной Гимн id=115')).toBe(true);
  });

  /**
   * Та же строка открывает СЕЙФ в нашей руке, и это находка крупнее самой
   * жалобы: «Сейф» `BG36_520t` («Unplayable. In 5 turns, break this open
   * and get a random Golden minion») превращается в золотого миньона,
   * а рука числилась вечным «Unplayable» — разыграть его советник
   * не предлагал никогда.
   */
  it('открытый сейф становится ЗОЛОТЫМ миньоном в руке', () => {
    const opened = text.match(/CHANGE_ENTITY - Updating Entity=\[[^\]]*cardId=BG36_520t[^\]]*\] CardID=(\S+)/g);
    expect(opened, 'открытия сейфа в логе').not.toBeNull();
    expect(opened!.length).toBeGreaterThanOrEqual(8);

    // Точки решения, где открытый сейф лежит в руке. До правки рука в них
    // была пуста (ходы 21 и 31) или короче на карту (ход 19).
    const hands = [19, 21, 31].map((t) => decisionPoint(t).hand.map((m) => m.cardId));
    expect(hands[0]).toContain('BG36_703_G');
    expect(hands[1]).toEqual(['BG26_148_G']);
    expect(hands[2]).toContain('BG31_843_G');

    // Это именно МИНЬОНЫ пула, а не карта-заглушка: иначе советовать
    // разыграть их было бы нечем.
    for (const cardId of ['BG36_703_G', 'BG26_148_G', 'BG31_843_G']) {
      expect(cards.info(cardId)?.type, cardId).toBe('MINION');
    }
    // Сам сейф миньоном не считается — игра создаёт его как SPELL.
    expect(decisionPoint(21).hand.some((m) => m.cardId === 'BG36_520t')).toBe(false);
  });

  /**
   * Пункт 2: «учитываешь ли ты в планировании ходов пиратку 3-1, которая
   * даёт золото на следующий ход?»
   *
   * Не учитывал, и причина оказалась не в весах, а в ПЕРЕНОСЕ СТРОКИ:
   * в снапшоте текст лежит как «Gain\n1 Gold next turn», а шаблон экономики
   * требовал пробел. Пятый случай того же класса (part16, part32, part39),
   * поэтому чинится он один раз для всех — в `normalizeCardText`.
   */
  it('золото пиратки читается: перенос строки больше не рвёт шаблон', () => {
    const busker = cards.info('BG26_135');
    expect(busker?.name).toBe('Southsea Busker');
    expect(busker?.text ?? '').toMatch(/gain \d+ gold/i);
    // Сырой снапшот при этом перенос содержит — правка в чтении, а не в данных.
    expect(normalizeCardText('<b>Battlecry:</b> Gain\n1 Gold next turn.')).toBe(
      '<b>Battlecry:</b> Gain 1 Gold next turn.',
    );

    // Ценность покупки выросла ровно на вес экономики, и это проверяется
    // подменой самого веса, а не сравнением с записанным числом.
    const turn = turns.find((t) => t.state.shop.some((m) => m.cardId === 'BG26_135'));
    expect(turn, 'точка решения, где пиратка в витрине').toBeDefined();
    const scoreOf = (rules: typeof DEFAULT_TAVERN_RULES): number => {
      const advice = adviseTavern(turn!.state, { cards, bgStats: null }, rules);
      const rec = advice?.recommendations.find((r) => r.minion?.cardId === 'BG26_135');
      expect(rec, 'совет про пиратку').toBeDefined();
      return rec!.score;
    };
    const zeroed = {
      ...DEFAULT_TAVERN_RULES,
      value: { ...DEFAULT_TAVERN_RULES.value, economy: 0 },
    };
    expect(scoreOf(DEFAULT_TAVERN_RULES) - scoreOf(zeroed)).toBeCloseTo(
      DEFAULT_TAVERN_RULES.value.economy,
      5,
    );
  });

  /**
   * Вторая половина того же вопроса: САМО золото, когда оно приходит,
   * состояние видит — тегом `TEMP_RESOURCES` (part34). Ход 7 показывает
   * 7 золота при максимуме хода 6, и «больше максимума» тут не ошибка,
   * а как раз отложенная монета пиратки.
   */
  it('отложенное золото приходит и видно в состоянии', () => {
    const fifth = decisionPoint(5);
    expect(fifth.gold).toBe(5);
    expect(fifth.goldTotal).toBe(5);

    const seventh = decisionPoint(7);
    expect(seventh.board.map((m) => m.cardId)).toContain('BG26_135');
    expect(seventh.gold).toBe(7);
    expect(seventh.goldTotal).toBe(6);
  });

  /**
   * Класс правки шире одной карты, и это закреплено: ни у одной карты
   * снапшота в тексте не остаётся переноса строки. Иначе следующий шаблон
   * споткнётся о него так же молча, как споткнулись четыре прежних.
   */
  it('в текстах снапшота переносов строк не остаётся', () => {
    const pool = [1, 2, 3, 4, 5, 6].flatMap((tier) => cards.poolOfTier(tier));
    expect(pool.length).toBeGreaterThan(300);
    expect(pool.filter((c) => (c.text ?? '').includes('\n'))).toHaveLength(0);
  });
});
