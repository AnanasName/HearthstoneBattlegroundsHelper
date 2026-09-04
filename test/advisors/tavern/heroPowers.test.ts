import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_TAVERN_RULES as R } from '../../../src/advisors/tavern/rules.js';
import { CARDS_PATH, createCardIndex, type CardIndex } from '../../../src/data/cards.js';

/**
 * СКОЛЬКО советник вычитывает из сил героя — числом, а не на память.
 *
 * Замер 26.08 (вопрос игрока «учитывал ли ты силу героя последней партии»)
 * показал, что механизм чтения силы куда тоньше, чем читалась запись
 * в CLAUDE.md: в пуле Battlegrounds племя называют 24 силы, а не 140 —
 * прежнее число было посчитано по всем 2147 картам типа HERO_POWER
 * снапшота, то есть по всему Hearthstone, вместе с Дуэлями и Наёмниками.
 *
 * Числа закреплены здесь по той же причине, по которой закреплены
 * `trinketOfferTurns` и счёт тавернных триггеров: покрытие меняется
 * от ДВУХ вещей сразу — от патча (снапшот приносит новых героев)
 * и от наших правок (новое правило читает новый канал), — а число,
 * живущее в прозе, разъезжается с кодом молча.
 *
 * **Если тест упал — это не поломка, а сигнал.** Числа изменились, потому
 * что обновился снапшот карт либо появилось новое правило. Надо посмотреть,
 * в какую сторону поехало покрытие, и обновить числа здесь — вместе
 * с записью в CLAUDE.md, если сдвиг заметный.
 */
