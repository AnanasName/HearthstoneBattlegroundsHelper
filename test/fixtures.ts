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
 * Партия 17 — 15.08.2026 (15:57–16:22), девятая партия с оверлеем,
 * элементали, **1-е место**. Четыре пункта обратной связи по пяти
 * скриншотам, из них два вопроса и две жалобы. Фактура: заклинание
 * витрины, дающее миньона (Enchanted Lasso — «Steal a random minion from
 * the Tavern», 2 золота), склеенный золотой вариант в тексте снапшота
 * (Fortify: «+{1} Health and Taunt.3[x]…»), миньон с триггером о себе
 * (Wildfire Elemental — «After this attacks…»), заморозка при полном борде
 * из миньонов в сотни статов.
 */
export function part17Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part17', 'game.log'), 'utf8');
}

/**
 * Партия 18 — 16.08.2026 (21:47–22:11), десятая партия с оверлеем (наги
 * на заклинаниях, 4-е место) и ПЕРВАЯ с планом трат хода: все три пункта
 * обратной связи — про него. Фактура: карта, чья ценность реализуется
 * продажей (River Skipper), обратная сторона синергии по механике (нага
 * со Spellcraft на борде, живущем заклинаниями), платное обновление
 * на остаток золота после подъёма.
 */
export function part18Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part18', 'game.log'), 'utf8');
}

/**
 * Партия 19 — 16–17.08.2026 (23:51–00:20), одиннадцатая партия с оверлеем
 * (Nightmare Lord Xavius, демоны, **1-е место**). Четыре пункта обратной
 * связи. Фактура: заморозка заклинания, пережившая подъём таверны
 * (Enchanted Lasso в витрине хода 3), модальное заклинание «Choose One»
 * с ветвями отдельными картами снапшота (Alliance Flag → Allied Mace
 * +3/+1 и Allied Buckler +1/+3, теги NUM_1..4 = 3,1,1,3), миньон с ралли
 * вторым номером расстановки (Tusked Camper), аура на чужих в жертвах
 * продажи (Brann Bronzebeard 27/29 при борде в сотни статов).
 */
export function part19Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part19', 'game.log'), 'utf8');
}

/**
 * Партия 20 — 17.08.2026 (14:34–15:02), двенадцатая партия с оверлеем
 * (пираты-квилбоары, **1-е место** при 3 hp). Фактура ШКАЛЫ ХОДОВ: игрок
 * пожаловался, что подъём таверны советуется слишком часто, и показал ход 15
 * — восьмой ход таверны, тир 5, десять золота, hp 22, седьмое место, где
 * советник числил отставание от кривой в два тира. Таверну игрок там
 * не поднял (тир 6 взял только на четырнадцатом ходу таверны) и партию
 * выиграл.
 */
export function part20Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part20', 'game.log'), 'utf8');
}

/**
 * Партия 21 — 17.08.2026 (15:47–16:12), тринадцатая партия с оверлеем
 * (наги на заклинаниях, 2-е место). Два пункта обратной связи, оба про
 * ЗАКЛИНАНИЯ НА МИНЬОНА. Фактура: магниты заклинаний (Lava Lurker
 * `BG23_009` — «The first Spellcraft spell played from hand on this each
 * turn is permanent», заряд в живом теге TAG_SCRIPT_DATA_NUM_1; Fleeing
 * Fugitive `BG36_921` — «Whenever you cast a spell on this, gain +{0}
 * Health», у нас {0}=1), временное усиление («+2 Attack until next turn»
 * у чародейского токена Mini-Trident `BG23_000t`), носитель ралли
 * с призывом ИЗ РУКИ (Expert Aviator `BG34_140` — из-за него в симулятор
 * поехала рука).
 */
export function part21Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part21', 'game.log'), 'utf8');
}

/**
 * Партия 22 — 17.08.2026 (17:23–17:53), четырнадцатая партия с оверлеем
 * (Грибомант Флургл `TB_BaconShop_HERO_55`, мурлоки, **1-е место**). Пять
 * пунктов обратной связи, три из них об одном: РУКА — ЭТО ПОЗИЦИЯ.
 *
 * Фактура: миньоны, работающие ИЗ руки (Flighty Scout `BG32_330` — «Start
 * of Combat: If this minion is in your hand, summon a copy of it»; Bream
 * Counter `BG26_137` — «While this is in your hand, after you play
 * a Murloc, gain +{0}/+{1}», к ходу 23 вырос до 670/668), и миньоны,
 * которые рукой ПИТАЮТСЯ (Costume Enthusiast `BG34_142` — «Gain the Attack
 * of the highest-Attack minion in your hand»). Все 14 карт пула
 * с «in your hand» — мурлоки.
 *
 * Здесь же сила героя, называющая продажу и племя («Рыбалка»
 * `TB_BaconShop_HP_056`: «After you sell 5 minions, get a random Murloc»),
 * и Бранн `BG_LOE_077` при выборе из кличевых карт (`BG35_143` —
 * «Battlecry and Deathrattle: Get a Deepwater Clan»).
 */
