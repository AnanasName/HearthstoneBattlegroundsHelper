/**
 * Обновление снапшота статистики Battlegrounds.
 *
 *   npm run update:bgstats
 *
 * Сеть — только по явной команде, как у снапшота карт; в рантайме статистика
 * берётся с диска. Источник — открытые данные Firestone (та же экосистема,
 * что симулятор и снапшот карт, идентификаторы карт совпадают с нашими):
 * средние места героев и тринкетов по реальным партиям.
 *
 * Зачем: советник честно говорил «оценить не берёмся» про тринкеты вне
 * племён и вовсе молчал при выборе героя. Статистика мест — данные,
 * а не чьё-то мнение, и на «оценить не берёмся» она отвечает числом.
 *
 * Статистика привязана к патчу (`last-patch`) и устаревает вместе с ним —
 * обновлять вместе со снапшотом карт. Срез MMR — mmr-100, то есть все
 * игроки: наш игрок ближе к среднему, чем к топ-1%.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { BG_STATS_DIR, HERO_STATS_PATH, TRINKET_STATS_PATH, loadBgStats } from './bgStats.js';

const HERO_SOURCE =
  'https://static.zerotoheroes.com/api/bgs/hero-stats/mmr-100/last-patch/overview-from-hourly.gz.json';
const TRINKET_SOURCE =
  'https://static.zerotoheroes.com/api/bgs/trinket-stats/last-patch/overview-from-hourly.gz.json';

function describeCurrent(): string {
  try {
    const stats = loadBgStats();
    return `${String(stats.heroCount)} героев, ${String(stats.trinketCount)} тринкетов`;
  } catch {
    return 'нет';
  }
}

async function download(source: string, path: string, rootKey: string): Promise<number> {
  console.log(`качаю ${source}`);
  const response = await fetch(source);
  if (!response.ok) throw new Error(`источник ответил ${String(response.status)}`);

  const text = await response.text();
  const parsed: unknown = JSON.parse(text);
  const list = (parsed as Record<string, unknown>)[rootKey];
  if (!Array.isArray(list) || list.length === 0) {
    // Мусор поверх рабочего снапшота хуже, чем не обновиться.
    throw new Error(`источник вернул не массив ${rootKey}`);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  console.log(`записано ${path}: ${String(list.length)} записей`);
  return list.length;
}

async function main(): Promise<void> {
  console.log(`сейчас на диске: ${describeCurrent()}`);
  await download(HERO_SOURCE, HERO_STATS_PATH, 'heroStats');
  await download(TRINKET_SOURCE, TRINKET_STATS_PATH, 'trinketStats');
  writeFileSync(
    `${BG_STATS_DIR}/README.md`,
    'Снапшот статистики Battlegrounds из открытых данных Firestone\n' +
      '(static.zerotoheroes.com, срез last-patch, mmr-100 — все игроки).\n' +
      `Обновлено: ${new Date().toISOString()}\n` +
      'Обновлять вместе со снапшотом карт: npm run update:bgstats\n',
    'utf8',
  );
  console.log('проверьте после обновления: npm test\nснапшот коммитится — он часть данных, а не кэш');
}

void main();
