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
 * **Точки.** Все бои партий САМОГО ПОЛЯ (`snapshot.parts`; до 25.09 это был
 * `CURRENT_BUILD_PARTS`, с D304 — партии нынешнего пула), где у нас
 * непустой борд и в поле хода есть хотя бы `minBoards` чужих бордов
 * ИЗ ДРУГИХ ПАРТИЙ. Бои другого пула против поля нынешнего мерили бы
 * не ту игру.
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
import type { BattleSetup } from '../battle/mapper.js';
import { readFixtureGame } from '../../data/fixtureGames.js';
import { tavernTurnOf } from '../tavern/rules.js';
import { EMPTY_GLOBAL_INFO, type GlobalInfo, type Minion } from '../../state/types.js';
import { boardsOfTurn, loadFieldBoards } from './boards.js';
import { DEFAULT_FIELD_STRENGTH_OPTIONS, runFieldStrength } from './strength.js';

const OPTIONS = DEFAULT_FIELD_STRENGTH_OPTIONS;

interface Point {
  readonly part: number;
  readonly tavernTurn: number;
  readonly strength: number;
  /** Та же сила со СВОИМИ счётчиками боя, обнулёнными, как у бордов поля (D205). */
  readonly symmetric: number;
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

  for (const part of snapshot.parts) {
    const text = readFixtureGame(part);
    if (text === null) continue;

    for (const episode of readBattleEpisodes(text)) {
      if (episode.playerBoard.length === 0) continue;
      const tavernTurn = tavernTurnOf(episode.turn);
      const field = boardsOfTurn(snapshot, tavernTurn, part);
      if (field.length < OPTIONS.minBoards) continue;

      // Тот же счёт, что у рантайма (`runFieldStrength`): на этом держится
      // подпись «как в рантайме» в отчёте о симметрии ниже.
      const strengthWith = (globalInfo: GlobalInfo): number => {
        const setups = field.map(
          (opponent): BattleSetup => ({
            turn: episode.turn,
            playerBoard: episode.playerBoard,
            playerHand: episode.playerHand,
            opponentBoard: opponent.board,
            playerHero: episode.playerHero,
            techLevel: episode.techLevel,
            anomalyCardId: episode.anomalyCardId,
            globalInfo,
            playerDeity: episode.playerDeity,
            playerTrinketDbfIds: episode.playerTrinketDbfIds,
            opponentTrinketDbfIds: opponent.trinketDbfIds,
            opponentDeity: opponent.deity ?? null,
            playersAlive: episode.playersAlive,
          }),
        );
        return runFieldStrength({ tavernTurn, setups }, { simulator }, null, OPTIONS).percent;
      };
      const strength = strengthWith(episode.globalInfo);
      const differs = JSON.stringify(episode.globalInfo) !== JSON.stringify(EMPTY_GLOBAL_INFO);

      const mine = statsOf(episode.playerBoard);
      const weaker = field.filter((o) => statsOf(o.board) < mine).length;
      points.push({
        part,
        tavernTurn,
        strength,
        symmetric: differs ? strengthWith(EMPTY_GLOBAL_INFO) : strength,
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
    `точек ${String(points.length)} на ${String(snapshot.parts.length)} партиях, ` +
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

  // Симметрия счётчиков (D205, docs/next-steps.md): рантайм отдаёт
  // симулятору наши счётчики боя, а у бордов поля их нет. Тот же прогон
  // с обнулёнными своими — какой из двух честнее по факту.
  const brier = (key: 'strength' | 'symmetric', list: readonly Point[]): number =>
    list.reduce((s, p) => s + (p[key] / 100 - p.actual) ** 2, 0) / list.length;
  const touched = points.filter((p) => p.symmetric !== p.strength);
  console.log('');
  console.log(
    `симметрия счётчиков: боёв, где обнуление меняет силу, ${String(touched.length)} из ${String(points.length)}`,
  );
  console.log(
    `  Brier по всем: как в рантайме ${brier('strength', points).toFixed(4)} | ` +
      `обнулены свои ${brier('symmetric', points).toFixed(4)}`,
  );
  if (touched.length > 0) {
    const mean = (key: 'strength' | 'symmetric' | 'actual'): number =>
      touched.reduce((s, p) => s + p[key], 0) / touched.length;
    const shift = mean('strength') - mean('symmetric');
    console.log(
      `  на затронутых: Brier ${brier('strength', touched).toFixed(4)} против ` +
        `${brier('symmetric', touched).toFixed(4)}; обещано ${mean('strength').toFixed(1)} % против ` +
        `${mean('symmetric').toFixed(1)} %, фактически ${(mean('actual') * 100).toFixed(1)} %; ` +
        `сдвиг ${shift.toFixed(2)} п.п.`,
    );
    console.log(
      `  корреляция с фактом: как в рантайме ${correlation(strengths, actuals).toFixed(3)} | ` +
        `обнулены свои ${correlation(points.map((p) => p.symmetric), actuals).toFixed(3)}`,
    );
  }

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
