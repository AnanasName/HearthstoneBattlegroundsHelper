/**
 * Арена выбирающих: чей ход лучше — игрока, советника или модели.
 *
 * Запрос игрока (02.09): «модель предсказывает только место — сделай, чтобы
 * предсказывала ходы, при этом ЛУЧШЕ ИГРОКА». Первое, чего для этого не
 * хватало, — мерки: до сих пор ход игрока не мерился ничем. Замер 2 (имитация
 * покупок) мерил ПОХОЖЕСТЬ на игрока, а не качество его хода, и потолок такой
 * модели — сыграть как он. Здесь мерка другая: ожидаемый исход ближайшего боя,
 * тот же, что у `buyQuality`, — и через неё проходят все выбирающие сразу.
 *
 * ## Почему только ПЕРВАЯ покупка хода
 *
 * Точка решения снимается ПЕРЕД действием, которое тратит золото (`turns.ts`).
 * Значит контрфакт «а если бы вместо этого купили другого» верен только для
 * ПЕРВОГО тратящего действия: после подъёма таверны, силы героя или платного
 * обновления состояние уже не то, которое в точке записано, и подставлять
 * в него кандидата — значит мерить чужой ход. Замер этого стоит дорого:
 * из 395 точек решения 32 партий первым тратящим действием была покупка
 * на 189, и лишь на 136 она была из ПОКАЗАННОЙ витрины (на остальных игрок
 * сперва бесплатно обновил витрину — бесплатное обновление золота не тратит
 * и точку решения не сдвигает).
 *
 * ## Кандидаты — витрина, а не рекомендации советника
 *
 * `buyQuality` берёт кандидатов из `advice.recommendations`, и для сверки
 * эвристики с симулятором это верно. Здесь так нельзя: множество, собранное
 * советником, — это множество, собранное ОДНИМ ИЗ СРАВНИВАЕМЫХ, и покупка
 * игрока, которую советник отсёк своим же правилом (цена, запас `sellMargin`
 * на полном борде), просто не попала бы в сравнение. Поэтому кандидаты —
 * вся витрина по карману, дедуп по базовому `cardId`: две копии одной карты
 * это один выбор.
 *
 * ## Жертва на полном борде — одна на всех, объявлена заранее
 *
 * Когда борд полон, покупка требует продажи, и от того, КОГО продать, зависит
 * исход боя. Брать жертву из `buyRules` значило бы строить ход игрока кодом
 * его соперника по замеру (`weakestOwn` ранжирует по `minionValue` советника).
 * Правило одно для всех выбирающих: фактическая продажа игрока того же хода,
 * если она была до покупки, иначе `weakestOwn`. Числа на полном и неполном
 * борде печатаются отдельно — это заранее объявленная страта, а не подвыборка
 * задним числом.
 *
 * ## Оракул оценивается на НЕЗАВИСИМОМ прогоне
 *
 * Максимум из нескольких зашумлённых оценок смещён вверх — тот самый эффект,
 * ради которого в `position/rng.ts` заведено зерно. При 2000 симуляций SE
 * доли около 1.6 п.п., и «потолок», посчитанный как argmax по тем же числам,
 * которыми потом хвалятся, завышен на величину порядка самого эффекта.
 * Поэтому кандидаты гоняются ДВАЖДЫ разными зёрнами: на прогоне A выбирается
 * лучший, на прогоне B оцениваются ВСЕ выбирающие, включая его. Прочие
 * выбирающие смещения не имеют — они выбирают, не глядя на исходы.
 *
 * ## Что мерка НЕ видит — и почему это важно именно здесь
 *
 * Ближайший бой слеп к экономике, к следующим ходам и к композиции; в проекте
 * это записано четырежды (part16/18/22/25), и портрет игрока по замеру 2
 * («покупает племя 0.60 и тир 0.20, статы 0») говорит, что покупает он как раз
 * то, чего эта мерка не видит. Значит разрыв «оракул минус игрок» — НЕ мера
 * того, насколько плохо он играет: часть разрыва создана слепотой мерки.
 * Читать его следует как ПОТОЛОК того, что вообще можно выиграть на ближайшем
 * бою, и не переводить в места.
 */

