import type { AllCardsService } from '@firestone-hs/reference-data';

import { normalizeCardText } from '../../data/cards.js';
import type { Minion } from '../../state/types.js';
import { distinguishable, type Objective } from './score.js';
import type { Candidate } from './search.js';

/**
 * «БОЕВОЙ РАЖ», ПЛАТЯЩИЙ КАРТОЙ: единственный эффект расстановки, который
 * наша мерка не видит в принципе.
 *
 * Жалоба игрока (part41, ход 13): «предлагает поставить карту с боевым ражем
 * на 5 место, кажется, что он почти никогда не сработает». Она верна,
 * и вот чем это подтверждено, а не согласием.
 *
 * Механика. Раж срабатывает, когда носитель АТАКУЕТ, а атакуют слева
 * направо. Замер на самой точке (счётчик повешен на реализацию карты
 * в пакете симулятора, поле из пяти виденных бордов, 10 000 боёв
 * на расстановку): у Bronze Timewalker `BG36_242` с ПЕРВОГО места раж
 * срабатывал в 10 000 боях из 10 000, с ПЯТОГО — в 102 из 10 000. То есть
 * место носителя решает не «чуть-чуть», а всё: 1.00 срабатывания на бой
 * против 0.01.
 *
 * Слепота. Награда такого ража — карта в руку: симулятор честно её кладёт
 * (`addCardsInHand`) и честно возвращает `dmgDone… = 0`. Значит в ИСХОДЕ
 * БОЯ — единственном числе, которым мы меряем расстановку, — она не весит
 * ничего, и советник платит ею за доли процентного пункта, сам того
 * не зная. На той же точке: бой при ражнике первым 99.0 % побед и 1.0 %
 * ничьих, при пятом — 100.0 %, разница полпункта.
 *
 * Что здесь сделано и чего НЕ сделано. Курса «карта в руке → проценты боя»
 * у нас нет, и выдумывать его нельзя — это ровно тот долг, что записан
 * у `spike:hand` и у платного края борда (part39): цена лежит ЗА горизонтом
 * ближайшего боя, где мерки нет вовсе. Поэтому веса не тронуты, и ни один
 * РАЗЛИЧИМЫЙ по бою совет не меняется. Меняется только выбор между
 * расстановками, которые наша же мерка признала НЕОТЛИЧИМЫМИ: из них
 * берётся та, где носитель ража левее. Пять прогонов советника на этой
 * точке дали ражника то на первом, то на втором, то на пятом месте
 * с приростом 0.2–0.8 п.п. — то есть выбор между ними и был случайным
 * броском, и теперь этот бросок решается в пользу карты.
 *
 * Когда мерка ВСЁ-ТАКИ различает расстановки, совет остаётся прежним —
 * и тогда игрок читает приписку `rallySwingNote` и решает сам.
 *
 * Класс, а не карта. В пуле 395 миньонов ражем владеют 34, и КАРТОЙ
 * из них платят восемь: Roadboar, Bigwig Bandit, Highkeeper Ra, Timewarped
 * Vaelastrasz, Timewarped Calligrapher, Bramble Tunneler, Headhunter
 * Gryphon, Bronze Timewalker. Остальные 26 ражей бьют, призывают или
 * усиливают — это симулятор считает сам, и вмешиваться в его счёт нечем.
 * Соседний класс — ражи со словами «this game» (Dustbone Devastator,
 * Blue Whelp): часть их эффекта симулятор применяет внутри боя, и обещать
 * про них «бой этого не видит» было бы неправдой, поэтому они не берутся.
 */

/** «Rally:» с любой разметкой снапшота между словом и эффектом. */
const RALLY = /rally:\s*(?:<\/b>)?\s*/i;

/**
 * Награда ражa — карта: эффект НАЧИНАЕТСЯ со слова добычи.
 *
 * Привязка к началу эффекта, а не свободный поиск: «Summon the highest-Attack
 * minion from your hand» тоже упоминает руку, но это призыв в бой, и его
 * симулятор считает сам.
 */
