import { readFileSync } from 'node:fs';

/**
 * Справочник карт: cardId → племя, тир, статы.
 *
 * Источник — тот же снапшот Firestone, что кормит симулятор
 * (`data/cards/cards_enUS.json`, 35 321 карта, из них 1833 с `techLevel`).
 * Коллекционный срез HearthstoneJSON из ТЗ здесь не годится по той же причине,
 * что и для симулятора: в нём нет ни `techLevel`, ни `races`, ни `isBaconPool`.
 *
 * Советнику таверны это нужно затем, что в логе у миньона есть `TECH_LEVEL`,
 * но нет племени: теги `BACON_SUBSET_*` означают принадлежность карты к
 * подмножеству, а не племя миньона, и на борде их нет вовсе.
 */

/** Поля снапшота, которые нам нужны. Остальные игнорируются. */
interface RawCard {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly techLevel?: unknown;
  readonly races?: unknown;
  readonly race?: unknown;
  readonly isBaconPool?: unknown;
  readonly attack?: unknown;
  readonly health?: unknown;
  readonly type?: unknown;
}

export interface CardInfo {
  readonly id: string;
  readonly name: string;
  /** Тир таверны. `null` у карт вне Battlegrounds. */
  readonly techLevel: number | null;
  /**
   * Племена карты.
   *
   * Их может быть несколько: у амальгам стоит `ALL`, и такая карта считается
   * своей для любого племени. Пустой список — нейтральный миньон.
   */
  readonly races: readonly string[];
  /** Входит ли в пул миньонов Battlegrounds — 526 карт из снапшота. */
  readonly isBaconPool: boolean;
  readonly attack: number | null;
  readonly health: number | null;
}

/** Племя, которое считается своим для любого другого. */
export const RACE_ALL = 'ALL';

export interface CardIndex {
  /** Карта по идентификатору. `null`, если такой в снапшоте нет. */
  readonly info: (cardId: string) => CardInfo | null;
  readonly size: number;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRaces(card: RawCard): string[] {
  if (Array.isArray(card.races)) return card.races.filter((r): r is string => typeof r === 'string');
  return typeof card.race === 'string' ? [card.race] : [];
}

export function createCardIndex(raw: readonly unknown[]): CardIndex {
  const byId = new Map<string, CardInfo>();

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const card = item as RawCard;
    if (typeof card.id !== 'string' || card.id === '') continue;

    byId.set(card.id, {
      id: card.id,
      name: typeof card.name === 'string' ? card.name : card.id,
      techLevel: asNumber(card.techLevel),
      races: asRaces(card),
      isBaconPool: card.isBaconPool === true,
      attack: asNumber(card.attack),
      health: asNumber(card.health),
    });
  }

  return {
    size: byId.size,
    info: (cardId) => {
      const direct = byId.get(cardId);
      if (direct !== undefined) return direct;
      /**
       * Золотая версия существует отдельной картой с суффиксом `_G`, но
       * в логе золотой миньон помечается тегом `PREMIUM` и суффикса чаще
       * не имеет (25 золотых эталонной партии — без него). Обратный случай
       * тоже бывает, поэтому суффикс снимается при промахе: свойства карты
       * у золотой и обычной версии одни и те же.
       */
      return cardId.endsWith('_G') ? (byId.get(cardId.slice(0, -2)) ?? null) : null;
    },
  };
}

export const CARDS_PATH = 'data/cards/cards_enUS.json';

export function loadCardIndex(path: string = CARDS_PATH): CardIndex {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return createCardIndex(Array.isArray(parsed) ? parsed : []);
}