import { readBattleEpisodes } from '../battle/episodes.js';
import { toBattleInfo, withPlayerBoard, type BattleSetup } from '../battle/mapper.js';
import type { BattleSimulator } from '../battle/simulator.js';
import { battleQuestion } from '../position/advisor.js';
import { withSeededRandom } from '../position/rng.js';
import {
  buyCheckQuestion,
  checkBuysWithBattle,
  DEFAULT_BUY_CHECK_OPTIONS,
} from './simulated.js';
import type { CardIndex } from '../../data/cards.js';
import { reduceLog } from '../../state/reducer.js';
import type { GameState, Minion, PlayerAction } from '../../state/types.js';
import { adviseTavern, buyCostOf, weakestOwn } from './advisor.js';
import { DEFAULT_TAVERN_RULES, type TavernRules } from './rules.js';
import { readTavernTurns } from './turns.js';

/** Действия, которые тратят золото. Заморозка и розыгрыш из руки — не тратят. */
const SPENDING_ACTIONS = new Set<PlayerAction['type']>([
  'buy',
  'levelUp',
  'roll',
  'darkGift',
  'heroPower',
  'activate',
]);

/** Золотая копия — та же карта: суффикс снимается, как во всех сверках. */
function baseCardOf(cardId: string): string {
  return cardId.endsWith('_G') ? cardId.slice(0, -2) : cardId;
}

export interface ArenaCandidate {
  readonly minion: Minion;
  /** Борд после покупки: жертва убрана, кандидат дописан в конец. */
  readonly board: readonly Minion[];
}

export interface ArenaDecision {
  readonly turn: number;
  readonly state: GameState;
  readonly base: ReturnType<typeof toBattleInfo>;
  readonly opponentBoard: readonly Minion[];
  readonly candidates: readonly ArenaCandidate[];
  /** Индекс кандидата, которого игрок фактически купил. */
  readonly playerIndex: number;
  /** Кого пришлось продать; `null` — борд был не полон. */
  readonly sacrifice: Minion | null;
}

/** Почему точка не вошла в замер — по причинам, а не одним числом. */
export interface ArenaSkips {
  /** Первым тратящим действием хода была не покупка. */
  readonly notBuyFirst: number;
  /** Покупка была, но не из витрины этой точки (обычно после бесплатного обновления). */
  readonly buyOffShop: number;
  /** В тот ход игрок не потратил ничего. */
  readonly noSpending: number;
  /** Следующего боя в логе нет (последний ход партии). */
  readonly noBattle: number;
  /** По карману была одна карта или ни одной — выбора не было. */
  readonly noChoice: number;
  /** Борд полон, а продать некого. */
  readonly noSacrifice: number;
}

export interface ArenaEnumeration {
  readonly decisions: readonly ArenaDecision[];
  readonly skips: ArenaSkips;
}

/**
 * Точки, где ход игрока восстановим и сравним, — без единой симуляции.
 *
 * Разрезано так же, как `enumerateBuyDecisions`: перечисление отдельно
 * от счёта, потому что перечисление нужно и замеру выборки, и самому замеру.
 */
