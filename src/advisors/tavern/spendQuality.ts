import { readBattleEpisodes } from '../battle/episodes.js';
import { toBattleInfo, withPlayerBoard, type BattleSetup } from '../battle/mapper.js';
import type { BattleSimulator } from '../battle/simulator.js';
import type { CardIndex } from '../../data/cards.js';
import type { GameState, Minion } from '../../state/types.js';
import { buyCostOf, weakestOwn, type TavernAdvisorDeps } from './advisor.js';
import { DEFAULT_TAVERN_RULES, type TavernRules } from './rules.js';
import { spendPlan } from './spend.js';
import { readTavernTurns } from './turns.js';

/**
 * Нужен ли настоящий перебор корзины трат — или довольно цепочки правил.
 *
 * План хода (`spendPlan`) — это ЖАДНАЯ цепочка: верхний совет, состояние
 * после него, снова верхний совет. Так он наследует уже проверенное
 * ранжирование и не заводит второй шкалы очков. Чего он не умеет —
 * заглядывать вперёд: «две покупки по 3» против «подъём за 7» жадность
 * решает первым шагом и назад не смотрит. Отсюда вопрос, записанный
 * в CLAUDE.md как отложенный: стоит ли строить полный оптимизатор трат.
 *
 * Здесь этот вопрос меряется. Для каждой точки решения перебираются ВСЕ
 * выполнимые наборы трат (покупки, розыгрыши из руки, подъём), каждый
 * доигрывается до борда, и борд прогоняется симулятором против того
 * противника, который ФАКТИЧЕСКИ вышел в бою следующего хода, — та же
 * мерка и та же оговорка, что у сверки покупок (`buyQuality.ts`).
 *
 * ## Что мерка видит и чего не видит
 *
 *  - **ближайший бой не видит экономику.** Подъём таверны не кладёт на борд
 *    ни одного стата, и по ближайшему бою корзина с подъёмом почти всегда
 *    проигрывает корзине с покупками. Поэтому главный итог считается внутри
 *    формы — среди наборов с тем же решением о подъёме;
 *  - **на полном борде место освобождает продажа слабейшего** — та же
 *    жертва, которую называют правила покупки. Политика одна на все наборы,
 *    поэтому сравнения она не перекашивает; без неё из замера выпадала бы
 *    вся поздняя партия, где борд полон почти всегда;
 *  - **непрозрачные действия в перебор не входят** (сила героя, дар,
 *    обновление, заклинания): что они принесут, симулятору не показать.
 *    План их использует, и в этом он богаче перебора; поэтому сравнение
 *    ведётся по той части плана, которую перебор умеет повторить;
 *  - **длина набора смешивает два вопроса.** Купленные тела дописываются
 *    в ХВОСТ борда, без поиска расстановки (та же политика, что в сверке
 *    покупок). При одной покупке это мелочь, при трёх — уже нет: набор
 *    из трёх тел судится вместе со своей случайной расстановкой, и разница
 *    с набором из одного тела наполовину про порядок, а не про выбор.
 *    Поэтому главный итог считается ВНУТРИ ФОРМЫ: план сравнивается
 *    с лучшим набором той же длины и с тем же решением о подъёме. Общий
 *    итог тоже печатается — но читать его надо с этой оговоркой.
 */

/** Один набор трат: что куплено, что разыграно, был ли подъём. */
interface Basket {
  readonly buys: readonly Minion[];
  readonly plays: readonly Minion[];
  readonly levelUp: boolean;
  /** Потрачено золота ВАЛОМ — по нему набор отбирается при переполнении предела. */
  readonly goldSpent: number;
  /**
   * Сколько золота останется — оно сгорит в конце хода.
   *
   * Считается остатком рекурсии, а не разностью «было минус потрачено»:
   * на полном борде набор начинается с продажи слабейшего, и её золото
   * тоже в кармане.
   */
  readonly goldLeft: number;
  /** Борд, с которым набор выйдет в бой. */
  readonly board: readonly Minion[];
}

