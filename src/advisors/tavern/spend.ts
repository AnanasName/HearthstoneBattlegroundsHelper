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
   * `goldSpent` держится согласованным с остатком (`gold = goldTotal −
   * goldSpent`) — тем самым равенством, которое поддерживает редьюсер.
   * Складывать цены отдельно нельзя: продажа возвращает золото, и счётчик
   * разошёлся бы с остатком. По `goldSpent > 0` определяются точки решения
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
    return { ...withGold, goldSpent: state.goldTotal - withGold.gold };
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
          state: paid({
            handSpells: withoutSpell(state.handSpells, rec.spellCardId),
            // Дневной заряд магнита-хранителя потрачен: следующее чародейское
            // заклинание той же цепочки постоянным на нём уже не станет
            // (part21). Счётчик живёт в `scriptData[0]` — «({0} left!)».
            board: withoutMagnetCharge(state.board, rec),
          }),
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
  const spending = usable.filter((rec) => rec.action !== 'freeze');
  return spending.length > 0 ? spending : usable.slice(0, 1);
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
  if (greedy.goldLeft <= 0) return greedy;

  // Цепочка с подъёмом судится развилкой только тогда, когда у подъёма есть
  // СВОЯ ценность (`standaloneScore`): без неё сумма очков считала бы лучшую
  // покупку дважды. Не заполнено — цепочка уходит как есть, как было до
  // 17.08 (мусорная витрина, см. `levelUpRule`).
  const levelStep = greedy.steps.find((s) => s.recommendation.action === 'levelUp');
  if (levelStep !== undefined && levelStep.recommendation.standaloneScore === undefined) {
    return greedy;
  }

  // Началом АЛЬТЕРНАТИВЫ подъём не пробуется: он либо уже стоит верхним
  // советом (и тогда он и есть жадная цепочка), либо проиграл в списке —
  // и начинать с проигравшего незачем.
  const alternatives = firstOptions
    .slice(1)
    .filter((rec) => rec.action !== 'levelUp')
    .slice(0, rules.maxAlternativeStarts);

  // Когда жадная цепочка поднимает таверну, альтернатива — это ход БЕЗ
  // подъёма целиком: ровно тот выбор, который делает игрок.
  const withoutLevelUp = levelStep !== undefined;

  let best = greedy;
  let bestValue = chainValue(greedy, rules);
  for (const first of alternatives) {
    const chain = buildChain(state, deps, rules, options, first, withoutLevelUp);
    const value = chainValue(chain, rules);
    // Строгое превосходство: при равенстве остаётся жадная цепочка, чтобы
    // порядок советов и план не расходились без причины.
    if (value > bestValue + 1e-9) {
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
function chainValue(plan: SpendPlan, rules: TavernRules): number {
  const gained = plan.steps
    .filter((s) => s.recommendation.action !== 'freeze')
    .reduce((sum, s) => sum + (s.recommendation.standaloneScore ?? s.recommendation.score), 0);
  return gained - plan.goldLeft * rules.goldPointValue;
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
