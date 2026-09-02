/**
 * Замер: как часто советник числит игрока отстающим от кривой подъёма
 * и как часто подъём выходит верхним советом.
 *
 *   npm run spike:level
 *
 * ## Зачем
 *
 * Жалоба игрока после part20 (17.08.2026): «очень часто советует улучшить
 * таверну». Такую жалобу нельзя проверить на одном скриншоте — «часто»
 * это число, а не впечатление, и мерить его надо по всем партиям сразу.
 *
 * Замер и нашёл причину. Таблица кривой (`rules.levelling`) написана
 * в ходах ТАВЕРНЫ («тир 6 к одиннадцатому ходу»), а сравнивалась с сырым
 * `GameState.turn`, который растёт и на переходе в бой. Ход таверны N —
 * это `turn = 2N − 1`, то есть кривая шла вдвое быстрее партии:
 *
 *  - до правки: отставание в 87% точек решения, подъём первым в 50%;
 *  - после (`tavernTurnOf` в `targetTier`): 45% и 30%.
 *
 * Числа печатаются по партиям, чтобы видеть не только сумму: если правило
 * снова уедет, разъедется весь столбец, а не одна партия.
 *
 * ## Чего замер НЕ говорит
 *
 * Он не говорит, какая частота правильная: «сколько раз за партию надо
 * подниматься» — вопрос стратегии, а не наших данных. Он показывает
 * согласие советника с САМОЙ КРИВОЙ, которую мы объявили правилом:
 * когда кривая требует тира, недостижимого по золоту этого хода,
 * отставание становится постоянным фоном и подъём вытесняет покупки.
 * Качество самих покупок мерит `npm run validate:tavern`, план хода —
 * `npm run validate:spend`.
 */
import { loadCardIndex } from '../../data/cards.js';
import { adviseTavern } from './advisor.js';
import { tavernTurnOf } from './rules.js';
import { readTavernTurns } from './turns.js';
import { CURRENT_BUILD_PARTS, readFixtureGame } from '../../data/fixtureGames.js';

/** Партии текущего билда 248348 — те же, на которых считается качество советов. */
const PARTS = CURRENT_BUILD_PARTS;

interface PartResult {
  readonly part: number;
  readonly turns: number;
  readonly behind: number;
  readonly levelFirst: readonly number[];
}

function measurePart(part: number, cards: ReturnType<typeof loadCardIndex>): PartResult | null {
  const text = readFixtureGame(part);
  if (text === null) return null;

  let turns = 0;
  let behind = 0;
  const levelFirst: number[] = [];
  for (const { state } of readTavernTurns(text)) {
    const advice = adviseTavern(state, { cards });
    if (advice === null) continue;
    turns += 1;
    if (advice.targetTier > state.techLevel) behind += 1;
    if (advice.recommendations[0]?.action === 'levelUp') levelFirst.push(state.turn);
  }
  return { part, turns, behind, levelFirst };
}

function main(): void {
  const cards = loadCardIndex();
  console.log(`справочник: ${cards.size.toLocaleString('ru-RU')} карт`);

  const results: PartResult[] = [];
  for (const part of PARTS) {
    const result = measurePart(part, cards);
    if (result === null) continue;
    results.push(result);

    const tavernTurns = result.levelFirst.map((t) => `${String(tavernTurnOf(t))}`).join(',');
    console.log(
      `part${String(result.part).padEnd(2)} точек ${String(result.turns).padStart(2)}` +
        `  отстаёт ${String(result.behind).padStart(2)}` +
        `  подъём первым ${String(result.levelFirst.length).padStart(2)}` +
        (result.levelFirst.length > 0 ? `  на ходах таверны ${tavernTurns}` : ''),
    );
  }

  const turns = results.reduce((n, r) => n + r.turns, 0);
  const behind = results.reduce((n, r) => n + r.behind, 0);
  const levelFirst = results.reduce((n, r) => n + r.levelFirst.length, 0);
  if (turns === 0) {
    console.log('фикстур не нашлось');
    return;
  }

  const pct = (n: number): string => `${((n / turns) * 100).toFixed(0)}%`;
  console.log(
    `\nвсего точек решения ${String(turns)} в ${String(results.length)} партиях:` +
      ` отставание в ${String(behind)} (${pct(behind)}),` +
      ` подъём верхним советом в ${String(levelFirst)} (${pct(levelFirst)})`,
  );
  console.log('до правки шкалы ходов (17.08.2026) было 87% и 50%');
}

main();
