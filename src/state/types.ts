/**
 * Состояние партии Battlegrounds, восстановленное из Power.log.
 *
 * Форма типов идёт от фактуры фикстур, а не наоборот: каждое поле ниже опирается
 * на конкретное наблюдение из data/fixtures, см. docs/power-log.md.
 */

/**
 * Фаза партии.
 *
 * Определяется тегом `BOARD_VISUAL_STATE` на `GameEntity`. Подтверждено на
 * эталонной партии: все 86 блоков `BlockType=ATTACK` пришлись на значение 2
 * и ни одного на 1. Хронология тоже чистая —
 * `TURN=2 → VISUAL=2 → ATTACK… → VISUAL=1 → TURN=3`.
 */
export type Phase = 'tavern' | 'combat' | 'gameOver';

export const BOARD_VISUAL_STATE_TAVERN = 1;
export const BOARD_VISUAL_STATE_COMBAT = 2;

/**
 * Энчант, наложенный на миньона.
 *
 * Симулятору их нужно передавать списком: итоговых статов миньона ему
 * недостаточно, см. docs/simulator.md. В логе энчант — это отдельная сущность
 * с `CARDTYPE=ENCHANTMENT` и тегом `ATTACHED`, указывающим на носителя.
 */
export interface Enchantment {
  readonly entityId: number;
  readonly cardId: string;
  /**
   * Порядок наложения. Берётся из `entityId`: идентификаторы растут монотонно
   * по времени создания, а сам симулятор при пустом поле подставляет
   * производную от entityId (`enchantment.timing || entity.entityId + index + 1`).
   */
  readonly timing: number;
  /** Тег `TAG_SCRIPT_DATA_NUM_1`, у симулятора это `tagScriptDataNum1`. */
  readonly scriptDataNum1: number | null;
  /** Тег `TAG_SCRIPT_DATA_NUM_2`. */
  readonly scriptDataNum2: number | null;
}

/** Миньон на борду или в магазине. */
export interface Minion {
  readonly entityId: number;
  readonly cardId: string;
  /** Позиция слева направо в пределах зоны, как её пишет игра. */
  readonly zonePos: number;
  readonly attack: number | null;
  readonly health: number | null;
  readonly taunt: boolean;
  readonly divineShield: boolean;
  readonly poisonous: boolean;
  readonly venomous: boolean;
  readonly reborn: boolean;
  readonly windfury: boolean;
  readonly stealth: boolean;
  /**
   * Золотой миньон — тег `PREMIUM`.
   *
   * Не суффикс `_G` в `cardId`: в эталонной партии 25 золотых миньонов такого
   * суффикса не имеют, тогда как обратных случаев нет ни одного.
   */
  readonly golden: boolean;
  /**
   * Заморожен ли — тег `FROZEN`.
   *
   * Осмыслен только у миньонов магазина: заморозка держит витрину до
   * следующего хода. В part2 таких 11 сущностей, в part3 ни одной —
   * игрок там не морозил ни разу.
   */
  readonly frozen: boolean;
  /** Здоровье без учёта полученного урона — тег `HEALTH`. */
  readonly maxHealth: number | null;
  /** Тир миньона из тега `TECH_LEVEL`. */
  readonly techLevel: number | null;
  /** Наложенные энчанты, в порядке наложения. */
  readonly enchantments: readonly Enchantment[];
  /** Теги `TAG_SCRIPT_DATA_NUM_1…6` — симулятору они нужны как есть. */
  readonly scriptData: readonly (number | null)[];
  /**
   * Сырые числовые теги сущности.
   *
   * Симулятор принимает их в поле `tags` и опирается на них в механиках,
   * которые мы не разбираем по именам. Отдавать всё, что удалось прочитать,
   * дешевле и надёжнее, чем угадывать нужное подмножество.
   */
  readonly tags: Readonly<Record<string, number>>;
  /**
   * Живая цена покупки — тег `COST` кнопки `TB_BaconShop_DragBuy`,
   * привязанной к этому миньону витрины (part35).
   *
   * Кнопок столько же, сколько миньонов в витрине, и каждая знает свой
   * товар: тег `2442` (игра его не именует) со значением — id миньона,
   * а на миньоне парный `HAS_DRAG_TO_BUY=1`. Цена лежит на КНОПКЕ, и это
   * единственный источник, который не пропускает: «They cost (1)»
   * у «Мозаики Стылой Межи» пишет `COST=1` на все кнопки и НЕ ставит
   * `BACON_REDUCE_BUY_COST` на миньонов вовсе (part35, ни одного за
   * партию), тогда как скидка part4 меняет и то и другое строками подряд
   * (кнопка `COST` 3 → 1, миньон `BACON_REDUCE_BUY_COST=2`).
   *
   * `null` — кнопки не видно: свой борд, рука, чужой борд в бою, старые
   * записи датасета. Тогда цена считается правилом игры со скидкой
   * по тегу миньона (`buyCostOf`).
   */
  readonly buyCost: number | null;
}