export interface SpendComparison {
  readonly turn: number;
  readonly baskets: number;
  /** Ожидаемый исход набора, который советует план: победа плюс половина ничьей. */
  readonly planOutcome: number;
  /** Он же у лучшего набора по симулятору. */
  readonly bestOutcome: number;
  readonly spread: number;
  readonly agreed: boolean;
  /** Считал ли план и лучший набор подъём таверны частью хода. */
  readonly planLevelUp: boolean;
  readonly bestLevelUp: boolean;
  readonly planGoldLeft: number;
  readonly bestGoldLeft: number;
}

export interface SpendQualityReport {
  readonly rows: readonly SpendComparison[];
  /** Ходы, где разброс исходов выше порога шума. */
  readonly decisive: readonly SpendComparison[];
  /**
   * Главный итог: сравнение ВНУТРИ ФОРМЫ — среди наборов той же длины
   * и с тем же решением о подъёме. Так вопрос «те ли тела куплены»
   * отделён от вопроса «сколько тел и куда они встали».
   */
  readonly sameShapeRows: readonly SpendComparison[];
  readonly skippedNoBattle: number;
  readonly skippedNoChoice: number;
}

export interface SpendQualityOptions {
  readonly simulations: number;
  readonly decisiveSpread: number;
  /** Предел числа наборов на точку решения — страховка по времени. */
  readonly maxBaskets: number;
  readonly rules: TavernRules;
}

export const DEFAULT_SPEND_QUALITY_OPTIONS: SpendQualityOptions = {
  // Ниже, чем у сверки покупок (2000): наборов на точку в разы больше,
  // а порог «решающего» хода поднят под этот шум.
  simulations: 800,
  decisiveSpread: 5,
  maxBaskets: 48,
  rules: DEFAULT_TAVERN_RULES,
};

const outcomeScore = (won: number, tied: number): number => won + tied / 2;

/**
 * Все выполнимые наборы трат: подмножества покупок и розыгрышей плюс
 * необязательный подъём.
 *
 * Ограничения — золото и места на борде; на полном борде место освобождает
 * продажа слабейшего. Наборы, оставляющие больше золота, при переполнении
 * предела отбрасываются первыми: вопрос замера — как потратить, а не как
 * сберечь.
 */