export function enumerateArenaDecisions(
  text: string,
  deps: { readonly cards: CardIndex; readonly simulator: BattleSimulator },
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): ArenaEnumeration {
  const battles = new Map(readBattleEpisodes(text).map((e) => [e.turn, e.opponentBoard]));

  // Журнал берётся ПОЛНЫМ прогоном, а не из последней точки решения: точка
  // несёт лишь то, что случилось ДО неё, и действия последнего хода таверны
  // в неё не попадают вовсе — годная точка ушла бы в «не тратил ничего».
  // Лишний проход по логу стоит около 0.2 с на 40 МБ, и это честная цена.
  const actionsByTurn = new Map<number, PlayerAction[]>();
  const turns = readTavernTurns(text);
  for (const action of reduceLog(text).actions) {
    const list = actionsByTurn.get(action.turn);
    if (list === undefined) actionsByTurn.set(action.turn, [action]);
    else list.push(action);
  }

  const decisions: ArenaDecision[] = [];
  const skips = {
    notBuyFirst: 0,
    buyOffShop: 0,
    noSpending: 0,
    noBattle: 0,
    noChoice: 0,
    noSacrifice: 0,
  };

  for (const { state } of turns) {
    if (state.hero === null) continue;

    const ofTurn = actionsByTurn.get(state.turn) ?? [];
    const first = ofTurn.find((a) => SPENDING_ACTIONS.has(a.type));
    if (first === undefined) {
      skips.noSpending += 1;
      continue;
    }
    if (first.type !== 'buy') {
      skips.notBuyFirst += 1;
      continue;
    }
    const bought = state.shop.find((m) => m.entityId === first.entityId);
    if (bought === undefined) {
      skips.buyOffShop += 1;
      continue;
    }

    const opponentBoard = battles.get(state.turn + 1);
    if (opponentBoard === undefined || opponentBoard.length === 0) {
      skips.noBattle += 1;
      continue;
    }

    // Кандидаты — витрина по карману, по одному представителю на карту.
    const seen = new Set<string>();
    const affordable: Minion[] = [];
    for (const minion of state.shop) {
      if (buyCostOf(minion, rules) > state.gold) continue;
      const key = baseCardOf(minion.cardId);
      if (seen.has(key)) continue;
      seen.add(key);
      affordable.push(minion);
    }
    const playerIndex = affordable.findIndex(
      (m) => baseCardOf(m.cardId) === baseCardOf(bought.cardId),
    );
    // Покупка игрока обязана быть среди кандидатов: он её сделал, значит
    // она была по карману. Если нет — цену читаем не так, и это дефект,
    // а не точка для выбрасывания; считаем вслух.
    if (playerIndex < 0) {
      skips.buyOffShop += 1;
      continue;
    }
    if (affordable.length < 2) {
      skips.noChoice += 1;
      continue;
    }

    // Место под покупку: продажа нужна только на полном борде.
    let sacrifice: Minion | null = null;
    if (state.board.length >= rules.boardSize) {
      const sold = ofTurn.find(
        (a) => a.type === 'sell' && a.entityId !== null && ofTurn.indexOf(a) < ofTurn.indexOf(first),
      );
      const actual =
        sold === undefined ? undefined : state.board.find((m) => m.entityId === sold.entityId);
      sacrifice = actual ?? weakestOwn(state, deps, rules)?.minion ?? null;
      if (sacrifice === null) {
        skips.noSacrifice += 1;
        continue;
      }
    }

    const kept = state.board.filter((m) => sacrifice === null || m.entityId !== sacrifice.entityId);
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

    decisions.push({
      turn: state.turn,
      state,
      base: toBattleInfo(setup, 1),
      opponentBoard,
      candidates: affordable.map((minion) => ({ minion, board: [...kept, minion] })),
      playerIndex,
      sacrifice,
    });
  }

  return { decisions, skips };
}

/**
 * Кто выбирает.
 *
 * `random` — не бросок монеты, а ожидание по кандидатам. `oracle` знает борд,
 * который у соперника ФАКТИЧЕСКИ вышел, и потому недостижим в живой игре;
 * `live3` и `liveAll` — наоборот, играют по знанию, доступному в тот момент:
 * поле виденных бордов (`battleQuestion`), как живой досчёт `simulated.ts`.
 * Разница между ними и есть цена вопроса «расширить досчёт»:
 *
 *  - `live3` — нынешний живой досчёт: три верхних кандидата ЭВРИСТИКИ;
 *  - `liveAll` — все кандидаты по карману, каждому ПОЛНЫЕ 800 симуляций:
 *    расширение, купленное временем (кандидатов вдвое больше — счёт вдвое
 *    дольше);
 *  - `liveBudget` — все кандидаты при ТОМ ЖЕ суммарном бюджете, что у трёх
 *    (2400 симуляций на всех): расширение, купленное точностью.
 *
 * Различать эти два обязательно. Больше кандидатов при том же бюджете —
 * это больше шансов, что победит самый УДАЧЛИВЫЙ, а не лучший: тот самый
 * winner's curse, ради которого заведено зерно в `position/rng.ts`.
 * В живой игре ограничен не счёт, а время, поэтому честный ответ на вопрос
 * «расширять ли» даёт `liveBudget`, а `liveAll` показывает верхнюю границу.
 *
 * Все три, не найдя цели (ранние ходы, боёв ещё не было), падают обратно
 * на выбор советника — ровно как живой путь, который тогда молчит.
 */