/**
 * Как ЛОГ называет племя в теге `BACON_SUBSET_<X>` — против того, как то же
 * племя называет снапшот в поле `races`.
 *
 * Восемь имён из десяти совпадают (BEAST, DEMON, DRAGON, MECH, MURLOC,
 * NAGA, PIRATE, UNDEAD), и потому расхождение остальных двух прожило
 * от part9 до part36 незамеченным: игра пишет `QUILLBOAR` с двумя «l»
 * и `ELEMENTALS` во множественном числе, а снапшот знает `QUILBOAR`
 * и `ELEMENTAL`. Сравнение с бордом молча не совпадало никогда —
 * не падение, а «своих таких нет» при пяти своих на столе (жалоба игрока
 * по part36, ход 17: тринкет `BG36_MagicItem_214` с тегами
 * `BACON_SUBSET_DRAGON` и `BACON_SUBSET_QUILLBOAR` при пяти квилбоарах).
 *
 * Таблица, а не «привести к единственному числу»: `UNDEAD` уже без «s»,
 * а `MECH` короче любого правила словообразования. Незнакомое имя
 * проходит как есть — новое племя патча лучше показать сырым тегом,
 * чем потерять; ловится это тестом part36, который сверяет КАЖДЫЙ тег
 * партии со списком племён снапшота.
 */
export const SUBSET_TAG_RACES: Readonly<Record<string, string>> = {
  QUILLBOAR: 'QUILBOAR',
  ELEMENTALS: 'ELEMENTAL',
};

/** Племя снапшота по имени из тега `BACON_SUBSET_<X>`. */
export function raceOfSubsetTag(tag: string): string {
  return SUBSET_TAG_RACES[tag] ?? tag;
}

/** Один вариант из открытого предложения тринкетов. */
export interface TrinketOffer {
  readonly entityId: number;
  readonly cardId: string;
  /**
   * Племена тринкета из тегов `BACON_SUBSET_<RACE>` на его сущности.
   *
   * Надёжнее текста: у «Разноцветного компаса» племя стоит в тексте
   * плейсхолдером `{0}`, а тег `BACON_SUBSET_DRAGON=1` называет его прямо
   * (part12).
   *
   * Хранятся именами ПЛЕМЁН СНАПШОТА, а не суффиксами тегов: словари
   * расходятся на `QUILLBOAR` и `ELEMENTALS`, и приводит их редьюсер —
   * `raceOfSubsetTag` (part36). Читателям, сравнивающим племя с бордом,
   * знать про имена тегов незачем.
   */
  readonly subsetRaces: readonly string[];
  /**
   * Сколько стоит взять этот тринкет — тег `COST` его сущности.
   *
   * Цена настоящая и разная: в фикстурах встречались 0, 1, 2, 3 и 4.
   * Точка решения хода предложения видит золото ДО выбора, и без этого
   * поля совет говорил про золото, которого у игрока сейчас же не станет.
   * `null` — тега нет (тринкет бесплатен либо цена не показана).
   */
  readonly cost: number | null;
}

/** Один вариант открытого модального выбора. */
export interface ChoiceOption {
  readonly entityId: number;
  readonly cardId: string;
  /**
   * Теги `TAG_SCRIPT_DATA_NUM_1..2` сущности варианта, если она известна.
   *
   * Ими клиент заполняет плейсхолдеры `{0}`/`{1}` в тексте карты: у сокровища
   * «Buy the Holy Light» текст «+{0} Attack», а 10 лежит в NUM_1 (part10).
   * Сущность варианта не всегда находится — в part9 id вариантов не совпадали
   * с id зонных копий, — тогда здесь `null`.
   */
  readonly scriptData?: readonly (number | null)[];
}

/**
 * Заклинание в руке: монетка таверны, тавматургия, кровавый самоцвет.
 *
 * `CARDTYPE=SPELL` в зоне `HAND` под своим контроллером (part10: монетка
 * BG28_810 создаётся именно так). Бой их не играет, но фаза таверны — да:
 * забытая в руке монетка — это потерянное золото, забытый бафф — потерянные
 * статы ближайшего боя.
 */