function enumerateBaskets(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
  maxBaskets: number,
): readonly Basket[] {
  const baskets: Basket[] = [];

  // Полный борд: место освобождает продажа слабейшего — та же жертва,
  // которую называют правила покупки. Политика одна на все наборы, поэтому
  // сравнение она не перекашивает; без неё из замера выпадала бы вся поздняя
  // партия, где борд полон почти всегда.
  const full = state.board.length >= rules.boardSize;
  const victim = full ? weakestOwn(state, deps, rules) : null;
  const startBoard =
    victim === null
      ? state.board
      : state.board.filter((m) => m.entityId !== victim.minion.entityId);
  const startGold = victim === null ? state.gold : state.gold + rules.sellGold;
  const soldFor = victim === null ? 0 : rules.sellGold;

  const slots = rules.boardSize - startBoard.length;
  const upgrade = state.tavernUpgradeCost;

  const shop = [...state.shop];
  const hand = [...state.hand];

  const walk = (
    i: number,
    chosenBuys: Minion[],
    chosenPlays: Minion[],
    gold: number,
    levelUp: boolean,
  ): void => {
    const bodies = chosenBuys.length + chosenPlays.length;
    // Продажа без покупки — размен в убыток: пустой набор считается по
    // ИСХОДНОМУ борду, без жертвы.
    if (bodies <= slots && (victim === null || bodies > 0)) {
      baskets.push({
        buys: [...chosenBuys],
        plays: [...chosenPlays],
        levelUp,
        goldSpent: state.gold - gold + soldFor,
        goldLeft: gold,
        board: [...startBoard, ...chosenPlays, ...chosenBuys],
      });
    }
    if (bodies >= slots) return;

    for (let j = i; j < shop.length + hand.length; j += 1) {
      const fromShop = j < shop.length;
      const minion = fromShop ? shop[j] : hand[j - shop.length];
      if (minion === undefined) continue;

      const cost = fromShop ? buyCostOf(minion, rules) : 0;
      if (cost > gold) continue;

      if (fromShop) chosenBuys.push(minion);
      else chosenPlays.push(minion);
      walk(j + 1, chosenBuys, chosenPlays, gold - cost, levelUp);
      if (fromShop) chosenBuys.pop();
      else chosenPlays.pop();
    }
  };

  walk(0, [], [], startGold, false);
  if (upgrade !== null && upgrade <= startGold) {
    walk(0, [], [], startGold - upgrade, true);
  }
  // Ничего не делать — всегда законный набор, и считается он по исходному
  // борду: продавать без покупки незачем.
  baskets.push({
    buys: [],
    plays: [],
    levelUp: false,
    goldSpent: 0,
    goldLeft: state.gold,
    board: state.board,
  });

  // Уникализация по составу борда: две копии одной карты дают один и тот же
  // борд, и считать их дважды значит платить симулятором за пустое.
  const seen = new Set<string>();
  const unique = baskets.filter((b) => {
    const key =
      (b.levelUp ? 'L|' : '') + b.board.map((m) => `${m.cardId}:${String(m.entityId)}`).join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length <= maxBaskets) return unique;
  return [...unique].sort((a, b) => b.goldSpent - a.goldSpent).slice(0, maxBaskets);
}

/**
 * Что план делает с ходом — в терминах, сравнимых с перебором.
 *
 * Борд берётся ФАКТИЧЕСКИЙ, из состояния после последнего шага, а не
 * восстанавливается по списку покупок. Восстановление врало бы в двух
 * случаях: магнитный мех слота не занимает (уходит на носителя), а покупка
 * на полный борд ложится в руку. В обоих набор «те же карты» дал бы борд,
 * которого у плана нет, и замер судил бы план по чужой расстановке.
 */
function planOutcomeOf(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): {
  readonly board: readonly Minion[];
  readonly levelUp: boolean;
  readonly goldLeft: number;
  /**
   * План потратил золото на то, чего перебор не умеет: силу героя, дар,
   * заклинание, обновление. Такие точки в сравнение не идут — иначе плану
   * засчитывается трата, борда не меняющая, а на деле сила героя приносит
   * тело, которого симулятор в этом сравнении не увидит.
   */
  readonly opaque: boolean;
} {
  const plan = spendPlan(state, deps, rules);
  const last = plan.steps.at(-1);
  return {
    board: last === undefined ? state.board : last.stateAfter.board,
    levelUp: plan.steps.some((s) => s.recommendation.action === 'levelUp'),
    goldLeft: plan.goldLeft,
    opaque: plan.steps.some((s) => s.opaque),
  };
}

export function measureSpendQuality(
  text: string,
  deps: { readonly cards: CardIndex; readonly simulator: BattleSimulator },
  overrides: Partial<SpendQualityOptions> = {},
): SpendQualityReport {
  const options = { ...DEFAULT_SPEND_QUALITY_OPTIONS, ...overrides };
  const rules = options.rules;
  const actualOpponents = new Map(readBattleEpisodes(text).map((e) => [e.turn, e.opponentBoard]));

  const rows: SpendComparison[] = [];
  const sameShapeRows: SpendComparison[] = [];
  let skippedNoBattle = 0;
  let skippedNoChoice = 0;

  for (const { state } of readTavernTurns(text)) {
    if (state.hero === null) continue;

    const opponentBoard = actualOpponents.get(state.turn + 1);
    if (opponentBoard === undefined || opponentBoard.length === 0) {
      skippedNoBattle += 1;
      continue;
    }

    const baskets = enumerateBaskets(state, deps, rules, options.maxBaskets);
    if (baskets.length < 2) {
      skippedNoChoice += 1;
      continue;
    }

    const setup: BattleSetup = {
      turn: state.turn,
      playerBoard: state.board,
      opponentBoard,
      playerHero: state.hero,
      techLevel: state.techLevel,
      anomalyCardId: state.anomalyCardId,
      globalInfo: state.globalInfo,
      playerTrinketDbfIds:
        state.playerId === null ? [] : (state.trinketsByPlayer[state.playerId] ?? []),
      opponentTrinketDbfIds:
        state.nextOpponentPlayerId === null
          ? []
          : (state.trinketsByPlayer[state.nextOpponentPlayerId] ?? []),
    };
    const base = toBattleInfo(setup, 1);

    const measured = baskets.map((basket) => {
      const result = deps.simulator.run(withPlayerBoard(base, basket.board), options.simulations);
      return { basket, outcome: outcomeScore(result.wonPercent, result.tiedPercent) };
    });

    const plan = planOutcomeOf(state, deps, rules);
    // План воспользовался действием, которого в переборе нет: сравнивать
    // нечего, точка честно пропускается.
    if (plan.opaque) {
      skippedNoChoice += 1;
      continue;
    }

    // Борд плана считается САМ, а не ищется среди наборов: так замер
    // не зависит от того, попал ли ровно такой набор в перебор, и не может
    // подменить план набором с другим бордом.
    const planResult = deps.simulator.run(
      withPlayerBoard(base, plan.board),
      options.simulations,
    );
    const planOutcome = outcomeScore(planResult.wonPercent, planResult.tiedPercent);

    const best = measured.reduce((a, b) => (b.outcome > a.outcome ? b : a));
    const outcomes = measured.map((m) => m.outcome);
    const row: SpendComparison = {
      turn: state.turn,
      baskets: measured.length,
      planOutcome,
      bestOutcome: best.outcome,
      spread: Math.max(...outcomes) - Math.min(...outcomes),
      agreed: planOutcome >= best.outcome - 1e-9,
      planLevelUp: plan.levelUp,
      bestLevelUp: best.basket.levelUp,
      planGoldLeft: plan.goldLeft,
      bestGoldLeft: best.basket.goldLeft,
    };
    rows.push(row);

    // Тот же ход внутри формы: столько же тел на борде и то же решение
    // о подъёме. Разница длин смешала бы выбор карт с расстановкой,
    // а разница по подъёму — с экономикой, которой ближайший бой не видит.
    const shape = measured.filter(
      (m) => m.basket.levelUp === plan.levelUp && m.basket.board.length === plan.board.length,
    );
    if (shape.length >= 2) {
      const shapeBest = shape.reduce((a, b) => (b.outcome > a.outcome ? b : a));
      const shapeOutcomes = shape.map((m) => m.outcome);
      sameShapeRows.push({
        ...row,
        baskets: shape.length,
        bestOutcome: shapeBest.outcome,
        spread: Math.max(...shapeOutcomes) - Math.min(...shapeOutcomes),
        agreed: planOutcome >= shapeBest.outcome - 1e-9,
        bestLevelUp: plan.levelUp,
        bestGoldLeft: shapeBest.basket.goldLeft,
      });
    }
  }

  return {
    rows,
    decisive: rows.filter((r) => r.spread > options.decisiveSpread),
    sameShapeRows,
    skippedNoBattle,
    skippedNoChoice,
  };
}

/** Доля ходов, где план совпал с лучшим набором по бою. */
export function spendAgreement(rows: readonly SpendComparison[]): number {
  if (rows.length === 0) return 0;
  return rows.filter((r) => r.agreed).length / rows.length;
}

/** Средняя цена расхождения в пунктах ожидаемого исхода. */
export function spendCost(rows: readonly SpendComparison[]): number {
  if (rows.length === 0) return 0;
  return rows.reduce((sum, r) => sum + (r.bestOutcome - r.planOutcome), 0) / rows.length;
}

/** Среднее золото, оставшееся неистраченным, — оно сгорает в конце хода. */
export function averageGoldLeft(
  rows: readonly SpendComparison[],
  pick: (r: SpendComparison) => number,
): number {
  if (rows.length === 0) return 0;
  return rows.reduce((sum, r) => sum + pick(r), 0) / rows.length;
}
