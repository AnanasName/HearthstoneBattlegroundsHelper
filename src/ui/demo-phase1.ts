/**
 * Демонстрация фазы 1: прогоняет фикстуру и печатает состояние по ходам.
 *
 *   npm run demo:phase1
 *   npm run demo:phase1 -- data/fixtures/part1/segment1.log
 *
 * Вывод сделан так, чтобы его можно было сверять глазами с записью экрана —
 * это следующий шаг разметки контрольных точек в expected.json.
 */
import { readFileSync } from 'node:fs';

import { readPowerEvents } from '../parser/blocks.js';
import { readPlayers } from '../state/players.js';
import { createReducer } from '../state/reducer.js';
import type { GameState, Minion } from '../state/types.js';

const DEFAULT_FIXTURE = 'data/fixtures/part2/game.log';

function describeMinion(m: Minion): string {
  const stats = `${m.attack ?? '?'}/${m.health ?? '?'}`;
  const marks = [
    m.golden ? 'зол' : '',
    m.taunt ? 'провок' : '',
    m.divineShield ? 'щит' : '',
    m.poisonous ? 'яд' : '',
    m.venomous ? 'токс' : '',
    m.reborn ? 'перерожд' : '',
    m.windfury ? 'вихрь' : '',
  ].filter((x) => x !== '');
  const tail = marks.length > 0 ? ` [${marks.join(',')}]` : '';
  const ench =
    m.enchantments.length > 0 ? `  +${String(m.enchantments.length)} энч` : '';
  return `${m.cardId} ${stats}${tail}${ench}`;
}

function printState(state: GameState): void {
  const hero = state.hero;
  const hp = hero === null ? '?' : `${(hero.health ?? 0) - hero.damage}${hero.armor > 0 ? `+${String(hero.armor)}` : ''}`;

  console.log(
    `\n─── ход ${String(state.turn).padStart(2)}  фаза ${state.phase.padEnd(8)}  ` +
      `тир ${String(state.techLevel)}  ` +
      `золото ${String(state.gold)}/${String(state.goldTotal)}  hp ${hp}`,
  );

  if (state.board.length > 0) {
    console.log('  борд:');
    for (const m of state.board) console.log(`    ${String(m.zonePos)}. ${describeMinion(m)}`);
  }
  if (state.hand.length > 0) {
    console.log(`  рука: ${state.hand.map((m) => m.cardId).join(', ')}`);
  }
  if (state.shop.length > 0) {
    console.log(`  магазин: ${state.shop.map(describeMinion).join(' | ')}`);
  }
  if (state.opponentBoard.length > 0) {
    console.log('  борд противника:');
    for (const m of state.opponentBoard) {
      console.log(`    ${String(m.zonePos)}. ${describeMinion(m)}`);
    }
  }
}

function main(): void {
  const path = process.argv[2] ?? DEFAULT_FIXTURE;
  const text = readFileSync(path, 'utf8');
  const players = readPlayers(text);
  const reducer = createReducer(players);

  console.log(`фикстура: ${path}`);
  console.log(`игрок:    ${players.selfName ?? '?'} (PlayerID ${String(players.selfPlayerId)})`);

  let lastKey = '';
  let pending: GameState | null = null;
  let events = 0;

  for (const event of readPowerEvents(text)) {
    reducer.step(event);
    events += 1;

    const s = reducer.snapshot();
    const key = `${String(s.turn)}|${s.phase}`;

    // Печатается состояние на КОНЕЦ фазы, а не на момент переключения.
    // В секунду перехода в бой магазин ещё не убран из PLAY — он исчезает
    // на десяток событий позже, и снимок «в момент смены» показывал бы
    // магазин как борд противника. Конец таверны заодно полезнее для сверки
    // с записью экрана: борд там уже собран целиком.
    if (key !== lastKey) {
      if (pending !== null) printState(pending);
      lastKey = key;
    }
    pending = s;
  }
  if (pending !== null) printState(pending);

  const final = reducer.snapshot();
  console.log(`\n─── итог`);
  console.log(`  событий обработано: ${events.toLocaleString('ru-RU')}`);
  console.log(`  аномалия:           ${final.anomalyCardId ?? '—'}`);
  console.log(`  герой:              ${final.hero?.cardId ?? '—'} (id ${String(final.hero?.entityId)})`);
  console.log(`  финальное место:    ${final.finalPlace ?? '—'}`);
}

main();
