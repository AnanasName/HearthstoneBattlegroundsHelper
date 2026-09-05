import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadDataset } from './dataset.js';
import { fitPlaceModel, PLACE_MODEL_PATH, usableForPlaceModel } from './placeModel.js';
import { filterGames, formatProvenance, parseDatasetFilter } from './provenance.js';

/**
 * `npm run ml:fit` — переобучить снапшот прогноза места из датасета.
 *
 * Отдельная команда, а не побочный эффект замера: `ml:eval4` ОЦЕНИВАЕТ
 * (LOGO, полосы, вердикт по предрегистрации), а эта — ПЕЧЁТ веса
 * для рантайма. Смешать их значило бы переобучать продукт каждым прогоном
 * замера, в том числе когда вердикт вышел «не доказано».
 *
 * Печатает паспорт выборки теми же строками, что замеры (`formatProvenance`),
 * и числа, которые уедут в файл: подпись на экране оверлея берётся из них,
 * и увидеть её надо здесь, а не потом в игре.
 *
 * Умолчание выборки — СВОИ партии, как у всех читателей датасета: чужая
 * партия с другим уровнем игры сдвинула бы веса молча (docs/ml.md,
 * `src/ml/provenance.ts`).
 */
function main(): void {
  const filter = parseDatasetFilter(process.argv.slice(2));
  const data = loadDataset();

  console.log(`билд: ${String(data.build ?? 'неизвестен')}`);
  for (const line of formatProvenance(data.games, filter)) console.log(line);

  const selected = filterGames(data.games, filter);
  const usable = usableForPlaceModel(selected);
  for (const g of selected) {
    if (!usable.includes(g)) console.log(`без таблицы лобби, исключено: ${g.fileName}`);
  }

  if (usable.length < 5) {
    console.log('партий меньше пяти — обучать нечего, стоп.');
    return;
  }

  const snapshot = fitPlaceModel(usable, new Date());

  mkdirSync(dirname(PLACE_MODEL_PATH), { recursive: true });
  writeFileSync(PLACE_MODEL_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  const fmt = (x: number): string => x.toFixed(3);
  console.log('');
  console.log(`обучено: партий ${String(snapshot.games)}, точек ${String(snapshot.points)}`);
  console.log(
    `LOGO той же выборки: модель ${fmt(snapshot.maeModel)} | таблица ${fmt(snapshot.maeCurrent)} | ` +
      `среднее место ${fmt(snapshot.maeMean)} (D̄ ${fmt(snapshot.dBar)})`,
  );
  console.log(`на экране это «ожидаемое место … ± ${snapshot.maeModel.toFixed(1)}»`);
  console.log(`записано: ${PLACE_MODEL_PATH}`);
}

main();
