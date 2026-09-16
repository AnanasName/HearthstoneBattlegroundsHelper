import type { GameState, Minion } from '../../state/types.js';
import {
  adviseTavern,
  withKeyword,
  withMagnetDoublingSpent,
  type Recommendation,
  type TavernAdvisorDeps,
} from './advisor.js';
import { DEFAULT_TAVERN_RULES, type TavernRules } from './rules.js';

/**
 * Сила героя после покупки миньона: остаток счётчика «после N покупок»
 * на один меньше, если покупка засчитывается. Иначе — прежний герой
 * (та же ссылка: без силы такого рода менять нечего).
 */
function withHeroPowerBuyCounted(state: GameState, rec: Recommendation): GameState['hero'] {
  const hero = state.hero;
  if (hero === null) return hero;
  // Скидка от покупки своего племени (Патчес, part40): «After you buy
  // a Pirate, your next Hero Power costs (1) less». Живую цену редьюсер
  // читает тегом, но скидку от СВОЕГО ЖЕ шага плану взять было неоткуда —
  // цепочка «купить пирата → нажать силу» считала силу по цене ДО покупки
  // и переоценивала ход на всю величину скидки.
  const discounted =
    rec.heroPowerCostAfter === undefined ? hero : { ...hero, heroPowerCost: rec.heroPowerCostAfter };
  if (rec.heroPowerBuyLeft === undefined) return discounted;
  const scriptData = [...discounted.heroPowerScriptData];
  // Запись по индексу, а не отображением: на пустом массиве `map` не сделал
  // бы ничего — ровно там, где «тега нет» читается как «счётчик полный»
  // (урок заряда магнита-хранителя, 18.08).
  scriptData[0] = rec.heroPowerBuyLeft;
  return { ...discounted, heroPowerScriptData: scriptData };
}

/**
 * Витрина после покупки миньона, чей клич дешевит заклинания (part49).
 *
 * Цена падает у ВСЕХ заклинаний витрины, хотя текст обещает её следующему
 * купленному: оценка верхняя, и разойтись с игрой она может только в ходу,
 * где план покупает два заклинания подряд. Ниже нуля цена не опускается —
 * заклинание за 0 игра пишет сама, придумывать отрицательные не наше дело.
 */
function withSpellDiscount(
  spells: GameState['shopSpells'],
  amount: number,
): GameState['shopSpells'] {
  return spells.map((s) => ({ ...s, cost: Math.max(0, s.cost - amount) }));
}

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
 * Тот же борд, но у цели совета израсходован дневной заряд хранителя
 * заклинаний. Ничего не трогает, если совет заряда не тратит.
 *
 * Заряд ПИШЕТСЯ по индексу, а не отображается на месте: `map` по пустому
 * `scriptData` не делает ничего, а ровно этот случай — «тега нет» — обе
 * стороны читают как «заряд есть» (`scriptData[0] ?? 1`). То есть на
 * миньоне без живого тега `TAG_SCRIPT_DATA_NUM_1` расход заряда молча
 * не записывался, и план советовал два чародейских заклинания подряд
 * на одного хранителя — ровно та двойная трата, ради которой поле
 * `spendsMagnetCharge` и заводилось (part21).
 */
