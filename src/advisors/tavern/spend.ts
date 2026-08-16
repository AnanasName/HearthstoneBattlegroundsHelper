import type { GameState, Minion } from '../../state/types.js';
import { adviseTavern, type Recommendation, type TavernAdvisorDeps } from './advisor.js';
import { DEFAULT_TAVERN_RULES, type TavernRules } from './rules.js';

/**
 * План трат хода: что делать со ВСЕМ золотом, а не только первым действием.
 *
 * Зачем это отдельно от списка советов. Советы — это ранжирование отдельных
 * действий: «купить X» 14 очков, «поднять таверну» 19, «разыграть Y» 16.
 * Игрок читает верхнюю строку и делает одно дело, а ход состоит из
 * нескольких: подняться на 7 и купить на 3, купить и купить, разыграть
 * из руки и обновить витрину. Судьбу остатка советник до сих пор называл
 * СЛОВАМИ («остаток 1 сгорит — это цена подъёма»), но корзину не собирал —
 * это и записано в CLAUDE.md как сознательно отложенное.
 *
 * Как устроено. План — это ЦЕПОЧКА тех же правил: берём верхний совет,
 * применяем его к гипотетическому состоянию, пересчитываем правила на новом
 * состоянии, берём следующий. Никакой второй шкалы очков не заводится —
 * и это главное решение здесь. Ценность подъёма в правилах СРАВНИТЕЛЬНАЯ
 * (при отставании она равна лучшей покупке плюс срочность, чтобы обойти
 * её в списке), а не маржинальная; складывать такие числа между собой
 * значило бы считать лучшую покупку дважды. Поэтому цепочка не «оптимизирует
 * сумму», а честно доигрывает уже проверенное ранжирование до конца хода.
 *
 * Границы, за которые план не выходит:
 *
 *  - **план обрывает только обновление витрины**. После реролла витрина
 *    другая, и любые советы по ней — выдумка. У остальных действий
 *    с неизвестным ЭФФЕКТОМ (сила героя, тёмный дар, заклинания) известна
 *    цена, и золото считается дальше честно; сам шаг помечен как
 *    непрозрачный — что он принесёт, решает игра;
 *  - **заморозка — последний шаг плана**. Золота она не тратит и состояния
 *    не меняет, а решается в конце хода: после трат видно, что осталось
 *    не по карману. Пока есть что делать с золотом, она ждёт — иначе план
 *    обрывался бы на ней, не потратив ни монеты;
 *  - **продажа** входит в план отдельным шагом только там, где её советуют
 *    правила: размен на полном борде (`sellRule`) и карта, чья ценность
 *    реализуется продажей (`sellForGoldRule`, part18). Продажа ради места
 *    под конкретную покупку по-прежнему живёт внутри самой покупки
 *    (`sellFirst`) и отдельным шагом не дублируется.
 */

/** Шаг плана трат. */
export interface SpendStep {
  /** Совет, из которого шаг вырос: у него уже есть цель, цена и причина. */
  readonly recommendation: Recommendation;
  /** Золото ДО шага. */
  readonly goldBefore: number;
  /** Золото ПОСЛЕ шага. */
  readonly goldAfter: number;
  /** Эффект шага смоделирован не полностью: реролл, сила героя, дар, заклинание. */
  readonly opaque: boolean;
  /**
   * Состояние ПОСЛЕ шага — то самое, на котором считался следующий совет.
   *
   * Нужно не интерфейсу, а проверке: борд плана нельзя восстановить
   * по списку покупок. Магнитный мех слота не занимает, а покупка
   * на полный борд уходит в руку — набор «те же карты» дал бы борд,
   * которого у плана нет, и замер судил бы его по чужой расстановке.
   */
  readonly stateAfter: GameState;
}

export interface SpendPlan {
  readonly steps: readonly SpendStep[];
  /** Сколько золота останется неистраченным — оно сгорает в конце хода. */
  readonly goldLeft: number;
  /** Оборвался ли план на непрозрачном действии. */
  readonly truncated: boolean;
}

/** Действия, которые в план трат не входят вовсе. */
const SKIPPED_ACTIONS: ReadonlySet<Recommendation['action']> = new Set(['pass']);

const withoutEntity = (list: readonly Minion[], entityId: number): Minion[] =>
  list.filter((m) => m.entityId !== entityId);

const withoutSpell = <T extends { readonly cardId: string }>(
  list: readonly T[],
  cardId: string | null | undefined,
): T[] => {
  const i = cardId == null ? -1 : list.findIndex((s) => s.cardId === cardId);
  return i < 0 ? [...list] : [...list.slice(0, i), ...list.slice(i + 1)];
};

/** Результат применения совета к гипотетическому состоянию. */
export interface AppliedStep {
  readonly state: GameState;
  /**
   * Эффект шага смоделирован не полностью: цена известна, а что придёт —
   * решает игра (сила героя, тёмный дар, заклинание, активация, прокрутка).
   */
  readonly opaque: boolean;
  /** После шага планировать больше нечего: витрина стала другой. */
  readonly terminal: boolean;
}