export type ChooserName =
  | 'player'
  | 'advisor'
  | 'oracle'
  | 'random'
  | 'stats'
  | 'live3'
  | 'liveAll'
  | 'liveBudget'
  | 'liveRich';

export const CHOOSER_NAMES: readonly ChooserName[] = [
  'player',
  'advisor',
  'oracle',
  'random',
  'stats',
  'live3',
  'liveAll',
  'liveBudget',
  'liveRich',
];

export interface ArenaRow {
  readonly turn: number;
  readonly candidates: number;
  /** Исход каждого кандидата на ОЦЕНОЧНОМ прогоне, в п.п. */
  readonly outcomes: readonly number[];
  /** Что получил каждый выбирающий; у `random` это среднее по кандидатам. */
  readonly scores: Readonly<Record<ChooserName, number>>;
  /** Индекс выбора; у `random` его нет. */
  readonly picks: Readonly<Record<Exclude<ChooserName, 'random'>, number | null>>;
  readonly spread: number;
  readonly boardFull: boolean;
  /** Была ли у живого досчёта цель: без неё `live*` равны советнику. */
  readonly liveHadTarget: boolean;
  /** Сколько бордов в поле виденных — цена досчёта растёт с ним линейно. */
  readonly liveBoards: number;
  /** Время живого досчёта по всем кандидатам, мс. */
  readonly liveAllMs: number;
}

export interface ArenaOptions {
  readonly simulations: number;
  /** Зерно отборочного прогона — только для оракула. */
  readonly seedPick: number;
  /** Зерно оценочного прогона — им считаются ВСЕ выбирающие. */
  readonly seedScore: number;
  /** Зерно живого досчёта: он тоже обязан быть воспроизводимым. */
  readonly seedLive: number;
  readonly rules: TavernRules;
  /**
   * Передавать ли руку в бой. По умолчанию нет — ровно как `buyQuality`,
   * чтобы числа «советник против симулятора» оставались сравнимыми
   * с записанными в docs/tavern.md. Рука меняет исход у носителей ралли
   * (part21: 77.4% против 97.0%), поэтому включать её надо осознанно
   * и обе версии печатать рядом.
   */
  readonly withHand: boolean;
}

export const DEFAULT_ARENA_OPTIONS: ArenaOptions = {
  simulations: 2000,
  seedPick: 20_260_902,
  seedScore: 20_260_903,
  seedLive: 20_260_904,
  rules: DEFAULT_TAVERN_RULES,
  withHand: false,
};

export interface ArenaReport {
  readonly rows: readonly ArenaRow[];
  readonly skips: ArenaSkips;
  /** Точек, где советник не назвал ни одной покупки из наших кандидатов. */
  readonly advisorSilent: number;
}

function outcomeOf(
  simulator: BattleSimulator,
  base: ReturnType<typeof toBattleInfo>,
  board: readonly Minion[],
  hand: readonly Minion[] | undefined,
  simulations: number,
  seed: number,
): number {
  const input = withPlayerBoard(base, board);
  const withHand = hand === undefined ? input : { ...input, playerHand: hand };
  const result = withSeededRandom(seed, () => simulator.run(withHand, simulations));
  return result.wonPercent + result.tiedPercent / 2;
}

