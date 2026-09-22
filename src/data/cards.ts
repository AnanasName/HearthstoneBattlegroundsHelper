import { readFileSync } from 'node:fs';

import { CARDS_PATH } from '../app/paths.js';

/**
 * Справочник карт: cardId → племя, тир, статы.
 *
 * Источник — тот же снапшот Firestone, что кормит симулятор
 * (`data/cards/cards_enUS.json`, 35 321 карта, из них 1833 с `techLevel`).
 * Коллекционный срез HearthstoneJSON из ТЗ здесь не годится по той же причине,
 * что и для симулятора: в нём нет ни `techLevel`, ни `races`, ни `isBaconPool`.
 *
 * Советнику таверны это нужно затем, что в логе у миньона есть `TECH_LEVEL`,
 * но нет племени: теги `BACON_SUBSET_*` означают принадлежность карты к
 * подмножеству, а не племя миньона, и на борде их нет вовсе.
 */

/** Поля снапшота, которые нам нужны. Остальные игнорируются. */
interface RawCard {
  readonly id?: unknown;
  readonly dbfId?: unknown;
  readonly name?: unknown;
  readonly text?: unknown;
  readonly techLevel?: unknown;
  readonly races?: unknown;
  readonly race?: unknown;
  readonly isBaconPool?: unknown;
  readonly attack?: unknown;
  readonly health?: unknown;
  readonly type?: unknown;
  readonly set?: unknown;
  readonly mechanics?: unknown;
}

export interface CardInfo {
  readonly id: string;
  /** Числовой идентификатор из базы игры — им лог называет тринкеты. */
  readonly dbfId: number | null;
  readonly name: string;
  /** Текст карты. Нужен тринкетам: их племя написано словами в тексте. */
  readonly text: string | null;
  /** Тир таверны. `null` у карт вне Battlegrounds. */
  readonly techLevel: number | null;
  /**
   * Племена карты.
   *
   * Их может быть несколько: у амальгам стоит `ALL`, и такая карта считается
   * своей для любого племени. Пустой список — нейтральный миньон.
   */
  readonly races: readonly string[];
  /** Входит ли в пул миньонов Battlegrounds — 526 карт из снапшота. */
  readonly isBaconPool: boolean;
  readonly attack: number | null;
  readonly health: number | null;
  /**
   * Тип карты, приведённый к верхнему регистру: MINION, SPELL,
   * BATTLEGROUND_TRINKET… В снапшоте регистр смешанный («Minion»,
   * «Battleground_trinket»), сравнение по сырому значению молча не совпадало бы.
   */
  readonly type: string | null;
  /**
   * Магнитный миньон — механика `MODULAR` в снапшоте.
   *
   * Проверено на part9: у Accord-o-Tron, Lullabot, Enchanted Sentinel
   * `mechanics` содержит MODULAR. У Glambot и тринкета Scraper Sticker
   * MODULAR стоит только в `referencedTags` — они про магнетизм говорят,
   * но сами не магнитятся, и здесь это честно `false`.
   */
  readonly magnetic: boolean;
  /**
   * Базовые плейсхолдеры карты — `TAG_SCRIPT_DATA_NUM_1..4` из снапшота.
   *
   * У сущности в логе эти числа ЖИВЫЕ (у Pointy Arrow 7/3 при счётчике 3/3),
   * и обычно читаются именно они. Но у карты, которую заклинание только
   * ОБЕЩАЕТ («Get 3 Pointy Arrows»), сущности ещё нет, а её числа уже нужны:
   * база из снапшота плюс живая надбавка заклинаниям таверны даёт ровно то,
   * что игра потом создаст (part52: база 4/0, в логе 7/3 при счётчике 3/3
   * и 8/4 при 4/4 — сверено на трёх картах, семь наблюдений).
   */
  readonly baseScriptData: readonly number[];
  /**
   * Механики карты как есть: DEATHRATTLE, REBORN, MODULAR…
   *
   * Нужны советнику для карт-смертников из «Восстания из гробницы»
   * (part11): розыгрыш в ход получения убивает миньона, и оправдан он
   * только предсмертным хрипом или перерождением.
   */
  readonly mechanics: readonly string[];
}

