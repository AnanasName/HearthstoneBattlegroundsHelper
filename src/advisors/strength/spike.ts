/**
 * Замер: калибрована ли «сила стола»?
 *
 *   npm run spike:strength
 *
 * ## Зачем
 *
 * Игрок попросил (06.09): «хочу, чтобы софт писал, сильный мой стол для
 * данного хода или нет». Мерка предложена такая: доля выигранных боёв
 * нашего борда против ВСЕХ чужих бордов того же хода таверны
 * (`src/advisors/strength/strength.ts`). Печатать её процентами можно
 * только в одном случае — если проценты означают то, что на них написано.
 * Это и проверяется: у мерки есть внешняя правда, и она у нас записана —
 * чем настоящий бой этого хода кончился НА САМОМ ДЕЛЕ (`readBattleEpisodes`
 * даёт и исход, и урон).
 *
 * Замер не про «полезен ли совет», а про честность числа.
 *
 * ## Предрегистрация — объявлено ДО прогона
 *
 * **Вопрос.** Совпадает ли предсказанная сила с фактической долей побед?
 *
 * **Точки.** Все бои партий `CURRENT_BUILD_PARTS`, где у нас непустой борд
 * и в поле хода есть хотя бы `minBoards` чужих бордов ИЗ ДРУГИХ ПАРТИЙ.
 * Своя партия из поля исключается всегда: борд фактического соперника
 * этого самого боя лежит в том же логе, и мерить им себя значит спрашивать
 * ответ у ответа.
 *
 * **Мера.** Сила — как в рантайме (всё поле хода, 40 симуляций, зерно
 * фиксировано). Правда — фактический исход: победа 1, ничья 0.5,
 * поражение 0.
 *
 * **Годность.** Мерка считается калиброванной, если выполнено И то,
 * и другое:
 *
 *  - в каждой корзине по 20 п.п. фактическая доля побед отличается
 *    от середины корзины не больше чем на 15 п.п.;
 *  - доли по корзинам не убывают (монотонность).
 *
 * Контроль — наивная мерка «перцентиль СТАТОВ среди того же поля». Если
 * симулятор не опережает её по корреляции с фактом, платить за симуляции
 * нечем, и считать в рантайме надо статы.
 *
 * ## Чего этот замер НЕ докажет
 *
 * 1. Что число ПОЛЕЗНО. Оно описывает ближайший бой, а выбор «усиливаться
 *    или качаться» ближайшим боем не решается структурно (CLAUDE.md,
 *    `spike:level`): подъём таверны статов на борд не кладёт.
 * 2. Что поле честно на поздних ходах: к 13-му ходу таверны доживает
 *    горстка партий, и там мерка МОЛЧИТ по `minBoards`, а не «работает
 *    хуже».
 * 3. Что борд, снятый в БОЮ, равен борду в момент вопроса: игрок смотрит
 *    оверлей посреди хода, когда покупки ещё не сделаны, и там сила
 *    ЗАНИЖЕНА. Замер сравнивает борд боя с бордами боёв — это честно,
 *    но подача обязана называть занижение вслух.
 * 4. Что поле представляет игру вообще: это соперники ОДНОГО игрока
 *    на его рейтинге. Для вопроса «силён ли я за этим столом» это ровно
 *    та выборка, что нужна, но переносить числа на другой рейтинг нельзя.
 */
import { readBattleEpisodes } from '../battle/episodes.js';
import { createBattleSimulator } from '../battle/simulator.js';
import { toBattleInfo, type BattleSetup } from '../battle/mapper.js';
import { withSeededRandom } from '../position/rng.js';
import { CURRENT_BUILD_PARTS, readFixtureGame } from '../../data/fixtureGames.js';
import { tavernTurnOf } from '../tavern/rules.js';
import type { Minion } from '../../state/types.js';
import { boardsOfTurn, loadFieldBoards } from './boards.js';
import { DEFAULT_FIELD_STRENGTH_OPTIONS } from './strength.js';

const OPTIONS = DEFAULT_FIELD_STRENGTH_OPTIONS;

interface Point {
  readonly part: number;
  readonly tavernTurn: number;
  readonly strength: number;
  readonly naive: number;
  readonly actual: number;
}

const statsOf = (board: readonly Minion[]): number =>
  board.reduce((sum, m) => sum + (m.attack ?? 0) + (m.health ?? 0), 0);

function correlation(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 3) return Number.NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - mx;
    const dy = (ys[i] ?? 0) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