/** Статы тела — шкала, во что вырождается ΔV замера 1 (там один признак борда). */
function statsOf(minion: Minion): number {
  return (minion.attack ?? 0) + (minion.health ?? 0);
}

export function measureArena(
  text: string,
  deps: { readonly cards: CardIndex; readonly simulator: BattleSimulator },
  overrides: Partial<ArenaOptions> = {},
): ArenaReport {
  const options = { ...DEFAULT_ARENA_OPTIONS, ...overrides };
  const { decisions, skips } = enumerateArenaDecisions(text, deps, options.rules);

  const rows: ArenaRow[] = [];
  let advisorSilent = 0;

  for (const [index, decision] of decisions.entries()) {
    const hand = options.withHand ? decision.state.hand : undefined;
    const score = (candidate: ArenaCandidate, i: number, seed: number): number =>
      outcomeOf(
        deps.simulator,
        decision.base,
        candidate.board,
        hand,
        options.simulations,
        seed + index * 101 + i,
      );

    // Отборочный прогон нужен ровно одному выбирающему — оракулу.
    const picking = decision.candidates.map((c, i) => score(c, i, options.seedPick));
    const outcomes = decision.candidates.map((c, i) => score(c, i, options.seedScore));

    const oracleIndex = picking.reduce((best, v, i) => (v > picking[best]! ? i : best), 0);

    const advice = adviseTavern(decision.state, deps, options.rules);
    const topBuy = advice?.recommendations.find((r) => r.action === 'buy' && r.minion !== null);
    const advisorIndex =
      topBuy?.minion == null
        ? -1
        : decision.candidates.findIndex(
            (c) => baseCardOf(c.minion.cardId) === baseCardOf(topBuy.minion!.cardId),
          );
    if (advisorIndex < 0) advisorSilent += 1;

    // Живой досчёт: выбор по знанию, доступному в тот момент, — поле виденных
    // бордов, а не борд, который выйдет на самом деле. Оценивается он потом
    // общей меркой арены, как все: иначе выбирающие сравнивались бы разными
    // линейками.
    const fallback = advisorIndex < 0 ? decision.playerIndex : advisorIndex;
    const question = advice === null ? null : battleQuestion(decision.state);
    let live3 = fallback;
    let liveAll = fallback;
    let liveBudget = fallback;
    let liveRich = fallback;
    let liveAllMs = 0;
    if (question !== null && advice !== null) {
      const byIndex = decision.candidates.map((c, i) => ({
        cardId: c.minion.cardId,
        entityId: c.minion.entityId,
        boardAfter: c.board,
        index: i,
      }));
      const runLive = (
        subset: typeof byIndex,
        seed: number,
        simulations: number,
      ): number | null => {
        if (subset.length < 2) return null;
        const result = withSeededRandom(seed, () =>
          checkBuysWithBattle(
            { setups: question.setups, candidates: subset },
            { simulator: deps.simulator },
            { ...DEFAULT_BUY_CHECK_OPTIONS, simulations, maxCandidates: subset.length },
          ),
        );
        const best = result.outcomes[0];
        if (best === undefined) return null;
        return subset.find((c) => c.entityId === best.entityId)?.index ?? null;
      };

      const perCandidate = DEFAULT_BUY_CHECK_OPTIONS.simulations;
      // Нынешний путь — ровно тот отбор кандидатов, что делает `buyCheckQuestion`.
      const current = buyCheckQuestion(decision.state, advice, options.rules);
      const currentSubset =
        current === null
          ? []
          : current.candidates
              .map((c) => byIndex.find((b) => b.entityId === c.entityId))
              .filter((c): c is (typeof byIndex)[number] => c !== undefined);
      live3 = runLive(currentSubset, options.seedLive + index, perCandidate) ?? fallback;

      const started = Date.now();
      liveAll = runLive(byIndex, options.seedLive + index, perCandidate) ?? fallback;
      liveAllMs = Date.now() - started;

      // Тот же суммарный бюджет, что у нынешних трёх кандидатов, размазанный
      // по всем: время прежнее, точность на кандидата ниже.
      const budget = Math.max(
        1,
        Math.floor(
          (perCandidate * Math.max(1, DEFAULT_BUY_CHECK_OPTIONS.maxCandidates)) / byIndex.length,
        ),
      );
      liveBudget = runLive(byIndex, options.seedLive + index, budget) ?? fallback;

      // Проверка гипотезы «расширение вредит из-за шума, а не из-за лишних
      // кандидатов»: те же все кандидаты, но втрое точнее каждый. Если беда
      // в winner's curse, здесь она должна отступить; если в самих кандидатах
      // (витрина содержит мусор, который иногда выигрывает по шуму) —
      // не должна.
      liveRich = runLive(byIndex, options.seedLive + index, perCandidate * 3) ?? fallback;
    }

    const statsIndex = decision.candidates.reduce(
      (best, c, i) => (statsOf(c.minion) > statsOf(decision.candidates[best]!.minion) ? i : best),
      0,
    );

    const mean = outcomes.reduce((a, b) => a + b, 0) / outcomes.length;
    rows.push({
      turn: decision.turn,
      candidates: decision.candidates.length,
      outcomes,
      scores: {
        player: outcomes[decision.playerIndex]!,
        advisor: advisorIndex < 0 ? outcomes[decision.playerIndex]! : outcomes[advisorIndex]!,
        oracle: outcomes[oracleIndex]!,
        random: mean,
        stats: outcomes[statsIndex]!,
        live3: outcomes[live3]!,
        liveAll: outcomes[liveAll]!,
        liveBudget: outcomes[liveBudget]!,
        liveRich: outcomes[liveRich]!,
      },
      picks: {
        player: decision.playerIndex,
        advisor: advisorIndex < 0 ? null : advisorIndex,
        oracle: oracleIndex,
        stats: statsIndex,
        live3,
        liveAll,
        liveBudget,
        liveRich,
      },
      spread: Math.max(...outcomes) - Math.min(...outcomes),
      boardFull: decision.sacrifice !== null,
      liveHadTarget: question !== null,
      liveBoards: question?.setups.length ?? 0,
      liveAllMs,
    });
  }

  return { rows, skips, advisorSilent };
}