/** Племя, которое считается своим для любого другого. */
export const RACE_ALL = 'ALL';

export interface CardIndex {
  /** Карта по идентификатору. `null`, если такой в снапшоте нет. */
  readonly info: (cardId: string) => CardInfo | null;
  /**
   * Карта по dbfId.
   *
   * Лог называет тринкеты именно так: теги
   * `BACON_FIRST/SECOND_TRINKET_DATABASE_ID` несут числовой идентификатор.
   */
  readonly infoByDbfId: (dbfId: number) => CardInfo | null;
  /**
   * Миньоны пула Battlegrounds указанного тира.
   *
   * Нужны там, где текст карты называет ТИР, а не витрину: «Get a random
   * Tier 1 minion» (Recruit a Trainee) приносит миньона из пула первого тира,
   * и на четвёртом тире это совсем не то же, что средняя карта витрины
   * (part23, ход 11 — жалоба игрока: «получать за 2 золота существо из 1
   * таверны не настолько хорошая идея»).
   *
   * Золотые копии (`_G`) из пула исключены: в витрине и в наградах ходит
   * обычная версия, а золотая — та же карта, посчитанная дважды.
   */
  readonly poolOfTier: (techLevel: number) => readonly CardInfo[];
  /**
   * Карты набора Battlegrounds с этим именем — регистр и лишние пробелы
   * не важны.
   *
   * Нужны там, где текст карты обещает ДРУГУЮ КАРТУ по имени и без неё
   * не читается вовсе: «Get a Gem Day» (ветвь Кратерного старателя, part48)
   * про самоцветы не говорит ни слова, а вся ветвь именно про них. Тот же
   * приём уже применён к награде силы героя в part34 — только там поиск
   * шёл по пулу миньонов, а обещанной картой бывает и заклинание.
   *
   * Возвращается СПИСОК: имена в наборе не уникальны (1447 повторов
   * на 5612 карт — золотые копии, токены), и выбирать между ними должен
   * тот, кто знает, что ищет.
   */
  readonly byName: (name: string) => readonly CardInfo[];
  readonly size: number;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Плейсхолдеры карты из снапшота: `tags.TAG_SCRIPT_DATA_NUM_1..4` по порядку. */
function scriptDataOf(card: RawCard): number[] {
  const tags = (card as { readonly tags?: unknown }).tags;
  if (typeof tags !== 'object' || tags === null) return [];
  const bag = tags as Record<string, unknown>;
  const out: number[] = [];
  for (let i = 1; i <= 4; i += 1) {
    // Индексы плейсхолдеров сквозные: `{0}` в тексте — это NUM_1. Дырок
    // тут быть не должно, поэтому пропущенный тег — ноль, а не пропуск.
    out.push(asNumber(bag[`TAG_SCRIPT_DATA_NUM_${String(i)}`]) ?? 0);
  }
  return out;
}

function asRaces(card: RawCard): string[] {
  if (Array.isArray(card.races)) return card.races.filter((r): r is string => typeof r === 'string');
  return typeof card.race === 'string' ? [card.race] : [];
}

/**
 * Текст карты без приклеенного золотого варианта.
 *
 * В снапшоте у части заклинаний в поле `text` лежат ДВА текста подряд,
 * склеенные номером и маркером переносов: «Give a minion +{1} Health and
 * Taunt.**3[x]**Give a minion +{0}/+{1} and Taunt.» (Fortify, part17).
 * Второй — золотая версия. Разбор читал их как один текст и складывал числа
 * усиления обеих версий: у Fortify выходило «+6 статов» вместо +3, и совет
 * тихо переоценивал заклинание. Таких карт в снапшоте шесть, и все шесть —
 * заклинания-усиления, то есть ровно те, чьи числа мы читаем.
 *
 * Режется по первому «цифры + [x]» ПОСЛЕ начала текста: ведущий «[x]» —
 * обычная разметка переносов и остаётся на месте.
 *
 * ## И ПРОБЕЛЫ — В ОДИН
 *
 * Снапшот переносит строки ПОСРЕДИ предложения: у Southsea Busker текст
 * лежит как «Gain\n1 Gold next turn», у Archimonde — «After your hero takes
 * damage,\nrewind it». Это ВЁРСТКА карточки, а не текст: игра ставит перенос
 * там, где строка кончилась по ширине.
 *
 * Проект спотыкался об это ЧЕТЫРЕЖДЫ, и каждый раз чинил ОДИН шаблон:
 * смертники и бафф соседям (part16), «Summon⏎two 1/1 Skeletons» (part32),
 * «right- most» у платного края (part39). Урок был записан как «многословный
 * шаблон обязан писать `\s+` вместо пробела» — и не сработал: правило
 * помнят, пока пишут новый шаблон, а спотыкается о него следующий.
 * Пятым стал вопрос игрока по part46 («учитываешь ли ты пиратку, которая
 * даёт золото на следующий ход?»): не учитывал — шаблон экономики
 * `gain \d+ gold` требовал пробел, а в тексте стоял перенос, и слагаемое
 * молчало.
 *
 * Поэтому чинится КЛАСС, а не карта: пробельные последовательности
 * сводятся к одному пробелу здесь, при загрузке, и ни один шаблон больше
 * не обязан про это помнить. Шаблоны с `\s+` от этого не ломаются — один
 * пробел им подходит.
 *
 * Охват замерен ДО правки, по всем 3124 картам режима с текстом (1819
 * из них с переносом): читаться иначе станут 88, и вот они по ветвям —
 * экономика 5 (Southsea Busker, Snarling Conductor и золотые), плата
 * здоровьем 8 (это ЧЕТЫРЕ носителя из пяти: Archimonde, Ashen Corruptor,
 * Timewarped Rewinder, Timewarped Archimonde — читался только Soul
 * Rewinder), «даёт миньона» 4 (две силы героя и тринкет), временное
 * усиление 4, свой тир 3, заклинание таверны 3, магнит заклинаний 3,
 * ключевое слово от силы 2, «цель не выбирается» 46 (там почти всё —
 * миньоны с «your other minions», у которых цели и правда нет).
 */
/**
 * Разделитель золотого варианта: `3[x]` — или ГОЛАЯ ЦИФРА (part50).
 *
 * Обычно золотую версию отделяет «цифры + `[x]`», и по ней текст и резался
 * с part17. Но у трёх карт набора маркера `[x]` нет вовсе — цифра стоит
 * сразу после точки, а за ней заглавной буквой начинается повтор:
 *
 *   Butchering      «…+{0} Attack this game <i>(wherever they are).</i>5Destroy…»
 *   Healthy Bounty  «…friendly minions +{1} Health.4Give four friendly…»
 *   Hostile Bounty  «…friendly minions +{0} Attack.4Give four friendly…»
 *
 * Цена ровно та же, что в part17, и видна на part50: у Butchering числа
 * обеих версий складывались, и советник обещал «усиление перед боем
 * (+12 статов)» там, где карта даёт +6 к атаке. Класс узкий и посчитан:
 * по снапшоту таких карт ТРИ, и все три — заклинания-усиления, то есть
 * ровно те, чьи числа мы читаем. Условие держится на трёх признаках сразу
 * (точка, затем цифры, затем ЗАГЛАВНАЯ буква), чтобы не срезать прозу:
 * свободный поиск цифры после точки резал бы текст в середине.
 */
const GOLDEN_TEXT_CUT = /\d+\[x\]|(?<=\.(?:<\/i>)?)\d+(?=[A-Z])/;

export function normalizeCardText(text: string): string {
  const cut = GOLDEN_TEXT_CUT.exec(text);
  const one = cut === null || cut.index === 0 ? text : text.slice(0, cut.index);
  return one.replace(/\s+/g, ' ').trim();
}

export function createCardIndex(raw: readonly unknown[]): CardIndex {
  const byId = new Map<string, CardInfo>();
  const byDbfId = new Map<number, CardInfo>();
  const byTier = new Map<number, CardInfo[]>();
  const byName = new Map<string, CardInfo[]>();

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const card = item as RawCard;
    if (typeof card.id !== 'string' || card.id === '') continue;

    const info: CardInfo = {
      id: card.id,
      dbfId: asNumber(card.dbfId),
      name: typeof card.name === 'string' ? card.name : card.id,
      text: typeof card.text === 'string' ? normalizeCardText(card.text) : null,
      techLevel: asNumber(card.techLevel),
      races: asRaces(card),
      isBaconPool: card.isBaconPool === true,
      attack: asNumber(card.attack),
      health: asNumber(card.health),
      type: typeof card.type === 'string' ? card.type.toUpperCase() : null,
      magnetic: Array.isArray(card.mechanics) && card.mechanics.includes('MODULAR'),
      baseScriptData: scriptDataOf(card),
      mechanics: Array.isArray(card.mechanics)
        ? card.mechanics.filter((m): m is string => typeof m === 'string')
        : [],
    };
    byId.set(card.id, info);
    if (info.dbfId !== null) byDbfId.set(info.dbfId, info);

    // Имена индексируются только по набору Battlegrounds: в снапшоте
    // 35 тысяч карт, и «Gem Day» надо искать среди тех, что вообще могут
    // прийти в партию режима.
    if (card.set === 'Battlegrounds') {
      const key = info.name.replace(/\s+/g, ' ').trim().toLowerCase();
      const same = byName.get(key);
      if (same === undefined) byName.set(key, [info]);
      else same.push(info);
    }

    if (info.isBaconPool && info.type === 'MINION' && info.techLevel !== null && !info.id.endsWith('_G')) {
      const tier = byTier.get(info.techLevel);
      if (tier === undefined) byTier.set(info.techLevel, [info]);
      else tier.push(info);
    }
  }