export function part22Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part22', 'game.log'), 'utf8');
}

/**
 * Партия 23 — 17.08.2026 (19:21–19:42), пятнадцатая партия с оверлеем
 * (Nightmare Lord Xavius `BG36_HERO_105`, мехи с пиратами, 7-е место).
 * Три пункта обратной связи, и все три — про ЦЕНУ ДЕЙСТВИЯ В ЗОЛОТЕ.
 *
 * Фактура: план, запирающий остаток (ход 5 — пять золота, тёмный дар за 3
 * и два сгоревших при прокрутке Oozeling Gladiator `BG27_002` за чистых 2);
 * заклинание витрины, называющее ТИР (Recruit a Trainee `BG28_504` — «Get
 * a random Tier 1 minion» за 2, на третьем тире оценивалось средним
 * по витрине); заклинание витрины ДОРОЖЕ покупки (Planar Telescope
 * `BG28_521` — «Discover a minion of your most common type» за 4, держало
 * витрину при нулевом золоте); заклинание бесплатных обновлений (Leaf
 * Through the Pages `BG28_827` — «Gain 2 free Refreshes» за 1, советнику
 * было невидимо).
 *
 * Здесь же лог показывает, ЧТО такое тёмный дар: блок PLAY на кнопке
 * `BG36_Button_DarkGift` открывает `ChoiceType=GENERAL` с источником
 * «Battlegrounds Dark Gift [DNT]» и ТРЕМЯ МИНЬОНАМИ в `Entities[0..2]` —
 * раскопка чужого тела с даром, а не усиление своего.
 */
export function part23Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part23', 'game.log'), 'utf8');
}

/**
 * Партия 24 — 17.08.2026 (21:03–21:28), шестнадцатая партия с оверлеем
 * (Тесс Златопряха `TB_BaconShop_HERO_35_SKIN_E`, демоны, 5-е место).
 * Четыре пункта обратной связи; вместе с ней игрок прислал ТАБЛИЦУ ТИРОВ
 * тёмного дара, которой не хватало с part23.
 *
 * Фактура: заклинание витрины, дающее золото (Hasty Excavation `BG28_571`,
 * «Gain 1 Gold» — план обещал «откроется покупка», а золото до следующего
 * шага не доезжало); активация-поглощение (Soulkeeping Jailer `BG36_503`,
 * «Activate ({0}): Your Demons each consume a random minion in the Tavern
 * to gain its stats» — семь демонов и витрина по 24 стата); канонический
 * подъём на шести золотых (ход 7, четвёртый ход таверны, цена 5, остаток 1);
 * витрина ВТОРОГО тира, целиком набранная картами ПЕРВОГО (ход 3).
 */
export function part24Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part24', 'game.log'), 'utf8');
}

/**
 * Партия 25 — 17.08.2026 (22:44–23:15), семнадцатая партия с оверлеем
 * (Murozond, Unbounded `BG34_HERO_000`, 3-е место). Два пункта обратной
 * связи, и оба про ОДНУ механику: карту, чьё обещание отдаёт ПРОДАЖА.
 *
 * Фактура: River Skipper `BG33_140` («When you sell this, get a random Tier
 * 1 minion») в витрине хода 3 при НУЛЕВОМ золоте — игрок заморозил витрину
 * сам (22:46:41) и на ходу 5 разменял пять золотых на ДВА тела: купил
 * скипера за 3, продал за 1 (пришёл Tusked Camper) и купил ещё одного.
 * Patient Scout `BG24_715` («When you sell this, Discover a Tier 1 minion»)
 * в витрине хода 7: та же цепочка за чистых 2, а следом Ominous Seer
 * `BG31_330` («Battlecry: The next Tavern spell you buy costs (1) less»)
 * удешевил Enchanted Lasso `BG28_512` до одного золота — шесть золота
 * превратились в три тела. Советник предлагал поднять таверну за 5 из 6
 * с горящей монетой (третий такой случай подряд, см. part23 и part24).
 */
