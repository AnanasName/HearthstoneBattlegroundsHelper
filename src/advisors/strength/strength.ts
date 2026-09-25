/**
 * Сила своего стола: во скольких боях этого хода наш борд побеждает.
 *
 * ## Что это за число
 *
 * Ожидаемый исход боя (победа плюс половина ничьей) нашего борда против
 * ВСЕХ чужих бордов, которые в наших партиях выходили в бой на этом же ходу
 * таверны (`src/advisors/strength/boards.ts`). Не рейтинг, не оценка
 * по нашей шкале ценности и не прогноз места — ровно доля выигранных боёв
 * против нормы хода.
 *
 * Число КАЛИБРОВАНО, и это проверено на 466 настоящих боях 41 партии
 * (`npm run spike:strength`, docs/quality.md): в корзине «сила 60–80 %»
 * игрок фактически выиграл 63.8 % боёв, в корзине «80–100 %» — 83.9 %,
 * в корзине «0–20 %» — 12.9 %; худшее расхождение с серединой корзины
 * 9.2 п.п. при пороге приёмки 15. Поэтому число печатается как есть,
 * не переводясь в слова вроде «сильный/слабый»: проценты означают то, что
 * на них написано.
 *
 * Симулятор тут не роскошь: наивная мерка «перцентиль СТАТОВ среди того же
 * поля» даёт корреляцию с фактическим исходом 0.288 против 0.411 у боя,
 * и она не даёт процентов вовсе — только ранг.
 *
 * ## Почему поле берётся ЦЕЛИКОМ, а симуляций мало
 *
 * Замерено (docs/quality.md): при полном поле хода хватает СОРОКА симуляций
 * на борд — отклонение от эталона (то же поле по 200 симуляций) 0.3–0.5
 * п.п. Стоит урезать поле ради скорости, и ошибка подскакивает до 8–22 п.п.
 * при том же времени. Причина та же, что записана у цели-поля в фазе 3:
 * разброс МЕЖДУ бордами много больше разброса симуляций одного боя, поэтому
 * платить надо за широту поля, а не за точность каждого замера.
 *
 * ## Чего это число НЕ говорит
 *
 * Оно про БЛИЖАЙШИЙ бой и только про него: экономику, темп и то, что борд
 * ещё вырастет, оно не видит (тот же горизонт, что у всех наших мерок
 * боем). Оно не про конкретного соперника — реальный противник хода один,
 * а тут их четыре десятка. И оно НЕ ВЕРДИКТ «усиливаться или качаться»:
 * подъём таверны статов на борд не кладёт, и ближайшим боем этот выбор
 * не решается структурно (CLAUDE.md, замер `spike:level`).
 */
import type { BattleSetup } from '../battle/mapper.js';
import type { BattleSimulator } from '../battle/simulator.js';
import { toBattleInfo } from '../battle/mapper.js';
import { withSeededRandom } from '../position/rng.js';
import { toEstimate } from '../position/score.js';
import { tavernTurnOf } from '../tavern/rules.js';
import { playersAlive, type GameState } from '../../state/types.js';
import { boardsOfTurn, type FieldSnapshot } from './boards.js';

export interface FieldStrengthOptions {
  /**
   * Симуляций на один борд поля. Сорок — замеренная достаточность, см. шапку.
   */
  readonly simulations: number;
  /**
   * Меньше скольких бордов поле считается непредставительным.
   *
   * Не косметика: к тринадцатому ходу таверны доживает горстка партий,
   * и «вы сильнее 3 из 3» звучит так же уверенно, как «сильнее 41 из 41»,
   * ничего при этом не зная. Молчать честнее.
   */
  readonly minBoards: number;
  /** Зерно ГПСЧ: одно положение обязано давать одно число. */
  readonly seed: number;
}

export const DEFAULT_FIELD_STRENGTH_OPTIONS: FieldStrengthOptions = {
  simulations: 40,
  minBoards: 12,
  seed: 20260906,
};

export interface FieldStrengthQuestion {
  readonly tavernTurn: number;
  /** Бои против каждого борда поля — то же, что уходит в воркер расстановки. */
  readonly setups: readonly BattleSetup[];
}