export interface HandSpell {
  readonly entityId: number;
  readonly cardId: string;
  /**
   * Позиция в своей зоне — тег `ZONE_POSITION`, как у миньонов.
   *
   * Нужна ровно затем, зачем `Minion.zonePos`: у ВИТРИНЫ заклинание стоит
   * в том же ряду, что миньоны, и нумерация у ряда одна на всех. Заклинание
   * при этом лежит не обязательно с краю: part41, ход 5 — миньоны на местах
   * 1, 2, 4, а «Recruit a Trainee» ТРЕТЬИМ (01:16:04, `ZONE_POSITION` 4 → 3
   * тем же блоком, которым игра расставляет всю витрину). Пока состав ряда
   * складывали из двух списков подряд, метка оверлея вставала мимо карты
   * (жалоба игрока по part41: «съехала обводка»).
   *
   * У руки поле тоже честное — там это место карты в руке, — но ряд руки
   * геометрией не описан, и никто его не читает.
   *
   * Ноль значит «позиции не знаем»: игра нумерует с единицы, а ноль стоит
   * в старых записях датасета, собранных до этого поля.
   */
  readonly zonePos: number;
  /**
   * Тег `COST`, живое значение: монетка создаётся с COST=1 и падает до нуля —
   * читать надо тег, а не снапшот карт.
   */
  readonly cost: number;
  /** `TAG_SCRIPT_DATA_NUM_1..2` — значения плейсхолдеров `{0}`/`{1}` текста. */
  readonly scriptData: readonly (number | null)[];
  /** `LITERALLY_UNPLAYABLE` — замок, как у карт-миньонов. */
  readonly unplayable: boolean;
  /**
   * Цена платится ЗДОРОВЬЕМ, а не золотом — тег `BACON_COSTS_HEALTH_TO_BUY`.
   *
   * Тег, а не текст: в пуле есть карта, у которой цена в здоровье своя
   * («Hasty Excavation»: «Gain 1 Gold. This costs Health to buy instead
   * of Gold»), и есть с полдюжины источников, которые делают чужую покупку
   * платой за здоровье, — Malchezaar и Bazaar Dealer на борде, наклейки
   * «Bazaar»/«Pilgrimp», тринкеты «The Eye of Sargeras» и «Demonic
   * Tapestry». Считать это по текстам значило бы моделировать то, что игра
   * уже посчитала: она ставит тег на саму карту витрины, и в логе
   * покупка выходит строкой `META_DATA - Meta=SPEND_HEALTH` (part29,
   * 01:14:09).
   *
   * Цена при этом лежит в том же теге `COST`, и `cost` его и несёт:
   * различает их только этот флаг. Без него заклинание за 3 «здоровья»
   * при нулевом золоте считалось не по карману и было невидимо целиком.
   */
  readonly costsHealth: boolean;
}

/**
 * Открытый модальный выбор «возьмите одно из».
 *
 * Канал — `GameState.DebugPrintEntityChoices()`: заголовок с id и
 * `ChoiceType`, затем `Source=[дескриптор]` и `Entities[i]=[дескриптор]`
 * с cardId прямо в строках. Закрывается строками `GameState.SendChoices()`
 * с тем же id. Подтверждено на part9: 10 выборов GENERAL за партию —
 * лавка аксессуаров, награда за тройку, раскопки карт — все идут этим
 * каналом, и выбор игрока виден в `m_chosenEntities`.
 *
 * Выбор героя в начале партии приходит тем же каналом с
 * `ChoiceType=MULLIGAN` и в состояние не попадает.
 */
export interface OpenChoice {
  /** Номер выбора из заголовка — по нему выбор и закрывается. */
  readonly id: number;
  /** Карта-источник выбора: кнопка тройки, заклинание раскопки, аксессуар. */
  readonly sourceCardId: string | null;
  readonly options: readonly ChoiceOption[];
}

/** Игрок лобби, каким его видно из лога: герой, тир, здоровье, место. */
export interface LobbyPlayer {
  readonly playerId: number;
  readonly heroCardId: string;
  /** Здоровье героя без учёта урона — тег `HEALTH`. */
  readonly health: number | null;
  readonly damage: number;
  readonly armor: number;
  /** Тир таверны — тег `PLAYER_TECH_LEVEL`. */
  readonly techLevel: number | null;
  /** Текущее место в таблице — тег `PLAYER_LEADERBOARD_PLACE`. */
  readonly place: number | null;
}

