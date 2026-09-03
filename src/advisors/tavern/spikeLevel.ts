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
 *
 * ## Согласие с ИГРОКОМ по подъёму (добавлено 03.09.2026, part37)
 *
 * Вопрос, ради которого секция появилась: на ходу 9 part37 при семи
 * золотых игрок поднял таверну на тир 4, а план советовал три покупки
 * (заклинание за 2 и два тела по 3). Кто прав, ближайшим боем НЕ
 * проверяется: подъём не кладёт на борд ни одного стата, и мерка
 * `validate:spend` системно против него — это записано в шапке
 * `spendQuality.ts` и видно в её же выводе. Мерки с горизонтом
 * в несколько ходов у нас нет вовсе (контрфакта из лога не достать).
 *
 * Поэтому меряется то, что измеримо без мерки исхода: **насколько часто
 * и в какую сторону план расходится с человеком**. Это описательный
 * замер, а не вердикт: он не говорит, кто прав, — он говорит, есть ли
 * систематическое расхождение и где оно живёт. Считаются четыре клетки
 * (план поднимается / игрок поднялся) плюс разбивка расхождений
 * по ходу таверны, и всё это только на точках, где подъём БЫЛ ПО КАРМАНУ
 * — иначе клетка «план не поднялся» набивается ходами, где выбора и не
 * было.
 *
 * «Игрок поднялся» читается из журнала действий партии (`actions`,
 * тип `levelUp`) по номеру хода, и в двух видах: подъём ГДЕ-НИБУДЬ
 * в ходу и подъём ПЕРВЫМ тратящим действием. Первый вид честнее
 * отвечает на вопрос «поднялся ли», второй сравним с планом, который
 * ход начинает.
 */
import { loadCardIndex } from '../../data/cards.js';
import { reduceLog } from '../../state/reducer.js';
import type { GameState, PlayerAction } from '../../state/types.js';
import { adviseTavern } from './advisor.js';
import { tavernTurnOf } from './rules.js';
import { spendPlan } from './spend.js';
import { readTavernTurns } from './turns.js';
import { CURRENT_BUILD_PARTS, readFixtureGame } from '../../data/fixtureGames.js';

/** Партии текущего билда 248348 — те же, на которых считается качество советов. */
const PARTS = CURRENT_BUILD_PARTS;

/** Одна точка решения, где подъём был по карману: что решили план и человек. */
interface LevelChoice {
  readonly part: number;
  readonly turn: number;
  /** Ход ТАВЕРНЫ — в этой шкале живёт кривая (`rules.levelling`). */
  readonly tavernTurn: number;
  readonly techLevel: number;
  readonly gold: number;
  readonly cost: number;
  /** Числит ли советник игрока отстающим от кривой в этой точке. */
  readonly behind: boolean;
  /** Есть ли подъём в плане хода и стоит ли он первым шагом. */
  readonly planLevels: boolean;
  readonly planFirst: boolean;
  /** Поднялся ли игрок в этом ходу — где угодно и первым тратящим действием. */
  readonly playerLevels: boolean;
  readonly playerFirst: boolean;
}

interface PartResult {
  readonly part: number;
  readonly turns: number;
  readonly behind: number;
  readonly levelFirst: readonly number[];
  readonly choices: readonly LevelChoice[];
}

/** Тратит ли действие золото — по нему ищется ПЕРВЫЙ ход игрока. */
function spendsGold(action: PlayerAction): boolean {
  return (
    action.type === 'buy' ||
    action.type === 'levelUp' ||
    action.type === 'roll' ||
    action.type === 'freeze' ||
    action.type === 'darkGift' ||
    action.type === 'heroPower' ||
    action.type === 'activate'
  );
}