  return {
    size: byId.size,
    infoByDbfId: (dbfId) => byDbfId.get(dbfId) ?? null,
    poolOfTier: (techLevel) => byTier.get(techLevel) ?? [],
    byName: (name) => byName.get(name.replace(/\s+/g, ' ').trim().toLowerCase()) ?? [],
    info: (cardId) => {
      const direct = byId.get(cardId);
      if (direct !== undefined) return direct;
      /**
       * Золотая версия существует отдельной картой с суффиксом `_G`, но
       * в логе золотой миньон помечается тегом `PREMIUM` и суффикса чаще
       * не имеет (25 золотых эталонной партии — без него). Обратный случай
       * тоже бывает, поэтому суффикс снимается при промахе: свойства карты
       * у золотой и обычной версии одни и те же.
       */
      return cardId.endsWith('_G') ? (byId.get(cardId.slice(0, -2)) ?? null) : null;
    },
  };
}

/** Путь к снапшоту решает `app/paths.ts`: из репозитория или из сборки. */
export { CARDS_PATH };

export function loadCardIndex(path: string = CARDS_PATH): CardIndex {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return createCardIndex(Array.isArray(parsed) ? parsed : []);
}

/**
 * Как ЛОГ называет племя в теге `CARDRACE` — против имени снапшота.
 *
 * Тот же класс расхождения, что у `SUBSET_TAG_RACES`, и словарь у игры
 * снова свой: в `CARDRACE` мехи зовутся `MECHANICAL`, тогда как снапшот
 * знает `MECH`. Остальные девять имён партии part64 совпали дословно.
 */
