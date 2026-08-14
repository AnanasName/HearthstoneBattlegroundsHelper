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
   * (part12). Имена совпадают со строками `races` снапшота — включая
   * `MECH`, а не `MECHANICAL` (part9, Scraper Sticker).
   */
  readonly subsetRaces: readonly string[];
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
   * Тег `COST`, живое значение: монетка создаётся с COST=1 и падает до нуля —
   * читать надо тег, а не снапшот карт.
   */
  readonly cost: number;
  /** `TAG_SCRIPT_DATA_NUM_1..2` — значения плейсхолдеров `{0}`/`{1}` текста. */
  readonly scriptData: readonly (number | null)[];
  /** `LITERALLY_UNPLAYABLE` — замок, как у карт-миньонов. */
  readonly unplayable: boolean;
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
   * `EXHAUSTED` на силах в фикстурах не встречается ни разу; применение
   * видно иначе — блоком `BlockType=PLAY` на сущности силы (part8:
   * 10 нажатий, 10 таких блоков). Сбрасывается со сменой хода.
   */
  readonly heroPowerUsedThisTurn: boolean;
  /** Тег `LITERALLY_UNPLAYABLE`: сила есть, но жать её сейчас нельзя. */
  readonly heroPowerUnplayable: boolean;
  /**
   * Активная ли сила — тег `HAS_ACTIVATE_POWER` на её сущности.
   *
   * У пассивных сил тега нет, и советовать «нажать» их нельзя. Фактура
   * part13: у «Мана в минуту» Хроми `HAS_ACTIVATE_POWER=1` при отсутствии
   * тега `COST` — сила активная и бесплатная.
   */
  readonly heroPowerHasActivate: boolean;
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
   * Цена нажатия тёмного дара — тег `COST` кнопки `BG36_Button_DarkGift`.
   *
   * `null`, когда кнопки нет (партия без даров или кнопка убрана). Кнопка —
   * `CARDTYPE=GAME_MODE_BUTTON` в `PLAY` под своим контроллером, как кнопка
   * подъёма таверны; цена меняется, читать её надо из тега, не из таблицы.
   */
  readonly darkGiftCost: number | null;
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
}

export const EMPTY_STATE: GameState = {
  phase: 'tavern',
  turn: 0,
  techLevel: 1,
  techLevelUpTurn: null,
  tavernUpgradeCost: null,
  tavernUpgradeTarget: null,
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
  lastSeenBoards: {},
  lastSeenBoardTurns: {},
  darkGiftCost: null,
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
};