export interface Hero {
  readonly entityId: number;
  readonly cardId: string;
  readonly health: number | null;
  readonly armor: number;
  readonly damage: number;
  /** Сила героя — сущность `CARDTYPE=HERO_POWER` под своим контроллером. */
  readonly heroPowerCardId: string | null;
  readonly heroPowerEntityId: number | null;
  /**
   * Цена силы — тег `COST` на её сущности. `null` у пассивных сил.
   *
   * Проверено на part8 (Скаббс, «I Spy»): COST=2 при создании силы.
   */
  readonly heroPowerCost: number | null;
  /**
   * Нажата ли сила в этом ходу.
   *
   * Применение видно блоком `BlockType=PLAY` на сущности силы (part8:
   * 10 нажатий, 10 таких блоков). Тег `EXHAUSTED` на силе впервые
   * встретился в part32 («Ритуал перерождения»: 1 после нажатия, 0
   * в начале следующего хода) — подтверждение, а не источник: у прочих
   * сил его нет. Сбрасывается со сменой хода.
   */
  readonly heroPowerUsedThisTurn: boolean;
  /** Тег `LITERALLY_UNPLAYABLE`: сила есть, но жать её сейчас нельзя. */
  readonly heroPowerUnplayable: boolean;
  /**
   * Замок на силе — тег `LOCK_VISUAL` на её сущности.
   *
   * Часть сил открывается не сразу: у Алекстразы «Queen of Dragons»
   * (`TB_BaconShop_HP_064`) в тексте прямо сказано «Discover a Dragon.
   * *(Unlocks at Tier 4.)*», и до четвёртого тира игра её не даёт нажать.
   * `HAS_ACTIVATE_POWER=1` и `COST=1` у неё стоят с первого хода,
   * `LITERALLY_UNPLAYABLE` не приходит НИ РАЗУ — по этим трём тегам сила
   * неотличима от доступной, и советник девять ходов подряд ставил её
   * верхней строкой и вписывал в план хода (part37, жалоба игрока).
   *
   * Фактура part37: `LOCK_VISUAL=1` приходит блоком TRIGGER сразу
   * за созданием силы (21:16:15), и ровно на подъёме до тира 4
   * (21:21:26) тем же блоком приходит `LOCK_VISUAL=0`. Тег общий для
   * «кнопок под замком»: та же пара стоит на кнопке тёмного дара
   * (`BG36_Button_DarkGift`) во всех фикстурах и снимается на пятом ходу
   * партии. У сил, доступных сразу, тега нет вовсе (part13, Хроми) —
   * поэтому умолчание `false` честное.
   *
   * Причину замка тег не называет, и это к лучшему: в логе она приходит
   * своим каналом (`DebugPrintOptions`, `error=
   * REQ_MINIMUM_TAVERN_TIER_LEVEL_TO_PLAY`), но чинить надо не причину,
   * а факт — жать нельзя.
   */
  readonly heroPowerLocked: boolean;
  /**
   * Активная ли сила — тег `HAS_ACTIVATE_POWER` на её сущности.
   *
   * У пассивных сил тега нет, и советовать «нажать» их нельзя. Фактура
   * part13: у «Мана в минуту» Хроми `HAS_ACTIVATE_POWER=1` при отсутствии
   * тега `COST` — сила активная и бесплатная.
   */
  readonly heroPowerHasActivate: boolean;
  /**
   * Плейсхолдеры силы — теги `TAG_SCRIPT_DATA_NUM_1..4` на её сущности,
   * как `scriptData` у миньона. У сил «после N покупок…» первый из них —
   * живой остаток счётчика: «Бранное дело» (part34, «After you buy 4
   * Battlecry minions, get a Brann Bronzebeard») создаётся БЕЗ тега
   * (остаток равен числу из текста), а с первой кличевой покупки идёт
   * 3 → 2 → 1 → 0 блоком TRIGGER внутри блока покупки. `null` на месте —
   * тега нет; пустой массив — силы нет.
   */
  readonly heroPowerScriptData: readonly (number | null)[];
}

/**
 * Накопительные счётчики игрока — то, что симулятор принимает в `globalInfo`.
 *
 * Влияют на исход боя напрямую: без них симуляция систематически ошибается
 * на бордах, завязанных на соответствующие механики.
 *
 * Здесь только те поля, для которых в фикстурах найден именованный тег.
 * Остальные счётчики в логе приходят **безымянными числовыми тегами**
 * (в эталонной партии их 62 штуки на сущности игрока), и сопоставить их
 * с полями симулятора без дополнительных данных нельзя — гадать не стали.
 * См. docs/simulator.md.
 */
export interface GlobalInfo {
  /** `NUM_RESOURCES_SPENT_THIS_GAME` → `GoldSpentThisGame`. */
  readonly goldSpentThisGame: number | null;
  /** `NUM_SPELLS_PLAYED_THIS_GAME` → `SpellsCastThisGame`. */
  readonly spellsCastThisGame: number | null;
  /** `NUM_CARDS_PLAYED_THIS_TURN` → `CardsPlayedThisTurn`. */
  readonly cardsPlayedThisTurn: number | null;
  /** `TAVERN_SPELL_ATTACK_INCREASE` → `TavernSpellAttackBuff`. */
  readonly tavernSpellAttackBuff: number | null;
  /** `TAVERN_SPELL_HEALTH_INCREASE` → `TavernSpellHealthBuff`. */
  readonly tavernSpellHealthBuff: number | null;
  /** `BACON_ELEMENTAL_BUFFATKVALUE` → `ElementalAttackBuff`. */
  readonly elementalAttackBuff: number | null;
  /** `BACON_ELEMENTAL_BUFFHEALTHVALUE` → `ElementalHealthBuff`. */
  readonly elementalHealthBuff: number | null;
}

export const EMPTY_GLOBAL_INFO: GlobalInfo = {
  goldSpentThisGame: null,
  spellsCastThisGame: null,
  cardsPlayedThisTurn: null,
  tavernSpellAttackBuff: null,
  tavernSpellHealthBuff: null,
  elementalAttackBuff: null,
  elementalHealthBuff: null,
};

