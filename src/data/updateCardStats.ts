/**
 * Обновление снапшота статистики ОТДЕЛЬНЫХ КАРТ Battlegrounds.
 *
 *   npm run update:cardstats
 *   npm run update:cardstats -- --out <путь>
 *
 * Сеть — только по явной команде, как у карт и статистики героев. Источник
 * тот же, что у уже подключённых героев и тринкетов: открытые данные
 * Firestone; идентификаторы карт совпадают с нашими (926 из 926).
 *
 * ## Сегмент `mmr-100` в URL обязателен
 *
 * Вариант без него отвечает 200 и выглядит правдоподобно, но это СУММА
 * пяти перекрывающихся корзин MMR, а не другая популяция: у BG20_100
 * `totalPlayed` там 478 738 = 248 088 + 129 544 + 67 717 + 29 510 + 3 879,
 * а корневой `dataPoints` ровно в пять раз больше. Двойной счёт молча
 * раздувает выборку и делает пороги бессмысленными.
 *
 * ## Что в записи
 *
 * `cardId`, `totalPlayed`, `averagePlacement`, `averagePlacementOther`
 * и `turnStats[]`. Полей `dataPoints`, `pickRate`, `standardDeviation`,
 * в отличие от героев и тринкетов, НЕТ — порог малой выборки считается
 * по `totalPlayed`. Золотых версий в источнике нет вовсе.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { CARD_STATS_PATH } from './cardStats.js';

/**
 * Срез: все игроки (mmr-100), текущий патч. Тот же выбор, что у героев:
 * наш игрок ближе к среднему, чем к топ-1%.
 */
const CARD_SOURCE =
  'https://static.zerotoheroes.com/api/bgs/card-stats/mmr-100/last-patch/overview-from-hourly.gz.json';

function outPath(argv: readonly string[]): string {
  const i = argv.indexOf('--out');
  return i === -1 ? CARD_STATS_PATH : (argv[i + 1] ?? CARD_STATS_PATH);
}

async function main(): Promise<void> {
  const path = outPath(process.argv.slice(2));
  console.log(`качаю ${CARD_SOURCE}`);

  const response = await fetch(CARD_SOURCE);
  if (!response.ok) throw new Error(`источник ответил ${String(response.status)}`);

  const text = await response.text();
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const list = parsed['cardStats'];
  if (!Array.isArray(list) || list.length === 0) {
    // Мусор поверх рабочего снапшота хуже, чем не обновиться.
    throw new Error('источник вернул не массив cardStats');
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  console.log(
    `записано ${path}: ${String(list.length)} записей, ` +
      `срез ${String(parsed['timePeriod'])}, обновлён ${String(parsed['lastUpdateDate'])}`,
  );
}

void main();
