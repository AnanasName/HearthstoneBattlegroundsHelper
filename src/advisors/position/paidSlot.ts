import type { CardIndex } from '../../data/cards.js';
import { normalizeCardText } from '../../data/cards.js';
import type { GameState } from '../../state/types.js';

/**
 * ПЛАТНЫЙ СЛОТ: край борда, куда тринкет каждый ход кладёт постоянное
 * усиление.
 *
 * Жалоба игрока (part39): «предложило поставить на первое место существо
 * с предсмертным хрипом, которое позже было усилено из-за trinket, что
 * не очень, так как предсмертный хрип этого существа давал мне
 * заклинание». Тринкет — Emergency Gearblade `BG36_MagicItem_812`
 * («At the end of your turn, cast Repair Job on your left-most Mech»),
 * и он превращает крайний левый слот в слот ВЫПЛАТЫ: расстановка решает
 * не только исход боя, но и то, кто будет расти всю оставшуюся партию.
 *
 * Почему это ПОДАЧА, а не правило. Слепота в коде настоящая — тринкет
 * не видит ни `endOfTurnAuraGains` (он ищет носителей только среди
 * миньонов борда и только по шаблону «adjacent minions +N attack»),
 * ни симулятор (эффект тавернный, а не боевой). Но на самой part39
 * слепота ИНЕРТНА: с применённым усилением ближайший бой всё равно
 * ставит того же миньона первым (97.0 % против 93.3 % у кэрри первым),
 * то есть починка чтения ничего бы не изменила. Цена, которую чувствует
 * игрок, лежит ЗА горизонтом ближайшего боя — «ценность миньона в его
 * смерти» и «статы ушли в того, кого я потом продал» такой меркой
 * не измеряются вовсе, а замер с горизонтом в несколько ходов у проекта
 * не построен (тот же долг, что записан у `spike:hand`).
 *
 * Поэтому здесь не появляется ни одного нового веса и не двигается
 * ни один совет. Появляется ФАКТ в строке, без которого совет читается
 * неверно, — ровно доктрина `searchGoal` (part37) и цели усиления
 * (part12): игрок должен видеть, что край платный, и что советник этого
 * не считает. Тогда он может возразить; молча одобренный порядок
 * возразить не даёт.
 *
 * Класс, а не карта. По снапшоту край называют 24 тринкета, и «каждый
 * ход» из них говорят СЕМЬ: Charming Panpipes, Auric Offering, Cliffdiver
 * Sticker, Accord-o-Tron Portrait, Young Murk-Eye Sticker, Murky Sticker
 * и Emergency Gearblade. Остальные семнадцать — «Start of Combat»,
 * «After you trigger a Deathrattle», «Whenever you cast a Tavern spell»:
 * край у них тоже значим, но одни из них симулятор считает сам, а другие
 * не повторяются каждый ход, и обещать про них «расстановка не считает»
 * было бы неправдой. Берём тот класс, про который утверждение проверено.
 */

/**
 * Голова эффекта: «в конце КАЖДОГО (или ВАШЕГО) хода».
 *
 * Пробелы — `\s+`: тексты снапшота переносят строки посреди предложения
 * (урок part16), и здесь это не теория — у Emergency Gearblade перенос
 * стоит ровно внутри фразы.
 */
const END_OF_TURN = /at\s+the\s+end\s+of\s+(?:your|each)\s+turn/i;

/**
 * Край борда. Дефис от слова отделяется `\s*` НЕ для красоты: снапшот
 * пишет «left and right- most minions'» с пробелом после дефиса (Young
 * Murk-Eye Sticker), и шаблон без этого молча терял бы карту — тот же
 * класс тихой потери, что переносы строк.
 */
const LEFT_MOST = /left-?\s*(?:and\s+right-?\s*most|most)/i;
const RIGHT_MOST = /right-?\s*most/i;

export interface PaidSlot {
  /** Какой край получает выплату. */
  readonly side: 'left' | 'right' | 'both';
  /** Имя тринкета — игрок обязан узнать источник, а не гадать. */
  readonly source: string;
}

/** Края, которым тринкеты игрока платят каждый ход. Пусто — платных нет. */
export function paidSlots(state: GameState, cards: CardIndex): readonly PaidSlot[] {
  const playerId = state.playerId;
  if (playerId === null) return [];
  const mine = state.trinketsByPlayer[playerId] ?? [];

  const found: PaidSlot[] = [];
  for (const dbfId of mine) {
    const info = cards.infoByDbfId(dbfId);
    if (info === null) continue;
    const text = normalizeCardText(info.text ?? '');
    if (!END_OF_TURN.test(text)) continue;

    const left = LEFT_MOST.test(text);
    const right = RIGHT_MOST.test(text);
    if (!left && !right) continue;
    // «left and right-most» ловится обоими шаблонами — это и есть 'both'.
    const side: PaidSlot['side'] = left && right ? 'both' : left ? 'left' : 'right';
    found.push({ side, source: info.name });
  }
  return found;
}

/**
 * Строка-приписка к совету по расстановке: какой слот платный и что
 * советник его не считает. `null` — платных слотов нет.
 */
export function paidSlotNote(state: GameState, cards: CardIndex): string | null {
  const slots = paidSlots(state, cards);
  if (slots.length === 0) return null;

  const label = (s: PaidSlot): string =>
    `${s.side === 'both' ? 'края борда' : s.side === 'left' ? 'левый край' : 'правый край'} (${s.source})`;

  const what = slots.map(label).join(', ');
  return `${what} — усиление туда идёт КАЖДЫЙ ход, и расстановка этого не считает`;
}
