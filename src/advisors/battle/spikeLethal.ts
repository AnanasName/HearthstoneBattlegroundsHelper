/**
 * Замер: означает ли «смерть в X %» то, что на нём написано?
 *
 *   npm run spike:lethal
 *   npm run spike:lethal -- --parts=4-12      подмножество, для проверки правки
 *   npm run spike:lethal -- --skip-field      только бои с фактическим соперником
 *
 * ## Зачем
 *
 * Доля выигранных боёв на экране уже есть и калибрована (`spike:strength`),
 * но на вопрос «доживу ли я до следующего хода» она не отвечает: проиграть
 * бой и вылететь из партии — разные события, и различает их запас здоровья.
 * Цена поражения рядом с числом — это СРЕДНЕЕ по проигранным боям, а смерть
 * решает правый хвост урона.
 *
 * Симулятор это событие считает сам (`lostLethal`: полученный урон ≥ `hpLeft`,
 * а `hpLeft` мы передаём здоровьем с бронёй). Печатать его процентами можно
 * только в одном случае — если проценты означают написанное. Внешняя правда
 * у нас записана: `readBattleEpisodes` даёт и фактический урон боя, и запас
 * здоровья перед ним, то есть факт «игрок здесь умер» читается из лога.
 *
 * Замер не про «полезно ли число», а про его честность.
 *
 * ## Предрегистрация — объявлено ДО прогона
 *
 * **Вопрос.** Совпадает ли предсказанная вероятность смерти с фактической
 * долей смертей, и не смещён ли предсказанный урон, из которого она выходит?
 *
 * **Точки.** Все бои партий `CURRENT_BUILD_PARTS`, где известен запас
 * здоровья перед боем. Факт: `урон боя ≥ запаса`, то есть ровно то условие,
 * по которому симулятор считает `lostLethal`.
 *
 * **Две меры, потому что на экран идут два разных числа.**
 *
 *  1. *Против фактического соперника* — так считается строка расстановки,
 *     когда следующий противник известен. Прогон боя как в `calibrate`.
 *  2. *Против поля хода* — так считается блок силы и строка риска подъёма,
 *     то есть большую часть партии. Прогон как в рантайме
 *     (`runFieldStrength`, всё поле хода, 40 симуляций, зерно фиксировано),
 *     своя партия из поля исключена: борд фактического соперника лежит
 *     в том же логе, и мерить им себя значит спрашивать ответ у ответа.
 *
 * **Годность.** Число печатаем, если выполнено ВСЁ:
 *
 *  - в каждой корзине предсказанной смерти (0–5, 5–20, 20–50, 50–100 %)
 *    фактическая доля смертей отличается от СРЕДНЕГО предсказания корзины
 *    не больше чем на 15 п.п. Порог взят у `spike:strength` — тот же экран,
 *    та же цена ошибки. Середина корзины вместо среднего здесь не годится:
 *    корзины неравной ширины, и у крайней «0–5 %» середина ничего
 *    не описывает;
 *  - доли по корзинам не убывают (монотонность);
 *  - смещение предсказанного урона не больше 2 hp по модулю. Два очка —
 *    четверть типичной цены поражения (7.5 hp на шестом ходу таверны),
 *    и это тот сдвиг, который на низком запасе переносит бой из «умираю»
 *    в «выживаю».
 *
 * **Проверка самой правды, тоже до прогона.** Смерть в партии одна и
 * последняя, поэтому найденных смертей должно быть примерно столько же,
 * сколько партий (все, кроме занявших первое место), и стоять они должны
 * на ПОСЛЕДНЕМ бою партии. Если это не так — сломано чтение факта,
 * и остальные числа замера читать нельзя.
 *
 * ## Чего этот замер НЕ докажет
 *
 * 1. Что число полезно: оно про ближайший бой, как и все наши мерки боем.
 * 2. Что редкие корзины надёжны: смертей на партию одна, и корзина
 *    «50–100 %» будет тонкой — её вердикт читать вместе с её размером.
 * 3. Что поле представляет игру вообще: это соперники ОДНОГО игрока
 *    на его рейтинге (та же граница, что у `spike:strength`).
 */
import { partsArg, seedArg } from '../../measure/args.js';
import { emitResult, round } from '../../measure/result.js';
import { CURRENT_BUILD_PARTS, readFixtureGame } from '../../data/fixtureGames.js';
import { deathRate, toEstimate } from '../position/score.js';
import { boardsOfTurn, loadFieldBoards } from '../strength/boards.js';
import { DEFAULT_FIELD_STRENGTH_OPTIONS, runFieldStrength } from '../strength/strength.js';
import { tavernTurnOf } from '../tavern/rules.js';
import type { BattleSetup } from './mapper.js';
import { readBattleEpisodes } from './episodes.js';
import { toBattleInfo } from './mapper.js';
import { seededSimulator } from './seeded.js';
import { createBattleSimulator } from './simulator.js';

