/**
 * Демонстрация фазы 4: советы по таверне на реальных ходах фикстуры.
 *
 *   npm run demo:phase4
 *   npm run demo:phase4 -- data/fixtures/part2/game.log
 *   npm run demo:phase4 -- data/fixtures/part3/game.log 9
 *
 * Точка совета — начало фазы таверны: витрина только обновилась, золото ещё
 * целое. Демо фазы 1 печатает конец фазы, где золото всегда 0 из 10 и
 * советовать нечего.
 */
import { readFileSync } from 'node:fs';

import { adviseTavern, type Recommendation, type TavernAdvice } from '../advisors/tavern/advisor.js';
import { readTavernTurns } from '../advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../data/cards.js';
import type { GameState, Minion } from '../state/types.js';

const DEFAULT_FIXTURE = 'data/fixtures/part3/game.log';

const ACTION_LABEL: Readonly<Record<Recommendation['action'], string>> = {
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

function describe(m: Minion, cards: CardIndex): string {
  const info = cards.info(m.cardId);
  const marks = [
    m.golden ? 'зол' : '',
    m.taunt ? 'провок' : '',
    m.divineShield ? 'щит' : '',
    m.poisonous || m.venomous ? 'яд' : '',
    m.frozen ? 'заморожен' : '',
  ].filter((x) => x !== '');
  const races = info?.races.length ?? 0;
  return (
    `${info?.name ?? m.cardId} ${String(m.attack ?? '?')}/${String(m.health ?? '?')}` +
    ` т${String(m.techLevel ?? info?.techLevel ?? '?')}` +
    (races > 0 ? ` [${(info?.races ?? []).join('/')}]` : '') +
    (marks.length > 0 ? ` (${marks.join(',')})` : '')
  );
}

function printTurn(state: GameState, advice: TavernAdvice, cards: CardIndex): void {
  const hero = state.hero;
  const hp = hero === null ? 0 : (hero.health ?? 0) - hero.damage + hero.armor;

  console.log(
    `\n─── ход ${String(state.turn).padStart(2)}  таверна ${String(state.techLevel)}` +
      ` (по графику ${String(advice.targetTier)})` +
      `  золото ${String(state.gold)}  hp ${String(hp)}` +
      `  подъём ${state.tavernUpgradeCost === null ? '—' : String(state.tavernUpgradeCost)}`,
  );

  if (state.board.length > 0) {
    console.log(`  борд:    ${state.board.map((m) => describe(m, cards)).join(' | ')}`);
  }
  console.log('  витрина:');
  for (const { minion, value } of advice.shopValues) {
    console.log(
      `    ${describe(minion, cards).padEnd(52)} ценность ${value.total.toFixed(1)}` +
        `  (тир ${value.techLevel.toFixed(1)} статы ${value.stats.toFixed(1)}` +
        ` племя ${value.tribe.toFixed(1)} слова ${value.keywords.toFixed(1)}` +
        ` копии ${value.copies.toFixed(1)} экономика ${value.economy.toFixed(1)}` +
        ` бой ${value.battle.toFixed(1)})`,
    );
  }

  console.log('  совет:');
  for (const r of advice.recommendations.slice(0, 3)) {
    const victim =
      r.sellFirst === null ? '' : `  ← сначала продать ${describe(r.sellFirst, cards)}`;
    console.log(
      `    ${ACTION_LABEL[r.action].padEnd(16)} ${r.score.toFixed(1).padStart(5)} очков` +
        `${r.cost > 0 ? `, ${String(r.cost)} золота` : ''}  ${r.reason}${victim}`,
    );
  }
}

function main(): void {
  const path = process.argv[2] ?? DEFAULT_FIXTURE;
  const onlyTurn = process.argv[3] === undefined ? null : Number(process.argv[3]);

  console.log(`фикстура: ${path}`);
  const cards = loadCardIndex();
  console.log(`справочник: ${cards.size.toLocaleString('ru-RU')} карт`);

  const turns = readTavernTurns(readFileSync(path, 'utf8')).filter(
    (t) => onlyTurn === null || t.turn === onlyTurn,
  );
  if (turns.length === 0) {
    console.log('точек решения не нашлось');
    return;
  }

  const taken = new Map<string, number>();
  for (const { state } of turns) {
    const advice = adviseTavern(state, { cards });
    if (advice === null) continue;
    printTurn(state, advice, cards);
    const first = advice.recommendations[0];
    if (first !== undefined) taken.set(first.action, (taken.get(first.action) ?? 0) + 1);
  }

  console.log(`\n─── итог по ${String(turns.length)} ходам`);
  for (const [action, count] of [...taken].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ACTION_LABEL[action as Recommendation['action']].padEnd(16)} ${String(count)}`);
  }
}

main();
