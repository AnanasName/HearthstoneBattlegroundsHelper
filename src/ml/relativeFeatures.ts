import { mean } from '../advisors/tavern/statAnalysis.js';
import type { GameState, LobbyPlayer } from '../state/types.js';
import { MISSING_PLACE } from './features.js';

/**
 * Относительные признаки точки решения — замер 3 фазы 6 (docs/ml.md).
 *
 * Замер 1 показал, что семь «своих» признаков места не предсказывают,
 * и назвал причину: место — величина ОТНОСИТЕЛЬНАЯ, 30 hp на 9-м ходу —
 * это хорошо или плохо в зависимости от стола. Стол лежит в `lobby`
 * (таблица всех восьми игроков: здоровье, тир, место — part26), и с 28.08
 * он есть во всех записях датасета (старые пересобраны из логов,
 * `src/dataset/refresh.ts`).
 *
 * Пять признаков, все с ОДНОЙ точки, без истории:
 *
 *   0. текущее место — тот же признак, что у бейзлайна B2 (сжатое место):
 *      модель замера 3 — это B2 плюс относительные признаки, и её выигрыш
 *      у B2 читается как сигнал именно этих признаков;
 *   1. живых игроков — сколько мест ещё разыгрывается; живой — у кого
 *      здоровье с бронёй минус урон больше нуля;
 *   2. здоровье против живых — моё hp минус среднее hp живых СОПЕРНИКОВ
 *      (себя из «стола» вычитаем: иначе большой стол размывал бы разницу);
 *   3. тир против живых — мой тир минус средний тир живых соперников
 *      (соперник с непрочитанным тиром в среднее не входит);
 *   4. место среди живых — (место − 1) / (живых − 1), зажато в [0, 1]:
 *      взаимодействие «место × стадия партии», которого линейной модели
 *      замера 1 не хватало (поздний проигрыш таблице, D̄_late < 0).
 *      Зажим нужен по фактуре: в 8 точках из 461 выбывший игрок ещё стоит
 *      в таблице выше живых — снимок до пересчёта мест.
 *
 * Пропуски. Таблицы лобби нет — признаки честно не считаются: живых 8,
 * разности 0, место среди восьми; но отчёт замера 3 такие партии
 * ИСКЛЮЧАЕТ целиком (предрегистрация), так что эта ветка — для типа,
 * а не для данных. Своего `playerId` нет — соперниками считаются все живые.
 * Список, порядок и политика пропусков предрегистрированы — менять их
 * значит перезапускать замер, а не подкручивать до результата.
 */
export const RELATIVE_FEATURE_NAMES: readonly string[] = [
  'текущее место',
  'живых игроков',
  'здоровье против живых',
  'тир против живых',
  'место среди живых',
];

/** Индекс признака «текущее место» — единственного признака бейзлайна B2. */
export const RELATIVE_PLACE_INDEX = 0;

/** Игроков в лобби Battlegrounds — умолчание при неизвестной таблице. */
export const FULL_LOBBY = 8;

/** Здоровье с бронёй минус урон; null, если здоровье не прочитано. */
export function lobbyHp(player: LobbyPlayer): number | null {
  return player.health === null ? null : player.health - player.damage + player.armor;
}

export function isAlive(player: LobbyPlayer): boolean {
  const hp = lobbyHp(player);
  return hp !== null && hp > 0;
}

/** Таблица лобби в этой точке известна — хоть один игрок прочитан. */
export function lobbyKnownInState(state: GameState): boolean {
  return Object.keys(state.lobby).length > 0;
}

/** (место − 1) / (живых − 1), зажато в [0, 1]; один живой — ноль. */
export function placeAmongAlive(place: number, alive: number): number {
  if (alive <= 1) return 0;
  return Math.min(1, Math.max(0, (place - 1) / (alive - 1)));
}

export function extractRelativeFeatures(state: GameState): readonly number[] {
  const place = state.finalPlace ?? MISSING_PLACE;
  const hero = state.hero;
  const myHp =
    hero === null || hero.health === null ? 0 : hero.health - hero.damage + hero.armor;

  const players = Object.values(state.lobby);
  if (players.length === 0) return [place, FULL_LOBBY, 0, 0, placeAmongAlive(place, FULL_LOBBY)];

  const alive = players.filter(isAlive);
  const rivals = alive.filter((p) => p.playerId !== state.playerId);
  const hpGap = rivals.length === 0 ? 0 : myHp - mean(rivals.map((p) => lobbyHp(p) ?? 0));
  const rivalTiers = rivals.map((p) => p.techLevel).filter((t): t is number => t !== null);
  const tierGap = rivalTiers.length === 0 ? 0 : state.techLevel - mean(rivalTiers);

  return [place, alive.length, hpGap, tierGap, placeAmongAlive(place, alive.length)];
}
