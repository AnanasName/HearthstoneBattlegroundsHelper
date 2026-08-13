import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../../src/advisors/tavern/advisor.js';
import { readTavernTurns, type TavernTurn } from '../../../src/advisors/tavern/turns.js';
import { DEFAULT_TAVERN_RULES } from '../../../src/advisors/tavern/rules.js';
import { loadCardIndex, type CardIndex } from '../../../src/data/cards.js';
import { part2Game, part3Game } from '../../fixtures.js';

/**
 * Сквозной тест «состояние → рекомендация» на реальных партиях — вторая
 * половина DoD фазы 4.
 *
 * Проверяется не «совет совпал с моим мнением», а то, что на всех настоящих
 * состояниях советник выдаёт связный ответ и не нарушает собственных правил.
 * Отдельно закреплены точки, разобранные глазами по выводу `npm run demo:phase4`.
 */
describe('советник таверны на фикстурах', () => {
  let cards: CardIndex;
  let part3: TavernTurn[];
  let part2: TavernTurn[];

  beforeAll(() => {
    cards = loadCardIndex();
    part3 = readTavernTurns(part3Game());
    part2 = readTavernTurns(part2Game());
  }, 120_000);

  const turnOf = (turns: TavernTurn[], turn: number): TavernTurn => {
    const found = turns.find((t) => t.turn === turn);
    if (found === undefined) throw new Error(`нет точки решения на ходу ${String(turn)}`);
    return found;
  };

  it('точки решения находятся в обеих партиях', () => {
    expect(part3.length).toBeGreaterThanOrEqual(5);
    expect(part2.length).toBeGreaterThanOrEqual(5);
  });

  it('в точке решения золото целое, а витрина уже показана', () => {
    for (const { state } of [...part3, ...part2]) {
      expect(state.phase).toBe('tavern');
      expect(state.goldSpent).toBe(0);
      expect(state.gold).toBe(state.goldTotal);
      expect(state.gold).toBeGreaterThan(0);
      // Одиночный миньон в витрине означал бы, что снимок взят до её
      // наполнения — ровно та ошибка, что была в первой версии.
      expect(state.shop.length).toBeGreaterThan(0);
      expect(state.hero).not.toBeNull();
    }
  });

  it('витрина к середине партии не вырождается в одного миньона', () => {
    const mid = [...part3, ...part2].filter((t) => t.turn >= 5);
    const sizes = mid.map((t) => t.state.shop.length);
    const average = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    expect(average).toBeGreaterThan(2);
  });

  it('на каждом ходу выдаётся связный совет', () => {
    for (const { state } of [...part3, ...part2]) {
      const advice = adviseTavern(state, { cards });
      expect(advice).not.toBeNull();
      const recommendations = advice?.recommendations ?? [];

      expect(recommendations.length).toBeGreaterThan(0);
      // «Ничего не делать» — точка отсчёта, она есть всегда.
      expect(recommendations.map((r) => r.action)).toContain('pass');
      for (const r of recommendations) {
        expect(r.reason).not.toBe('');
        expect(Number.isFinite(r.score)).toBe(true);
        // Совет не может стоить больше, чем есть золота.
        expect(r.cost).toBeLessThanOrEqual(state.gold);
      }
    }
  });

  it('цена подъёма таверны читается из лога и падает за ход без подъёма', () => {
    // part3: тир 4 держался с 7-го хода по 12-й, и цена подъёма до 5-го
    // падала 10 → 9 → 8, по единице за каждый ход без подъёма.
    const costs = [9, 11, 13].map((turn) => turnOf(part3, turn).state.tavernUpgradeCost);
    expect(costs).toEqual([10, 9, 8]);
    expect(turnOf(part3, 9).state.tavernUpgradeTarget).toBe(5);
    expect(turnOf(part3, 9).state.maxTechLevel).toBe(6);
  });

  it('на полном борде совет покупки называет, кого продать', () => {
    // part2, ход 17: семь миньонов на борде, витрина сильная.
    const { state } = turnOf(part2, 17);
    expect(state.board).toHaveLength(DEFAULT_TAVERN_RULES.boardSize);

    const advice = adviseTavern(state, { cards });
    const buy = advice?.recommendations.find((r) => r.action === 'buy');
    expect(buy?.requiresSlot).toBe(true);
    // Совет «купи, но борд полон» без имени жертвы перекладывает работу
    // обратно на игрока — ровно ту, ради которой советник и нужен.
    expect(buy?.sellFirst).not.toBeNull();
    expect(buy?.reason).toContain('продать');

    // Отдельная рекомендация продажи тоже есть, и жертва в ней та же.
    const sell = advice?.recommendations.find((r) => r.action === 'sell');
    expect(sell?.minion?.entityId).toBe(buy?.sellFirst?.entityId);
  });

  it('слабейший свой ищется с учётом племенной синергии, а не в пустоте', () => {
    const { state } = turnOf(part2, 17);
    const advice = adviseTavern(state, { cards });
    const victim = advice?.recommendations.find((r) => r.action === 'buy')?.sellFirst;
    expect(victim).toBeDefined();

    // На борде из семи элементалей жертвой не должен оказываться элементаль,
    // если среди своих есть кто-то вне племени: при оценке против пустого
    // борда синергия обнулялась у всех, и выбор был случайным.
    const races = (id: string): readonly string[] => cards.info(id)?.races ?? [];
    const elementals = state.board.filter((m) => races(m.cardId).includes('ELEMENTAL'));
    if (elementals.length < state.board.length) {
      expect(races(victim?.cardId ?? '')).not.toContain('ELEMENTAL');
    }
  });

  it('на остатках здоровья подъём таверны не советуется', () => {
    // part3, ход 15: здоровья 5, золота 10, кнопка подъёма доступна.
    const { state } = turnOf(part3, 15);
    const hero = state.hero;
    const hp = hero === null ? 0 : (hero.health ?? 0) - hero.damage + hero.armor;
    expect(hp).toBeLessThan(DEFAULT_TAVERN_RULES.levellingHpFloor);
    expect(state.tavernUpgradeCost).not.toBeNull();

    const advice = adviseTavern(state, { cards });
    const levelUp = advice?.recommendations.find((r) => r.action === 'levelUp');
    expect(levelUp?.score).toBe(0);
    expect(levelUp?.reason).toContain('здоровья');
    // И первым советом подъём в такой ситуации не станет.
    expect(advice?.recommendations[0]?.action).not.toBe('levelUp');
  });

  it('экономические шаблоны находят настоящие карты пула', () => {
    // Шаблоны написаны от реальных текстов; если патч перепишет тексты,
    // этот тест обязан заметить, что шаблоны отстали.
    const skipper = cards.info('BG33_140');
    expect(skipper?.name).toBe('River Skipper');
    expect(
      DEFAULT_TAVERN_RULES.economyTextWords.some((w) =>
        new RegExp(w, 'i').test(skipper?.text ?? ''),
      ),
    ).toBe(true);

    const sellemental = cards.info('BGS_115');
    expect(
      DEFAULT_TAVERN_RULES.economyTextWords.some((w) =>
        new RegExp(w, 'i').test(sellemental?.text ?? ''),
      ),
    ).toBe(true);
  });

  it('справочник карт покрывает всё, что встретилось в витринах', () => {
    const unknown = new Set<string>();
    for (const { state } of [...part3, ...part2]) {
      for (const m of [...state.shop, ...state.board]) {
        if (cards.info(m.cardId) === null) unknown.add(m.cardId);
      }
    }
    // Непокрытая карта означает, что советник не знает её племени и тира,
    // то есть оценивает вслепую. Такое надо замечать сразу.
    expect([...unknown]).toEqual([]);
  });
});