export function part25Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part25', 'game.log'), 'utf8');
}

/**
 * Партия 26 — 18.08.2026 (00:28–00:54), восемнадцатая партия с оверлеем
 * (Мастер Нгуен `BG20_HERO_202`, 4-е место). Два пункта обратной связи,
 * и оба про ВЫБОР, который советник не брался оценивать.
 *
 * Фактура: Нгуен меняет силу героя КАЖДЫЙ ход — `ChoiceType=GENERAL`
 * с источником «Сменяет силу героя» (`BG20_HERO_202pt`) и двумя чужими
 * силами в вариантах (за партию их 24: от `TB_BaconShop_HP_020`
 * до `BG34_HERO_001p`). Здесь же «Дружеская ставка» `TB_BaconShop_HP_081`
 * («Guess which player will win their next combat. If you're correct, get
 * 3 Tavern Coins») — выбор из двух ГЕРОЕВ, то есть из двух игроков лобби,
 * и «Наемный детектив» `BG23_HERO_303p2`, угадывающий миньона следующего
 * противника (угадал: ход 7, витрина монеты `BG28_810`).
 */
export function part26Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part26', 'game.log'), 'utf8');
}

/**
 * Партия 27 — 26.08.2026 (16:15–16:42), девятнадцатая партия с оверлеем
 * и ПЕРВАЯ на билде 250339 (все прежние — 248348): пираты, 3-е место.
 * Три пункта обратной связи по трём скриншотам, и все три — про состояние
 * ПОСРЕДИ хода, после трат, которого точки решения не видят.
 *
 * Фактура: заморозка ради Enchanted Lasso `BG28_512`, которую план обещал
 * вторым шагом («КУПИТЬ Risen Rider → ЗАМОРОЗИТЬ») и которая исчезла после
 * покупки Crackling Cyclone — второго из двух РАВНЫХ (6.0) миньонов
 * витрины (ход 1); замороженная витрина, ДОЗАПОЛНЕННАЯ свежей картой
 * в купленном слоте (ход 3: Molten Rock рядом с Risen Rider и Harmless
 * Bonehead); «Slimy Shield» `BG27_002t` (+1/+1 и провокация) на Oozeling
 * Gladiator 3/3 при Molten Rock 4/4 `BGS_127` («After you play an
 * Elemental…» — тавернный триггер, не боевой) на борде (ход 7); совет
 * «ОБНОВИТЬ» при нулевом золоте, полном борде и бесплатном обновлении
 * (ход 19, пара Dual-Wield Corsair `BG31_824` на борде).
 */
export function part27Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part27', 'game.log'), 'utf8');
}

/**
 * Партия 28 — 26.08.2026 (23:11–23:27), двадцатая партия с оверлеем
 * и вторая на билде 250339: Galakrond `TB_BaconShop_HERO_02`, квилбоары,
 * 8-е место. Пункт обратной связи один, и он про МОДАЛЬНЫЙ ВЫБОР миньона:
 * «на 1 скриншоте мне не предложило лучший выбор».
 *
 * Фактура: Snare Trapper `BG36_332` (тир 4, квилбоар 4/4, механика
 * `CHOOSE_ONE`) с ветвями-картами `BG36_332t` Ensnare the Target («Get
 * a random Quilboar») и `BG36_332t2` Collect the Bounty («Increase your
 * maximum Gold by {0}», {0}=1 живым тегом `TAG_SCRIPT_DATA_NUM_1`).
 * Ветви приходят сущностями в `SETASIDE` с тегом `PARENT_CARD` ЕЩЁ ПРИ
 * ПОЯВЛЕНИИ карты в витрине (23:19:38), а не при розыгрыше (23:20:31), —
 * то есть открытый экран выбора из лога не виден вовсе, и канал выборов
 * (`DebugPrintEntityChoices`) тут молчит. Какую ветвь выбрал игрок,
 * говорит поле `SubOption` блока PLAY: `SubOption=0` — первая, квилбоар,
 * и пришёл им Roadboar `BG20_101` (тир 2 при таверне 4, то есть пул тиров
 * 1..N). Здесь же подтверждение, что предел золота поднимается ВЫШЕ
 * десяти: тег `RESOURCES` в part27 доходил до 19, в part28 у соперника
 * до 11.
 */
