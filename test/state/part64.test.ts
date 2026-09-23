import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, lobbyRaces, minionValue } from '../../src/advisors/tavern/advisor.js';
import {
  CARDS_PATH,
  createCardIndex,
  loadCardIndex,
  withLogRaces,
  type CardIndex,
} from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { recommendationLine } from '../../src/ui/format.js';
import { frameAt, parseClock, sliceLogByClock } from '../../src/ui/logSlice.js';
import { createBreather } from '../breather.js';
import { part51Game, part64Game } from '../fixtures.js';

/**
 * part64 — Миллифисент Манашторм (22.09.2026), 1-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Партия пришла с сообщением игрока
 * «в игру добавлено племя Аберрации», и проверяется здесь ровно оно: лог
 * племя называет, снапшот молчит, и слияние обязано взять сторону лога
 * ТОЛЬКО там, где снапшоту сказать нечего (D275).
 */
describe('part64: Миллифисент — аберрации, которых снапшот не знает', () => {
  let cards: CardIndex;
  let final: GameState;

  beforeAll(async () => {
    cards = snapshotBlindToAberrations();
    const text = part64Game();
    const reducer = createReducer(readPlayers(text));
    const breather = createBreather();
    for (const event of readPowerEvents(text)) {
      if (breather.due()) await breather.pause();
      reducer.step(event);
    }
    final = reducer.snapshot();
  }, 600_000);

  it('читает племя из тега CARDRACE — 26 аберраций, которых нет в снапшоте', () => {
    const aberrations = Object.entries(final.logRaces).filter(([, race]) => race === 'ABERRATION');
    expect(aberrations.length).toBe(26);
    // Карты с кадра и с борда игрока: снапшот про их племя не знает ничего.
    for (const id of ['BG36_110', 'BG36_116', 'BG36_308', 'BG36_312']) {
      expect(final.logRaces[id]).toBe('ABERRATION');
      expect(cards.info(id)?.races ?? []).toEqual([]);
    }
  });

  it('снапшот 24.09 знает племя всех двадцати шести — лог и снапшот сходятся', () => {
    // Firestone внёс ABERRATION 23.09, и слияние для аберраций теперь молчит:
    // говорит снапшот. Правило D275 от этого не устарело — оно ждёт
    // следующего племени, которое придёт в игру раньше, чем в данные.
    const current = loadCardIndex();
    const aberrations = Object.entries(final.logRaces).filter(([, race]) => race === 'ABERRATION');
    for (const [id] of aberrations) {
      expect({ id, races: current.info(id)?.races }).toEqual({ id, races: ['ABERRATION'] });
    }
  });

  it('слияние даёт племя там, где снапшот молчит', () => {
    const merged = withLogRaces(cards, final.logRaces);
    // Faceless Operative стоял на борде игрока на ходу 11.
    expect(merged.info('BG36_308')?.races).toEqual(['ABERRATION']);
    // Joyous — та самая карта из витрины первого хода («Счастье» в логе).
    expect(merged.info('BG36_110')?.races).toEqual(['ABERRATION']);
  });

  it('снапшот СИЛЬНЕЕ: двуплеменные карты тег не обедняет (причина D071)', () => {
    const merged = withLogRaces(cards, final.logRaces);
    // Лог говорит про «Руку-протез» одно слово — MECHANICAL. Подмени тег
    // снапшот, карта потеряла бы UNDEAD, и это ровно то, ради чего D071
    // отверг CARDRACE для состава партии.
    expect(final.logRaces['BG_DEEP_015']).toBe('MECHANICAL');
    expect(merged.info('BG_DEEP_015')?.races).toEqual(['MECH', 'UNDEAD']);
    // Ещё три двуплеменных той же партии.
    expect(merged.info('BG32_820')?.races).toEqual(['DRAGON', 'NAGA']);
    expect(merged.info('BG34_500')?.races).toEqual(['DEMON', 'ELEMENTAL']);
    expect(merged.info('BG36_764')?.races).toEqual(['MURLOC', 'MECH']);
  });

  it('ПРИОБРЕТЁННОЕ племя карте не приписывается', () => {
    // Племя бывает выданным по ходу партии — тёмным даром или тринкетом,
    // на конкретную СУЩНОСТЬ (подтверждено игроком 22.09). В логе оно
    // приходит отдельным `TAG_CHANGE`, а не в блоке тегов карты, и ключ
    // здесь — КАРТА: записать такое значило бы раздать приобретение всем
    // копиям, своим и чужим. В part64 приобретений нет ни одного, поэтому
    // проверка держится на part51, где Бранн получил `ALL` даром.
    const text = part51Game();
    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) reducer.step(event);
    const state = reducer.snapshot();

    // Приобретение в логе есть — иначе тест ничего не значит.
    expect(/TAG_CHANGE Entity=\d+ tag=CARDRACE value=ALL/.test(text)).toBe(true);
    // А в таблице карт его нет, и слияние Бранну племени не даёт.
    expect(state.logRaces['BG_LOE_077']).toBeUndefined();
    expect(withLogRaces(cards, state.logRaces).info('BG_LOE_077')?.races).toEqual([]);
  }, 600_000);

  it('словарь лога приводится к словарю снапшота: MECHANICAL → MECH', () => {
    const merged = withLogRaces(cards, { BG36_999test: 'MECHANICAL' });
    // Карты в снапшоте нет вовсе — обёртка её не выдумывает.
    expect(merged.info('BG36_999test')).toBeNull();
    // А имя приводится там, где карта есть и молчит: проверяется на живой
    // таблице партии через любую аберрацию — её имя менять не нужно.
    expect(withLogRaces(cards, final.logRaces).info('BG36_098')?.races).toEqual(['ABERRATION']);
  });

  it('состав племён партии видит аберрацию, а без слияния — нет', () => {
    // Состав доказывается ОДНОПЛЕМЕННЫМ миньоном витрины (D071). Пока
    // аберрации были бесплеменными, ни один из двадцати шести ничего
    // не доказывал, и партия числилась на одно племя беднее.
    expect(lobbyRaces(final, cards).has('ABERRATION')).toBe(false);
    expect(lobbyRaces(final, withLogRaces(cards, final.logRaces)).has('ABERRATION')).toBe(true);
  });

  it('кадр 14:57: заморозка НАЗЫВАЕТ причину прямо в строке действия', () => {
    // Жалоба игрока по этому кадру — «почему-то предлагает заморозить».
    // Совет был обоснован (Scarlet Skull `BG25_022`: Reborn и Deathrattle
    // «Give a friendly Undead +1/+2» при двух своих UNDEAD на борде, золото
    // 0 из 5), но причина жила в reason, а оверлей его не показывает.
    const clock = parseClock('14:57:00');
    expect(clock).not.toBeNull();
    const slice = sliceLogByClock(part64Game(), clock!);
    expect(slice?.inGame).toBe(true);
    const { state } = frameAt(slice!);

    expect(state.gold).toBe(0);
    expect(state.shop.length).toBe(2);
    const advice = adviseTavern(state, { cards });
    const top = advice?.recommendations[0];
    expect(top?.action).toBe('freeze');
    expect(cards.info(top?.minion?.cardId ?? '')?.name).toBe('Scarlet Skull');
    expect(top?.holdReason).toBe('своих по племени 2');
    expect(recommendationLine(top!, cards)).toContain('— своих по племени 2');
  }, 600_000);

  it('ценность аберрации считает своих по племени, а не ноль', () => {
    const merged = withLogRaces(cards, final.logRaces);
    // Борд из трёх аберраций: до правки каждая была бесплеменной, и надбавка
    // за своих по племени молчала у всех троих.
    const board = [
      { ...MINION, entityId: 1, cardId: 'BG36_116' },
      { ...MINION, entityId: 2, cardId: 'BG36_308' },
      { ...MINION, entityId: 3, cardId: 'BG36_110' },
    ];
    const state: GameState = { ...final, board, shop: [], hand: [] };
    const withTribe = minionValue(board[0]!, state, { cards: merged });
    const blind = minionValue(board[0]!, state, { cards });
    expect(withTribe.total).toBeGreaterThan(blind.total);
  });
});

/**
 * Снапшот, каким он был до 24.09: племени ABERRATION не знала ни одна карта.
 *
 * Правило D275 писалось под такой снапшот и проверяется на нём же — иначе
 * со снапшотом 24.09 (данные Firestone от 23.09, где аберрации есть) слияние
 * для них молчит, и тест доказывал бы ничего.
 */
function snapshotBlindToAberrations(): CardIndex {
  const raw = JSON.parse(readFileSync(CARDS_PATH, 'utf8')) as { races?: string[]; race?: string }[];
  return createCardIndex(
    raw.map((c) =>
      c.races?.includes('ABERRATION') === true
        ? { ...c, races: c.races.filter((r) => r !== 'ABERRATION'), race: undefined }
        : c,
    ),
  );
}

/** Заготовка миньона: поля, которых тест не касается. */
const MINION = {
  entityId: 0,
  cardId: '',
  zonePos: 0,
  attack: 3,
  health: 3,
  taunt: false,
  divineShield: false,
  poisonous: false,
  venomous: false,
  reborn: false,
  windfury: false,
  stealth: false,
  golden: false,
  frozen: false,
  maxHealth: 3,
  techLevel: 2,
  enchantments: [],
  scriptData: [],
  tags: {},
  buyCost: null,
};