export interface FieldStrength {
  /** Доля выигранных боёв против поля хода, 0..100. */
  readonly percent: number;
  /**
   * Доля боёв поля, в которых игрок УМИРАЕТ, 0..100.
   *
   * Не «доля поражений»: смерть — это поражение, в котором полученный урон
   * достал до нашего запаса здоровья с бронёй. Считает её сам симулятор
   * (`lostLethal`: урон ≥ `hpLeft`), и потому число зависит от здоровья
   * так же, как от борда: тот же стол на 30 очках и на 8 даёт разную
   * смертность при одной и той же доле побед. Урон — с потолком игры
   * (D288): при пяти и больше живых запас выше 15 бой не пробивает вовсе,
   * и до правки на таком запасе печаталась смерть, которой быть не может
   * (part72, кадр 19:45: «смерть в 2 %» при 28 hp).
   *
   * Зачем отдельным числом при живой цене поражения рядом. Цена — это
   * СРЕДНЕЕ по проигранным боям, а смерть решает хвост: на девяти очках
   * здоровья при средней цене поражения 8 hp умирает не «около половины»
   * боёв, а столько, сколько их приходится на правый хвост распределения
   * урона. Отвечать на «доживу ли» средним — то же самое, что переходить
   * реку по средней глубине.
   */
  readonly deathPercent: number;
  /** Сколько бордов было в поле — размер выборки, за которой стоит число. */
  readonly boards: number;
  readonly tavernTurn: number;
  /** Средний урон в проигранных боях этого хода, или `null`, если не замерен. */
  readonly damageOnLoss: number | null;
  /** По скольким проигранным боям посчитан урон. */
  readonly damageLosses: number;
}

/**
 * Против чего считать силу — или `null`, если считать нечем.
 *
 * Отдельно от счёта по той же причине, что `battleQuestion` у расстановки:
 * живой режим отправляет эти же `setups` в воркер, а пакетный путь считает
 * тут же. Условия молчания живут ЗДЕСЬ, в одном месте на обе подачи.
 *
 * `excludePart` — для замеров по фикстурам (см. `boardsOfTurn`): партия
 * не мерится об борды собственных соперников. В живой игре не передаётся.
 */
export function fieldStrengthQuestion(
  state: GameState,
  snapshot: FieldSnapshot | null,
  options: FieldStrengthOptions = DEFAULT_FIELD_STRENGTH_OPTIONS,
  excludePart: number | null = null,
): FieldStrengthQuestion | null {
  if (snapshot === null || state.hero === null) return null;
  // Пустой борд — не «сила ноль», а «стола ещё нет»: на первом ходу до
  // покупки говорить «вы слабее всех» бессмысленно и неверно.
  if (state.board.length === 0) return null;
  if (state.phase !== 'tavern') return null;

  const hero = state.hero;
  const tavernTurn = tavernTurnOf(state.turn);
  const field = boardsOfTurn(snapshot, tavernTurn, excludePart);
  if (field.length < options.minBoards) return null;
  // Потолок урона (D288) — число живых НАШЕГО лобби: бой, о котором
  // спрашивают, наш, а поле лишь подставляет возможного соперника.
  const alive = playersAlive(state);

  const setups = field.map(
    (opponent): BattleSetup => ({
      turn: state.turn,
      playerBoard: state.board,
      // Рука идёт в бой вместе с бордом — ралли-призыв достаёт из неё тело
      // (part21). Мерка обязана считать то же, что считает расстановка.
      playerHand: state.hand,
      opponentBoard: opponent.board,
      playerHero: hero,
      techLevel: state.techLevel,
      anomalyCardId: state.anomalyCardId,
      globalInfo: state.globalInfo,
      playerDeity: state.deity,
      playerTrinketDbfIds:
        state.playerId === null ? [] : (state.trinketsByPlayer[state.playerId] ?? []),
      opponentTrinketDbfIds: opponent.trinketDbfIds,
      // Наше Божество в бой идёт — идёт и Божество соперника поля (D304).
      opponentDeity: opponent.deity ?? null,
      playersAlive: alive,
    }),
  );

  return { tavernTurn, setups };
}

/**
 * Ключ положения, от которого зависит сила стола.
 *
 * Нужен подаче, а не счёту, и вот зачем. Положение дел у советника меняется
 * от витрины, золота и руки — то есть по многу раз за ход, — а сила зависит
 * от БОРДА и хода. Если гасить блок на каждую смену положения, он будет
 * мигать полсекунды после каждой покупки, хотя число то же самое; если
 * не гасить никогда — покажет силу борда, которого уже нет.
 *
 * Поэтому одна функция на обе подачи: пока ключ тот же, прошлое число
 * остаётся на экране. Рука входит в ключ, потому что входит в бой
 * (ралли-призыв, part21).
 */
