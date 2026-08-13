import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  choiceAdvice,
  heroPowerRule,
  playRules,
} from '../../src/advisors/tavern/advisor.js';
import { readTavernTurns, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part9Game } from '../fixtures.js';

/**
 * part9 — Зирелла (BG20_HERO_101, билд 248348), партия 13.08.2026, сыгранная
 * игроком с работающим оверлеем. Пять скриншотов советов стали обратной
 * связью, и каждый тест ниже — один её пункт. Контрольные значения сверены
 * со скриншотами из чата (`part9.expected.json`, verifiedBy: скриншот).
 *
 * Временные срезы режут лог по меткам `D HH:MM:SS` — моменты, когда игрок
 * снимал экран: состояние в тесте то же, что было на его мониторе.
 */
describe('part9: Зирелла, модальные выборы и магниты', () => {
  let text: string;
  let cards: CardIndex;
  let turns: TavernTurn[];

  const reduceTo = (slice: string): GameState => {
    const reducer = createReducer(readPlayers(slice));
    for (const event of readPowerEvents(slice)) reducer.step(event);
    return reducer.snapshot();
  };

  beforeAll(() => {
    text = part9Game();
    cards = loadCardIndex();
    turns = readTavernTurns(text);
  }, 120_000);

  it('герой — Зирелла, сила за 2, партия дошла до 2-го места', () => {
    const state = reduceTo(text);
    expect(state.hero?.cardId).toBe('BG20_HERO_101');
    expect(state.hero?.heroPowerCardId).toBe('BG20_HERO_101p');
    expect(state.hero?.heroPowerCost).toBe(2);
    expect(state.finalPlace).toBe(2);
  });

  it('сила Зиреллы советуется, когда золота на неё хватает (жалоба хода 3)', () => {
    // На скриншоте хода 3 сила за 2 была доступна при золоте 2, а совет —
    // «НИЧЕГО»: шаблоны «глагол…minion» не видели силу с местоимением.
    const turn3 = turns.find((t) => t.turn === 3);
    expect(turn3).toBeDefined();
    expect(turn3?.state.hero?.heroPowerUsedThisTurn).toBe(false);

    const rec = heroPowerRule(turn3?.state ?? reduceTo(text), { cards });
    expect(rec?.action).toBe('heroPower');
    expect(rec?.cost).toBe(2);
  });

  it('лавка аксессуаров открывается выбором id=2 и закрывается выбором игрока', () => {
    const header = text.indexOf('id=2 Player=AngryMem#2886');
    expect(header).toBeGreaterThan(0);
    const lastOption = text.indexOf('Entities[3]=', header);
    const cut = text.indexOf('\n', lastOption);

    const open = reduceTo(text.slice(0, cut + 1));
    expect(open.openChoice?.id).toBe(2);
    expect(open.openChoice?.sourceCardId).toBe('BG30_Trinket_1st');
    expect(open.openChoice?.options.map((o) => o.cardId)).toEqual([
      'BG30_MagicItem_303',
      'BG30_MagicItem_891',
      'BG30_MagicItem_425',
      'BG35_MagicItem_301',
    ]);

    // Игрок взял Scraper Sticker — SendChoices с тем же id закрывает выбор.
    const closed = text.indexOf('SendChoices() - id=2');
    const cut2 = text.indexOf('\n', closed + 300);
    expect(reduceTo(text.slice(0, cut2)).openChoice).toBeNull();
  });

  it('тринкет про мехов видит своих мехов (жалоба хода 11)', () => {
    // На скриншоте: «Scraper Sticker — для племени MECHANICAL, а своих таких
    // нет» при мехах на борде. Племя в снапшоте называется MECH.
    const turn11 = turns.find((t) => t.turn === 11);
    expect(turn11).toBeDefined();

    const advice = adviseTavern(turn11?.state ?? reduceTo(text), { cards });
    const sticker = advice?.trinkets.find((t) => t.offer.cardId === 'BG35_MagicItem_301');
    expect(sticker).toBeDefined();
    expect(sticker?.tribeMinions).toBeGreaterThan(0);
    expect(sticker?.reason).not.toContain('своих таких нет');
  });

  it('раскопка хода 13 разобрана и ранжирована: мех с магнетизмом первым', () => {
    const header = text.indexOf('id=3 Player=AngryMem#2886');
    const lastOption = text.indexOf('Entities[2]=', header);
    const cut = text.indexOf('\n', lastOption);
    const state = reduceTo(text.slice(0, cut + 1));

    expect(state.turn).toBe(13);
    expect(state.openChoice?.sourceCardId).toBe('BG34_330');
    expect(state.openChoice?.options.map((o) => o.cardId)).toEqual([
      'BG35_341',
      'BG36_331',
      'BG36_180',
    ]);

    // Борд из мехов — Enchanted Sentinel (мех, магнитный) обязан быть первым,
    // а не «оценить не берёмся», как было с тринкетами на скриншоте.
    const advice = choiceAdvice(state, { cards });
    expect(advice[0]?.option.cardId).toBe('BG35_341');
    expect(advice[0]?.value).not.toBeNull();
    expect(advice[0]?.reason).toContain('магнитный');
  });

  it('ход 19: Ученица Кангора не продаётся ради Свиногонщика (жалоба скриншота)', () => {
    // Момент скриншота: рука Turbo Hogrider + Brann, на борде мех-композиция
    // с Ученицей 3/6. Совет был «разыграть свинобраза, продав Ученицу».
    const cut = text.indexOf('D 22:47:0');
    expect(cut).toBeGreaterThan(0);
    const state = reduceTo(text.slice(0, cut));

    expect(state.turn).toBe(19);
    expect(state.hand.some((m) => m.cardId === 'BG31_323')).toBe(true);
    expect(state.board.some((m) => m.cardId === 'BGS_012')).toBe(true);

    for (const play of playRules(state, { cards })) {
      expect(play.sellFirst?.cardId).not.toBe('BGS_012');
      expect(play.minion?.cardId).not.toBe('BG31_323');
    }
  });

  it('ход 25: план разыгрывает несколько карт, магниты — с целью', () => {
    // Момент скриншота: борд полон, в руке Glambot, Ученица, магнитные
    // Accord-o-Tron и Lullabot. Совет «разыграть Glambot» терял остальное.
    const cut = text.indexOf('D 22:54:2');
    expect(cut).toBeGreaterThan(0);
    const state = reduceTo(text.slice(0, cut));
    expect(state.turn).toBe(25);

    const advice = adviseTavern(state, { cards });
    const plan = advice?.playPlan ?? [];
    expect(plan.length).toBeGreaterThanOrEqual(2);

    // Магнитные шаги называют носителя, а не требуют продажи.
    const magnets = plan.filter((s) => s.magnetizeTo !== null);
    expect(magnets.length).toBeGreaterThanOrEqual(1);
    for (const step of magnets) expect(step.sellFirst).toBeNull();

    // Glambot — сильнейший розыгрыш — из плана не выпадает.
    expect(plan.some((s) => s.minion.cardId === 'BG36_853')).toBe(true);
  });

  it('выбор героя (MULLIGAN) в открытые выборы не попадает', () => {
    // Первый выбор партии — герои, id=1. До первого GENERAL открытых
    // выборов быть не должно.
    const mulligan = text.indexOf('id=1 Player=AngryMem#2886');
    const cut = text.indexOf('\n', mulligan + 600);
    expect(reduceTo(text.slice(0, cut)).openChoice).toBeNull();
  });
});