/**
 * Действие игрока в таверне, каким его видно из лога.
 *
 * Каждое действие — блок `BlockType=PLAY` канала-источника на своей
 * сущности: покупка и продажа — на перетаскивателях `TB_BaconShop_DragBuy`
 * (`…_Spell`) и `TB_BaconShop_DragSell` с картой в `Target=[…]`, обновление
 * витрины, подъём и заморозка — на кнопках, розыгрыш — на карте в `HAND`,
 * сила героя, тёмный дар и активация — как и прежде у их флагов (part8,
 * part14). Журнал нужен датасету фазы 6: «какие действия ведут к победе»
 * не выучить, не записывая действий.
 */
export type PlayerActionType =
  | 'buy'
  | 'sell'
  | 'roll'
  | 'levelUp'
  /**
   * НАЖАТИЕ кнопки заморозки — и включение, и снятие: кнопка одна на оба
   * направления, а блок `PLAY` у них тождественный (part25: 14 нажатий
   * за партию, среди них снятия). Различить их можно только по тегу
   * `FROZEN` витрины ДО нажатия; пока этого нет, читать журнал надо как
   * «игрок трогал заморозку», а не «заморозил».
   */
  | 'freeze'
  | 'play'
  | 'heroPower'
  | 'darkGift'
  | 'activate';

export interface PlayerAction {
  /** Ход партии (`GameState.turn`), на котором действие сделано. */
  readonly turn: number;
  readonly type: PlayerActionType;
  /** Карта действия: у покупки/продажи — цель, у розыгрыша — сама карта. */
  readonly cardId: string | null;
  readonly entityId: number | null;
  /**
   * Ветвь модального «Choose One», выбранная игроком: 0 — первая, 1 —
   * вторая, `null` — выбора не было (у подавляющего большинства действий).
   *
   * Пишется у ЛЮБОГО типа действия, потому что читается из одного и того же
   * поля `SubOption` блока PLAY, а не из разбора карты; ненулевым он бывает
   * у розыгрыша модальной карты (part28: Snare Trapper `BG36_332`
   * с `SubOption=0`, Gem Day `BG31_893` с обоими значениями).
   *
   * Зачем в журнале: советник ветвь НАЗЫВАЕТ заранее (`spellBranches`,
   * part19/part28), и это единственное поле, по которому его совет можно
   * сверить с тем, что игрок выбрал на самом деле, — тот же замер, что
   * имитация покупок.
   */
  readonly subOption: number | null;
}

