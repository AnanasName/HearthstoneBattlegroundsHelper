import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { adviseTavern } from '../advisors/tavern/advisor.js';
import { createRng, mean, summarize } from '../advisors/tavern/statAnalysis.js';
import { loadCardIndex } from '../data/cards.js';
import { DATASET_DIR } from '../dataset/recorder.js';
import { loadDataset } from './dataset.js';
import { evaluateLogo, RIDGE_LAMBDA, signFlipBand, summarizeEvals, toMlGame } from './evaluate.js';
import {
  baseCardOf,
  buildInstances,
  evaluateImitationLogo,
  type AdvisorPick,
  type ImitationInstance,
} from './imitation.js';

/**
 * Мониторинг накопления датасета — «сколько данных и куда движутся числа».
 *
 *   npm run ml:track
 *
 * ## Зачем отдельная команда, а не просто повторный замер
 *
 * Оба замера фазы 6 предрегистрированы с условием «перезамер при +10 новых
 * партиях», и это не формальность: смотреть на вердикт после каждой партии
 * и остановиться, когда число понравилось, — подгонка через выбор момента
 * остановки. Проект уже платил за родственный урок (docs/cardstats.md:
 * «множественные взгляды на одну выборку удешевляют вывод, и цену видно»).
 *
 * Поэтому здесь ВЕРДИКТА НЕТ вовсе. Печатаются состав датасета, что
 * прибавилось с прошлого запуска, текущие числа обоих замеров рядом
 * с шумовой полосой — и сколько партий осталось до честного перезамера.
 * Числа на +1 партии дрожат в пределах шума, и команда говорит это сама,
 * а не оставляет читателю.
 *
 * Главное, ради чего смотреть после каждой игры осмысленно, — не проценты,
 * а РАСХОЖДЕНИЯ свежей партии: где советник назвал одно, а игрок купил
 * другое. Это фактура для правил, и она не портится от того, что на неё
 * посмотрели рано.
 *
 * Журнал прогонов — `data/dataset/ml-track.jsonl` (вне git, как и датасет):
 * по строке на запуск, чтобы динамика была видна не по памяти.
 */

/** Партий было на момент предрегистрированных замеров 18–19.08. */
const BASELINE_GAMES = 23;
/** Через столько НОВЫХ партий предрегистрация разрешает перезамер. */
const REMEASURE_AFTER = 10;

const BAND_SEED = 20260818;
const BAND_ITERATIONS = 10_000;
const TRACK_LOG = join(DATASET_DIR, 'ml-track.jsonl');

interface TrackEntry {
  readonly at: string;
  readonly games: number;
  readonly points: number;
  readonly instances: number;
  readonly gameFiles: readonly string[];
  readonly placeMaeModel: number;
  readonly placeMaeCurrent: number;
  readonly placeMaeMean: number;
  readonly placeDelta: number;
  readonly hitModel: number;
  readonly hitAdvisor: number;
  readonly hitRandom: number;
  readonly hitDelta: number;
}

