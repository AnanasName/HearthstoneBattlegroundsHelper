import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { splitLogLines } from '../src/parser/logLine.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Корень с фикстурами: реальные Power.log, снятые с игры. */
export const FIXTURES_DIR = join(here, '..', 'data', 'fixtures');

/**
 * Партия 1 — полная партия Battlegrounds от выбора героя до финального места,
 * снятая 03.08.2026 в четыре приёма через перезапуск клиента посреди игры
 * (обход предела 10000 КБ, см. docs/power-log.md).
 */
export function part1Segment(n: 1 | 2 | 3 | 4): string {
  return readFileSync(join(FIXTURES_DIR, 'part1', `segment${String(n)}.log`), 'utf8');
}

/** Строки сегмента. Разбиение через splitLogLines — в логе смешаны CRLF и LF. */
export function part1SegmentLines(n: 1 | 2 | 3 | 4): string[] {
  return splitLogLines(part1Segment(n));
}

/**
 * Партия 2 — эталонная: полная партия Battlegrounds одним файлом, без
 * переподключений и без провалов. 41 МБ, 301 289 строк, 23 минуты.
 * Снята после снятия предела размера логов через client.config.
 */
export function part2Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part2', 'game.log'), 'utf8');
}

/**
 * Партия 3 — снята вместе со скриншотами игрока, поэтому её контрольные точки
 * проверены изображением, а не памятью. Скриншоты в data/screenshots/.
 */
export function part3Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part3', 'game.log'), 'utf8');
}

/**
 * Партия 4 — снята 13.08.2026 на билде 248348, первая после патча: аномалий
 * в ней уже нет, вместо них тёмные дары, и 41 карта из 216 не была известна
 * прежнему снапшоту. Ею калибруются предсказания — правила и статы меняются
 * с патчем, поэтому записанный исход относится к своему билду.
 */
export function part4Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part4', 'game.log'), 'utf8');
}

/** Партии 5–7 — три партии 13.08.2026 одним заходом клиента, билд 248348. */
export function part5Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part5', 'game.log'), 'utf8');
}

export function part6Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part6', 'game.log'), 'utf8');
}

export function part7Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part7', 'game.log'), 'utf8');
}

/**
 * Партия 8 — Скаббс Маслорез, 13.08.2026, билд 248348. Сыграна игроком
 * специально для фактуры активной силы героя: сила «I Spy» за 2 золота
 * нажата 10 раз. Здесь же тринкет с замком выдаёт карту в руку
 * с LITERALLY_UNPLAYABLE — случай, на котором советник предлагал
 * разыграть неиграбельное.
 */
export function part8Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part8', 'game.log'), 'utf8');
}

/**
 * Партия 9 — Зирелла, 13.08.2026, билд 248348, сыграна игроком с работающим
 * оверлеем: пять скриншотов советов легли в обратную связь. Фактура для
 * модальных выборов (лавка аксессуаров, раскопка, награда за тройку — канал
 * `DebugPrintEntityChoices`), магнитных мехов и силы героя, дающей миньона
 * с местоимением вместо слова «minion» в тексте.
 */
export function part9Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part9', 'game.log'), 'utf8');
}

/**
 * Партия 10 — 14.08.2026, вторая партия с оверлеем, сыграна сразу после
 * правок по part9. Восемь пунктов обратной связи по восьми скриншотам:
 * мнимая синергия заморозки (амальгамы и золотые копии), плоский порог
 * заморозки, «дракон продаёт дракона», тройка через продажу, немая монетка
 * таверны и бафф-заклинания, остаток золота при подъёме, выбор из
 * сокровищ-заклинаний. Здесь же фактура заклинаний руки: CARDTYPE=SPELL,
 * живой COST монетки, плейсхолдеры {N} и TAG_SCRIPT_DATA_NUM.
 */
export function part10Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part10', 'game.log'), 'utf8');
}

/**
 * Та же фикстура байтами, без разбора в строку.
 *
 * Нужна живому режиму: он читает файл порциями произвольной границы, и порция
 * может разрезать многобайтовый символ. Проверять склейку на уже разобранном
 * тексте бессмысленно — там резать нечего.
 */
export function fixtureBytes(part: 'part2' | 'part3'): Buffer {
  return readFileSync(join(FIXTURES_DIR, part, 'game.log'));
}