export interface GameState {
  readonly phase: Phase;
  /** Номер хода из тега `TURN` на `GameEntity`. */
  readonly turn: number;
  /** Тир таверны из `PLAYER_TECH_LEVEL`. */
  readonly techLevel: number;
  /**
   * Ход, на котором таверна поднялась в последний раз.
   *
   * Нужен правилу заморозки: в ход подъёма свежая витрина будет уже нового
   * тира, и держать витрину старого ради «собираемого племени» — потеря
   * (part11, ход 9: заморозка наги сразу после подъёма на третий тир).
   */
  readonly techLevelUpTurn: number | null;
  /**
   * Сколько сейчас стоит поднять таверну.
   *
   * Читается из кнопки апгрейда — сущности `TB_BaconShopTechUp0N_Button`
   * в зоне `PLAY` под своим контроллером, тег `COST`. Считать по таблице
   * нельзя: цена падает на единицу за каждый ход, когда таверну не подняли,
   * и к моменту совета зависит от всей истории партии. В фикстурах базовые
   * цены 5, 7, 8, 11, 11 для тиров 2–6, и падение на единицу за ход видно
   * прямо в логе.
   *
   * `null` на максимальном тире — кнопки там нет.
   */
  readonly tavernUpgradeCost: number | null;
  /** Какой тир дала бы кнопка апгрейда — её тег `TECH_LEVEL`. */
  readonly tavernUpgradeTarget: number | null;
  /**
   * Цена обновления витрины — тег `COST` кнопки `TB_BaconShop_8p_Reroll_Button`
   * в зоне `PLAY` под своим контроллером.
   *
   * Правилом игры это число было единицей, и таблица `rules.rerollCost`
   * его и хранит. Но экономику меняют тринкеты и герои («Refreshing the
   * Tavern is free», скидки), а живой тег показывает результат уже
   * применённым — читать факт надёжнее, чем моделировать эффект. Ноль
   * здесь ЗНАЧАЩИЙ: бесплатное обновление меняет весь ход. Сброс кнопки
   * в начале хода нулями отсеян зоной: сущность на это время уходит
   * в `REMOVEDFROMGAME`.
   *
   * `null` — кнопки в PLAY нет (бой, конец партии), берётся таблица.
   */
  readonly rerollCost: number | null;
  /** Предел тира в этой партии — тег `BACON_MAX_PLAYER_TECH_LEVEL`, в фикстурах 6. */
  readonly maxTechLevel: number | null;
  /**
   * Доступное золото — именно оно показано в игре слева от дроби.
   *
   * В логе прямого тега на остаток нет: `RESOURCES` — сколько золота выдано
   * на ход, `RESOURCES_USED` — сколько потрачено. Остаток считается разностью.
   * Проверено по скриншоту: экран показывал `0/6` при `RESOURCES=6`.
   */
  readonly gold: number;
  /** Всего золота на ход — знаменатель дроби на экране, тег `RESOURCES`. */
  readonly goldTotal: number;
  /** Потрачено золота за ход — `RESOURCES_USED`. */
  readonly goldSpent: number;
  readonly hero: Hero | null;
  /** Свой борд, слева направо. */
  readonly board: readonly Minion[];
  /** Своя рука: миньоны. */
  readonly hand: readonly Minion[];
  /** Своя рука: заклинания. Отдельно — у них нет ни статов, ни борда. */
  readonly handSpells: readonly HandSpell[];
  /**
   * Заклинания в витрине таверны — монетка за 1, баффы за 1–2.
   *
   * Те же чужие сущности `CARDTYPE=SPELL` в `PLAY`, что и миньоны магазина,
   * но с тегом `COST` — в отличие от миньонов, цена заклинания в логе есть
   * (part11: монетка BG28_810 у бармена с COST=1). Служебные заклинания
   * клиента (`TB_BaconShop_*` — перетаскивание, проверка троек) отсеяны.
   */
  readonly shopSpells: readonly HandSpell[];
  /**
   * Магазин таверны. Непуст только в фазе `tavern`.
   *
   * Это миньоны в `zone=PLAY` под чужим контроллером. Подтверждено блоком
   * покупки: цель `TB_BaconShop_DragBuy` — именно такой миньон.
   */
  readonly shop: readonly Minion[];
  /**
   * Борд противника. Непуст только в фазе `combat`.
   *
   * Те же чужие миньоны в `zone=PLAY`, что и магазин, — различает их только
   * фаза. В таверне чужой слот занимает Бармен Боб, на бой в него
   * подставляется оппонент.
   */
  readonly opponentBoard: readonly Minion[];
  /** Аномалия партии, `cardId` сущности с `CARDTYPE=BATTLEGROUND_ANOMALY`. */
  readonly anomalyCardId: string | null;
  /** Накопительные счётчики игрока для симулятора. */
  readonly globalInfo: GlobalInfo;
  /**
   * `PlayerID` следующего противника — тег `NEXT_OPPONENT_PLAYER_ID`.
   *
   * Известен уже в таверне, до боя. Это и есть ответ на вопрос, против кого
   * считать расстановку: не «против типичного борда», а против конкретного
   * игрока, чей борд мы, возможно, уже видели в предыдущих боях.
   */
  readonly nextOpponentPlayerId: number | null;
  /**
   * `PlayerID` противника текущего боя.
   *
   * Берётся не из тега с подходящим именем, а через героя: в бою чужому слоту
   * подставляют `HERO_ENTITY` противника, а у самого героя есть тег `PLAYER_ID`.
   * Тег `BACON_CURRENT_COMBAT_PLAYER_ID` для этого не годится — в фикстурах
   * он равен идентификатору самого игрока.
   */
  readonly currentOpponentPlayerId: number | null;
  /** Выигран ли прошлый бой — тег `BACON_WON_LAST_COMBAT`. */
  readonly wonLastCombat: boolean | null;
  /**
   * РЕЖИМ партии — строка `GameType=…` канала `DebugPrintGame` сразу после
   * CREATE_GAME (`GT_BATTLEGROUNDS`, `GT_RANKED`, `GT_CASUAL`…).
   *
   * Нужен потому, что в ОБЫЧНОЙ партии Hearthstone наши признаки таверны
   * складываются сами собой, и складываются ЛОЖНО: фаза читается как
   * `tavern`, мана — как золото (5/5, 6/6 … 10/10 — мановая кривая),
   * а чужие карты попадают в «витрину». Замерено на живом логе игрока
   * (сессия 05.09 19:16, шесть `GT_RANKED` и ни одной BG): пакетный путь
   * дал ШЕСТЬ точек решения, а живой рекордер записал бы такую партию
   * в датасет как настоящую — с тиром 1, пустым лобби и местом `null`.
   *
   * `null` — режим ещё не объявлен (начало лога) или строка не встретилась:
   * тогда прежнее поведение сохраняется, и решает уже сам состав состояния.
   */
  readonly gameType: string | null;
  /**
   * Идёт ли АЛЬТЕРНАТИВНАЯ ТАВЕРНА — тег `BACON_ALT_TAVERN_IN_PROGRESS`
   * на `GameEntity` («Альтернативная история»).
   *
   * Важно не тем, что мы её советуем (не советуем вовсе), а тем, что она
   * ПОДМЕНЯЕТ ПУЛ ЗОЛОТА: игра ставит `RESOURCES` в ноль, потом в число
   * монет альт-таверны (`BACON_ALT_TAVERN_COIN`), игрок тратит их —
   * `RESOURCES_USED` растёт, — и после выхода `RESOURCES` возвращается
   * к обычному максимуму хода. Для всякого, кто считает «золото тронуто»,
   * это ложная трата: своё золото хода целое. Встречается редко и потому
   * особенно опасно — в 39 фикстурах ровно две партии (part25 и part41,
   * по два входа), то есть правило, написанное без неё, ломается раз
   * в двадцать партий и молча.
   */
  readonly altTavern: boolean;
  /**
   * Последний увиденный борд каждого противника, по его `PlayerID`.
   *
   * Требование ТЗ к `GameState`. Заполняется по итогам боёв: борд противника
   * виден только когда с ним дерёшься. Вместе с `nextOpponentPlayerId` это
   * даёт ответ на вопрос, против кого считать расстановку в таверне.
   */
  readonly lastSeenBoards: Readonly<Record<number, readonly Minion[]>>;
  /**
   * На каком ходу этот борд был увиден, по тому же `PlayerID`.
   *
   * Без этого числа `lastSeenBoards` вводит в заблуждение: борд, снятый шесть
   * ходов назад, к следующему бою успевает смениться целиком, а выглядит
   * в состоянии так же достоверно, как снятый только что. Советник расстановки
   * обязан говорить, насколько его картинка устарела.
   */
  readonly lastSeenBoardTurns: Readonly<Record<number, number>>;
  /**
   * Все игроки лобби по `PlayerID`: герой, тир таверны, здоровье, место.
   *
   * Требование ТЗ («последний увиденный борд каждого оппонента + его
   * hp/tier»), которого долго не было: борд копился, а hp и тир — нет.
   * Всё это лог сообщает открыто и про ВСЕХ восьмерых — тегами на сущности
   * героя (`PLAYER_ID`, `PLAYER_TECH_LEVEL`, `PLAYER_LEADERBOARD_PLACE`,
   * `HEALTH`/`DAMAGE`/`ARMOR`), а не только про тех, с кем дрались.
   *
   * Понадобилось «Дружеской ставке» (`TB_BaconShop_HP_081`, part26):
   * сила героя предлагает угадать, КТО из двух игроков выиграет свой
   * следующий бой, и без тира и здоровья сказать об этом нечего.
   */
  readonly lobby: Readonly<Record<number, LobbyPlayer>>;
  /**
   * Цена нажатия тёмного дара — тег `COST` кнопки `BG36_Button_DarkGift`.
   *
   * `null`, когда кнопки нет (партия без даров или кнопка убрана). Кнопка —
   * `CARDTYPE=GAME_MODE_BUTTON` в `PLAY` под своим контроллером, как кнопка
   * подъёма таверны; цена меняется, читать её надо из тега, не из таблицы.
   */
  readonly darkGiftCost: number | null;
  /**
   * Сколько зарядов дара осталось — тег `TAG_SCRIPT_DATA_NUM_2` кнопки:
   * 3 при создании, по единице за нажатие (part11: 3 → 2 → 1 → 0; part31:
   * кнопка создаётся с NUM_2=3 на первом ходу, нажатия на ходах 19, 21, 23).
   *
   * `null` — кнопки нет или тега на ней нет. Заряды нужны советнику
   * не как «есть ли ещё», а как ЧИСЛО: три заряда на партию длиной
   * в дюжину ходов таверны — это выбор, на каких ходах их жать (part31).
   */
  readonly darkGiftCharges: number | null;
  /** Нажат ли дар в этом ходу — блок `BlockType=PLAY` на кнопке. */
  readonly darkGiftUsedThisTurn: boolean;
  /**
   * Свои миньоны, чья активация нажата в этом ходу.
   *
   * Активация («Activate (N): …», part14: Suspicious Prisonguard) видна
   * так же, как сила героя: блоком `BlockType=PLAY` на сущности миньона,
   * СТОЯЩЕГО в `PLAY`, — розыгрыш из руки отличается зоной сущности.
   * Сброс — по смене `TURN`. Снимается ли доступность тегом после нажатия,
   * в фикстурах не видно, поэтому счёт ведётся блоками.
   */
  readonly activatedEntityIds: readonly number[];

