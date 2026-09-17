import { mean } from '../advisors/tavern/statAnalysis.js';
import { tavernTurnOf } from '../advisors/tavern/rules.js';
import type { GameState } from '../state/types.js';
import type { DatasetGame } from './dataset.js';
import type { MlGame } from './evaluate.js';
import { MISSING_PLACE } from './features.js';
import {
  extractRelativeFeatures,
  isAlive,
  lobbyHp,
  placeAmongAlive,
  RELATIVE_FEATURE_NAMES,
} from './relativeFeatures.js';

/**
 * Соперники из таблицы лобби как обучающие строки — замер 6а (docs/ml.md).
 *
 * У каждой нашей партии исход один, а игроков в ней восемь. Таблица лобби
 * лежит в каждой точке решения (здоровье, тир и место всех восьми), и пять
 * относительных признаков замера 3 у соперника считаются ровно так же,
 * как у нас. Места соперников на оверлей не завязаны и покрывают 1–8,
 * а не скос одного сильного игрока.
 *
 * ## Исход соперника
 *
 * Известен не у всех. Берётся ПОСЛЕДНЯЯ точка решения партии:
 *
 *  - соперник уже выбыл (здоровье с бронёй не больше нуля) — его место
 *    окончательное, и оно ТОЧНОЕ;
 *  - соперник ещё жив — мы вылетим раньше него или одновременно, и его
 *    место — одно из мест, которые остались: всё от 1 до 8, кроме нашего
 *    и мест выбывших. Сумма мест этой группы известна точно, порядок — нет,
 *    и каждому ставится СРЕДНЕЕ группы. Группа из одного — снова точное
 *    место (мы вторые, живой соперник — первый).
 *
 * Среднее группы выбрано вместо «только точных» сознательно: точными
 * оказываются одни проигравшие раньше нас, и выборка по одним им отбиралась
 * бы по целевой. Смещения по ОТБОРУ среднее группы не даёт, но ошибка
 * внутри группы связана с признаками (сильнейший из доживших станет
 * первым, а получает среднее), и наклоны по строкам доживших занижены.
 * Парная целевая («кто выше») этого не делает, но у неё нет закрытой
 * формы, а прибор фазы 6 — гребневая регрессия; вторичная ветка
 * `currentOrder` раздаёт места доживших по их текущему месту.
 *
 * ## Годность исходов
 *
 * Проверяется на каждой партии, и партия, где она не сходится, выпадает
 * целиком и называется: в таблице ровно восемь игроков и наш среди них,
 * здоровье и места выбывших прочитаны, и выбывшие к последней точке
 * занимают РОВНО нижние места (мы в ней ещё живы, значит они вылетели
 * раньше нас), а наше место выше их. Иначе это снимок до пересчёта мест.
 * 17.09 так выпадает одна партия из 57 (живая запись part21).
 *
 * ## Строки
 *
 * В каждой точке решения — строка на каждого ЖИВОГО в ней соперника:
 * пять признаков замера 3 с его стороны плюс индикатор «это владелец
 * записи» (0 у соперника, 1 у нас). Индикатор — отдельный интерсепт
 * владельца: игрок сильнее своего стола (его среднее место 3.7, у семи
 * соперников в среднем около 4.6), и без индикатора модель, обученная
 * на всех восьми, завышала бы ему место по причине, не связанной
 * с признаками. Вес строк соперников — забота оценки (`evaluateLogo`,
 * `balanced`), не этого модуля.
 */

export const LOBBY_FEATURE_NAMES: readonly string[] = [...RELATIVE_FEATURE_NAMES, 'владелец записи'];

/** Мест в лобби Battlegrounds. */
const LOBBY_SIZE = 8;

export interface LobbyOutcome {
  readonly playerId: number;
  /** Место: точное — или среднее мест, оставшихся группе живых. */
  readonly place: number;
  readonly exact: boolean;
}

export type LobbyOutcomes =
  | { readonly ok: true; readonly outcomes: ReadonlyMap<number, LobbyOutcome> }
  | { readonly ok: false; readonly reason: string };