export function part28Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part28', 'game.log'), 'utf8');
}

/**
 * Партия 29 — двадцать первая с оверлеем (27.08.2026, 01:07–01:31,
 * Scoutmaster Tavish `BG22_HERO_000_SKIN_A`, 3-е место), третья на билде
 * 250339. Пять пунктов обратной связи по пяти скриншотам.
 *
 * Фактура:
 *
 *  - **бесплатная сила героя с ЦЕЛЬЮ В ВИТРИНЕ** — «Lock and Load»
 *    `BG22_HERO_000p_Alt` («Remove a minion in the Tavern. When you have
 *    space next combat, fire it at a random enemy minion»): активная
 *    (`HAS_ACTIVATE_POWER`), без тега `COST`, нажата 13 раз за партию.
 *    Применение — блок `PLAY` на сущности силы с `Target=` миньоном
 *    витрины; копия цели уходит в `SETASIDE` под наш контроллер
 *    (`TAG_SCRIPT_DATA_ENT_1`), заряд `TAG_SCRIPT_DATA_NUM_1` 0 → 1,
 *    сам миньон — в `REMOVEDFROMGAME`, а в начале боя заряд тратится
 *    обратно в ноль;
 *  - **цена В ЗДОРОВЬЕ** — тег `BACON_COSTS_HEALTH_TO_BUY=1` на карте
 *    витрины (Hasty Excavation `BG28_571`, «Gain 1 Gold. This costs Health
 *    to buy instead of Gold», `COST=3`). Покупка в логе: `META_DATA -
 *    Meta=SPEND_HEALTH Data=3`, броня героя 14 → 11 и тут же обратно 14
 *    триггером Soul Rewinder `BG26_174` («After your hero takes damage,
 *    rewind it and give this +1 Health») — то есть здоровье вернулось;
 *  - **тройка считает копии В РУКЕ** — тег `BACON_PAIR_CANDIDATE` игра
 *    ставит на карту витрины и тогда, когда единственная наша копия лежит
 *    в руке (part29 ход 23 `BG31_330`, part22 — шесть таких случаев);
 *  - **заморозка ради предложения дешевле покупки** на ходах 5 и 7:
 *    шесть и семь золота следующего хода, где лишнего тела уже не выходит.
 */
export function part29Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part29', 'game.log'), 'utf8');
}

/**
 * Партия 30 — двадцать вторая с оверлеем (27.08.2026, 19:55–20:23,
 * Крысиный король `TB_BaconShop_HERO_12`, 3-е место), четвёртая на билде
 * 250339. Четыре пункта обратной связи по четырём скриншотам.
 *
 * Фактура:
 *
 *  - **платная сила героя «Discover a \<Tribe\>»** — «A Tale of Kings»
 *    `TB_BaconShop_HP_041`: каждый ход в `PLAY` приходит НОВАЯ сущность
 *    варианта (`…041b` King of Mechs, `…041g` Pirates, `…041i` Quilboar…),
 *    `COST=2` живым тегом. 10 нажатий за партию; на ходу 1 игрок нажал
 *    силу (19:56:49), разыграл найденного Cord Puller `BG29_611` из руки
 *    (19:56:55) и купил Tavern Dish Banana `BG28_897` на него (19:56:58) —
 *    ровно та цепочка, вместо которой советник предлагал «просто купить»;
 *  - **заклинание, бьющее ПО ВИТРИНЕ** — Them Apples `BG28_966` («Give
 *    minions in the Tavern +{0}/+{1}»): блок PLAY с `Target=0`, энчант
 *    ложится на миньонов `player=10` (витрина), NUM_1=1/NUM_2=2 → +1/+2;
 *  - **золото СЛЕДУЮЩЕГО хода** — Careful Investment `BG28_800` («Gain 2
 *    Gold next turn», `COST=1`): куплено в 20:14:44, золото этого хода
 *    не растёт;
 *  - **обновление как сток сгорающего золота** — ход 19, золото 1/10,
 *    борд полон, в витрине ничего дешевле трёх: игрок потратил последний
 *    золотой на обновление (кормит «Whenever you spend 5 Gold…»
 *    Dual-Wield Corsair `BG31_824` и «After you spend {2} Gold…»
 *    Enterprising Escapee `BG36_523`), а совет говорил «НИЧЕГО».
 */
export function part30Game(): string {
  return readFileSync(join(FIXTURES_DIR, 'part30', 'game.log'), 'utf8');
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