function withoutMagnetCharge(
  board: readonly Minion[],
  rec: Recommendation,
): readonly Minion[] {
  const target = rec.targetMinion;
  if (rec.spendsMagnetCharge !== true || target == null) return board;
  return board.map((m) => {
    if (m.entityId !== target.entityId) return m;
    const scriptData = [...m.scriptData];
    scriptData[0] = Math.max(0, (scriptData[0] ?? 1) - 1);
    return { ...m, scriptData };
  });
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
   * `goldSpent` держится согласованным с остатком: на сколько уменьшился
   * остаток, на столько выросло «потрачено» — как у редьюсера. Складывать
   * цены отдельно нельзя: продажа возвращает золото, и счётчик разошёлся
   * бы с остатком. По `goldSpent > 0` определяются точки решения
   * (`turns.ts`) и запись в датасет, и гипотетическое состояние обязано
   * выглядеть как настоящее.
   */
  const paid = (patch: Partial<GameState> = {}): GameState => {
    const next = { ...state, gold: state.gold - rec.cost, ...patch };
    // Золото, которое действие ПРИНОСИТ, известно числом из текста карты —
    // и обязано доехать до следующего шага. Иначе план обещает «откроется
    // покупка» и тут же её не делает (part24, ход 9).
    const gained = rec.grantsGold ?? 0;
    const withGold = gained > 0 ? { ...next, gold: next.gold + gained } : next;
    // Приращением, а не `goldTotal − gold`: с временным золотом
    // (`TEMP_RESOURCES`, part34) остаток бывает больше базового максимума,
    // и разность дала бы отрицательное «потрачено».
    return { ...withGold, goldSpent: Math.max(0, state.goldSpent + (state.gold - withGold.gold)) };
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
          state: paid({
            gold: state.gold - rec.cost + refund,
            shop,
            board: withMagnetDoublingSpent(board, rec.magnetizeTo),
          }),
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
          // Клич, дешевящий заклинание витрины (Зловещая пророчица, part49):
          // скидка достаётся плану ТОЛЬКО когда миньон встаёт на борд —
          // клич срабатывает розыгрышем, а на полном борде без продажи
          // карта осталась бы в руке и не сработала бы вовсе.
          ...(rec.spellDiscountAfter === undefined || !room
            ? {}
            : { shopSpells: withSpellDiscount(state.shopSpells, rec.spellDiscountAfter) }),
          // Сила «после N покупок с механикой — награда» (part34) считает
          // ЭТУ покупку: следующий шаг плана обязан видеть остаток на один
          // меньше, иначе на последнем шаге два кличевых миньона подряд оба
          // стоили бы «целого Бранна». Саму награду гипотетическое
          // состояние не получает: выдумывать сущность в нём — тот же
          // отказ, что у силы-Discover (part30).
          hero: withHeroPowerBuyCounted(state, rec),
        }),
        opaque: false,
        terminal: false,
      };
    }

    case 'play': {
      // Заклинание руки: бесплатно или за цену тега, эффект неизвестен.
      if (rec.minion === null) {
        // Заклинание, ОБНОВЛЯЮЩЕЕ витрину («Refresh the Tavern with Battlecry
        // minions», part35), — то же, что обновление кнопкой: витрина стала
        // другой, и планировать по старой больше нечего.
        const refreshes = rec.refreshesShop === true;
        return {
          state: paid({
            handSpells: withoutSpell(state.handSpells, rec.spellCardId),
            // Дневной заряд магнита-хранителя потрачен: следующее чародейское
            // заклинание той же цепочки постоянным на нём уже не станет
            // (part21). Счётчик живёт в `scriptData[0]` — «({0} left!)».
            board: withoutMagnetCharge(state.board, rec),
            shop: refreshes ? [] : state.shop,
            // Покупки после обновления обещаны самим советом («на 4 золота
            // покупок 4 по 1»), и их золото уходит здесь же: шаг обрывает
            // план, и иначе остаток числился бы сгоревшим (`refreshSpend`).
            gold: state.gold - rec.cost - (refreshes ? (rec.refreshSpend ?? 0) : 0),
          }),
          opaque: true,
          terminal: refreshes,
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
          state: paid({
            gold: state.gold + refund,
            hand,
            board: withMagnetDoublingSpent(board, rec.magnetizeTo),
          }),
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
      // Сила, ДАРЯЩАЯ своему миньону слово («Give a minion Reborn», part32):
      // эффект известен целиком — слово ложится на цель, и шаг прозрачен.
      const gift = rec.targetMinion;
      const keyword = rec.grantsKeyword;
      // Сила, кладущая на своего миньона СТАТЫ («Give a minion Attack equal
      // to your Tier», part45): эффект известен числом, шаг прозрачен так же,
      // как у слова. Без этого следующий шаг плана считал бы цель по старым
      // статам — та же дыра, что у заряда хранителя (`spellMagnetGain`).
      const stats = rec.grantsStats;
      // Сила, делающая своего миньона ЗОЛОТЫМ («Once per game, make
      // a friendly minion Golden», part48): прибавка известна числом
      // с золотой карты снапшота, значит шаг прозрачен так же, как слово
      // и статы. Без этого следующий шаг плана считал бы цель по старым
      // статам и мог бы назвать её же жертвой продажи.
      const golden = rec.grantsGolden;
      const grants =
        gift != null && (keyword !== undefined || stats !== undefined || golden !== undefined);
      // Продажа, ОПЛАЧИВАЮЩАЯ нажатие на полном борде (part40, ход 13):
      // без неё шаг стоил бы золота, которого нет, а жертва осталась бы
      // на борде — ровно та дыра, из-за которой прибавку от продажи
      // в part39 не стали распространять на подъём.
      const sold = rec.sellFirst;
      const sellBoard = sold === null ? state.board : withoutEntity(state.board, sold.entityId);
      const refund = sold === null ? 0 : rules.sellGold;
      // Сила, ПОДНИМАЮЩАЯ карту витрины на тир («Алчность Галакронда»,
      // part47), меняет витрину так же, как её обновление: что предложит
      // выбор из трёх, решает игра. Поэтому шаг обрывает план, а золото
      // обещанной покупки списывается здесь же (`refreshSpend`) — очки
      // нажатия УЖЕ посчитаны покупками хода, и без списания план потратил
      // бы те же три золота второй раз.
      const refreshes = rec.refreshesShop === true;
      return {
        state: paid({
          gold: state.gold - rec.cost + refund - (refreshes ? (rec.refreshSpend ?? 0) : 0),
          // Гасится и `EXHAUSTED`, а не только «нажата в этом ходу»: с part45
          // тег СИЛЬНЕЕ признака нажатия (`heroPowerReady`), и у силы Инге он
          // стоит в `false` посреди хода — без гашения план жал бы одну и ту
          // же силу шаг за шагом. Сколько нажатий положено, в логе не написано
          // нигде, поэтому план берёт ОДНО: недосчитать бесплатный шаг честнее,
          // чем построить ход на выдуманном лимите. Второе нажатие вернётся
          // само — живой оверлей пересчитает совет, увидев `EXHAUSTED=0`.
          hero:
            hero === null
              ? null
              : { ...hero, heroPowerUsedThisTurn: true, heroPowerExhausted: true },
          // Сила с ЦЕЛЬЮ в витрине забирает карту насовсем («Lock and Load»
          // Тавиша, part29: миньон уходит в REMOVEDFROMGAME). Без этого
          // следующий шаг плана мог бы предложить купить то, чем мы только
          // что выстрелили.
          // У силы, поднявшей карту, витрина стала другой целиком: место
          // цели занял неизвестный миньон тира выше.
          shop: refreshes
            ? []
            : rec.minion === null
              ? state.shop
              : withoutEntity(state.shop, rec.minion.entityId),
          board: grants
            ? sellBoard.map((m) => {
                if (m.entityId !== gift.entityId) return m;
                const withWord = keyword === undefined ? m : withKeyword(m, keyword);
                const withGold =
                  golden === undefined
                    ? withWord
                    : {
                        ...withWord,
                        golden: true,
                        attack: (withWord.attack ?? 0) + golden.attack,
                        health: (withWord.health ?? 0) + golden.health,
                      };
                if (stats === undefined) return withGold;
                return stats.stat === 'attack'
                  ? { ...withGold, attack: (withGold.attack ?? 0) + stats.amount }
                  : { ...withGold, health: (withGold.health ?? 0) + stats.amount };
              })
            : sellBoard,
        }),
        opaque: !grants,
        terminal: refreshes,
      };
    }

    case 'darkGift':
      return {
        state: paid({
          darkGiftUsedThisTurn: true,
          darkGiftCharges:
            state.darkGiftCharges === null ? null : Math.max(0, state.darkGiftCharges - 1),
        }),
        opaque: true,
        terminal: false,
      };

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
      // И отмечается нажатым: `activationRules` второй раз за ход его
      // не советует, а без отметки активация оставалась верхним советом
      // на каждом шаге, и запасное обновление плана не наступало никогда
      // (part53, ходы 23 и 25; part54, ход 27 — «остаётся 10 — сгорит»
      // при шестнадцати золотых).
      return {
        state: paid({
          activatedEntityIds:
            rec.minion === null
              ? state.activatedEntityIds
              : [...state.activatedEntityIds, rec.minion.entityId],
        }),
        opaque: true,
        terminal: false,
      };

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
function planSteps(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
  used: ReadonlySet<string>,
  withoutLevelUp = false,
): readonly Recommendation[] {
  const advice = adviseTavern(state, deps, rules);
  if (advice === null) return [];

  const usable = advice.recommendations.filter((rec) => {
    if (SKIPPED_ACTIONS.has(rec.action)) return false;
    // Ветка развилки «не поднимать в этот ход»: подъём выключен во всей
    // цепочке, а не только на первом шаге. Иначе сравнение выходило бы
    // не «подъём против покупок», а «две цепочки, и в обеих подъём»:
    // после вынужденного первого шага он снова становится верхним советом
    // и возвращается вторым (part24, ход 7).
    if (withoutLevelUp && rec.action === 'levelUp') return false;
    // Шаг с продажей платит за себя её золотым: тот же счёт, что
    // и у `applyRecommendation`, где возврат приходит вместе с покупкой
    // (part36, ход 13 — два золотых и покупка за три после продажи).
    if (rec.cost - (rec.sellFirst === null ? 0 : rules.sellGold) > state.gold) return false;
    // Совет без ценности планом не считается: «ничего» и нулевые довески
    // заканчивают ход, а не наполняют план.
    if (rec.score <= 0) return false;
    const key = stepKey(rec);
    return key === null || !used.has(key);
  });

  // Заморозка — действие КОНЦА хода: пока есть что делать с золотом, она ждёт.
  // Иначе план обрывался бы на ней, не потратив ни монеты: очки заморозки
  // считаются по своей шкале и легко обгоняют покупку.
  const spending = usable.filter((rec) => rec.action !== 'freeze');
  if (spending.length === 0) {
    // Тратить больше не на что — и тогда остаток забирает подъём,
    // обнулённый ПОРОГОМ ЗДОРОВЬЯ (`blockedByHp`). Довод порога — «ход без
    // покупки ослабит бой», — но покупок в этой ветке нет вовсе: они уже
    // сделаны или их не было. Золото иначе сгорает целиком (part52, ход 23:
    // hp 1, десять золотых, все шаги плана бесплатны; part51, ход 29 при hp 2).
    //
    // Берётся ТОЛЬКО ноль от порога здоровья. Ноль «по графику» — другое
    // утверждение («тир и так свой»), и пускать его тем же условием значило
    // бы воскресить подъём, который правило только что признало ненужным.
    //
    // В ветке развилки «ход БЕЗ подъёма» хвост не добавляется: там сравнение
    // идёт именно про подъём, и вернуть его с другого конца значило бы
    // сравнивать две цепочки, в обеих из которых он есть (part24, ход 7).
    const burning = withoutLevelUp ? undefined : advice.recommendations.find(
      (rec) =>
        rec.action === 'levelUp' &&
        rec.blockedByHp === true &&
        rec.cost <= state.gold &&
        !used.has(stepKey(rec) ?? ''),
    );
    if (burning !== undefined) {
      const tail: Recommendation = {
        ...burning,
        reason: `${burning.reason}; но тратить больше не на что — иначе золото сгорает, а покупок подъём не отнимает`,
      };
      return [tail, ...usable.slice(0, 1)];
    }
    return usable.slice(0, 1);
  }

  // Усиление ВСЕГО борда ждёт, пока есть что делать до него (part51).
  // Сыгранное раньше покупки, оно купленному не достанется, а жадная цепочка
  // ставила его первым именно потому, что оно стало дорогим: на part44
  // (ход 19) Time Management шёл до трёх выставленных миньонов, на part50
  // (ход 13) — до Persistent Poet.
  //
  // Правило — ровно заморозки строкой выше, а не «сначала купи тело»:
  // первая версия выдвигала вперёд именно покупку тела и тем самым тратила
  // золото на тело, которого план без неё не брал, — на part31 (ход 21)
  // из плана из-за этого выпал тёмный дар. Здесь вперёд идёт следующий
  // по очкам шаг, какой бы он ни был, и только если после него усиление
  // всё ещё оплачивается: переставить законно, потерять нельзя. Перед шагом,
  // который обрывает план (обновление, заморозка, заклинание-обновление),
  // оно не откладывается — за обрывом его в плане уже не будет.
  const head = spending[0];
  if (head?.buffsWholeBoard === true) {
    const ends = (rec: Recommendation): boolean =>
      rec.action === 'reroll' || rec.action === 'freeze' || rec.refreshesShop === true;
    const before = spending.find((rec) => {
      if (rec === head || rec.buffsWholeBoard === true || ends(rec)) return false;
      const net = rec.cost - (rec.sellFirst === null ? 0 : rules.sellGold) - (rec.grantsGold ?? 0);
      return state.gold - net >= head.cost;
    });
    if (before !== undefined) return [before, ...spending.filter((rec) => rec !== before)];
  }
  return spending;
}

function planNextStep(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
  used: ReadonlySet<string>,
  withoutLevelUp = false,
): Recommendation | null {
  return planSteps(state, deps, rules, used, withoutLevelUp)[0] ?? null;
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
 *
 * ## Развилка, когда золото сгорает
 *
 * Жадная цепочка берёт верхний совет и живёт остатком. Пока остаток
 * тратится, это честно; но верхний совет умеет ЗАПЕРЕТЬ остаток — оставить
 * золото, которого не хватает ни на что. Случай part23 (ход 5, пять золота):
 * тёмный дар за 3 (8.0 очков) — и два золота сгорают, тогда как прокрутка
 * за 2 (7.5) оставляла ровно три на покупку за 3 (7.0). Игрок сыграл именно
 * второе и написал: «мне подсвечивает ход, где я должен потерять золото».
 *
 * Поэтому шаг, после которого золото сгорает, соревнуется не сам с собой,
 * а с ЦЕПОЧКОЙ: план пробует начать с ближайших соперников верхнего совета
 * и берёт ту, у которой «сумма очков минус сгоревшее золото» больше.
 * Полного перебора корзин это не вводит (он замерен и отвергнут, см.
 * `spendQuality.ts`): развилка одна, на первом шаге, и только тогда, когда
 * жадная цепочка уже призналась, что золото сгорает.
 *
 * ПОДЪЁМ ТАВЕРНЫ входит в развилку с 17.08 — по решению игрока, после
 * третьей подряд жалобы на один и тот же ход (part23 ход 5, part24 ход 7,
 * part25 ход 7: шесть золота, подъём за 5, монета сгорает). Условие входа
 * одно и то же для всех: жадная цепочка сама призналась, что золото горит.
 *
 * Честность суммы держится на `standaloneScore`. Очки подъёма в СПИСКЕ —
 * это «лучшая покупка плюс срочность»: первое слагаемое не ценность
 * подъёма, а планка, которую он обязан перебить, чтобы стоять выше покупок.
 * В цепочке эта покупка делается по-настоящему и отдельным шагом, поэтому
 * в сумму идёт только своя ценность подъёма — срочность. Ровно на этом
 * прежняя попытка и была откачена; разница в том, что теперь двойной счёт
 * снят явно, а не спрятан.
 *
 * Следствие названо заранее и принято игроком: когда золота хватает на два
 * действия, цепочка почти всегда перевешивает срочность одного тира. Там,
 * где покупать нечего (правило мусорной витрины, JeefHS), подъём в развилку
 * по-прежнему не входит — `levelUpRule` не заполняет там `standaloneScore`.
 */
export function spendPlan(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
  options: SpendPlanOptions = {},
): SpendPlan {
  // Ранжирование на ИСХОДНОМ состоянии считается один раз: жадная цепочка
  // берёт отсюда свой первый шаг, развилка — его ближайших соперников.
  // Прежде и то и другое звало `adviseTavern` на одном и том же состоянии
  // порознь, а это самый дорогой вызов хода (полная витрина, тёмный дар
  // с усреднением по пулу, заморозка, выборы).
  const firstOptions = planSteps(state, deps, rules, new Set<string>());
  const greedy = buildChain(state, deps, rules, options, firstOptions[0] ?? null);
  // Золото, которое цепочка НЕ пристроила к делу: остаток плюс то, что ушло
  // в подъём-хвост (D214). Хвост тратит остаток, но развилку он выключать
  // не должен — иначе жадная цепочка, сунувшая девять золотых в тир,
  // объявлялась бы «потратившей всё», и альтернативы не пробовались бы
  // вовсе (part52, ход 21: из плана так выпадал тёмный дар).
  if (burningGold(greedy) <= 0) return greedy;

  // Цепочка с подъёмом судится развилкой только тогда, когда у подъёма есть
  // СВОЯ ценность (`standaloneScore`): без неё сумма очков считала бы лучшую
  // покупку дважды. Не заполнено — цепочка уходит как есть, как было до
  // 17.08 (мусорная витрина, см. `levelUpRule`).
  // Подъём-ХВОСТ (`blockedByHp`, D214) развилкой не считается: он не выбор
  // между тиром и покупками, а способ не сжечь остаток, и появляется он
  // ровно там, где тратить больше не на что. Считать его «подъёмом жадной
  // цепочки» значило бы и выключить развилку, и строить альтернативы
  // без него — то есть сравнивать цепочку с непотраченным золотом
  // с цепочкой, которая его сожгла.
  const levelStep = greedy.steps.find(
    (s) => s.recommendation.action === 'levelUp' && s.recommendation.blockedByHp !== true,
  );
  if (levelStep !== undefined && levelStep.recommendation.standaloneScore === undefined) {
    return greedy;
  }

  // Началом АЛЬТЕРНАТИВЫ подъём не пробуется: он либо уже стоит верхним
  // советом (и тогда он и есть жадная цепочка), либо проиграл в списке —
  // и начинать с проигравшего незачем.
  const nearest = firstOptions
    .slice(1)
    .filter((rec) => rec.action !== 'levelUp')
    .slice(0, rules.maxAlternativeStarts);

  // Шаг, ДОБАВЛЯЮЩИЙ золото, пробуется началом всегда — независимо от места
  // в списке (решение игрока 04.09 по part39). Своих очков у него мало
  // (нажатие силы-кубика — 7.5 против 20.5 у верхней покупки), в тройку
  // ближайших соперников он не попадает, и жадная цепочка ставила его
  // ПОСЛЕ покупок — туда, где принесённое золото уже некуда девать.
  // Игрок все три раза за партию жал силу ПЕРВЫМ действием хода.
  const goldAdders = firstOptions
    .slice(1)
    .filter((rec) => rec.action !== 'levelUp' && (rec.grantsGold ?? 0) > 0)
    .filter((rec) => !nearest.includes(rec));

  // Шаг, ДЕШЕВЯЩИЙ заклинание витрины, пробуется началом по тому же доводу
  // (part49, ход 1, жалоба игрока «не учёл, что нага удешевит карту, и я смогу
  // сыграть 3 карты за ход без сгорания»). Своих очков у наги мало — 3.5
  // против 5.0 у верхней покупки, четвёртое место в списке, — и в тройку
  // ближайших соперников она не попадала.
  //
  // **Но пускать её началом ВСЕГДА нельзя, и это показал замер, а не
  // рассуждение** (41 партия, 510 точек решения): без условия ниже правка
  // меняла план в трёх точках, и две из трёх — к худшему. На part27 (ход 23,
  // восемнадцать золота) цепочка покупала нагу за 3 и тут же продавала её,
  // не купив НИ ОДНОГО заклинания: скидка не понадобилась, а очки набежали
  // от «остаток меньше». На part21 (ход 15) ради золотой скидки терялся
  // розыгрыш Clunker Junker 5/5 из руки. Тот же класс, что отменённый
  // запрет продажи носителя активации в part44: правило, верное на своём
  // ходу, не масштабируется на богатые.
  //
  // Условие — из фактуры жалобы, а не порог: скидка обязана ОТКРЫВАТЬ
  // покупку, которая иначе закрыта, то есть превращать сгорающее золото
  // в заклинание. Тот же довод, что у продажи ради золота («обязана менять
  // ЧИСЛО доступных покупок», part18) и у заморозки ради предложения
  // дешевле покупки («два тела вместо одного», part29). На ходу 1 part49
  // жадная цепочка оставляет 1, лассо стоит 2 — со скидкой ровно 1,
  // и монета вместо сгорания покупает карту.
  const burning = greedy.goldLeft;
  const opensPurchase = (rec: Recommendation): boolean => {
    const amount = rec.spellDiscountAfter ?? 0;
    if (amount <= 0) return false;
    return state.shopSpells.some(
      // Заклинание за здоровье золотом не оплачивается вовсе (part29),
      // и скидка на золото ему ничего не открывает.
      (s) => !s.costsHealth && s.cost > burning && s.cost - amount <= burning,
    );
  };
  const discounters = firstOptions
    .slice(1)
    .filter((rec) => rec.action !== 'levelUp' && opensPurchase(rec))
    .filter((rec) => !nearest.includes(rec) && !goldAdders.includes(rec));
  const alternatives = [...nearest, ...goldAdders, ...discounters];

  // Когда жадная цепочка поднимает таверну, альтернатива — это ход БЕЗ
  // подъёма целиком: ровно тот выбор, который делает игрок.
  const withoutLevelUp = levelStep !== undefined;

  let best = greedy;
  let bestValue = chainValue(greedy, deps, rules);
  for (const first of alternatives) {
    const chain = buildChain(state, deps, rules, options, first, withoutLevelUp);
    const value = chainValue(chain, deps, rules);
    // Строгое превосходство: при равенстве остаётся жадная цепочка, чтобы
    // порядок советов и план не расходились без причины.
    //
    // ИСКЛЮЧЕНИЕ — начало, которое ДОБАВЛЯЕТ золото, и причина у него
    // не «так красивее», а арифметическая. В план такой шаг отдаёт НИЖНЮЮ
    // грань (`grantsGold: 1` у силы-кубика), потому что настоящей суммы
    // до нажатия не знает никто. Цепочка из тех же шагов в другом порядке
    // стоит РОВНО СТОЛЬКО ЖЕ — нижняя грань на то и нижняя, — и строгое
    // сравнение оставляло бы нажатие в хвосте навсегда. Между двумя
    // одинаковыми по нашей шкале цепочками выбирать надо ту, где неизвестное
    // число становится известным РАНЬШЕ: всё, что стоит после нажатия,
    // посчитано на заниженном золоте, и игрок пересчитает это сам, увидев
    // бросок. Обратное (нажать последним) не даёт взамен ничего.
    const better = value > bestValue + 1e-9;
    const tieButLearnsSooner =
      Math.abs(value - bestValue) <= 1e-9 && (first.grantsGold ?? 0) > 0;
    if (better || tieButLearnsSooner) {
      best = chain;
      bestValue = value;
    }
  }
  return best;
}

/**
 * Сколько цепочка стоит целиком: очки шагов минус сгоревшее золото.
 *
 * Шаг идёт в сумму своей ценностью: у покупок, прокруток и заклинаний это
 * и есть `score` — ценность того, что действие приносит. У подъёма таверны
 * очки списка устроены иначе («лучшая покупка плюс срочность»), и в сумму
 * берётся `standaloneScore` — срочность без чужой покупки внутри. Иначе
 * лучшая покупка считалась бы дважды: один раз внутри подъёма, второй —
 * отдельным шагом соперничающей цепочки.
 *
 * Заморозка из суммы исключена: она ничего не тратит и решает про СЛЕДУЮЩИЙ
 * ход, а сравниваем мы этот. Сгоревшее золото переводится в очки тем же
 * курсом `goldPointValue`, что и везде.
 */
function chainValue(plan: SpendPlan, deps: TavernAdvisorDeps, rules: TavernRules): number {
  const gained =
    plan.steps
      .filter((s) => s.recommendation.action !== 'freeze')
      .reduce((sum, s) => sum + (s.recommendation.standaloneScore ?? s.recommendation.score), 0) -
    undoneValue(plan, deps, rules);
  // Подъём-ХВОСТ (D214) в сравнении цепочек считается ТАК ЖЕ, как сгоревшее
  // золото, хотя на деле оно уходит в тир. Иначе он становится доводом
  // ОСТАВЛЯТЬ золото: у сгорания цена 3 очка за монету, и хвост, съедающий
  // девять, «стоил» бы 27 очков — больше любого настоящего шага. Корпусный
  // прогон это и показал: на part52 (ход 21) из плана выпадал тёмный дар
  // (19.3), на part51 (ход 23) — покупка, и оба раза ради хвоста.
  // Хвост — утешение остатку, а не аргумент его копить.
  return gained - burningGold(plan) * rules.goldPointValue;
}

/**
 * Очки шагов, которые та же цепочка потом ОТМЕНЯЕТ продажей (D222).
 *
 * part54, ход 25: «КУПИТЬ Treasure Parrot 5/5 за 3 → РАЗЫГРАТЬ Proud
 * Privateer, продав Treasure Parrot». Попугай без клича («Once this deals
 * {1} damage, get a Golden Touch») — купить за 3 и продать за 1 ради места
 * значит выбросить два золотых. Развилка при этом выбирала именно эту
 * цепочку: её сумма считала попугая (15.5) целиком, хотя к концу хода его
 * нет, а два потраченных впустую золотых не попадали в «сгорело». Ход 29
 * того же класса: «РАЗЫГРАТЬ Felfire Conjurer → РАЗЫГРАТЬ Blue Chromadrake,
 * продав Felfire Conjurer» — триггер конца хода, который до конца хода
 * не доживёт. По корпусу до правки таких планов 43 из 647.
 *
 * Шаг не отменён, если тело успело отдать своё до продажи: клич (прокрутка
 * D094 живёт ровно так) или ценность в самой продаже (`sellValueWords`).
 * Покупка теряет ещё и разницу цены с возвратом — тем же курсом, что
 * сгоревшее золото: иначе потраченные впустую монеты выглядели бы
 * пристроенными и продолжали выигрывать развилку.
 */
function undoneValue(plan: SpendPlan, deps: TavernAdvisorDeps, rules: TavernRules): number {
  const placed = new Map<number, Recommendation[]>();
  let undone = 0;
  for (const { recommendation: rec } of plan.steps) {
    const victim = rec.sellFirst ?? (rec.action === 'sell' ? rec.minion : null);
    const origins = victim === null ? undefined : placed.get(victim.entityId);
    if (victim !== null && origins !== undefined) {
      const info = deps.cards.info(victim.cardId);
      const text = info?.text ?? '';
      const paidOnTheWay =
        (info?.mechanics.includes('BATTLECRY') ?? false) ||
        rules.sellValueWords.some((w) => new RegExp(w, 'i').test(text));
      if (!paidOnTheWay) {
        for (const origin of origins) {
          undone += origin.standaloneScore ?? origin.score;
          if (origin.action === 'buy') {
            undone += Math.max(0, origin.cost - rules.sellGold) * rules.goldPointValue;
          }
        }
      }
      placed.delete(victim.entityId);
    }
    if ((rec.action === 'buy' || rec.action === 'play') && rec.minion !== null && rec.magnetizeTo == null) {
      placed.set(rec.minion.entityId, [...(placed.get(rec.minion.entityId) ?? []), rec]);
    }
  }
  return undone;
}

/** Золото, не пристроенное к делу: остаток плюс ушедшее в подъём-хвост (D214). */
function burningGold(plan: SpendPlan): number {
  const tail = plan.steps
    .filter((s) => s.recommendation.action === 'levelUp' && s.recommendation.blockedByHp === true)
    .reduce((sum, s) => sum + s.recommendation.cost, 0);
  return plan.goldLeft + tail;
}

function buildChain(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
  options: SpendPlanOptions,
  forcedFirst: Recommendation | null,
  withoutLevelUp = false,
): SpendPlan {
  const maxSteps = options.maxSteps ?? 8;
  const steps: SpendStep[] = [];
  const used = new Set<string>();
  let current = state;
  let truncated = false;

  for (let i = 0; i < maxSteps; i += 1) {
    const rec =
      i === 0 && forcedFirst !== null
        ? forcedFirst
        : planNextStep(current, deps, rules, used, withoutLevelUp);
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
