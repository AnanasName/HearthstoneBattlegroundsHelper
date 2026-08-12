/**
 * Правила таверны — данными, не кодом.
 *
 * ТЗ требует, чтобы конфигурация правил лежала таблицами, а не была вшита
 * в логику. Причина понятна на второй неделе: балансные патчи Hearthstone
 * выходят раз в месяц, тайминги подъёма и ценность племён от них ползут,
 * и менять это должно быть правкой числа, а не поиском по коду.
 *
 * Про происхождение чисел — честно и по пунктам:
 *
 *  - **цены** прочитаны из лога и проверены на фикстурах;
 *  - **тайминги подъёма** — общепринятая кривая сообщества, сверенная с тем,
 *    как играл человек в фикстурах. Это не замер и не оптимум, а отправная
 *    точка, которую видно и легко подвинуть;
 *  - **веса ценности миньона** подобраны так, чтобы порядок предпочтений был
 *    осмысленным, а не так, чтобы совпасть с чьей-то статистикой. Проверка
 *    у нас другая и лучше любых весов: симулятор считает, чем покупка
 *    оборачивается в бою (`docs/tavern.md`).
 */

export interface LevelTiming {
  /** С какого хода эта строка действует. */
  readonly fromTurn: number;
  /** Какой тир к этому ходу хочется иметь. */
  readonly tier: number;
}

export interface TavernRules {
  /**
   * Сколько стоит купить миньона.
   *
   * Правило игры, а не факт лога: именованного тега с ценой покупки
   * в фикстурах нет, у миньонов магазина тега `COST` не оказалось вовсе.
   * Герои и предметы цену меняют — в part3 виден `BACON_REDUCE_BUY_COST`
   * и `BACON_SHOW_OVERRIDEN_MINION_COST`, — но разобрать их мы пока не умеем,
   * и советник этого не скрывает.
   */
  readonly minionCost: number;
  /** Обновление витрины. Прочитано из кнопки `TB_BaconShop_8p_Reroll_Button`: 1. */
  readonly rerollCost: number;
  /** Мест на борде. */
  readonly boardSize: number;

  /**
   * К какому тиру стремиться на каком ходу.
   *
   * Кривая сообщества, сверенная с фикстурами: в part3 человек шёл
   * т2 на 3-м ходу, т3 на 5-м, т4 на 7-м — почти ровно по этой таблице;
   * в part2 он играл медленнее и занял место хуже.
   */
  readonly levelling: readonly LevelTiming[];
  /**
   * Ниже этого здоровья подъём таверны не советуется.
   *
   * Смысл не в самом числе, а в том, что оно есть: подъём — это ход без
   * покупки, то есть заведомо слабый бой. На полном здоровье такой размен
   * окупается, на остатках он и есть проигрыш партии.
   */
  readonly levellingHpFloor: number;
  /**
   * Насколько отставание от таблицы усиливает желание подняться.
   * За каждый тир отставания.
   */
  readonly levellingUrgencyPerTier: number;

  /** Веса ценности миньона при покупке. */
  readonly value: {
    /** За каждый тир миньона. */
    readonly perTechLevel: number;
    /** За каждую единицу суммы атаки и здоровья. */
    readonly perStatPoint: number;
    /** За каждого своего миньона того же племени. */
    readonly perTribeMate: number;
    /** Золотой. */
    readonly golden: number;
    /** Ключевые слова. */
    readonly taunt: number;
    readonly divineShield: number;
    readonly poisonous: number;
    readonly windfury: number;
    readonly reborn: number;
  };

  /**
   * Сколько добавляет каждая уже имеющаяся копия карты.
   *
   * Индекс — число копий на борде и в руке. Две копии означают, что покупка
   * собирает тройку: миньон становится золотым и даёт открытие карты тиром
   * выше. Это самая сильная покупка в игре, и вес это отражает.
   */
  readonly copiesBonus: readonly number[];

  /** Ниже этой ценности покупка считается пустой, и лучше обновить витрину. */
  readonly rerollWhenBestBelow: number;
  /**
   * Заморозка: витрину стоит держать, если в ней есть недоступное сейчас,
   * но ценное. Порог — та же шкала ценности.
   */
  readonly freezeWhenUnaffordableAbove: number;
  /**
   * Насколько лучший кандидат из магазина должен превосходить худшего своего,
   * чтобы советовать продажу ради места.
   */
  readonly sellMargin: number;
}

export const DEFAULT_TAVERN_RULES: TavernRules = {
  minionCost: 3,
  rerollCost: 1,
  boardSize: 7,

  levelling: [
    { fromTurn: 1, tier: 1 },
    { fromTurn: 3, tier: 2 },
    { fromTurn: 5, tier: 3 },
    { fromTurn: 7, tier: 4 },
    { fromTurn: 9, tier: 5 },
    { fromTurn: 11, tier: 6 },
  ],
  levellingHpFloor: 15,
  levellingUrgencyPerTier: 3,

  value: {
    perTechLevel: 2,
    perStatPoint: 0.5,
    perTribeMate: 1.5,
    golden: 4,
    taunt: 1,
    divineShield: 3,
    poisonous: 3,
    windfury: 2,
    reborn: 2,
  },

  // 0 копий — ничего, 1 копия — заметно, 2 копии — тройка, и это решает.
  copiesBonus: [0, 3, 12],

  rerollWhenBestBelow: 6,
  freezeWhenUnaffordableAbove: 12,
  sellMargin: 3,
};

/** Какой тир полагается иметь к этому ходу по таблице. */
export function targetTier(turn: number, rules: TavernRules): number {
  let tier = rules.levelling[0]?.tier ?? 1;
  for (const row of rules.levelling) {
    if (turn >= row.fromTurn) tier = row.tier;
  }
  return tier;
}
