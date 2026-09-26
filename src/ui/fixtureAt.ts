/**
 * Кадр игрока по часам: состояние, действия внутри минуты и советы.
 *
 *   npm run fixture:at -- part48 13:12:57
 *   npm run fixture:at -- 48 13:12
 *   npm run fixture:at -- data/fixtures/part48/game.log 13:12:57
 *
 * Партия называется номером фикстуры (сегменты склеиваются сами) или путём
 * к любому логу. Часы — как на кадре: минуты, а если известны, то и секунды.
 *
 * Код выхода 2 — кадр не попадает в партию. Так и было на part49: кадры
 * оказались из другой партии, и узнать это можно только по часам.
 */
import { readFileSync } from 'node:fs';

import { adviseTavern, heroPowerReady } from '../advisors/tavern/advisor.js';
import { tavernTurnOf } from '../advisors/tavern/rules.js';
import { spendPlan } from '../advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../data/cards.js';
import { readFixtureGame } from '../data/fixtureGames.js';
import type { GameState, HandSpell, Minion, PlayerActionType } from '../state/types.js';
import { minionLabel, recommendationLine, situationLine, spendPlanLine } from './format.js';
import { clockText, frameAt, parseClock, sliceLogByClock, type TimedAction } from './logSlice.js';

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

function readGame(ref: string): { label: string; text: string } {
  const numbered = /^(?:part)?(\d+)$/i.exec(ref);
  if (numbered !== null) {
    const part = Number(numbered[1]);
    const text = readFixtureGame(part);
    if (text === null) throw new Error(`у part${String(part)} нет лога в data/fixtures`);
    return { label: `part${String(part)}`, text };
  }
  return { label: ref, text: readFileSync(ref, 'utf8') };
}

const minions = (list: readonly Minion[], cards: CardIndex): string =>
  list.length === 0 ? '—' : list.map((m) => minionLabel(m, cards)).join(' | ');

const spells = (list: readonly HandSpell[], cards: CardIndex): string =>
  list
    .map((s) => `${cards.info(s.cardId)?.name ?? s.cardId} за ${String(s.cost)}${s.costsHealth === true ? ' здоровья' : ''}`)
    .join(' | ');

function actionLine(t: TimedAction, cards: CardIndex): string {
  const card = t.action.cardId === null ? '' : ` ${cards.info(t.action.cardId)?.name ?? t.action.cardId}`;
  const branch = t.action.subOption === null ? '' : ` (ветвь ${String(t.action.subOption + 1)})`;
  return `  ${t.time}  ${ACTION_WORD[t.action.type]}${card}${branch}`;
}

function heroPowerLine(state: GameState, cards: CardIndex): string | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;
  const name = cards.info(hero.heroPowerCardId)?.name ?? hero.heroPowerCardId;
  // Пассивная сила (нет ни цены, ни `HAS_ACTIVATE_POWER`) не нажимается
  // вовсе: «Double Time» part58 строка звала «бесплатна, можно нажать».
  if (hero.heroPowerCost === null && !hero.heroPowerHasActivate) {
    return `сила героя: ${name} — пассивная`;
  }
  const price = hero.heroPowerCost === null ? 'бесплатна' : `за ${String(hero.heroPowerCost)}`;
  const status = hero.heroPowerLocked
    ? 'под замком'
    : heroPowerReady(hero)
      ? 'можно нажать'
      : 'сейчас нажать нельзя';
  return `сила героя: ${name} ${price}, ${status}`;
}

/** Чем кадр отличается от точки решения: по сущностям, а не по картам. */
function difference(label: string, before: readonly Minion[], after: readonly Minion[], cards: CardIndex): string | null {
  const beforeIds = new Set(before.map((m) => m.entityId));
  const afterIds = new Set(after.map((m) => m.entityId));
  const gone = before.filter((m) => !afterIds.has(m.entityId));
  const came = after.filter((m) => !beforeIds.has(m.entityId));
  if (gone.length === 0 && came.length === 0) return null;
  const parts = [
    gone.length > 0 ? `ушли ${gone.map((m) => cards.info(m.cardId)?.name ?? m.cardId).join(', ')}` : '',
    came.length > 0 ? `пришли ${came.map((m) => cards.info(m.cardId)?.name ?? m.cardId).join(', ')}` : '',
  ].filter((x) => x !== '');
  return `  ${label}: ${parts.join('; ')}`;
}

