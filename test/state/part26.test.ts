import { beforeAll, describe, expect, it } from 'vitest';

import { choiceAdvice } from '../../src/advisors/tavern/advisor.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part26Game } from '../fixtures.js';

/**
 * part26 — восемнадцатая партия с оверлеем (18.08.2026, Мастер Нгуен,
 * 4-е место). Оба пункта обратной связи — про ВЫБОР, который советник
 * не брался оценивать: силу героя, меняемую каждый ход, и ставку
 * на исход чужого боя.
 *
 * Контрольные значения — `part26.expected.json`.
 */
describe('part26: выбор силы героя каждый ход и ставка на чужой бой', () => {
  let cards: CardIndex;

  const shifts = new Map<number, GameState>();
  let wager: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part26Game();
    cards = loadCardIndex();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      const s = reducer.snapshot();
      const choice = s.openChoice;
      if (choice === null || choice.options.length < 2) continue;

      // Смена силы героя Нгуена: источник один и тот же весь матч.
      if (choice.sourceCardId === 'BG20_HERO_202pt' && !shifts.has(s.turn)) shifts.set(s.turn, s);
      // Дружеская ставка: варианты — ГЕРОИ, то есть игроки лобби.
      if (choice.sourceCardId === 'TB_BaconShop_HP_081' && wager === null) wager = s;
    }
    finalState = reducer.snapshot();
  }, 600_000);

  it('партия дочитывается до конца: 4-е место, Нгуен из лога', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(4);
    expect(finalState.hero?.cardId).toBe('BG20_HERO_202');
    expect(finalState.buildNumber).toBe(248348);
  });

  it('смена силы героя приходит каждый ход таверны отдельным выбором', () => {
    // Нгуен меняет силу каждый ход — это и есть причина обоих пунктов.
    expect(shifts.size).toBeGreaterThanOrEqual(8);
    for (const [, s] of shifts) {
      expect(s.openChoice?.options).toHaveLength(2);
      for (const o of s.openChoice?.options ?? []) {
        expect(cards.info(o.cardId)?.type).toBe('HERO_POWER');
      }
    }
  });

  /**
   * Пункт 1 (скриншот хода 3): «выбираю новую способность каждый ход,
   * сейчас пишется, что мы не беремся оценить».
   *
   * Сила старого образца (`TB_BaconShop_HP_020`) героя в идентификаторе
   * не несёт, и про неё честно молчим; у второй он есть, и статистика
   * героя отвечает на вопрос — тем же способом, что у выбора героя
   * и тринкетов.
   */
  it('пункт 1: сила героя оценивается статистикой героя, чья она', () => {
    const s = shifts.get(3);
    expect(s).toBeDefined();
    if (s === undefined) return;

    expect(s.openChoice?.options.map((o) => o.cardId).sort()).toEqual(
      ['BG25_HERO_103p', 'TB_BaconShop_HP_020'].sort(),
    );

    const advice = choiceAdvice(s, { cards });
    expect(advice[0]?.option.cardId).toBe('BG25_HERO_103p');
    expect(advice[0]?.reason).toContain('по статистике героя');
    expect(advice[0]?.reason).toContain('среднее место');
    // Старая сила остаётся неоценённой — выдумывать за неё число нечем.
    expect(advice[1]?.option.cardId).toBe('TB_BaconShop_HP_020');
    expect(advice[1]?.score).toBeNull();
  });

  it('пункт 1: замена своего миньона читается текстом и не путается с покупкой', () => {
    const s = shifts.get(5);
    expect(s).toBeDefined();
    if (s === undefined) return;

    const rune = choiceAdvice(s, { cards }).find((a) => a.option.cardId === 'TB_BaconShop_HP_702t');
    // «Destroy a friendly Undead to get a random Undead» — замена, а не
    // лишнее тело: иначе она стоила бы целой покупки.
    expect(rune?.reason).toContain('меняет своего миньона на нового');
    expect(rune?.reason).toContain('3.0 очка');
  });

  it('пункт 1: «Discover a Naga» — это миньон, а триггерная сила молчит', () => {
    const s = shifts.get(11);
    expect(s).toBeDefined();
    if (s === undefined) return;

    const advice = choiceAdvice(s, { cards });
    const naga = advice.find((a) => a.option.cardId === 'TB_BaconShop_HP_041j');
    expect(naga?.reason).toContain('даёт миньона');

    // «Your Tavern spells give an extra +{1}/+{1}. At the start of every
    // 3 turns, improve this» — вечная прибавка ко всем будущим заклинаниям.
    // Прежде разбор находил тут «+2 статов» и оценивал их в одно очко.
    const lighting = advice.find((a) => a.option.cardId === 'TB_BaconShop_HP_085t');
    expect(lighting?.score).toBeNull();
    expect(lighting?.reason).toBe('оценить не берёмся');
  });

  /**
   * Пункт 2: «Дружеская ставка» — выбор из двух ИГРОКОВ лобби.
   *
   * Тест закрепляет фактуру: источник выбора — сила героя
   * `TB_BaconShop_HP_081`, а варианты — карты ГЕРОЕВ, а не миньонов.
   * Этим ставка отличается от любой раскопки, и по этому признаку её
   * и находит советник.
   */
  it('пункт 2: ставка приходит выбором из двух героев-игроков', () => {
    expect(wager).not.toBeNull();
    if (wager === null) return;

    expect(wager.openChoice?.sourceCardId).toBe('TB_BaconShop_HP_081');
    const options = wager.openChoice?.options ?? [];
    expect(options).toHaveLength(2);
    for (const o of options) {
      expect(cards.info(o.cardId)?.type).toBe('HERO');
    }
    expect(options.map((o) => o.cardId).sort()).toEqual(
      ['BG27_HERO_801', 'TB_BaconShop_HERO_33'].sort(),
    );
  });

  /**
   * Таблица игроков лобби — тир, здоровье и место всех восьмерых. Лог
   * говорит это открыто, а состояние до part26 хранило только борды тех,
   * с кем дрались (требование ТЗ «hp/tier оппонента» висело незакрытым).
   *
   * Главная тонкость — ЛИШНИЕ сущности героя: копии для модальных выборов
   * создаются позже и остаются с тегами момента создания. Если брать
   * последнюю, тир половины лобби читается нулём.
   */
  it('пункт 2: состояние знает тир, здоровье и место всех игроков', () => {
    expect(wager).not.toBeNull();
    if (wager === null) return;

    const lobby = Object.values(wager.lobby);
    expect(lobby).toHaveLength(8);

    // Свой герой в таблице — тот же, что в state.hero: копии муллигана
    // (три невыбранных героя) в неё не попадают.
    const mine = lobby.find((p) => p.heroCardId === wager?.hero?.cardId);
    expect(mine).toBeDefined();

    // Тир у всех живой, а не нулевой от копий.
    for (const p of lobby) expect(p.techLevel ?? 0).toBeGreaterThan(0);

    const thorim = lobby.find((p) => p.heroCardId === 'BG27_HERO_801');
    const curator = lobby.find((p) => p.heroCardId === 'TB_BaconShop_HERO_33');
    expect(thorim?.techLevel).toBe(3);
    expect(thorim?.place).toBe(2);
    expect(curator?.techLevel).toBe(4);
    expect(curator?.place).toBe(3);
  });

  /**
   * Пункт 2: «может быть мы можем добавить оценку, кто вероятнее победит?»
   *
   * Оценка — фактами: тир, здоровье с бронёй, место и давность нашей
   * картинки его борда. Порядок по тиру, при равенстве по здоровью.
   * Симулятор не зовётся намеренно: борд соперника виден только в бою
   * с ним, здесь картинке 5 и 9 ходов.
   *
   * В этой партии игрок поставил на Торима (выше в таблице) и ставку
   * ПРОИГРАЛ — трёх монет таверны после боя в логе нет. Совет назвал бы
   * Смотрителя: тир 4 против 3.
   */
  it('пункт 2: совет по ставке называет игрока и числа, по которым выбрал', () => {
    expect(wager).not.toBeNull();
    if (wager === null) return;

    const advice = choiceAdvice(wager, { cards });
    expect(advice).toHaveLength(2);
    expect(advice[0]?.option.cardId).toBe('TB_BaconShop_HERO_33');
    expect(advice[0]?.reason).toContain('тир 4');
    expect(advice[0]?.reason).toContain('впереди по тиру');
    expect(advice[0]?.reason).toContain('борд видели 9 ходов назад');
    expect(advice[1]?.option.cardId).toBe('BG27_HERO_801');
    expect(advice[1]?.reason).toContain('тир 3');
  });
});