const LOG_RACE_NAMES: Readonly<Record<string, string>> = {
  MECHANICAL: 'MECH',
};

/** Племя снапшота по имени из тега `CARDRACE`. */
export function raceOfLogTag(tag: string): string {
  return LOG_RACE_NAMES[tag] ?? tag;
}

/**
 * Индекс, дополненный племенами, которые НАЗВАЛ ЛОГ (`GameState.logRaces`).
 *
 * Зачем: новое племя приходит в игру раньше, чем в снапшот. Аберрации жили
 * в партиях с part60, а `races` у всех двадцати шести их карт пусты и
 * посейчас — HearthstoneJSON их не проставил. Для советника это не падение,
 * а тихий ноль: «своих по племени» не считалось, состав партии (`lobbyRaces`)
 * аберрацию не видел, и 36% карт витрины part64 шли как бесплеменные.
 *
 * Правило слияния ровно одно: **снапшот сильнее всегда**, тег говорит
 * только там, где снапшот молчит. Этим сохранена причина, по которой D071
 * отверг `CARDRACE` для состава партии, — у двуплеменной карты тег называет
 * одно племя, и подмени он снапшот, «Рука-протез» потеряла бы UNDEAD.
 * Замер на part64: из 126 карт с тегом снапшот сильнее у 100 (94 совпали,
 * 6 двуплеменных), и тег добавляет 26 — все до одной ABERRATION (D275).
 *
 * Возвращается ОБЁРТКА, а не новый индекс: `poolOfTier`, `byName` и прочее
 * отдают те же объекты снапшота, и переcборка ради одного поля стоила бы
 * полной копии 5612 карт на каждое чтение состояния.
 */