/**
 * Состояние после применения совета — ровно в тех полях, от которых зависят
 * следующие советы: борд, рука, витрина, золото, тир.
 *
 * `null` — совет применить нельзя (в план он не входит). Модель намеренно
 * грубая там, где игра случайна: купленный миньон попадает на борд, если
 * место есть, и в руку, если борд полон, — это ровно то, что увидит игрок,
 * и ровно то, чем правила пользуются дальше. Где эффект неизвестен, честно
 * считается ОДНО золото, а шаг помечается непрозрачным.
 */
export function applyRecommendation(
  state: GameState,
  rec: Recommendation,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): AppliedStep | null {
  if (SKIPPED_ACTIONS.has(rec.action)) return null;

  /**
   * Общая часть любого платного шага: золото ушло.
   *
   * `goldSpent` держится согласованным с остатком (`gold = goldTotal −
   * goldSpent`) — тем самым равенством, которое поддерживает редьюсер.
   * Складывать цены отдельно нельзя: продажа возвращает золото, и счётчик
   * разошёлся бы с остатком. По `goldSpent > 0` определяются точки решения
   * (`turns.ts`) и запись в датасет, и гипотетическое состояние обязано
   * выглядеть как настоящее.
   */
  const paid = (patch: Partial<GameState> = {}): GameState => {
    const next = { ...state, gold: state.gold - rec.cost, ...patch };
    return { ...next, goldSpent: state.goldTotal - next.gold };
  };

  switch (rec.action) {
    case 'levelUp': {
      const target = state.tavernUpgradeTarget ?? state.techLevel + 1;
      return {
        state: paid({
          techLevel: target,
          techLevelUpTurn: state.turn,
          // Кнопки подъёма на этот ход больше нет: дважды за ход не поднимаются.
          tavernUpgradeCost: null,
          tavernUpgradeTarget: null,
        }),
        opaque: false,
        terminal: false,
      };
    }

    case 'buy': {
      // Заклинание витрины: цена известна, эффект — нет.
      if (rec.minion === null) {
        return {
          state: paid({ shopSpells: withoutSpell(state.shopSpells, rec.spellCardId) }),
          opaque: true,
          terminal: false,
        };
      }

      const sold = rec.sellFirst;
      const board = sold === null ? state.board : withoutEntity(state.board, sold.entityId);
      const refund = sold === null ? 0 : rules.sellGold;
      const shop = withoutEntity(state.shop, rec.minion.entityId);

      // Магнитный мех уходит на носителя: слота не занимает. Статы носителя
      // правила пересчитают сами — здесь важно лишь то, что миньон покинул
      // витрину и золото потрачено.
      if (rec.magnetizeTo != null) {
        return {
          state: paid({ gold: state.gold - rec.cost + refund, shop, board }),
          opaque: false,
          terminal: false,
        };
      }

      const room = board.length < rules.boardSize;
      return {
        state: paid({
          gold: state.gold - rec.cost + refund,
          shop,
          board: room ? [...board, rec.minion] : board,
          hand: room ? state.hand : [...state.hand, rec.minion],
        }),
        opaque: false,
        terminal: false,
      };
    }

    case 'play': {
      // Заклинание руки: бесплатно или за цену тега, эффект неизвестен.
      if (rec.minion === null) {
        return {
          state: paid({ handSpells: withoutSpell(state.handSpells, rec.spellCardId) }),
          opaque: true,
          terminal: false,
        };
      }

      const sold = rec.sellFirst;
      const board = sold === null ? state.board : withoutEntity(state.board, sold.entityId);
      const refund = sold === null ? 0 : rules.sellGold;
      const hand = withoutEntity(state.hand, rec.minion.entityId);

      // Розыгрыш бесплатен (cost 0), но продажа ради места возвращает золото,
      // и остаток обязан это учесть — как и `goldSpent` следом за ним.
      if (rec.magnetizeTo != null) {
        return {
          state: paid({ gold: state.gold + refund, hand, board }),
          opaque: false,
          terminal: false,
        };
      }
      if (board.length >= rules.boardSize) return null;
      return {
        state: paid({ gold: state.gold + refund, hand, board: [...board, rec.minion] }),
        opaque: false,
        terminal: false,
      };
    }

    case 'heroPower': {
      const hero = state.hero;
      return {
        state: paid({
          hero: hero === null ? null : { ...hero, heroPowerUsedThisTurn: true },
        }),
        opaque: true,
        terminal: false,
      };
    }

    case 'darkGift':
      return { state: paid({ darkGiftUsedThisTurn: true }), opaque: true, terminal: false };

    case 'spin':
      // Прокрутка — цепочка «купить-разыграть-продать»: миньон уходит
      // из витрины, а цена шага и есть чистая цена цепочки. Что принесёт
      // боевой клич — решает игра.
      return {
        state: paid({
          shop: rec.minion === null ? state.shop : withoutEntity(state.shop, rec.minion.entityId),
        }),
        opaque: true,
        terminal: false,
      };

    case 'activate':
      // Активация — свой эффект со своей ценой; носитель остаётся на борде.
      return { state: paid(), opaque: true, terminal: false };

    case 'reroll':
      // Витрина стала другой: всё, что мы про неё знали, больше не про неё.
      return { state: paid({ shop: [] }), opaque: true, terminal: true };

    case 'sell': {
      // Продажа — шаг хода, а не только освобождение места: карта, чья
      // ценность в продаже, отдаёт золото и обещанное (part18, ход 5).
      // Кого продать, решило правило; здесь только последствия.
      if (rec.minion === null) return null;
      return {
        state: paid({
          gold: state.gold + rules.sellGold,
          board: withoutEntity(state.board, rec.minion.entityId),
        }),
        // Что придёт взамен по тексту карты, решает игра.
        opaque: true,
        terminal: false,
      };
    }

    case 'freeze':
      // Заморозка ничего не тратит и ничего не меняет — она про следующий
      // ход. В плане она последняя: решение о ней принимается, когда золото
      // уже потрачено и стало видно, что осталось не по карману.
      return { state, opaque: false, terminal: true };

    default:
      return null;
  }
}

