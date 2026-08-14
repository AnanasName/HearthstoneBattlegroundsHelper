import type { PositionAdvice } from '../advisors/position/advisor.js';
import type { PositionTarget, ResolvedOpponent } from '../advisors/position/opponent.js';
import type {
  ChoiceAdvice,
  PlanStep,
  Recommendation,
  TrinketAdvice,
} from '../advisors/tavern/advisor.js';
import type { CardIndex } from '../data/cards.js';
import type { GameState, Minion } from '../state/types.js';

/**
 * Как советы выглядят словами.
 *
 * Одно место на терминал и на оверлей: расходиться им незачем, а решения тут
 * не оформительские. Например, возраст картинки противника — это не украшение
 * подписи, а единственное, что отличает осмысленное число от бессмысленного.
 */

export const ACTION_LABEL: Readonly<Record<Recommendation['action'], string>> = {
  levelUp: 'ПОДНЯТЬ ТАВЕРНУ',
  buy: 'КУПИТЬ',
  play: 'РАЗЫГРАТЬ',
  sell: 'ПРОДАТЬ',
  reroll: 'ОБНОВИТЬ',
  freeze: 'ЗАМОРОЗИТЬ',
  heroPower: 'СИЛА ГЕРОЯ',
  darkGift: 'ТЁМНЫЙ ДАР',
  pass: 'НИЧЕГО',
};

/** Миньон одной строкой: имя, статы и то, что меняет бой. */
export function minionLabel(m: Minion, cards: CardIndex): string {
  const marks = [
    m.golden ? 'зол' : '',
    m.taunt ? 'провок' : '',
    m.divineShield ? 'щит' : '',
    m.poisonous || m.venomous ? 'яд' : '',
    m.reborn ? 'перерожд' : '',
    m.windfury ? 'вихрь' : '',
  ].filter((x) => x !== '');

  return (
    `${cards.info(m.cardId)?.name ?? m.cardId} ${String(m.attack ?? '?')}/${String(m.health ?? '?')}` +
    (marks.length > 0 ? ` (${marks.join(',')})` : '')
  );
}

/** Здоровье героя с бронёй, если она есть. */
export function heroHp(state: GameState): string {
  const hero = state.hero;
  if (hero === null) return '?';
  const hp = (hero.health ?? 0) - hero.damage;
  return hero.armor > 0 ? `${String(hp)}+${String(hero.armor)}` : String(hp);
}

export function situationLine(state: GameState): string {
  return (
    `ход ${String(state.turn)} · ${state.phase === 'tavern' ? 'таверна' : 'бой'}` +
    ` · тир ${String(state.techLevel)} · золото ${String(state.gold)}/${String(state.goldTotal)}` +
    ` · hp ${heroHp(state)}`
  );
}

/** Совет по таверне одной строкой. */
export function recommendationLine(r: Recommendation, cards: CardIndex): string {
  const what =
    r.minion !== null
      ? ` ${minionLabel(r.minion, cards)}`
      : r.spellCardId != null
        ? ` ${cards.info(r.spellCardId)?.name ?? r.spellCardId}`
        : '';
  const price = r.cost > 0 ? ` за ${String(r.cost)}` : '';
  const victim = r.sellFirst === null ? '' : `, продав ${minionLabel(r.sellFirst, cards)}`;
  const magnet =
    r.magnetizeTo == null ? '' : `, примагнитив к ${minionLabel(r.magnetizeTo, cards)}`;
  // Цель заклинания-усиления — прямо в строке действия: «РАЗЫГРАТЬ Fortify»
  // без цели перекладывал выбор на игрока (part12).
  const target =
    r.targetMinion == null ? '' : ` → на ${minionLabel(r.targetMinion, cards)}`;
  return `${ACTION_LABEL[r.action]}${what}${price}${victim}${magnet}${target}`;
}

/** Вариант выбора тринкета одной строкой. */
export function trinketLine(t: TrinketAdvice): string {
  return `${t.name} — ${t.reason}`;
}