function readLog(): TrackEntry[] {
  if (!existsSync(TRACK_LOG)) return [];
  const out: TrackEntry[] = [];
  for (const line of readFileSync(TRACK_LOG, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as TrackEntry);
    } catch {
      // Битая строка журнала — не повод терять прогон.
    }
  }
  return out;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const pp = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} п.п.`;
const num = (x: number): string => x.toFixed(3);

/** Движение относительно прошлого прогона — справка, а не вывод. */
function shift(now: number, before: number | undefined, asPoints: boolean): string {
  if (before === undefined) return '';
  const d = now - before;
  if (Math.abs(d) < 5e-4) return ' (без изменений)';
  return ` (${asPoints ? pp(d) : `${d >= 0 ? '+' : ''}${num(d)}`} к прошлому)`;
}

function main(): void {
  const data = loadDataset();
  const cards = loadCardIndex();
  const games = data.games.map((g) => toMlGame(g));
  const points = games.reduce((n, g) => n + g.rows.length, 0);

  // Состав по билдам печатается ВСЕГДА и первым. В день выхода патча
  // выборка схлопывается до партий нового билда, и без этой строки
  // инструмент выглядел бы сломанным, хотя работает как задумано.
  if (data.recordsByBuild.length > 1) {
    console.log('═══ билды в датасете ═══');
    for (const row of data.recordsByBuild) {
      const mark = row.learned
        ? row.build === data.build
          ? ' ← текущий, учится'
          : ' ← та же игра по таблице совместимости, учится'
        : ' (другой патч, отброшен)';
      console.log(
        `  билд ${String(row.build ?? 'неизвестен')}: записей ${String(row.records)}${mark}`,
      );
    }
    console.log(
      'Билды одной группы (src/data/builds.ts) учатся вместе — баланс и багфиксы ' +
        'игру не меняют. Контентный патч группу не получает: там пул карт другой, ' +
        'и учиться на прошлом стоило калибровке 3.9 → 9.0 п.п.',
    );
    console.log('');
  }

  if (games.length < 5) {
    console.log(
      `партий на текущем билде: ${String(games.length)} — для оценки нужно хотя бы пять.`,
    );
    console.log(
      'Это не поломка: копите партии дальше, датасет пишется живым режимом сам. ' +
        'Прежние партии никуда не делись — они лежат в data/dataset/ и вернутся ' +
        'в работу, если правило билда будет смягчено по фактуре.',
    );
    return;
  }

  const history = readLog();
  const previous = history[history.length - 1];
  const knownBefore = new Set(previous?.gameFiles ?? []);
  const fresh = data.games.filter((g) => !knownBefore.has(g.fileName));

  console.log('═══ датасет ═══');
  console.log(
    `партий: ${String(games.length)}, точек решения: ${String(points)}` +
      (previous === undefined
        ? ''
        : ` (на прошлом прогоне ${previous.at.slice(0, 16)} было ${String(previous.games)})`),
  );
  if (previous !== undefined) {
    for (const g of fresh) {
      console.log(`  новая партия: ${g.fileName} — место ${String(g.finalPlace)}`);
    }
  }
  for (const dup of data.duplicates) {
    console.log(`  задвоено: оставлено ${dup.kept}, отброшено ${dup.dropped.join(', ')}`);
  }

  // Замер 1 — прогноз финального места.
  const evals = evaluateLogo(games, RIDGE_LAMBDA, 'global');
  const place = summarizeEvals(evals);
  const placeDelta = summarize(place.deltas);
  const band = signFlipBand(place.deltas, BAND_ITERATIONS, createRng(BAND_SEED));
  const placeMde = 1.645 * placeDelta.se;

  console.log('');
  console.log('═══ прогноз места (мониторинг) ═══');
  console.log(
    `MAE по партиям: модель ${num(place.maeModel)}${shift(place.maeModel, previous?.placeMaeModel, false)}` +
      ` | таблица ${num(place.maeCurrent)} | среднее место ${num(place.maeMean)}`,
  );
  console.log(
    `D̄ против таблицы: ${num(placeDelta.mean)}${shift(placeDelta.mean, previous?.placeDelta, false)}` +
      ` при МРЭ ${num(placeMde)} и полосе ${num(band.p05)}…${num(band.p95)}`,
  );

  // Замер 2 — имитация покупок игрока.
  const build = buildInstances(data.games);
  const advisorByInstance = new Map<ImitationInstance, string | null>();
  for (const inst of build.instances) {
    const advice = adviseTavern(inst.state, { cards });
    const top = advice?.recommendations.find((r) => r.action === 'buy' && r.minion !== null);
    advisorByInstance.set(inst, top?.minion == null ? null : baseCardOf(top.minion.cardId));
  }
  const advisorPick: AdvisorPick = (inst) => advisorByInstance.get(inst) ?? null;
  const imitation = evaluateImitationLogo(build.instances, cards, RIDGE_LAMBDA, advisorPick);
  const hitModel = mean(imitation.evals.map((e) => e.hitModel));
  const hitAdvisor = mean(imitation.evals.map((e) => e.hitAdvisor));
  const hitRandom = mean(imitation.evals.map((e) => e.hitRandom));
  const hitDelta = summarize(imitation.evals.map((e) => e.hitModel - e.hitAdvisor));
  const hitMde = 1.645 * hitDelta.se;

  console.log('');
  console.log('═══ имитация покупок (мониторинг) ═══');
  console.log(
    `решений о покупке: ${String(build.instances.length)}` +
      (previous === undefined ? '' : ` (было ${String(previous.instances)})`),
  );
  console.log(
    `угадано выборов игрока: модель ${pct(hitModel)}${shift(hitModel, previous?.hitModel, true)}` +
      ` | советник ${pct(hitAdvisor)}${shift(hitAdvisor, previous?.hitAdvisor, true)}` +
      ` | случайно ${pct(hitRandom)}`,
  );
  console.log(
    `D̄ против советника: ${pp(hitDelta.mean)}${shift(hitDelta.mean, previous?.hitDelta, true)}` +
      ` при МРЭ ${pp(hitMde)}`,
  );

  // Свежие партии по отдельности — то, ради чего смотреть после игры стоит.
  const freshNames = new Set(fresh.map((g) => g.fileName));
  const freshEvals = imitation.evals.filter((e) => freshNames.has(e.name));
  if (previous !== undefined && freshEvals.length > 0) {
    console.log('');
    console.log('═══ свежие партии по отдельности ═══');
    for (const e of freshEvals) {
      console.log(
        `${e.name}: место ${String(e.finalPlace)}, решений ${String(e.instances)}, ` +
          `угадано моделью ${pct(e.hitModel)}, советником ${pct(e.hitAdvisor)}`,
      );
    }
    const nameOf = (id: string | null): string =>
      id === null ? '?' : (cards.info(id)?.name ?? id);
    const missed = build.instances
      .filter((i) => freshNames.has(i.gameName))
      .map((inst) => ({ inst, advisor: advisorPick(inst) }))
      .filter(({ inst, advisor }) => advisor !== null && !inst.boughtCardIds.has(advisor));
    for (const { inst, advisor } of missed.slice(0, 8)) {
      console.log(
        `  ход ${String(inst.turn)}: советник → ${nameOf(advisor)}, ` +
          `игрок купил ${[...inst.boughtCardIds].map(nameOf).join(', ')}`,
      );
    }
    if (missed.length > 8) {
      console.log(`  …и ещё ${String(missed.length - 8)} расхождений`);
    }
  }

  // Печатается ВСЕГДА: соблазн прочитать дрожание как результат возникает
  // ровно здесь, и отвечать на него должен сам инструмент.
  const newGames = games.length - BASELINE_GAMES;
  const left = REMEASURE_AFTER - newGames;
  console.log('');
  console.log('═══ как это читать ═══');
  console.log('Это МОНИТОРИНГ, а не вердикт: решения по этим числам не принимаются.');
  console.log(
    `Новых партий с замеров 18–19.08: ${String(Math.max(0, newGames))} из ${String(REMEASURE_AFTER)}; ` +
      (left > 0
        ? `до предрегистрированного перезамера ещё ${String(left)}.`
        : 'перезамер РАЗРЕШЁН — гоняйте ml:eval и ml:imitation и дописывайте docs/ml.md.'),
  );
  console.log(
    `Сдвиг меньше МРЭ (${num(placeMde)} места и ${pp(hitMde)}) — шум выборки, а не «стало лучше»: ` +
      'одна партия двигает среднее по партиям примерно на 1/N.',
  );
  console.log('После каждой игры смотреть стоит на расхождения выше, а не на проценты.');

  const entry: TrackEntry = {
    at: new Date().toISOString(),
    games: games.length,
    points,
    instances: build.instances.length,
    gameFiles: data.games.map((g) => g.fileName),
    placeMaeModel: place.maeModel,
    placeMaeCurrent: place.maeCurrent,
    placeMaeMean: place.maeMean,
    placeDelta: placeDelta.mean,
    hitModel,
    hitAdvisor,
    hitRandom,
    hitDelta: hitDelta.mean,
  };
  const lines = [...history.map((h) => JSON.stringify(h)), JSON.stringify(entry)];
  writeFileSync(TRACK_LOG, `${lines.join('\n')}\n`, 'utf8');
  console.log('');
  console.log(`прогон записан: ${TRACK_LOG} (строк ${String(lines.length)})`);
}

main();