  /**
   * Открытое сейчас предложение тринкетов.
   *
   * Сущности `CARDTYPE=BATTLEGROUND_TRINKET` под своим контроллером
   * в `SETASIDE` с тегом `USE_DISCOVER_VISUALS=1`. После выбора клиент
   * обнуляет тег, и предложение из состояния исчезает само.
   */
  readonly trinketOffer: readonly TrinketOffer[];
  /**
   * Открытый модальный выбор «возьмите одно из», если он сейчас на экране.
   *
   * Покрывает то, чего не видно по зонам: награду за тройку, раскопку карт,
   * лавку аксессуаров. Тринкеты при этом продолжают жить и в `trinketOffer` —
   * старый механизм по тегам зон никуда не девается.
   */
  readonly openChoice: OpenChoice | null;
  /**
   * Открытый выбор ГЕРОЯ в начале партии — канал тот же
   * (`DebugPrintEntityChoices`), но `ChoiceType=MULLIGAN`.
   *
   * Отдельным полем: это не модальный выбор таверны, советуется он
   * статистикой мест, а не ценностью миньона. Среди вариантов бывают
   * скины (`BG27_HERO_801_SKIN_A`) — статистика приводится к базовой карте.
   */
  readonly heroChoice: OpenChoice | null;
  /**
   * Взятые тринкеты по игрокам: `PlayerID` → dbfId карт.
   *
   * Теги `BACON_FIRST/SECOND_TRINKET_DATABASE_ID` на сущности героя.
   * Видны у ВСЕХ восьми игроков, не только у себя, — поэтому тринкеты
   * противника можно передавать симулятору. Идентификатор здесь dbfId,
   * как в логе; в cardId его переводит справочник карт.
   */
  readonly trinketsByPlayer: Readonly<Record<number, readonly number[]>>;
  /**
   * Карты миньонов, виденные в витрине за партию, без повторов.
   *
   * Единственный найденный источник состава племён партии: витрина
   * предлагает только пул. Племена из этого выводит советник по снапшоту
   * карт — однoплеменный миньон витрины доказывает своё племя, двуплеменные
   * («Рука-протез» MECH/UNDEAD была в пуле part11 без мехов) и амальгамы
   * доказательством не являются. Тег `CARDRACE` для состава не годится:
   * он строковый и показывает одно племя даже у двуплеменной карты.
   */
  readonly seenShopCardIds: readonly string[];
  /**
   * Место в таблице лобби — тег `PLAYER_LEADERBOARD_PLACE` на своём герое.
   *
   * Живёт всю партию как ТЕКУЩЕЕ место (part1, сегмент 1: 3-е посреди игры),
   * финальным становится на `FINAL_GAMEOVER`. Показывать его как «финальное»
   * до конца партии нельзя.
   */
  readonly finalPlace: number | null;
  /**
   * Номер билда игры — строка `BuildNumber=…` канала метаданных сразу
   * после CREATE_GAME (part16: 248348 на 239-й строке партии). Нужен
   * предупреждению о снапшоте, отставшем от патча, и датасету.
   */
  readonly buildNumber: number | null;
  /** BattleTag игрока — самый надёжный якорь «кто я». */
  readonly playerBattleTag: string | null;
  /** Номер контроллера игрока. */
  readonly playerId: number | null;
  /**
   * Журнал СВОИХ действий с начала партии, в порядке совершения.
   *
   * Накапливается всю партию (это история, а не «сейчас») и сбрасывается
   * только с новой партией — как борды соперников. После переподключения
   * журнал начинается заново: дамп реконнекта несёт состояние, но
   * не историю (та же честная граница, что у `lastSeenBoards`).
   */
  readonly actions: readonly PlayerAction[];
}

