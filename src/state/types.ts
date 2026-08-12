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
  /** Золотой миньон. Признак пока не подтверждён, см. docs/power-log.md. */
  readonly golden: boolean;
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

export interface Hero {
  readonly entityId: number;
  readonly cardId: string;
  readonly health: number | null;
  readonly armor: number;
  readonly damage: number;
}

export interface GameState {
  readonly phase: Phase;
  /** Номер хода из тега `TURN` на `GameEntity`. */
  readonly turn: number;
  /** Тир таверны из `PLAYER_TECH_LEVEL`. */
  readonly techLevel: number;
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
  /** Своя рука. */
  readonly hand: readonly Minion[];
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
  /** Финальное место, появляется на `FINAL_GAMEOVER`. */
  readonly finalPlace: number | null;
  /** BattleTag игрока — самый надёжный якорь «кто я». */
  readonly playerBattleTag: string | null;
  /** Номер контроллера игрока. */
  readonly playerId: number | null;
}

export const EMPTY_STATE: GameState = {
  phase: 'tavern',
  turn: 0,
  techLevel: 1,
  gold: 0,
  goldTotal: 0,
  goldSpent: 0,
  hero: null,
  board: [],
  hand: [],
  shop: [],
  opponentBoard: [],
  anomalyCardId: null,
  finalPlace: null,
  playerBattleTag: null,
  playerId: null,
};
