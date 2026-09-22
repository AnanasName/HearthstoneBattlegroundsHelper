import { beforeAll, describe, expect, it } from 'vitest';

import { weakestOwn } from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import type { Minion } from '../../src/state/types.js';
import { createBreather } from '../breather.js';
import { part69Game } from '../fixtures.js';

/**
 * part69 — Rustlin' Rokara (22.09.2026), 3-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Обе жалобы игрока про одно:
 * на полном борде жертвой назначается тело, ценность которого не в теле,
 * а в тексте — том, что оно делает с ОСТАЛЬНЫМ бордом.
 *
 * Это тот же промах, что был закрыт по part19 для аур Бранна
 * (`isAuraOverOthers`), но сигнал там взят из механики `AURA` снапшота,
 * а у этих карт эффект на чужих висит на ТРИГГЕРЕ, и снапшот метит их
 * `TRIGGER_VISUAL`/`DEATHRATTLE`. Шкала мерила их телом — и на ходу 21
 * ставила первыми в очередь на продажу два ключевых узла жучиного движка.
 */
describe('part69: Rustlin’ Rokara — жертва на полном борде среди движков', () => {
  let cards: CardIndex;
  let turns: TavernTurn[];

  beforeAll(async () => {
    cards = loadCardIndex();
    turns = await readTavernTurnsAsync(part69Game(), createBreather());
  }, 600_000);

  const at = (turn: number): TavernTurn => {
    const found = turns.find((t) => t.turn === turn);
    if (found === undefined) throw new Error(`нет точки решения на ходу ${String(turn)}`);
    return found;
  };

  const nameOf = (m: Minion): string => cards.info(m.cardId)?.name ?? m.cardId;

  /**
   * Тексты карт — из снапшота, а не из памяти: правило читает именно их.
   */
  it('карты борда обещают эффект ДРУГИМ своим, а тела у них мелкие', () => {
    expect(cards.info('BG26_802')?.text).toContain('After you summon a');
    expect(cards.info('BG26_802')?.text).toContain('double its Attack');
    expect(cards.info('BG31_809')?.text).toContain('Your Beetles');
    expect(cards.info('BG31_809')?.text).toContain('this game');
    expect(cards.info('BG36_209')?.text).toContain('your Beetles');
    expect(cards.info('BG36_211')?.text).toContain('give your Beasts');

    // Ни одна из них не помечена `AURA` — потому фильтр part19 их и не видел.
    for (const id of ['BG26_802', 'BG31_809', 'BG36_209', 'BG36_211']) {
      expect(cards.info(id)?.mechanics).not.toContain('AURA');
    }
  });

  /**
   * Кадр игрока 23:20, ход 19 — жалоба «предлагает продать зверя, который
   * удваивает статы внутри боя». Борд полон, и жертвой выходила Banana
   * Slamma 9/8: по шкале тел она слабейшая (25.5 против 33.0 у следующего).
   */
  it('ход 19: жертвой не назначается Banana Slamma — её ценность в тексте', () => {
    const { state } = at(19);
    expect(state.board).toHaveLength(7);
    expect(state.board.map(nameOf)).toContain('Banana Slamma');

    const victim = weakestOwn(state, { cards }, DEFAULT_TAVERN_RULES);
    expect(victim).not.toBeNull();
    expect(nameOf(victim!.minion)).not.toBe('Banana Slamma');
  });

  /**
   * Кадр игрока 23:22, ход 21 — жалоба «рекомендует продать полезного жука».
   * Жертвой выходил Turquoise Skitterer, а следом за ним — Banana Slamma:
   * два самых мелких тела борда и есть два узла движка.
   *
   * Что остаётся в кандидатах: Headhunter Gryphon («Rally: Get a random
   * Beast» — добыча В РУКУ, не эффект на чужих) и Lurking Lionfish
   * (носитель АКТИВАЦИИ, которого фильтр не трогает по замеру part44).
   * Игрок продал именно Lurking Lionfish, и поле бордов оценило его выбор
   * выше советника: средний урон 32.82 против 30.04.
   */
  it('ход 21: жертвой не назначается ни Skitterer, ни Banana Slamma', () => {
    const { state } = at(21);
    expect(state.board).toHaveLength(7);

    const victim = weakestOwn(state, { cards }, DEFAULT_TAVERN_RULES);
    expect(victim).not.toBeNull();
    expect(['Turquoise Skitterer', 'Banana Slamma']).not.toContain(nameOf(victim!.minion));
  });

  /**
   * Доказательство дефекта в самой партии: Тираэль поставил Banana Slamma
   * статы 50/50 (`BG36_356`, «Set another minion's stats to {1}/{2}»), и та
   * же карта с тем же текстом из ПЕРВОЙ в очереди на продажу стала последней.
   * Тест держит факт, а не число: текст карты на её место в очереди
   * не влиял вовсе.
   */
  it('ход 23: Banana Slamma 50/50 — уже не жертва, хотя текст не менялся', () => {
    const { state } = at(23);
    const slamma = state.board.find((m) => nameOf(m) === 'Banana Slamma');
    expect(slamma).toBeDefined();
    expect(slamma?.attack).toBe(50);

    const victim = weakestOwn(state, { cards }, DEFAULT_TAVERN_RULES);
    expect(nameOf(victim!.minion)).not.toBe('Banana Slamma');
  });
});