describe('покрытие сил героя правилами советника', () => {
  let cards: CardIndex;
  let pool: string[];

  /**
   * Силы пула Battlegrounds.
   *
   * Тип HERO_POWER даёт 2147 карт на весь Hearthstone, поэтому нужен ещё
   * фильтр по идентификатору: силы старого образца зовутся
   * `TB_BaconShop_HP_NN`, новые — `<id героя>p`, `…p2`, `…p_Alt`. Силы
   * без текста (заготовки) в счёт не идут: читать из них нечего никому.
   */
  beforeAll(() => {
    const raw = JSON.parse(readFileSync(CARDS_PATH, 'utf8')) as { id?: string; type?: string }[];
    cards = createCardIndex(raw);
    pool = raw
      .filter((c) => c.type === 'Hero_power' && typeof c.id === 'string')
      .map((c) => c.id as string)
      .filter(
        (id) => /^TB_BaconShop_HP_\d+/.test(id) || /_HERO_[A-Za-z0-9]+p\d*(?:_Alt|_ALT)?$/.test(id),
      )
      .filter((id) => (cards.info(id)?.text ?? '') !== '');
  }, 120_000);

  const matches = (id: string, list: readonly string[]): boolean => {
    const text = cards.info(id)?.text ?? '';
    return list.some((w) => new RegExp(w, 'i').test(text));
  };

  /** Племена, названные текстом силы, — тем же чтением, что у `minionValue`. */
  const namesTribe = (id: string): boolean => {
    const info = cards.info(id);
    const text = info?.text ?? '';
    const own = new Set(info?.races ?? []);
    return Object.entries(R.tribeTextWords).some(
      ([race, w]) => !own.has(race) && new RegExp(String.raw`\b(?:${w})\b`, 'i').test(text),
    );
  };

  /** Все каналы, которыми сила героя вообще доходит до советника. */
  const channelsOf = (id: string): string[] => {
    const on: string[] = [];
    if (namesTribe(id)) on.push('tribe');
    if (matches(id, R.heroPowerSellWords)) on.push('sell');
    if (matches(id, R.givesMinionWords)) on.push('minion');
    if (matches(id, R.heroPowerRefreshWords)) on.push('refresh');
    if (matches(id, R.heroPowerSpellWords)) on.push('spell');
    if (matches(id, R.tripleCopiesWords)) on.push('triple');
    if (matches(id, R.heroPowerPlayStatsWords)) on.push('play');
    if (matches(id, R.heroPowerKeywordWords)) on.push('keyword');
    if (matches(id, R.heroPowerBuyRewardWords)) on.push('buy');
    if (matches(id, R.heroPowerGoldWords)) on.push('gold');
    return on;
  };

  it('каждый канал читает столько сил, сколько записано', () => {
    // Счёт по ТЕКСТУ: сработает ли правило на самом деле, решают ещё живые
    // теги (`heroPowerRule` требует платную силу, обновление — активную
    // и бесплатную). То есть это верхняя оценка покрытия, а не нижняя.
    const count = (name: string): number =>
      pool.filter((id) => channelsOf(id).includes(name)).length;

    expect(pool).toHaveLength(174);
    expect(count('tribe')).toBe(24);
    expect(count('sell')).toBe(3);
    expect(count('minion')).toBe(17);
    expect(count('refresh')).toBe(3);
    expect(count('spell')).toBe(2);
    // Два канала от 26.08, и каждый закрывает ровно одну карту пула:
    // «Double Time» и «Hat Trick». Так и должно быть — правило внесено
    // по фактуре одной партии, а не по догадке о классе.
    expect(count('triple')).toBe(1);
    expect(count('play')).toBe(1);
    // «Give a minion Reborn/Divine Shield» — Reborn Rites (part32) и Boon
    // of Light; пассивный «Start of Combat: Give your left-most minion…»
    // (Swatting Insects) шаблон не ловит намеренно: нажимать там нечего.
    expect(count('keyword')).toBe(2);
    // «After you buy 4 Battlecry minions, get a Brann Bronzebeard» —
    // «Бранное дело» (part34), первая внесённая сила класса «платит
    // за действие». Шаблон требует и механику-условие, и награду-миньона:
    // «After you buy 3 minions, get a Tavern Coin» (Verdant Spheres)
    // и «After you buy 12 cards, get Sulfuras» (BUY, INSECT!) он не ловит.
    expect(count('buy')).toBe(1);
    // «Roll a 6-sided die. Gain that much Gold» — «Удачный бросок» Змеиного
    // Глаза (part39), обе версии карты: `BG28_HERO_400p` (нажимаемая,
    // COST=1) и `BG28_HERO_400p2` (та же сила на перезарядке, с живым
    // остатком ходов в тексте). Золото упоминают 17 сил пула, но шаблон
    // привязан к ГЛАГОЛУ броска и потому не ловит ни модификаторы цены
    // («Minions and Refreshes cost 2 Gold»), ни предел («Increase your
    // maximum Gold by 1»), ни класс «платит за ДЕЙСТВИЕ» («After you sell
    // a minion, gain 1 Gold next turn»). Плоская форма «Gain 2 Gold»
    // (Piggy Bank `TB_BaconShop_HP_076`) остаётся немой намеренно: сумма
    // у неё РАСТЁТ («Increases by 1 each turn»), а живого числа мы
    // не видели ни разу — карта во всех партиях чужая.
    expect(count('gold')).toBe(2);
  });

  it('из 174 сил пула советник не берёт ничего у 119', () => {
    const mute = pool.filter((id) => channelsOf(id).length === 0);
    expect(mute).toHaveLength(119);

    // Число большое, и прятать его незачем: сила героя определяет стиль
    // партии, а мы читаем меньше трети пула. Что из этого стоит вносить —
    // решается фикстурой, а не списком (см. «Отложено сознательно»).
    expect(mute.length / pool.length).toBeGreaterThan(2 / 3);
  });

  it('племя называют 24 силы пула, а не 140 — 140 было по всему Hearthstone', () => {
    // Ошибка, ради которой этот тест и написан: прежний счёт шёл по типу
    // карты без фильтра пула. Здесь закреплены ОБА числа, чтобы разница
    // была видна, а не переоткрывалась.
    const raw = JSON.parse(readFileSync(CARDS_PATH, 'utf8')) as { id?: string; type?: string }[];
    const everyPower = raw
      .filter((c) => c.type === 'Hero_power' && typeof c.id === 'string')
      .map((c) => c.id as string);

    expect(everyPower.length).toBeGreaterThan(2000);
    expect(everyPower.filter(namesTribe)).toHaveLength(140);
    expect(pool.filter(namesTribe)).toHaveLength(24);
  });

  it('контрольные силы читаются теми каналами, ради которых написаны', () => {
    // Каждая — из партии игрока, и каждая проверяет свой шаблон на живом
    // тексте снапшота: у него переносы строк и разметка посреди фразы.
    expect(channelsOf('BG34_HERO_002p')).toEqual(['triple']);
    expect(channelsOf('TB_BaconShop_HP_042')).toEqual(['play']);
    expect(channelsOf('TB_BaconShop_HP_056')).toEqual(['tribe', 'sell']);
    expect(channelsOf('TB_BaconShop_HP_024')).toEqual(['keyword']);
    expect(channelsOf('TB_BaconShop_HP_048')).toEqual(['buy']);
    expect(channelsOf('TB_BaconShop_HP_066')).toEqual([]);
    expect(channelsOf('TB_BaconShop_HP_087')).toEqual([]);

    // А это — сила самой частой партии датасета (три раза), и она
    // показывает, почему счёт по тексту ВЕРХНИЙ: «Discover a minion with
    // a Dark Gift» шаблон «даёт миньона» ловит, а правило `heroPowerRule`
    // требует ПЛАТНУЮ силу (cost > 0), и эта пассивная. Совета из неё
    // не выходит ни одного; настоящий её эффект советник видит КНОПКОЙ
    // тёмного дара (`darkGiftRule`), а не текстом силы.
    expect(channelsOf('BG36_HERO_105p')).toEqual(['minion']);
    expect(cards.info('BG36_HERO_105p')?.text ?? '').toMatch(/Dark Gift/i);
  });
});