/** Симуляций на бой в прогоне против фактического соперника. */
const SIMULATIONS = 1000;

const FIELD_OPTIONS = DEFAULT_FIELD_STRENGTH_OPTIONS;

interface Point {
  readonly part: number;
  readonly turn: number;
  readonly tavernTurn: number;
  /** Запас здоровья с бронёй перед боем — то же, что уходит в `hpLeft`. */
  readonly hp: number;
  /** Предсказанная вероятность смерти против фактического соперника, 0..1. */
  readonly predicted: number;
  /** Она же против поля хода, или `null` — поле узко или прогон пропущен. */
  readonly field: number | null;
  /** Ожидаемый полученный урон за бой: сумма по поражениям на все симуляции. */
  readonly predictedDamage: number;
  readonly actualDamage: number;
  readonly died: boolean;
  /** Последний ли это бой партии — для проверки самой правды. */
  readonly last: boolean;
}

interface Bucket {
  readonly low: number;
  readonly high: number;
}

const BUCKETS: readonly Bucket[] = [
  { low: 0, high: 5 },
  { low: 5, high: 20 },
  { low: 20, high: 50 },
  { low: 50, high: 100 },
];

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;

function collect(parts: readonly number[], seed: number, skipField: boolean): Point[] {
  const simulator = seededSimulator(createBattleSimulator(), seed);
  const snapshot = skipField ? null : loadFieldBoards();
  if (!skipField && snapshot === null) {
    console.error('снапшота поля нет — прогон против поля пропущен (`npm run field:fit`)');
  }

  const points: Point[] = [];

  for (const part of parts) {
    const text = readFixtureGame(part);
    if (text === null) continue;

    const episodes = readBattleEpisodes(text);
    for (const [index, episode] of episodes.entries()) {
      const hero = episode.playerHero;
      const hp = (hero.health ?? 0) - hero.damage + hero.armor;
      // Без запаса здоровья условие смерти не определено вовсе, а симулятор
      // при `hpLeft = 0` не считает `lostLethal` по построению.
      if (hp <= 0) continue;

      const result = simulator.run(toBattleInfo(episode, SIMULATIONS), SIMULATIONS);
      const estimate = toEstimate(result);
      if (estimate.sims === 0) continue;

      const tavernTurn = tavernTurnOf(episode.turn);
      let field: number | null = null;
      if (snapshot !== null && episode.playerBoard.length > 0) {
        const boards = boardsOfTurn(snapshot, tavernTurn, part);
        if (boards.length >= FIELD_OPTIONS.minBoards) {
          const setups = boards.map(
            (opponent): BattleSetup => ({
              turn: episode.turn,
              playerBoard: episode.playerBoard,
              playerHand: episode.playerHand,
              opponentBoard: opponent.board,
              playerHero: hero,
              techLevel: episode.techLevel,
              anomalyCardId: episode.anomalyCardId,
              globalInfo: episode.globalInfo,
              playerTrinketDbfIds: episode.playerTrinketDbfIds,
              opponentTrinketDbfIds: opponent.trinketDbfIds,
            }),
          );
          field =
            runFieldStrength({ tavernTurn, setups }, { simulator }, null, FIELD_OPTIONS)
              .deathPercent / 100;
        }
      }

      points.push({
        part,
        turn: episode.turn,
        tavernTurn,
        hp,
        predicted: deathRate(estimate),
        field,
        predictedDamage: estimate.damageLost / estimate.sims,
        actualDamage: episode.damageTaken,
        died: episode.damageTaken >= hp,
        last: index === episodes.length - 1,
      });
    }

    const own = points.filter((p) => p.part === part);
    console.error(
      `part${String(part)}: боёв ${String(own.length)}, смертей ${String(own.filter((p) => p.died).length)}`,
    );
  }

  return points;
}

/**
 * Калибровка по корзинам: обещано → фактически.
 *
 * Возвращает худшее расхождение и монотонность — то, из чего складывается
 * вердикт. Печать здесь же, потому что читать таблицу глазами нужно в обоих
 * прогонах одинаково.
 */