function main(): void {
  const snapshot = loadFieldBoards();
  if (snapshot === null) {
    console.log('снапшота поля нет — сначала `npm run field:fit`');
    return;
  }

  const simulator = createBattleSimulator();
  const points: Point[] = [];

  for (const part of CURRENT_BUILD_PARTS) {
    const text = readFixtureGame(part);
    if (text === null) continue;

    for (const episode of readBattleEpisodes(text)) {
      if (episode.playerBoard.length === 0) continue;
      const tavernTurn = tavernTurnOf(episode.turn);
      const field = boardsOfTurn(snapshot, tavernTurn, part);
      if (field.length < OPTIONS.minBoards) continue;

      let sum = 0;
      for (const opponent of field) {
        const setup: BattleSetup = {
          turn: episode.turn,
          playerBoard: episode.playerBoard,
          playerHand: episode.playerHand,
          opponentBoard: opponent.board,
          playerHero: episode.playerHero,
          techLevel: episode.techLevel,
          anomalyCardId: episode.anomalyCardId,
          globalInfo: episode.globalInfo,
          playerTrinketDbfIds: episode.playerTrinketDbfIds,
          opponentTrinketDbfIds: opponent.trinketDbfIds,
        };
        const info = toBattleInfo(setup, OPTIONS.simulations);
        const result = withSeededRandom(OPTIONS.seed, () =>
          simulator.run(info, OPTIONS.simulations),
        );
        sum += result.wonPercent + result.tiedPercent / 2;
      }

      const mine = statsOf(episode.playerBoard);
      const weaker = field.filter((o) => statsOf(o.board) < mine).length;
      points.push({
        part,
        tavernTurn,
        strength: sum / field.length,
        naive: (weaker / field.length) * 100,
        actual: episode.outcome === 'won' ? 1 : episode.outcome === 'tied' ? 0.5 : 0,
      });
    }
    const own = points.filter((p) => p.part === part).length;
    console.error(`part${String(part)}: точек ${String(own)}`);
  }

  const strengths = points.map((p) => p.strength);
  const naives = points.map((p) => p.naive);
  const actuals = points.map((p) => p.actual);

  console.log('');
  console.log(
    `точек ${String(points.length)} на ${String(CURRENT_BUILD_PARTS.length)} партиях, ` +
      `симуляций на борд ${String(OPTIONS.simulations)}`,
  );
  console.log(
    `корреляция с фактом: сила ${correlation(strengths, actuals).toFixed(3)} | ` +
      `перцентиль статов ${correlation(naives, actuals).toFixed(3)}`,
  );

  console.log('');
  console.log('калибровка: обещано → фактически');
  let worst = 0;
  let previous = -1;
  let monotone = true;
  for (const low of [0, 20, 40, 60, 80]) {
    const high = low + 20;
    const bucket = points.filter(
      (p) => p.strength >= low && (high === 100 ? p.strength <= 100 : p.strength < high),
    );
    if (bucket.length === 0) continue;
    const actual = (bucket.reduce((s, p) => s + p.actual, 0) / bucket.length) * 100;
    const middle = low + 10;
    const gap = Math.abs(actual - middle);
    worst = Math.max(worst, gap);
    if (actual < previous) monotone = false;
    previous = actual;
    console.log(
      `  ${String(low).padStart(3)}–${String(high).padStart(3)} % | боёв ${String(bucket.length).padStart(4)} | ` +
        `фактически ${actual.toFixed(1).padStart(5)} % | ` +
        `расхождение с серединой ${gap.toFixed(1)} п.п.`,
    );
  }

  console.log('');
  console.log(
    `худшее расхождение ${worst.toFixed(1)} п.п. (порог 15), ` +
      `монотонность ${monotone ? 'есть' : 'НАРУШЕНА'}`,
  );
  console.log(
    worst <= 15 && monotone
      ? 'ВЕРДИКТ: калибрована — проценты можно печатать как есть'
      : 'ВЕРДИКТ: НЕ калибрована — числом печатать нельзя',
  );

  console.log('');
  console.log('по ходам таверны:');
  const turns = [...new Set(points.map((p) => p.tavernTurn))].sort((a, b) => a - b);
  for (const tt of turns) {
    const bucket = points.filter((p) => p.tavernTurn === tt);
    const predicted = bucket.reduce((s, p) => s + p.strength, 0) / bucket.length;
    const actual = (bucket.reduce((s, p) => s + p.actual, 0) / bucket.length) * 100;
    console.log(
      `  ход ${String(tt).padStart(2)} | боёв ${String(bucket.length).padStart(3)} | ` +
        `обещано ${predicted.toFixed(1).padStart(5)} % | фактически ${actual.toFixed(1).padStart(5)} %`,
    );
  }
}

main();