export function withLogRaces(cards: CardIndex, logRaces: Readonly<Record<string, string>>): CardIndex {
  // Обёртку просят на КАЖДОМ шаге плана (spendPlan зовёт adviseTavern
  // в цепочке), поэтому она кэшируется по обоим аргументам сразу: ответ
  // зависит и от индекса, и от таблицы лога, и ключ обязан покрывать оба
  // (D154). Оба — объекты, поэтому кэш слабый и течь не может.
  const forIndex = LOG_RACE_CACHE.get(cards) ?? new WeakMap<object, CardIndex>();
  LOG_RACE_CACHE.set(cards, forIndex);
  const hit = forIndex.get(logRaces);
  if (hit !== undefined) return hit;
  const made = buildLogRaceIndex(cards, logRaces);
  forIndex.set(logRaces, made);
  return made;
}

const LOG_RACE_CACHE = new WeakMap<CardIndex, WeakMap<object, CardIndex>>();

function buildLogRaceIndex(cards: CardIndex, logRaces: Readonly<Record<string, string>>): CardIndex {
  const learned = new Map<string, readonly string[]>();
  for (const [cardId, raw] of Object.entries(logRaces)) {
    const race = raceOfLogTag(raw);
    // `ALL` из лога НЕ берём — страховка второго ряда. Первый ряд стоит
    // в редьюсере: приобретённое племя (тёмный дар, тринкет) приходит
    // отдельным `TAG_CHANGE` и в `logRaces` не попадает вовсе. Но карту
    // можно впервые УВИДЕТЬ уже с даром — `SHOW_ENTITY` раскрывает её
    // с текущими тегами, — и тогда приобретение окажется в блоке карты.
    // Дороже всего ошибиться именно на `ALL`: это не племя, а джокер
    // «свой любому», и один такой миньон добавляет сородича КАЖДОМУ
    // кандидату (part51 без этой оговорки переоценивала весь ход 21
    // ровно на сородича: Felfire Conjurer 27.0 → 28.5).
    //
    // Настоящим амальгамам это не мешает: у них `ALL` стоит в СНАПШОТЕ
    // (87 карт, среди них Gatekeeper Amalgam и Nightmare Par-tea Guest),
    // а снапшот здесь сильнее.
    if (race === RACE_ALL) continue;
    learned.set(cardId, [race]);
  }
  if (learned.size === 0) return cards;

  const patched = new Map<string, CardInfo | null>();
  const info = (cardId: string): CardInfo | null => {
    const known = patched.get(cardId);
    if (known !== undefined) return known;
    const base = cards.info(cardId);
    const extra = learned.get(cardId);
    // Снапшот сильнее: непустой список племён обёртка не трогает вовсе.
    const out = base === null || base.races.length > 0 || extra === undefined ? base : { ...base, races: extra };
    patched.set(cardId, out);
    return out;
  };
  return { ...cards, info };
}