export function strengthKey(state: GameState): string {
  const minions = state.board
    .map((m) => `${String(m.entityId)}:${String(m.attack ?? 0)}/${String(m.health ?? 0)}`)
    .join(',');
  const hand = state.hand.map((m) => String(m.entityId)).join(',');
  return [state.turn, state.techLevel, minions, hand].join('|');
}

/** Цена поражения на этом ходу из снапшота, или `null`, если её там нет. */
export function damageOnLoss(
  snapshot: FieldSnapshot | null,
  tavernTurn: number,
): { mean: number; losses: number } | null {
  const row = snapshot?.damage.find((d) => d.tavernTurn === tavernTurn);
  return row === undefined ? null : { mean: row.mean, losses: row.losses };
}

/**
 * Счёт брошен: положение ушло вперёд, и ответ относился бы уже не к нему.
 *
 * Своим классом, как `SearchAborted` у расстановки: воркер отличает
 * брошенный счёт от сбоя, и «упало» вместо «поздно» выглядело бы у игрока
 * сломанным советником.
 */
export class StrengthAborted extends Error {
  constructor() {
    super('счёт силы стола брошен');
    this.name = 'StrengthAborted';
  }
}

export interface FieldStrengthDeps {
  readonly simulator: BattleSimulator;
  /** Ждут ли ещё этот ответ. Спрашивается между бордами поля. */
  readonly aborted?: () => boolean;
}

/**
 * Прогон вопроса симулятором.
 *
 * Зерно фиксировано и НЕ зависит от состава поля: два вызова на одном
 * положении обязаны давать одно число, иначе блок будет мигать у игрока
 * на глазах, а причина будет выглядеть как смена положения.
 */
export function runFieldStrength(
  question: FieldStrengthQuestion,
  deps: FieldStrengthDeps,
  snapshot: FieldSnapshot | null = null,
  options: FieldStrengthOptions = DEFAULT_FIELD_STRENGTH_OPTIONS,
): FieldStrength {
  let sum = 0;
  // Смерть копится СЧЁТЧИКАМИ по всем симуляциям поля, а не средним
  // из процентов каждого борда: проценты пакета округлены до десятой доли,
  // а на редком событии округление — это и есть весь ответ (D205 о том же
  // у доли побед). Складывать штуки можно точно.
  let deaths = 0;
  let sims = 0;
  for (const setup of question.setups) {
    // Между бордами, а не внутри боя: один бой на сорока симуляциях идёт
    // миллисекунды, а всё поле — полсекунды, и бросать надо именно её.
    if (deps.aborted?.() === true) throw new StrengthAborted();
    const info = toBattleInfo(setup, options.simulations);
    const result = withSeededRandom(options.seed, () =>
      deps.simulator.run(info, options.simulations),
    );
    sum += result.wonPercent + result.tiedPercent / 2;
    const estimate = toEstimate(result);
    deaths += estimate.lostLethal;
    // Не `options.simulations`: симулятор обрывает прогон по своему пределу
    // времени, и тогда сделанных симуляций меньше заказанных.
    sims += estimate.sims;
  }

  const damage = damageOnLoss(snapshot, question.tavernTurn);
  return {
    percent: sum / question.setups.length,
    deathPercent: sims === 0 ? 0 : (deaths / sims) * 100,
    boards: question.setups.length,
    tavernTurn: question.tavernTurn,
    damageOnLoss: damage?.mean ?? null,
    damageLosses: damage?.losses ?? 0,
  };
}

/** Пакетный путь: вопрос и счёт разом. `null` — считать не на чем. */
export function fieldStrength(
  state: GameState,
  snapshot: FieldSnapshot | null,
  simulator: BattleSimulator,
  options: FieldStrengthOptions = DEFAULT_FIELD_STRENGTH_OPTIONS,
): FieldStrength | null {
  const question = fieldStrengthQuestion(state, snapshot, options);
  if (question === null) return null;
  return runFieldStrength(question, { simulator }, snapshot, options);
}
