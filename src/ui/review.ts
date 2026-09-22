/**
 * Разбор партии: что советник говорил в каждой точке решения и что игрок
 * сделал на самом деле.
 *
 *   npm run review -- part64
 *   npm run review -- part64 --turn=11
 *
 * Зачем отдельно от `fixture:at`: тот отвечает про ОДИН кадр по часам, а
 * вопрос игрока «где я делал не по подсказке и был ли прав» — про всю партию
 * сразу. Сверки (`validate:tavern`, `ml:imitation`) на этот вопрос не отвечают:
 * первая судит совет БОЕМ из своих же кандидатов, вторая — статистикой по
 * датасету, и ни одна не показывает пару «совет ↔ поступок» глазами.
 *
 * Точка решения — та же, что у датасета и у оверлея (`readTavernTurns`),
 * то есть последнее состояние до первой траты золота (D119, D180). Действия
 * хода берутся из журнала `GameState.actions` финального состояния.
 */
import { adviseTavern } from '../advisors/tavern/advisor.js';
import { tavernTurnOf } from '../advisors/tavern/rules.js';
import { spendPlan } from '../advisors/tavern/spend.js';
import { readTavernTurns } from '../advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../data/cards.js';
import { readFixtureGame } from '../data/fixtureGames.js';
import { readPowerEvents } from '../parser/blocks.js';
import { readPlayers } from '../state/players.js';
import { createReducer } from '../state/reducer.js';
import type { GameState, HandSpell, Minion, PlayerAction, PlayerActionType } from '../state/types.js';
import { minionLabel, recommendationLine, situationLine, spendPlanLine } from './format.js';

const ACTION_WORD: Readonly<Record<PlayerActionType, string>> = {
  buy: 'купил',
  sell: 'продал',
  roll: 'обновил витрину',
  levelUp: 'поднял таверну',
  freeze: 'заморозил витрину',
  unfreeze: 'снял заморозку',
  play: 'разыграл',
  heroPower: 'нажал силу героя',
  darkGift: 'нажал тёмный дар',
  activate: 'активировал',
  trinket: 'взял тринкет',
};

const minions = (list: readonly Minion[], cards: CardIndex): string =>
  list.length === 0 ? '—' : list.map((m) => minionLabel(m, cards)).join(' | ');

const spells = (list: readonly HandSpell[], cards: CardIndex): string =>
  list
    .map(
      (s) =>
        `${cards.info(s.cardId)?.name ?? s.cardId} за ${String(s.cost)}${s.costsHealth === true ? ' здоровья' : ''}`,
    )
    .join(' | ');

function actionLine(a: PlayerAction, cards: CardIndex): string {
  const card = a.cardId === null ? '' : ` ${cards.info(a.cardId)?.name ?? a.cardId}`;
  const branch = a.subOption === null ? '' : ` (ветвь ${String(a.subOption + 1)})`;
  return `${ACTION_WORD[a.type]}${card}${branch}`;
}

function flag(argv: readonly string[], name: string): string | null {
  const found = argv.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? null : found.slice(name.length + 3);
}

function finalState(text: string): GameState {
  const reducer = createReducer(readPlayers(text));
  for (const event of readPowerEvents(text)) reducer.step(event);
  return reducer.snapshot();
}

function main(): number {
  const argv = process.argv.slice(2);
  const ref = argv.find((a) => !a.startsWith('--'));
  if (ref === undefined) {
    console.log('использование: npm run review -- <partN> [--turn=N]');
    return 1;
  }
  const only = flag(argv, 'turn');
  const part = Number(/^(?:part)?(\d+)$/i.exec(ref)?.[1] ?? NaN);
  const text = readFixtureGame(part);
  if (text === null) {
    console.log(`у part${String(part)} нет лога в data/fixtures`);
    return 1;
  }

  const cards = loadCardIndex();
  const turns = readTavernTurns(text);
  const final = finalState(text);

  const byTurn = new Map<number, PlayerAction[]>();
  for (const a of final.actions) {
    const list = byTurn.get(a.turn) ?? [];
    list.push(a);
    byTurn.set(a.turn, list);
  }

  console.log(
    `part${String(part)}: точек решения ${String(turns.length)}, действий ${String(final.actions.length)}, место ${String(final.finalPlace ?? '?')}`,
  );

  for (const { turn, state } of turns) {
    if (only !== null && turn !== Number(only)) continue;
    console.log(`\n═══ ${situationLine(state)} · ход таверны ${String(tavernTurnOf(turn))}`);
    console.log(`борд:    ${minions(state.board, cards)}`);
    console.log(`витрина: ${minions(state.shop, cards)}${state.shop.some((m) => m.frozen) ? '  [ЗАМОРОЖЕНА]' : ''}`);
    if (state.shopSpells.length > 0) console.log(`         ${spells(state.shopSpells, cards)}`);
    if (state.hand.length > 0) console.log(`рука:    ${minions(state.hand, cards)}`);
    if (state.handSpells.length > 0) console.log(`         ${spells(state.handSpells, cards)}`);

    const advice = adviseTavern(state, { cards });
    if (advice === null) {
      console.log('СОВЕТ: молчит');
    } else {
      const plan = spendPlan(state, { cards });
      if (plan.steps.length >= 2) console.log(`ПЛАН:  ${spendPlanLine(plan, cards)}`);
      // Полный план, без обрезки: на экране хвост прячется («…и ещё N»,
      // D164), а разбору нужен именно он — совет, вытесненный из видимой
      // части, читается как «советник этого не предлагал».
      if (plan.steps.length > 0) {
        console.log(
          `ПЛАН ЦЕЛИКОМ: ${plan.steps.map((s, i) => `${String(i + 1)}) ${recommendationLine(s.recommendation, cards)}`).join(' | ')}`,
        );
      }
      console.log('СОВЕТ:');
      advice.recommendations.slice(0, 5).forEach((r, i) => {
        console.log(`  ${String(i + 1)}. ${recommendationLine(r, cards)}  (${r.score.toFixed(1)})`);
        console.log(`     ← ${r.reason}`);
      });
    }

    const done = byTurn.get(turn) ?? [];
    console.log(`ИГРОК: ${done.length === 0 ? '— (ничего)' : done.map((a) => actionLine(a, cards)).join('; ')}`);
  }
  return 0;
}

process.exitCode = main();
