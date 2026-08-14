import type { AllCardsService } from '@firestone-hs/reference-data';

import type { Minion } from '../../state/types.js';

/**
 * Предбоевые эффекты конца хода, зависящие от РАССТАНОВКИ.
 *
 * Порядок фаз: таверна → конец хода → бой. Расстановка, выбранная
 * в таверне, определяет и то, кому достанется бафф «соседям» в конце хода,
 * и сам бой. Советник расстановки прежде видел только бой — и двигал
 * Surfing Sylvar («At the end of your turn, give adjacent minions +{0}
 * Attack. Repeat for each friendly Golden minion») из центра краем ради
 * +2.2 п.п. одного боя, теряя постоянный бафф второму соседу (part16,
 * скриншот хода 7, — на что игрок и указал).
 *
 * Здесь бафф применяется к КАЖДОМУ кандидату расстановки перед симуляцией:
 * соседи носителя получают атаку, и польза центра входит в счёт боя сама,
 * без выдуманных весов. Величина — живой плейсхолдер `{0}` (scriptData
 * сущности), повторы — единица плюс число своих золотых («Repeat for each
 * friendly Golden minion»; считается ли золотой носитель сам, из фикстур
 * не видно — включён, это следует из слова «friendly»).
 *
 * Носители ищутся по тексту карты в том же снапшоте, которым живёт
 * симулятор, — оба пути (пакетный и воркер) читают один источник и не могут
 * разойтись. Разбор узкий сознательно: только «adjacent minions +N Attack»,
 * прочие эффекты конца хода (заклинания, золото) расстановки не касаются.
 */

// Пробелы — \s+: тексты снапшота переносят строки посреди предложения.
const ADJACENT_ATTACK =
  /at\s+the\s+end\s+of\s+your\s+turn,\s+give\s+adjacent\s+minions\s+\+(?:\{(\d)\}|(\d+))\s+attack/i;
const REPEAT_GOLDEN = /repeat\s+for\s+each\s+friendly\s+golden\s+minion/i;

/**
 * Прибавка атаки соседям от каждого носителя: entityId → сколько атаки
 * получит КАЖДЫЙ сосед в конце хода (повторы уже учтены).
 *
 * Считается один раз на борд: состав не зависит от перестановки, только
 * позиции соседей — их применяет `withEndOfTurnAuras` на каждый кандидат.
 */
export function endOfTurnAuraGains(
  board: readonly Minion[],
  cards: AllCardsService,
): ReadonlyMap<number, number> {
  const gains = new Map<number, number>();
  const golden = board.filter((m) => m.golden).length;

  for (const m of board) {
    const text: string = cards.getCard(m.cardId)?.text ?? '';
    const match = ADJACENT_ATTACK.exec(text);
    if (match === null) continue;

    const placeholder = match[1];
    const literal = match[2];
    const per =
      placeholder !== undefined
        ? (m.scriptData[Number(placeholder)] ?? 1)
        : literal !== undefined
          ? Number(literal)
          : 1;
    const repeats = REPEAT_GOLDEN.test(text) ? 1 + golden : 1;
    gains.set(m.entityId, per * repeats);
  }
  return gains;
}

/** Применить баффы соседям для данного ПОРЯДКА борда. Без носителей — вход как есть. */
export function withEndOfTurnAuras(
  board: readonly Minion[],
  gains: ReadonlyMap<number, number>,
): readonly Minion[] {
  if (gains.size === 0) return board;

  const boosted = board.map((m) => ({ ...m }));
  for (const [i, m] of board.entries()) {
    const gain = gains.get(m.entityId);
    if (gain === undefined) continue;
    for (const j of [i - 1, i + 1]) {
      const neighbor = boosted[j];
      if (neighbor !== undefined) neighbor.attack = (neighbor.attack ?? 0) + gain;
    }
  }
  return boosted;
}