/** Вариант открытого выбора одной строкой. */
export function choiceLine(c: ChoiceAdvice): string {
  return `${c.name} — ${c.reason}`;
}

/** План розыгрыша одной строкой: тела по порядку, магниты с целью. */
export function planLine(steps: readonly PlanStep[], cards: CardIndex): string {
  const parts = steps.map((s) => {
    const sold = s.sellFirst === null ? '' : ` (продав ${minionLabel(s.sellFirst, cards)})`;
    return s.magnetizeTo === null
      ? `${minionLabel(s.minion, cards)}${sold}`
      : `${minionLabel(s.minion, cards)} примагнитить к ${minionLabel(s.magnetizeTo, cards)}`;
  });
  return `РАЗЫГРАТЬ ПО ПОРЯДКУ: ${parts.join(', затем ')}`;
}

/** Доля побед оценки, в процентах. */
export function winPercent(estimate: { readonly sims: number; readonly won: number }): number {
  return estimate.sims === 0 ? 0 : (estimate.won / estimate.sims) * 100;
}

/**
 * Устарела ли картинка противника настолько, что числам верить нельзя.
 *
 * Порог показной, а не замеренный: за четыре хода противник успевает дважды
 * сходить в таверну. Замерено другое — что в обеих фикстурах давность доходит
 * до 17 ходов, и там счёт даёт 100% побед против борда, которого давно нет
 * (docs/live.md).
 */
export const STALE_TURNS_LIMIT = 4;

export function opponentStale(target: PositionTarget): boolean {
  if (target.kind === 'single') {
    return target.opponent.source === 'lastSeen' && target.opponent.staleTurns > STALE_TURNS_LIMIT;
  }
  // Поле устарело, только когда устарел КАЖДЫЙ борд в нём: пока хоть одна
  // картинка свежа, средний исход опирается не только на прошлое.
  return target.boards.every((b) => b.staleTurns > STALE_TURNS_LIMIT);
}

/** «1 ход», «3 хода», «13 ходов» — подпись не имеет права быть безграмотной. */
function turnsLabel(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  const word =
    mod100 >= 11 && mod100 <= 14
      ? 'ходов'
      : mod10 === 1
        ? 'ход'
        : mod10 >= 2 && mod10 <= 4
          ? 'хода'
          : 'ходов';
  return `${String(n)} ${word}`;
}

export function opponentSource(target: PositionTarget): string {
  if (target.kind === 'field') {
    const stale = target.boards.map((b) => b.staleTurns);
    const min = Math.min(...stale);
    const max = Math.max(...stale);
    const age = min === max ? turnsLabel(min) : `${String(min)}–${String(max)} ходов`;
    const count = target.boards.length;
    return `в среднем по полю из ${String(count)} ${count === 1 ? 'борда' : 'бордов'}, давность ${age}`;
  }
  return target.opponent.source === 'lastSeen'
    ? `по борду ${String(target.opponent.staleTurns)} ходов давности`
    : 'по текущему бою';
}

/** Почему расстановку считать не на чем. */
export function noOpponentReason(opponent: ResolvedOpponent): string {
  return opponent.source === 'unknown'
    ? 'противник неизвестен'
    : 'чужих бордов ещё не видели — считать не против кого';
}

/** Совет по расстановке словами: что переставить и чего это стоит. */
export function positionLine(
  advice: PositionAdvice,
  target: PositionTarget,
  cards: CardIndex,
): string {
  const odds = `${winPercent(advice.report.current.estimate).toFixed(0)}% побед`;
  const spent = `${opponentSource(target)}, ${String(advice.elapsedMs)} мс`;
  const best = advice.top[0];

  if (!advice.improves || best === undefined) {
    return `менять нечего (${odds}, ${spent})`;
  }
  return (
    `${best.board.map((m) => minionLabel(m, cards)).join(' → ')}` +
    `  +${advice.gain.toFixed(1)} п.п. к ${odds} (${spent})`
  );
}
