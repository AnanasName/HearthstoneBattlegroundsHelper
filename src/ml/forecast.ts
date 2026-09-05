import { DecisionPoints } from '../dataset/recorder.js';
import type { GameState } from '../state/types.js';
import { forecastPlace, loadPlaceModel, type PlaceModelSnapshot } from './placeModel.js';

/**
 * Прогноз места в живом режиме: что показать и когда молчать.
 *
 * ## Почему это отдельный накопитель, а не одно состояние
 *
 * Модель замера 4 читает ИСТОРИЮ партии — темп потери здоровья за бой, ранг
 * времени жизни, долю выигранных боёв, — и считается она по точкам решения
 * партии, а не по «сейчас». Значит живой путь обязан вести те же точки, что
 * пишет датасет, и вести их с начала партии. Правило точки при этом
 * не переписывается: `DecisionPoints` тот же самый, что у рекордера,
 * и читается новым методом `snapshot()`.
 *
 * ## Что молчит и почему
 *
 * Прогноза нет, пока нет модели (свежая установка до `ml:fit`), нет таблицы
 * лобби (относительные признаки на пустом столе — ложь, а не пропуск)
 * и пока не набралось ни одной точки решения. Молчание тут дешевле числа:
 * строка «ожидаемое место» без стола была бы пересказом константы 3.6.
 *
 * Молчит он и ВНЕ ТАВЕРНЫ — в бою и на экране конца партии. Считать там
 * есть по чему (последняя точка решения никуда не делась), но показывать
 * нечего: место игрок в этот момент читает с самого экрана игры, и «ожидается
 * 3.4» рядом с уже случившимся — два числа об одном, из которых наше заведомо
 * хуже. Условие живёт ЗДЕСЬ, а не в двух подачах: у оверлея и терминала оно
 * одно и то же, и разъехалось бы молча.
 *
 * ## Чего этот прогноз НЕ делает
 *
 * Советов из него не выводится — так записано в предрегистрации замера
 * (docs/ml.md, «Чего этот замер не докажет», п. 5): «модель ждёт 5-е место»
 * не значит «подъём таверны это исправит». Поэтому число живёт отдельной
 * строкой внизу оверлея, не входит ни в один совет, ни в план и ни в одну
 * причину, и подписано своей ошибкой — чтобы читалось как прогноз, а не как
 * приговор.
 */

export interface PlaceForecast {
  /** Ожидаемое место, 1..8 — то, что печатает оверлей. */
  readonly place: number;
  /** Типичная ошибка прогноза (MAE по LOGO той же выборки). */
  readonly error: number;
  /** По скольким партиям обучено — паспорт рядом с числом. */
  readonly games: number;
}

export interface PlaceForecasterDeps {
  /** Снапшот; по умолчанию читается с диска один раз при создании. */
  readonly snapshot?: PlaceModelSnapshot | null;
}

export class PlaceForecaster {
  readonly #points = new DecisionPoints();
  readonly #snapshot: PlaceModelSnapshot | null;
  #inTavern = false;

  constructor(deps: PlaceForecasterDeps = {}) {
    this.#snapshot = deps.snapshot === undefined ? loadPlaceModel() : deps.snapshot;
  }

  /** Новая партия: история — прошлой. */
  reset(): void {
    this.#points.reset();
    this.#inTavern = false;
  }

  update(state: GameState): void {
    this.#points.update(state);
    this.#inTavern = state.phase === 'tavern';
  }

  /** Прогноз на текущей точке решения; `null` — сказать нечего. */
  current(): PlaceForecast | null {
    const snapshot = this.#snapshot;
    if (snapshot === null || !this.#inTavern) return null;

    const points = this.#points.snapshot();
    if (points.length === 0) return null;

    const states = points.map((p) => p.state);
    const place = forecastPlace(snapshot, states, states.length - 1);
    if (place === null) return null;

    return { place, error: snapshot.maeModel, games: snapshot.games };
  }
}