/**
 * Можно ли ставить совет следующим шагом плана.
 *
 * Смысл проверки — не повторить уже сделанное: подъём один за ход, каждая
 * карта покупается и разыгрывается однажды. Состояние это и так отражает
 * (купленный миньон уходит из витрины), но подъём отдельным полем.
 */
function planNextStep(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
  used: ReadonlySet<string>,
): Recommendation | null {
  const advice = adviseTavern(state, deps, rules);
  if (advice === null) return null;

  const usable = advice.recommendations.filter((rec) => {
    if (SKIPPED_ACTIONS.has(rec.action)) return false;
    if (rec.cost > state.gold) return false;
    // Совет без ценности планом не считается: «ничего» и нулевые довески
    // заканчивают ход, а не наполняют план.
    if (rec.score <= 0) return false;
    const key = stepKey(rec);
    return key === null || !used.has(key);
  });

  // Заморозка — действие КОНЦА хода: пока есть что делать с золотом, она ждёт.
  // Иначе план обрывался бы на ней, не потратив ни монеты: очки заморозки
  // считаются по своей шкале и легко обгоняют покупку.
  return usable.find((rec) => rec.action !== 'freeze') ?? usable[0] ?? null;
}

/**
 * Ключ шага: одно и то же действие над одной и той же картой в план
 * дважды не попадает.
 *
 * Состояние это ловит не всегда: активация оставляет носителя на борде,
 * а «нажато в этом ходу» читается из блоков лога, которых у гипотетического
 * состояния нет. Без ключа план на part17 (ход 19) трижды подряд прокручивал
 * одного и того же Oozeling Gladiator.
 */
function stepKey(rec: Recommendation): string | null {
  // Заклинания ключом не запираются: состояние убирает разыгранное само,
  // по одной штуке. Ключ по cardId запретил бы вторую такую же карту —
  // две монетки таверны в руке разыгрываются обе.
  if (rec.minion === null && rec.spellCardId != null) return null;
  return `${rec.action}:${rec.minion === null ? '' : String(rec.minion.entityId)}`;
}

export interface SpendPlanOptions {
  /** Предел длины плана — страховка от зацикливания на бесплатных шагах. */
  readonly maxSteps?: number;
}

/**
 * План трат хода: цепочка советов, каждый следующий — на состоянии после
 * предыдущего.
 *
 * Возвращается как есть, включая план из одного шага: решать, показывать ли
 * его, — дело интерфейса (одношаговый план и есть верхняя строка советов,
 * и оверлей его прячет). Обрезка здесь ломала бы замер: план из одного
 * действия он читал бы как «ничего не делать».
 */
export function spendPlan(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
  options: SpendPlanOptions = {},
): SpendPlan {
  const maxSteps = options.maxSteps ?? 8;
  const steps: SpendStep[] = [];
  const used = new Set<string>();
  let current = state;
  let truncated = false;

  for (let i = 0; i < maxSteps; i += 1) {
    const rec = planNextStep(current, deps, rules, used);
    if (rec === null) break;
    const key = stepKey(rec);
    if (key !== null) used.add(key);

    const applied = applyRecommendation(current, rec, rules);
    if (applied === null) break;

    steps.push({
      recommendation: rec,
      goldBefore: current.gold,
      goldAfter: applied.state.gold,
      opaque: applied.opaque,
      stateAfter: applied.state,
    });
    current = applied.state;

    if (applied.terminal) {
      // «Оборван» — не то же, что «закончен»: план обрывается, только когда
      // будущее стало неизвестным (обновление меняет витрину). Заморозка
      // тоже заканчивает план, но ничего не прячет — она и есть последний
      // осмысленный шаг хода.
      truncated = applied.opaque;
      break;
    }
  }

  return { steps, goldLeft: current.gold, truncated };
}