const GETS_CARD = /^(?:get|discover)\b/i;

/** Носители ража, чья награда — карта. Пусто — таких на борде нет. */
export function cardRallyCarriers(
  board: readonly Minion[],
  cards: AllCardsService,
): readonly Minion[] {
  return board.filter((m) => {
    const raw: string = cards.getCard(m.cardId)?.text ?? '';
    const text = normalizeCardText(raw);
    const head = RALLY.exec(text);
    if (head === null) return false;
    // Разметка внутри эффекта («a random <b>Chromadrake</b>») мешает только
    // первому слову — его и хватает, чтобы отличить добычу от призыва.
    const effect = text.slice(head.index + head[0].length).replace(/<[^>]*>/g, '').trimStart();
    return GETS_CARD.test(effect);
  });
}

/** Сумма мест носителей: чем меньше, тем раньше они бьют и тем вернее раж. */
function slotsOf(board: readonly Minion[], carriers: readonly Minion[]): number {
  let sum = 0;
  for (const carrier of carriers) {
    const index = board.findIndex((m) => m.entityId === carrier.entityId);
    // Носителя нет в расстановке — считать нечего; такого быть не должно
    // (состав у перестановок один), но молчаливый −1 испортил бы сумму.
    sum += index < 0 ? board.length : index;
  }
  return sum;
}

/**
 * Финалисты, переупорядоченные в пользу срабатывания ража.
 *
 * Трогается ТОЛЬКО голова списка и только среди кандидатов, неотличимых
 * от лучшего по той же проверке значимости, которой советник решает «стоит
 * ли вообще переставлять» (`distinguishable`). Кандидат с меньшей суммой
 * мест носителей встаёт первым; при равенстве порядок прежний, то есть
 * при отсутствии носителей функция возвращает вход как есть.
 */
export function preferRallySwing(
  top: readonly Candidate[],
  carriers: readonly Minion[],
  objective: Objective,
): readonly Candidate[] {
  const best = top[0];
  if (best === undefined || carriers.length === 0) return top;

  let chosen = best;
  let chosenSlots = slotsOf(best.board, carriers);
  for (const candidate of top.slice(1)) {
    if (distinguishable(best.estimate, candidate.estimate, objective)) continue;
    const slots = slotsOf(candidate.board, carriers);
    if (slots < chosenSlots) {
      chosen = candidate;
      chosenSlots = slots;
    }
  }
  if (chosen === best) return top;
  return [chosen, ...top.filter((c) => c !== chosen)];
}

/**
 * Приписка к строке расстановки: совет двигает носителя ража ВПРАВО.
 *
 * Говорится только про то, что делает САМ совет. Носитель, уже стоящий
 * справа и советом не тронутый, приписки не получает: иначе строка висела бы
 * на каждом кадре партии с таким миньоном и перестала бы читаться — а вот
 * «мы сдвинули, и вот чем это грозит» игрок обязан увидеть.
 */
export function rallySwingNote(
  current: readonly Minion[],
  advised: readonly Minion[],
  cards: AllCardsService,
): string | null {
  const moved = cardRallyCarriers(current, cards)
    .map((carrier) => ({
      carrier,
      from: current.findIndex((m) => m.entityId === carrier.entityId),
      to: advised.findIndex((m) => m.entityId === carrier.entityId),
    }))
    .filter((m) => m.from >= 0 && m.to > m.from);
  if (moved.length === 0) return null;

  const what = moved
    .map((m) => {
      const name: string = cards.getCard(m.carrier.cardId)?.name ?? m.carrier.cardId;
      return `${name} ${String(m.from + 1)}→${String(m.to + 1)}`;
    })
    .join(', ');
  return `${what}: «раж» срабатывает при АТАКЕ носителя, а карту в руку бой не считает`;
}