function calibration(
  title: string,
  points: readonly { predicted: number; died: boolean }[],
): { worst: number; monotone: boolean } {
  console.log('');
  console.log(`${title}: обещано → фактически`);
  let worst = 0;
  let previous = -1;
  let monotone = true;

  for (const { low, high } of BUCKETS) {
    const bucket = points.filter(
      (p) => p.predicted * 100 >= low && (high === 100 ? p.predicted * 100 <= 100 : p.predicted * 100 < high),
    );
    if (bucket.length === 0) continue;
    const promised = mean(bucket.map((p) => p.predicted)) * 100;
    const actual = (bucket.filter((p) => p.died).length / bucket.length) * 100;
    const gap = Math.abs(actual - promised);
    worst = Math.max(worst, gap);
    if (actual < previous) monotone = false;
    previous = actual;
    console.log(
      `  ${String(low).padStart(3)}–${String(high).padStart(3)} % | боёв ${String(bucket.length).padStart(4)} | ` +
        `смертей ${String(bucket.filter((p) => p.died).length).padStart(3)} | ` +
        `обещано ${promised.toFixed(1).padStart(5)} % | фактически ${actual.toFixed(1).padStart(5)} % | ` +
        `расхождение ${gap.toFixed(1)} п.п.`,
    );
  }

  return { worst, monotone };
}

function summarize(points: readonly Point[], parts: readonly number[], seed: number): void {
  if (points.length === 0) {
    console.log('боёв не найдено');
    return;
  }

  const deaths = points.filter((p) => p.died);
  const misplaced = deaths.filter((p) => !p.last);

  console.log('');
  console.log(
    `боёв ${String(points.length)} на ${String(parts.length)} партиях, ` +
      `симуляций на бой ${String(SIMULATIONS)}, зерно ${String(seed)}`,
  );
  console.log(
    `правда: смертей ${String(deaths.length)} при ${String(parts.length)} партиях; ` +
      `не на последнем бою партии ${String(misplaced.length)}`,
  );
  for (const p of misplaced) {
    console.log(`  part${String(p.part)} ход ${String(p.turn)}: урон ${String(p.actualDamage)} при hp ${String(p.hp)}`);
  }

  // ── смерть против фактического соперника ─────────────────────────────────
  const direct = calibration('против фактического соперника', points);
  const brier =
    points.reduce((s, p) => s + (p.predicted - (p.died ? 1 : 0)) ** 2, 0) / points.length;
  console.log(
    `  Brier ${brier.toFixed(4)}; обещано в среднем ${(mean(points.map((p) => p.predicted)) * 100).toFixed(1)} %, ` +
      `фактически ${((deaths.length / points.length) * 100).toFixed(1)} %`,
  );

  // ── смерть против поля хода ──────────────────────────────────────────────
  const withField = points.filter(
    (p): p is Point & { field: number } => p.field !== null,
  );
  const fieldCalibration =
    withField.length === 0
      ? null
      : calibration(
          'против поля хода (то, что печатается)',
          withField.map((p) => ({ predicted: p.field, died: p.died })),
        );

  // ── смещение урона ───────────────────────────────────────────────────────
  const damageBias = mean(points.map((p) => p.predictedDamage - p.actualDamage));
  const damageMae = mean(points.map((p) => Math.abs(p.predictedDamage - p.actualDamage)));
  console.log('');
  console.log(
    `урон: предсказано в среднем ${mean(points.map((p) => p.predictedDamage)).toFixed(2)} hp, ` +
      `фактически ${mean(points.map((p) => p.actualDamage)).toFixed(2)} hp; ` +
      `смещение ${damageBias >= 0 ? '+' : ''}${damageBias.toFixed(2)} hp (порог 2), MAE ${damageMae.toFixed(2)}`,
  );

  const passed =
    direct.worst <= 15 &&
    direct.monotone &&
    Math.abs(damageBias) <= 2 &&
    (fieldCalibration === null || (fieldCalibration.worst <= 15 && fieldCalibration.monotone));

  console.log('');
  console.log(
    passed
      ? 'ВЕРДИКТ: калибрована — процент смерти можно печатать как есть'
      : 'ВЕРДИКТ: НЕ калибрована — числом печатать нельзя',
  );

  emitResult({
    seed,
    parts,
    metrics: {
      battles: points.length,
      deaths: deaths.length,
      deathsNotLast: misplaced.length,
      worstGapPp: round(direct.worst, 1),
      monotone: direct.monotone ? 1 : 0,
      brier: round(brier, 4),
      fieldBattles: withField.length,
      fieldWorstGapPp: fieldCalibration === null ? null : round(fieldCalibration.worst, 1),
      fieldMonotone: fieldCalibration === null ? null : fieldCalibration.monotone ? 1 : 0,
      damageBiasHp: round(damageBias, 2),
      damageMaeHp: round(damageMae, 2),
      passed: passed ? 1 : 0,
    },
  });
}

function main(): void {
  const seed = seedArg(process.argv);
  const parts = partsArg(process.argv, CURRENT_BUILD_PARTS);
  const skipField = process.argv.includes('--skip-field');
  summarize(collect(parts, seed, skipField), parts, seed);
}

main();