function main(): number {
  const [ref, clockArg] = process.argv.slice(2);
  const clock = clockArg === undefined ? null : parseClock(clockArg);
  if (ref === undefined || clock === null) {
    console.log('использование: npm run fixture:at -- <partN | путь к логу> <ЧЧ:ММ[:СС]>');
    return 1;
  }

  const game = readGame(ref);
  const slice = sliceLogByClock(game.text, clock);
  if (slice === null) {
    console.log(`${game.label}: в логе нет ни одной метки времени`);
    return 1;
  }

  console.log(`партия ${game.label}: ${clockText(slice.start)} … ${clockText(slice.end)}`);
  if (!slice.inGame) {
    console.log(`кадр ${clockArg ?? ''} НЕ попадает в эту партию — вероятно, он из другой (урок part49)`);
    return 2;
  }

  const cards = loadCardIndex();
  const frame = frameAt(slice);
  const { state } = frame;

  console.log(`\nдействия игрока с ${clockText(slice.frameStart)} до ${clockText(slice.frameEnd - 1)}:`);
  if (frame.actions.length === 0) console.log('  —');
  for (const t of frame.actions) console.log(actionLine(t, cards));

  console.log(`\n─── ${situationLine(state)} · ход таверны ${String(tavernTurnOf(state.turn))}`);
  console.log(`борд:    ${minions(state.board, cards)}`);
  console.log(`витрина: ${minions(state.shop, cards)}`);
  if (state.shopSpells.length > 0) console.log(`         ${spells(state.shopSpells, cards)}`);
  console.log(`рука:    ${minions(state.hand, cards)}`);
  if (state.handSpells.length > 0) console.log(`         ${spells(state.handSpells, cards)}`);
  const power = heroPowerLine(state, cards);
  if (power !== null) console.log(power);
  if (state.darkGiftCost !== null) {
    console.log(`тёмный дар: за ${String(state.darkGiftCost)}, зарядов ${String(state.darkGiftCharges ?? '?')}`);
  }

  const point = frame.decisionPoint;
  if (point !== null) {
    console.log(`\nточка решения этого хода (до первой траты): золото ${String(point.gold)}/${String(point.goldTotal)}, тир ${String(point.techLevel)}`);
    const diffs = [
      point.gold !== state.gold ? `  золото ${String(point.gold)} → ${String(state.gold)}` : null,
      point.techLevel !== state.techLevel ? `  тир ${String(point.techLevel)} → ${String(state.techLevel)}` : null,
      difference('борд', point.board, state.board, cards),
      difference('витрина', point.shop, state.shop, cards),
      difference('рука', point.hand, state.hand, cards),
    ].filter((x): x is string => x !== null);
    console.log(diffs.length === 0 ? '  кадр совпадает с точкой решения' : 'кадр отличается от неё:\n' + diffs.join('\n'));
  }

  if (state.phase !== 'tavern') {
    console.log('\nв этот момент идёт бой — советов таверны нет');
    return 0;
  }
  const advice = adviseTavern(state, { cards });
  if (advice === null) {
    console.log('\nсоветник молчит на этом состоянии');
    return 0;
  }
  // Предложение тринкетов оверлей показывает отдельной панелью поверх
  // советов, и кадр без неё врёт о том, что видел игрок (part80: выбор
  // силы Марин на ходу таверны 5 в срезе не печатался вовсе).
  if (advice.trinkets.length > 0) {
    console.log('\nвыбор тринкета на момент кадра:');
    advice.trinkets.forEach((t, i) => {
      console.log(`  ${String(i + 1)}. ${t.name} — ${t.reason}`);
    });
  }
  console.log('\nсоветы на момент кадра:');
  const plan = spendPlan(state, { cards });
  if (plan.steps.length >= 2) console.log(`  ${spendPlanLine(plan, cards)}`);
  advice.recommendations.slice(0, 5).forEach((r, i) => {
    console.log(`  ${String(i + 1)}. ${recommendationLine(r, cards)}  (${r.score.toFixed(1)})`);
    // Обоснование печатается всегда: вопрос «почему мне это советуют»
    // приходит от игрока по кадру, а в оверлее reason не виден (part37,
    // part64). Диагностике прятать его незачем.
    console.log(`     ← ${r.reason}`);
  });
  return 0;
}

process.exitCode = main();
