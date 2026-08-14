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
 * Партия 11 — 14.08.2026, третья партия с оверлеем (Сильвана, 3-е место).
 * Семь пунктов обратной связи. Фактура: заряды тёмного дара
 * (TAG_SCRIPT_DATA_NUM_2 на кнопке), карты-смертники из «Восстания
 * из гробницы» (энчант TB_BaconShopBadsongE), заклинания витрины
 * (CARDTYPE=BATTLEGROUND_SPELL с ценой в COST), тег CARDRACE строками.
 */
export function part11Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part11', 'game.log'), 'utf8');
}

/**
 * Партия 12 — 14.08.2026, четвёртая партия с оверлеем (E.T.C., 2-е место),
 * три пункта обратной связи. Фактура: сила «Discover a Buddy», племя
 * тринкета тегом BACON_SUBSET_<RACE> (текст — плейсхолдер {0}),
 * заклинание витрины Fortify с целью.
 */
export function part12Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part12', 'game.log'), 'utf8');
}

/**
 * Партия 13 — 14.08.2026, пятая партия с оверлеем (Хроми, 4-е место),
 * первая после цели-поля. Пять пунктов обратной связи. Фактура: активная
 * бесплатная сила героя (HAS_ACTIVATE_POWER без COST), модальный выбор,
 * не меняющий ничего кроме себя, магнит с даром (Рука-протез:
 * Magnetic+Reborn, к мехам и нежити), заклинание-жертва («Разделка туши»:
 * Destroy a friendly Undead).
 */
export function part13Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part13', 'game.log'), 'utf8');
}

/**
 * Партия 14 — 14.08.2026, шестая партия с оверлеем (Сильвана, 5-е место),
 * три пункта обратной связи. Фактура: заклинание-замена от тринкета
 * (наклейка Тюремщика, Spellcraft: «Destroy a friendly Undead to get
 * a random Undead»), активации миньонов (HAS_ACTIVATE_POWER +
 * INTERACTABLE_OBJECT_COST, применение блоком PLAY на стоящей в PLAY
 * сущности — Suspicious Prisonguard).
 */
export function part14Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part14', 'game.log'), 'utf8');
}

/**
 * Партия 15 — 14.08.2026, седьмая партия с оверлеем (Доктор Холли'дэй),
 * пять пунктов обратной связи. Фактура: платная сила героя, дающая
 * заклинание таверны («Get a random Tavern spell», COST=1,
 * HAS_ACTIVATE_POWER), заморозка пары первого тира (Buzzing Vermin),
 * миньоны-усилители механик (Titus Rivendare, Deathstrider), заклинание
 * без выбора цели (Misplaced Tea Set, «of each type»), заклинание
 * с провокацией (Slimy Shield) на борде с движками.
 */
export function part15Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part15', 'game.log'), 'utf8');
}

/**
 * Партия 16 — 14.08.2026 (23:00–23:30), восьмая партия с оверлеем,
 * АПМ-пираты, четыре пункта обратной связи. Фактура: батлкрай-генератор
 * карт (Oozeling Gladiator — прокрутка «купить-разыграть-продать»),
 * тавернный бафф соседям (Surfing Sylvar, END_OF_TURN + adjacent),
 * нецелевое заклинание с числительным (Healthy Bounty, «four friendly»),
 * энчант Badsong на картах от БЕЗОБИДНЫХ источников (Friendly Bounty,
 * Chef's Choice, награда за тройку) — смертность несёт текст создателя.
 */
export function part16Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part16', 'game.log'), 'utf8');
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