/**
 * Как ставить исход ДОЖИВШИМ соперникам. `groupMean` — основная ветка
 * (шапка модуля). `currentOrder` — вторичная: оставшиеся места раздаются
 * по текущему месту в последней точке (лучший сейчас — лучшее место);
 * ошибка тут не нулевая в среднем, зато внутри группы она не гасит наклон.
 */
export type SurvivorTargets = 'groupMean' | 'currentOrder';

export interface LobbyOutcomeOptions {
  readonly survivors?: SurvivorTargets;
  /**
   * Место владельца, от которого выводятся исходы доживших, — для
   * отрицательного контроля: там место владельца ПЕРЕМЕШАНО, и исходы
   * его соперников обязаны следовать за ним, иначе контроль не увидит
   * утечку их строк из отложенной партии. С подставным местом проверки
   * «наше место совместимо с выбывшими» не делаются: оставшиеся места —
   * всё, что выше выбывших, без подставного места, если оно среди них.
   */
  readonly ownerPlace?: number;
}

/** Исходы семи соперников по последней точке партии; см. шапку модуля. */
export function lobbyOutcomes(game: DatasetGame, options: LobbyOutcomeOptions = {}): LobbyOutcomes {
  const last = game.record.checkpoints.at(-1)?.state;
  if (last === undefined) return { ok: false, reason: 'нет точек решения' };
  const me = last.playerId;
  if (me === null) return { ok: false, reason: 'свой игрок не известен' };

  const players = Object.values(last.lobby);
  if (players.length !== LOBBY_SIZE) {
    return { ok: false, reason: `в таблице ${String(players.length)} игроков, а не ${String(LOBBY_SIZE)}` };
  }
  if (!players.some((p) => p.playerId === me)) return { ok: false, reason: 'своего игрока нет в таблице' };

  const rivals = players.filter((p) => p.playerId !== me);
  if (rivals.some((p) => lobbyHp(p) === null)) return { ok: false, reason: 'здоровье соперника не прочитано' };

  const dead = rivals.filter((p) => !isAlive(p));
  const alive = rivals.filter(isAlive);

  const deadPlaces = dead.map((p) => p.place);
  if (deadPlaces.some((pl) => pl === null)) return { ok: false, reason: 'место выбывшего не прочитано' };
  const placed = (deadPlaces as number[]).slice().sort((a, b) => a - b);
  // Мы живы в последней точке, значит все выбывшие к ней вылетели раньше
  // нас и занимают РОВНО нижние места: при d выбывших — с 9−d по 8.
  // Любое другое — снимок до пересчёта мест (замер 3: 8 точек из 461),
  // и тогда неверны и точные исходы, и среднее группы.
  const firstDeadPlace = LOBBY_SIZE - placed.length + 1;
  if (placed.some((pl, i) => pl !== firstDeadPlace + i)) {
    return {
      ok: false,
      reason: `места выбывших ${placed.join(', ')} — не нижние ${String(placed.length)} (снимок до пересчёта)`,
    };
  }
  const k = options.ownerPlace ?? game.finalPlace;
  if (options.ownerPlace === undefined && k >= firstDeadPlace) {
    return { ok: false, reason: `наше место ${String(k)} среди мест выбывших раньше нас` };
  }

  // Мест осталось ровно столько, сколько живых соперников: выше выбывших
  // их 8 − d, одно из них наше.
  const left: number[] = [];
  for (let pl = 1; pl < firstDeadPlace; pl += 1) if (pl !== k) left.push(pl);

  const outcomes = new Map<number, LobbyOutcome>();
  for (const p of dead) outcomes.set(p.playerId, { playerId: p.playerId, place: p.place ?? 0, exact: true });
  const exact = left.length === 1 && alive.length === 1;
  if (options.survivors === 'currentOrder') {
    const ordered = [...alive].sort(
      (a, b) => (a.place ?? LOBBY_SIZE) - (b.place ?? LOBBY_SIZE) || a.playerId - b.playerId,
    );
    ordered.forEach((p, i) => {
      outcomes.set(p.playerId, { playerId: p.playerId, place: left[i] ?? mean(left), exact });
    });
  } else {
    const groupPlace = left.length === 0 ? 0 : mean(left);
    for (const p of alive) outcomes.set(p.playerId, { playerId: p.playerId, place: groupPlace, exact });
  }
  return { ok: true, outcomes };
}