/**
 * Режим партии Battlegrounds — значение `GameType` канала `DebugPrintGame`.
 * Живёт здесь, а не у приёма архивов, потому что читателей теперь двое:
 * `dataset/import.ts` (чужие сессии) и точка решения (`gameType` состояния).
 */
export const BATTLEGROUNDS_GAME_TYPE = 'GT_BATTLEGROUNDS';

/**
 * Партия ли это Battlegrounds. Неизвестный режим (`null`) считается СВОИМ:
 * строки `GameType` нет у сегмента переподключения (part1, part35, part41),
 * и выбрасывать такие партии значило бы терять доигранные партии ради
 * страховки от чужого режима, который в них и так не встречается.
 */
export function isBattlegroundsGame(state: Pick<GameState, 'gameType'>): boolean {
  return state.gameType === null || state.gameType === BATTLEGROUNDS_GAME_TYPE;
}

export const EMPTY_STATE: GameState = {
  phase: 'tavern',
  turn: 0,
  techLevel: 1,
  techLevelUpTurn: null,
  tavernUpgradeCost: null,
  tavernUpgradeTarget: null,
  rerollCost: null,
  maxTechLevel: null,
  gold: 0,
  goldTotal: 0,
  goldSpent: 0,
  hero: null,
  board: [],
  hand: [],
  handSpells: [],
  shopSpells: [],
  shop: [],
  opponentBoard: [],
  anomalyCardId: null,
  globalInfo: EMPTY_GLOBAL_INFO,
  nextOpponentPlayerId: null,
  currentOpponentPlayerId: null,
  wonLastCombat: null,
  gameType: null,
  altTavern: false,
  lastSeenBoards: {},
  lastSeenBoardTurns: {},
  lobby: {},
  darkGiftCost: null,
  darkGiftCharges: null,
  darkGiftUsedThisTurn: false,
  activatedEntityIds: [],
  trinketOffer: [],
  openChoice: null,
  heroChoice: null,
  trinketsByPlayer: {},
  seenShopCardIds: [],
  finalPlace: null,
  buildNumber: null,
  playerBattleTag: null,
  playerId: null,
  actions: [],
};
