/**
 * Пул миньонов — какая это игра для всего, что читает КАРТЫ.
 *
 * ## Почему не номер билда
 *
 * 22.09.2026 пул сменился посреди билда 251952: part64–part67 играли
 * старым пулом (наги, Scrap Scraper, Molten Rock), part68 — уже новым
 * (щитовые драконы Hopebringer и Bronze Warden, Volumizer'ы, Dune Dweller),
 * а номер билда один и тот же. Ротацию игра включает на своей стороне,
 * и таблица билдов (`src/data/builds.ts`) её не видит по устройству.
 * Обратное тоже бывает: билд 253216 (24.09) пул не тронул вовсе.
 *
 * ## Откуда пул
 *
 * Из снапшота карт: флаг `isBaconPool` — это пул на дату данных Firestone
 * (`poolOfTier`). Таблицы ротаций, которую пришлось бы вести руками, нет:
 * снапшот обновляется, когда игра меняется, и вместе с ним меняется
 * ответ «какие партии той же игры».
 *
 * ## Как узнать пул партии
 *
 * По её же витрине, и только по картам, которые игра пометила картой пула
 * (`seenShopPoolCardIds`, тег `IS_BACON_POOL_MINION`): карта пула партии,
 * которой нет в пуле снапшота, значит, что партия сыграна на другом пуле.
 * Не наоборот: «ни одной карты вне пула» — не доказательство, а отсутствие
 * опровержения. Опровержение на деле дешёвое: ротация 22.09 увела из пула
 * 57 карт, и счёт по фикстурам — в журнале (j-0925-7).
 *
 * Борд и рука сюда не годятся: там жетоны и карты наград.
 */
import { createHash } from 'node:crypto';

import type { CardIndex } from './cards.js';

/** Тиры таверны: седьмой бывает у аномалий. */
const TIERS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];

/** Идентификатор карты без золотого суффикса: золотая — та же карта пула. */
export function baseCardId(cardId: string): string {
  return cardId.endsWith('_G') ? cardId.slice(0, -2) : cardId;
}

/** Миньоны пула по снапшоту карт. */
export function poolMinionIds(cards: CardIndex): ReadonlySet<string> {
  return new Set(TIERS.flatMap((tier) => cards.poolOfTier(tier).map((c) => c.id)));
}

/**
 * Отпечаток пула: одинаковый у двух снапшотов с одним составом пула.
 *
 * Хэш, а не дата снапшота: данные обновляются и без ротации (тексты,
 * статы), и поле бордов от этого не устаревает.
 */
export function poolFingerprint(cards: CardIndex): string {
  const ids = [...poolMinionIds(cards)].sort();
  return createHash('sha1').update(ids.join('\n')).digest('hex').slice(0, 12);
}

/**
 * Карты пула партии, которых нет в пуле снапшота, — по возрастанию,
 * без повторов. Непусто — партия сыграна на другом пуле.
 *
 * На вход — `seenShopPoolCardIds`: карты витрины, которые игра САМА
 * пометила картой пула (`IS_BACON_POOL_MINION`). Вся витрина
 * (`seenShopCardIds`) не годится: эффекты кладут в таверну жетоны вне
 * пула — варианты Dark Paradox `BG36_360t*`, Fishbait `BG36_205`, — и они
 * есть у шести партий нового пула из десяти. Отсеять их по снапшоту
 * нельзя: Firestone стирает ушедшим из пула картам и флаг, и тир, и Molten
 * Rock в нём выглядит так же, как жетон. Первая сборка поля 25.09 на всей
 * витрине оставила из десяти партий нового пула четыре, вторая (жетоны —
 * по тиру снапшота) вернула в «нынешний пул» part4.
 */
export function offPoolShopCards(seenShopPoolCardIds: readonly string[], cards: CardIndex): string[] {
  const pool = poolMinionIds(cards);
  return [...new Set(seenShopPoolCardIds.map(baseCardId))].filter((id) => !pool.has(id)).sort();
}