function measurePart(part: number, cards: ReturnType<typeof loadCardIndex>): PartResult | null {
  const text = readFixtureGame(part);
  if (text === null) return null;

  // Журнал действий партии целиком: точка решения снята ДО хода игрока,
  // и его собственный подъём в её `actions` ещё не записан.
  const final: GameState = reduceLog(text);

  let turns = 0;
  let behind = 0;
  const levelFirst: number[] = [];
  const choices: LevelChoice[] = [];
  for (const { state } of readTavernTurns(text)) {
    const advice = adviseTavern(state, { cards });
    if (advice === null) continue;
    turns += 1;
    const isBehind = advice.targetTier > state.techLevel;
    if (isBehind) behind += 1;
    if (advice.recommendations[0]?.action === 'levelUp') levelFirst.push(state.turn);

    // Клетки считаются только там, где подъём был по карману: иначе
    // «план не поднялся» — это не решение, а отсутствие выбора.
    const cost = state.tavernUpgradeCost;
    if (cost === null || cost > state.gold) continue;

    const plan = spendPlan(state, { cards });
    const turnActions = final.actions.filter((a) => a.turn === state.turn);
    const firstSpend = turnActions.find(spendsGold);
    choices.push({
      part,
      turn: state.turn,
      tavernTurn: tavernTurnOf(state.turn),
      techLevel: state.techLevel,
      gold: state.gold,
      cost,
      behind: isBehind,
      planLevels: plan.steps.some((s) => s.recommendation.action === 'levelUp'),
      planFirst: plan.steps[0]?.recommendation.action === 'levelUp',
      playerLevels: turnActions.some((a) => a.type === 'levelUp'),
      playerFirst: firstSpend?.type === 'levelUp',
    });
  }
  return { part, turns, behind, levelFirst, choices };
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

  reportAgreement(results.flatMap((r) => r.choices));
}

/**
 * Согласие плана с человеком по подъёму — четыре клетки и разбор
 * расхождений. Вердиктов не выносит: мерки исхода у подъёма нет.
 */
function reportAgreement(choices: readonly LevelChoice[]): void {
  if (choices.length === 0) return;

  const share = (n: number): string => `${((n / choices.length) * 100).toFixed(0)}%`;
  const cell = (plan: boolean, player: boolean): LevelChoice[] =>
    choices.filter((c) => c.planLevels === plan && c.playerLevels === player);

  const both = cell(true, true);
  const planOnly = cell(true, false);
  const playerOnly = cell(false, true);
  const neither = cell(false, false);

  console.log(`\n═══ согласие с игроком по подъёму ═══`);
  console.log(`  точек, где подъём был по карману: ${String(choices.length)}`);
  console.log(`  оба поднимаются:        ${String(both.length).padStart(3)} (${share(both.length)})`);
  console.log(`  только план:            ${String(planOnly.length).padStart(3)} (${share(planOnly.length)})`);
  console.log(`  только игрок:           ${String(playerOnly.length).padStart(3)} (${share(playerOnly.length)})`);
  console.log(`  никто:                  ${String(neither.length).padStart(3)} (${share(neither.length)})`);
  const agreed = both.length + neither.length;
  console.log(`  согласие:               ${String(agreed)} (${share(agreed)})`);

  // То же по ПЕРВОМУ действию хода: план ход начинает, и сравнивать его
  // с «игрок поднялся когда-нибудь в ходу» — сравнивать разные вопросы.
  const firstAgreed = choices.filter((c) => c.planFirst === c.playerFirst).length;
  console.log(
    `  по первому действию хода: согласие ${String(firstAgreed)} (${share(firstAgreed)});` +
      ` план первым ${String(choices.filter((c) => c.planFirst).length)},` +
      ` игрок первым ${String(choices.filter((c) => c.playerFirst).length)}`,
  );

  const byTavernTurn = new Map<number, { player: number; plan: number; total: number }>();
  for (const c of choices) {
    const row = byTavernTurn.get(c.tavernTurn) ?? { player: 0, plan: 0, total: 0 };
    row.total += 1;
    if (c.playerLevels) row.player += 1;
    if (c.planLevels) row.plan += 1;
    byTavernTurn.set(c.tavernTurn, row);
  }
  console.log('\n  по ходам таверны (точек / поднялся игрок / поднимается план):');
  for (const [tavernTurn, row] of [...byTavernTurn].sort((a, b) => a[0] - b[0])) {
    console.log(
      `    ход ${String(tavernTurn).padStart(2)}: ${String(row.total).padStart(3)}` +
        ` / ${String(row.player).padStart(3)} / ${String(row.plan).padStart(3)}`,
    );
  }

  // Клетка «только игрок» — та самая жалоба part37: игрок поднялся,
  // план потратил золото иначе. Её и печатаем поимённо.
  console.log('\n  «только игрок» — где план не поднялся, а человек поднял:');
  for (const c of playerOnly) {
    console.log(
      `    part${String(c.part).padEnd(3)} ход ${String(c.turn).padStart(2)}` +
        ` (таверны ${String(c.tavernTurn)})  тир ${String(c.techLevel)}` +
        `  золото ${String(c.gold)}  подъём за ${String(c.cost)}` +
        (c.behind ? '  (советник числит отставание)' : ''),
    );
  }
}

main();