/**
 * Пять признаков замера 3 со стороны ЛЮБОГО игрока лобби — только
 * по таблице. Для владельца записи совпадает с `extractRelativeFeatures`:
 * его строка в таблице несёт те же здоровье, тир и место, что герой
 * и состояние (сверено 17.09 на всех 765 точках датасета).
 */
export function relativeFeaturesOfPlayer(state: GameState, playerId: number): readonly number[] {
  const self = state.lobby[playerId];
  if (self === undefined) throw new Error(`игрока ${String(playerId)} нет в таблице лобби`);
  const place = self.place ?? MISSING_PLACE;
  const alive = Object.values(state.lobby).filter(isAlive);
  const rivals = alive.filter((p) => p.playerId !== playerId);
  const hpGap =
    rivals.length === 0 ? 0 : (lobbyHp(self) ?? 0) - mean(rivals.map((p) => lobbyHp(p) ?? 0));
  const rivalTiers = rivals.map((p) => p.techLevel).filter((t): t is number => t !== null);
  const tierGap =
    rivalTiers.length === 0 || self.techLevel === null ? 0 : self.techLevel - mean(rivalTiers);
  return [place, alive.length, hpGap, tierGap, placeAmongAlive(place, alive.length)];
}

export interface LobbyMlGame extends MlGame {
  /** Точен ли исход каждой дополнительной строки. */
  readonly extraExact: readonly boolean[];
  /** Текущее место соперника в каждой дополнительной строке — его бейзлайн B1. */
  readonly extraCurrentPlaces: readonly number[];
}

export type LobbyGameResult =
  | { readonly ok: true; readonly game: LobbyMlGame }
  | { readonly ok: false; readonly reason: string };

/**
 * Партия для модели «на всех восьми»: свои строки — признаки замера 3
 * плюс индикатор 1, дополнительные — живые соперники каждой точки
 * с индикатором 0 и своим исходом. `exactOnly` — вторичная ветка: только
 * соперники с точным исходом (смещённая отбором, печатается для сведения).
 * `ownerPlace` — подставное место владельца для отрицательного контроля:
 * им становятся и место партии, и исходы доживших соперников.
 */
export function toLobbyMlGame(
  game: DatasetGame,
  options: LobbyOutcomeOptions & { readonly exactOnly?: boolean } = {},
): LobbyGameResult {
  const exactOnly = options.exactOnly ?? false;
  const result = lobbyOutcomes(game, options);
  if (!result.ok) return result;

  const states = game.record.checkpoints.map((cp) => cp.state);
  const me = states.at(-1)?.playerId ?? null;
  const extraRows: (readonly number[])[] = [];
  const extraYs: number[] = [];
  const extraTavernTurns: number[] = [];
  const extraExact: boolean[] = [];
  const extraCurrentPlaces: number[] = [];

  for (const state of states) {
    for (const p of Object.values(state.lobby)) {
      if (p.playerId === me || !isAlive(p)) continue;
      const outcome = result.outcomes.get(p.playerId);
      if (outcome === undefined) {
        return { ok: false, reason: `у живого соперника ${String(p.playerId)} нет исхода` };
      }
      if (exactOnly && !outcome.exact) continue;
      extraRows.push([...relativeFeaturesOfPlayer(state, p.playerId), 0]);
      extraYs.push(outcome.place);
      extraTavernTurns.push(tavernTurnOf(state.turn));
      extraExact.push(outcome.exact);
      extraCurrentPlaces.push(p.place ?? MISSING_PLACE);
    }
  }

  return {
    ok: true,
    game: {
      name: game.fileName,
      finalPlace: options.ownerPlace ?? game.finalPlace,
      rows: states.map((s) => [...extractRelativeFeatures(s), 1]),
      tavernTurns: states.map((s) => tavernTurnOf(s.turn)),
      currentPlaces: states.map((s) => s.finalPlace),
      extraRows,
      extraYs,
      extraTavernTurns,
      extraExact,
      extraCurrentPlaces,
    },
  };
}
