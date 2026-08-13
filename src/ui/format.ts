import type { PositionAdvice } from '../advisors/position/advisor.js';
import type { ResolvedOpponent } from '../advisors/position/opponent.js';
import type { Recommendation, TrinketAdvice } from '../advisors/tavern/advisor.js';
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
  const what = r.minion === null ? '' : ` ${minionLabel(r.minion, cards)}`;
  const price = r.cost > 0 ? ` за ${String(r.cost)}` : '';
  const victim = r.sellFirst === null ? '' : `, продав ${minionLabel(r.sellFirst, cards)}`;
  return `${ACTION_LABEL[r.action]}${what}${price}${victim}`;
}

/** Вариант выбора тринкета одной строкой. */
export function trinketLine(t: TrinketAdvice): string {
  return `${t.name} — ${t.reason}`;
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

export function opponentStale(opponent: ResolvedOpponent): boolean {
  return opponent.source === 'lastSeen' && opponent.staleTurns > STALE_TURNS_LIMIT;
}

export function opponentSource(opponent: ResolvedOpponent): string {
  return opponent.source === 'lastSeen'
    ? `по борду ${String(opponent.staleTurns)} ходов давности`
    : 'по текущему бою';
}

/** Почему расстановку считать не против кого. */
export function noOpponentReason(opponent: ResolvedOpponent): string {
  return opponent.source === 'unseen'
    ? 'следующего противника ещё не видели — считать не против кого'
    : 'противник неизвестен';
}

/** Совет по расстановке словами: что переставить и чего это стоит. */
export function positionLine(
  advice: PositionAdvice,
  opponent: ResolvedOpponent,
  cards: CardIndex,
): string {
  const odds = `${winPercent(advice.report.current.estimate).toFixed(0)}% побед`;
  const spent = `${opponentSource(opponent)}, ${String(advice.elapsedMs)} мс`;
  const best = advice.top[0];

  if (!advice.improves || best === undefined) {
    return `менять нечего (${odds}, ${spent})`;
  }
  return (
    `${best.board.map((m) => minionLabel(m, cards)).join(' → ')}` +
    `  +${advice.gain.toFixed(1)} п.п. к ${odds} (${spent})`
  );
}