/**
 * Парный контраст «выбирающий минус игрок», кластер — партия.
 *
 * Кластер именно партия, а не точка: точки одной партии зависимы (один борд,
 * один герой, один стиль), и считать их независимыми значило бы завысить
 * точность в разы. Так же считают все замеры фазы 6 (LOGO по партиям).
 */
export interface Contrast {
  readonly mean: number;
  readonly sd: number;
  readonly se: number;
  /** Минимальный различимый эффект: 1.645 · SE, односторонний. */
  readonly mde: number;
  readonly games: number;
}

export function contrastAgainstPlayer(
  perGame: readonly (readonly ArenaRow[])[],
  chooser: ChooserName,
): Contrast {
  return contrastBetween(perGame, chooser, 'player');
}

/**
 * Тот же парный контраст, но против любого выбирающего.
 *
 * Нужен для вопроса «что даёт расширение досчёта»: там сравниваются между
 * собой `liveAll` и `live3`, а игрок ни при чём.
 */
export function contrastBetween(
  perGame: readonly (readonly ArenaRow[])[],
  chooser: ChooserName,
  baseline: ChooserName,
): Contrast {
  const deltas = perGame
    .filter((rows) => rows.length > 0)
    .map(
      (rows) =>
        rows.reduce((sum, r) => sum + (r.scores[chooser] - r.scores[baseline]), 0) / rows.length,
    );
  const games = deltas.length;
  if (games === 0) return { mean: 0, sd: 0, se: 0, mde: 0, games: 0 };
  const mean = deltas.reduce((a, b) => a + b, 0) / games;
  const sd =
    games < 2
      ? 0
      : Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / (games - 1));
  const se = sd / Math.sqrt(games);
  return { mean, sd, se, mde: 1.645 * se, games };
}
