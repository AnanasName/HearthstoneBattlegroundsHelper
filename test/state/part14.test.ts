import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../src/advisors/tavern/advisor.js';
import { readTavernTurns, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part14Game } from '../fixtures.js';

/**
 * part14 — шестая партия с оверлеем (14.08.2026, Сильвана, 5-е место),
 * три пункта обратной связи (`part14.expected.json`): молчание заклинания
 * наклейки Тюремщика, спорная покупка низкого тира, молчание активаций.
 */
describe('part14: заклинание-замена и активации миньонов', () => {
  let text: string;
  let cards: CardIndex;
  let turns: TavernTurn[];

  const reduceTo = (mark: string): GameState => {
    const cut = text.indexOf(mark);
    expect(cut, `метка ${mark} должна быть в логе`).toBeGreaterThan(0);
    const slice = text.slice(0, cut);
    const reducer = createReducer(readPlayers(slice));
    for (const event of readPowerEvents(slice)) reducer.step(event);
    return reducer.snapshot();
  };

  beforeAll(() => {
    text = part14Game();
    cards = loadCardIndex();
    turns = readTavernTurns(text);
  }, 120_000);

  it('Сильвана, 5-е место', () => {
    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) reducer.step(event);
    const state = reducer.snapshot();
    expect(state.hero?.cardId).toBe('BG23_HERO_306');
    expect(state.finalPlace).toBe(5);
  });

  it('заклинание наклейки Тюремщика советуется заменой наименьшей нежити (жалоба 1)', () => {
    // «Destroy a friendly Undead to get a random Undead» — ни статов,
    // ни золота в тексте; прежний разбор возвращал null, совет молчал
    // всю партию.
    const withSpell = turns.filter(({ state }) =>
      state.handSpells.some((s) => s.cardId === 'BG35_MagicItem_306t'),
    );
    expect(withSpell.length).toBeGreaterThan(0);

    const advised = withSpell.filter(({ state }) =>
      adviseTavern(state, { cards })?.recommendations.some(
        (r) => r.spellCardId === 'BG35_MagicItem_306t' && r.reason.includes('замен'),
      ),
    );
    expect(advised.length).toBeGreaterThan(0);
  });

  it('выбор героя виден в состоянии и ранжирован статистикой мест', () => {
    // Канал MULLIGAN прежде отбрасывался; теперь выбор героя — первое
    // положение партии, и совет ранжирует варианты по среднему месту.
    const state = reduceTo('D 18:24:24.4307741');
    expect(state.heroChoice?.options.length).toBeGreaterThanOrEqual(2);
    expect(state.heroChoice?.options.some((o) => o.cardId.startsWith('BG23_HERO_306'))).toBe(
      true,
    );

    const advice = adviseTavern(state, { cards });
    const picks = advice?.heroChoice ?? [];
    expect(picks.length).toBe(state.heroChoice?.options.length);
    // Ранжирование по возрастанию среднего места; без статистики — в конец.
    const places = picks.map((p) => p.averagePosition ?? 9);
    expect([...places].sort((a, b) => a - b)).toEqual(places);

    // После выбора состояние чисто: героя выбрали, выбор закрыт.
    const after = reduceTo('D 18:24:50');
    expect(after.heroChoice).toBeNull();
  });

  it('нажатая активация видна в состоянии и повторно не советуется (жалоба 3, фактура)', () => {
    // «Творец обманок» (Decoy Conjurer, id 1142) даёт ОБА события на одной
    // сущности и с разницей в пять секунд — лучшей фактуры для этой границы
    // в фикстурах нет:
    //   18:26:40.69  BLOCK_START PLAY … zone=HAND  — розыгрыш из руки,
    //   18:26:45.39  BLOCK_START PLAY … zone=PLAY  — активация
    //                («Activate ({0}): Steal the highest-Attack minion»).
    //
    // Между ними миньон стоит на борде, но НЕ нажат: советовать активацию
    // в тот же ход, когда его выставили, — обычное дело, и запрет тут был бы
    // прямой потерей хода (part40, ход 17: Тираэль за 1 делает соседа 50/50).
    const played = reduceTo('D 18:26:45.1294092');
    expect(played.board.some((m) => m.entityId === 1142)).toBe(true);
    expect(played.activatedEntityIds).not.toContain(1142);

    const activated = reduceTo('D 18:26:46.4905917');
    expect(activated.activatedEntityIds).toContain(1142);

    // Смена хода счётчик чистит.
    const nextTurn = reduceTo('D 18:27:42.2915767');
    expect(nextTurn.activatedEntityIds).not.toContain(1142);
  });

  it('разыгранный из руки миньон не числится активированным (part40, регрессия)', () => {
    // Прежде зона нажатой сущности читалась из ТАБЛИЦЫ сущностей, а не из
    // дескриптора строки BLOCK_START. Внутри блока PLAY карта успевает
    // сменить зону (`ZONE value=PLAY` идёт строкой ниже), а стек блоков висит
    // на КАЖДОМ событии блока — и любой разыгранный из руки миньон попадал
    // в «уже активирован в этом ходу». Здесь это «Подозрительный надзиратель»
    // (id 1854, `Activate ({2}): Give another minion +{0}/+{1}`): за партию
    // у него РОВНО ОДИН блок PLAY, и тот с `zone=HAND` — то есть его
    // разыграли и ни разу не нажали.
    const state = reduceTo('D 18:28:33.9673078');
    expect(state.board.some((m) => m.entityId === 1854)).toBe(true);
    expect(state.activatedEntityIds).not.toContain(1854);
  });
});
