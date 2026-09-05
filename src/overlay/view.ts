import type { PositionAdvice } from '../advisors/position/advisor.js';
import { paidSlotNote } from '../advisors/position/paidSlot.js';
import type { PositionTarget, ResolvedOpponent } from '../advisors/position/opponent.js';
import type { Recommendation, TavernAdvice } from '../advisors/tavern/advisor.js';
import {
  DEFAULT_TAVERN_RULES,
  tavernTurnOf,
  type TavernRules,
} from '../advisors/tavern/rules.js';
import type { BuyCheckResult } from '../advisors/tavern/simulated.js';
import type { SpendPlan } from '../advisors/tavern/spend.js';
import type { CardIndex } from '../data/cards.js';
import type { PlaceForecast } from '../ml/forecast.js';
import type { GameState } from '../state/types.js';
import { buttonRect, slotRect, type Rect, type SlotRow, type TavernButton } from './layout.js';
import {
  ACTION_LABEL,
  buyCheckLine,
  choiceLine,
  minionLabel,
  noOpponentReason,
  opponentStale,
  planLine,
  spendPlanOutcome,
  positionLine,
  recommendationLine,
  situationLine,
  trinketLine,
} from '../ui/format.js';

/**
 * Что показывает оверлей — простыми данными, без DOM и без Electron.
 *
 * Смысл разделения не в чистоте, а в проверяемости: окно поверх игры нечем
 * проверить тестом, а решения о том, что показывать, проверить нужно. Здесь
 * они все, и они же покрыты тестами; на долю Electron остаётся создание окна
 * и передача этой структуры в разметку.
 */

export type Tone = 'normal' | 'good' | 'warn' | 'muted';

export interface OverlayLine {
  readonly text: string;
  readonly tone: Tone;
}

/** Шаг плана трат — строкой действия и остатком золота после него. */
export interface OverlayPlanStep {
  /** Номер с единицы: ход делается по порядку, и место в нём значит. */
  readonly no: number;
  /**
   * Текст шага — тот же, что в строке совета (`recommendationLine`).
   *
   * Целиком, а не разобранный по полям: второе определение того, как назвать
   * жертву, цель и ветвь, разъедется с первым молча — так уже случалось
   * со списком партий текущего билда и с базовой картой героя. Разметке
   * разбор всё равно не помог бы: справочник карт живёт в главном процессе,
   * а к ней ходит только готовый вид.
   */
  readonly text: string;
  /**
   * Сколько золота останется ПОСЛЕ шага.
   *
   * Ради этого столбика блок и отличается от строки: `goldBefore − goldAfter`
   * цене шага НЕ равно — из остатка вычтена цена, прибавлено золото, которое
   * действие приносит (`grantsGold`), и возврат за проданную жертву. Одной
   * строкой судьбу золота показать негде, а именно её игрок и проверяет.
   */
  readonly goldAfter: number;
  /** `warn` только там, где золото после хода сгорит; иначе `muted`. */
  readonly goldTone: Tone;
}

/** План трат хода — блоком, по шагу в строку. */
export interface OverlayPlan {
  /** Золото ДО первого шага: без якоря столбик остатков читается с нуля. */
  readonly gold: number;
  readonly steps: readonly OverlayPlanStep[];
  /**
   * Глаголы шагов, не поместившихся в блок. Пусто — поместились все.
   *
   * Именно глаголы, а не «…и ещё N»: слово действия — то, ради чего шаг
   * читают, и терять его надо последним.
   */
  readonly restVerbs: readonly string[];
  /**
   * Подпись столбика остатка.
   *
   * «остаток не меньше» — когда в плане есть сила героя, дающая золото
   * броском кубика: в план она кладёт НИЖНЮЮ грань, а очки считает
   * по среднему (part39). Столбик после такого шага — минимум, а не факт,
   * и выдавать грань за факт нельзя: игрок сверит с игрой и решит, что
   * советник врёт.
   */
  readonly goldCaption: string;
  /**
   * Судьба остатка и обрыв — словами; `null` — сказать нечего.
   *
   * Оба факта вместе, в отличие от строки: при обрыве на обновлении остаток
   * посчитан и обещанные покупки из него вычтены, но «сгорит» там сказать
   * нельзя — витрина будет другая.
   */
  readonly tail: OverlayLine | null;
}

/** Клетка шкалы тиров. */
export interface OverlayTempoCell {
  readonly tier: number;
  /** Тир игрока сейчас. */
  readonly you: boolean;
  /** Тир, который кривая советника ставит на этот ход. */
  readonly curve: boolean;
  /** Выше предела партии — подниматься туда некуда. */
  readonly locked: boolean;
}

/**
 * Где мы на кривой подъёма — ФОН, а не сообщение.
 *
 * Блок вправе утверждать ровно одно: «вот кривая, по которой считает
 * советник, и вот где на ней стоите вы». Кто прав — не наш вопрос. Кривая
 * взята из разговоров об игре, а не замерена, а замер согласия с игроком
 * (`npm run spike:level`) вердикта не выносит НАМЕРЕННО: согласие 74% при
 * асимметрии 62 против 24, и расхождение — в сторону игрока, который идёт
 * на два хода таверны впереди нашей таблицы. Поэтому здесь нет ни оценок,
 * ни стрелок, ни `warn`, ни красного, ни кривой, дорисованной вперёд:
 * картинка, читающаяся как «вы отстаёте», утверждала бы ровно то, что
 * замером не подтверждено.
 */
export interface OverlayTempo {
  readonly cells: readonly OverlayTempoCell[];
  /** Ход ТАВЕРНЫ — та шкала, в которой написана кривая (урок part20). */
  readonly tavernTurn: number;
  readonly tier: number;
  readonly curveTier: number;
  /**
   * Причина совета подъёма ДОСЛОВНО; `null` — совета подъёма нет вовсе.
   *
   * Своих формулировок тут нет и быть не может по двум причинам. Первая:
   * те же слова игрок увидит в списке советов, и расхождение подписи
   * с советом читалось бы как второй, скрытый вердикт. Вторая: причин
   * у правила четыре (отставание, мусорная витрина, «на опережение», порог
   * здоровья), а на пределе тира, без цены в логе и когда подъём не
   * по карману, совета нет вовсе — выдуманная склейка на этих точках была бы
   * враньём.
   */
  readonly note: string | null;
  /**
   * Цена и цель подъёма — прямо из лога (тег `COST` кнопки подъёма).
   * Заполняется ТОЛЬКО когда причины нет: иначе цена уже названа в ней,
   * и второй раз читается как другое число. `null` — кнопки не видно;
   * ноль и «бесплатно» вместо неё не подставляются.
   */
  readonly upgrade: { readonly cost: number; readonly target: number } | null;
  /** Ярлык блока: оговорка о происхождении кривой живёт в подписи. */
  readonly label: string;
}

/**
 * Каким смыслом окрашена метка на карте.
 *
 * `tavern` — не смысл, а МЕСТО: метка стоит на кнопке таверны, а не на карте.
 * Свой цвет ей нужен по замеру глазами, а не для красоты: у подъёма кнопка
 * сама зелёно-золотая, и зелёное кольцо покупки на ней теряется (жалоба
 * игрока по part41: «обводка для поднятия таверны сильно сливается
 * по цвету»); там же игра рисует СВОИ зелёные рамки доступности вокруг
 * обновления и заморозки. Смысл действия у кнопки и без цвета назван
 * словом — «ПОДНЯТЬ ТАВЕРНУ · 4», «ОБНОВИТЬ · 1», «ЗАМОРОЗИТЬ», — а вот
 * у карт цвет остаётся единственным различием покупки и продажи.
 */
export type MarkTone = 'buy' | 'sell' | 'keep' | 'target' | 'tavern';

/**
 * Метка поверх настоящей карты в игре.
 *
 * Кольцо и подпись рисуются по геометрии (`layout.ts`), а КАКУЮ карту пометить
 * — решается здесь и покрыто тестами: разметке остаётся только рисование.
 *
 * Действие, объект которого разместить негде (карта руки, сила героя), метки
 * не получает вовсе и живёт только в панели. Это не недоделка, а договор:
 * метка, поставленная наугад, показывает на чужую карту, и игрок это увидит
 * как враньё советника.
 */
export interface OverlayMark {
  /** Ряд карт; `null` — метка на кнопке таверны. */
  readonly row: SlotRow | null;
  /** Кнопка таверны; `null` — метка на карте ряда. */
  readonly button: TavernButton | null;
  /** Место в ряду и его состав — по ним посчитан прямоугольник. */
  readonly index: number;
  readonly count: number;
  /**
   * Куда рисовать — долями окна, посчитано здесь, а не в разметке.
   *
   * Геометрия — такое же решение, как выбор карты, и жить ей положено там,
   * где её проверяет тест. Разметке остаётся перевести доли в проценты.
   */
  readonly rect: Rect;
  readonly tone: MarkTone;
  /** Короткая подпись действия; `null` — только кольцо. */
  readonly label: string | null;
  /** Номер шага плана; `null` — шаг не из плана. */
  readonly step: number | null;
}

/**
 * Номер места в советуемой расстановке, над своим миньоном.
 *
 * Отдельно от `marks`, потому что это про ВЕСЬ борд сразу, а не про
 * выбранную карту: номера получают все свои миньоны, а кольцо — один.
 */
export interface OverlayOrderMark {
  /** Где миньон стоит СЕЙЧАС. */
  readonly index: number;
  readonly count: number;
  /** Куда рисовать номер — долями окна. */
  readonly rect: Rect;
  /** Каким по счёту он должен стоять, с единицы. */
  readonly order: number;
  /** Совет двигает именно его. */
  readonly moved: boolean;
}

/**
 * Прогноз финального места — единственная строка оверлея, которая не советует.
 *
 * Право на неё дано замером, а не желанием: критерий фазы 6 был написан
 * 18.08.2026 до всяких данных и взят 05.09.2026 на 43 партиях (docs/ml.md,
 * «Перезамер 05.09»). Поэтому и содержимое строки — то, что замерено:
 * само число, ТИПИЧНАЯ ОШИБКА этого числа и размер выборки, по которой
 * обучено. Без ошибки рядом прогноз читается как знание, а он на своей
 * же выборке промахивается почти на два места.
 *
 * Ни советов, ни вердиктов отсюда не следует: «ожидается 5-е место»
 * не значит «поднимай таверну» (предрегистрация, п. 5 «чего не докажет»).
 * Поэтому блок стоит последним и ничего не окрашивает.
 */
export interface OverlayForecast {
  /** Ожидаемое место, 1..8. */
  readonly place: number;
  /** Типичная ошибка (MAE прогноза по кросс-валидации той же выборки). */
  readonly error: number;
  /** По скольким партиям обучена модель. */
  readonly games: number;
  /** Подпись блока — та же роль, что `label` у темпа. */
  readonly label: string;
}

export interface OverlayView {
  /** Есть ли что показывать вообще. */
  readonly active: boolean;
  readonly header: string;
  readonly board: readonly string[];
  readonly shop: readonly string[];
  /** Что делать: первые рекомендации по таверне. */
  readonly actions: readonly OverlayLine[];
  /** Расстановка: совет, причина молчания или отметка о счёте. */
  readonly position: OverlayLine | null;
  /** План трат хода блоком; `null` — плана нет, он из одного шага, или экран модальный. */
  readonly plan: OverlayPlan | null;
  /** Темп таверны; `null` — вне таверны и на модальных экранах. */
  readonly tempo: OverlayTempo | null;
  /** Прогноз места; `null` — модели нет, стола не видно или не таверна. */
  readonly forecast: OverlayForecast | null;
  /** Кольца и подписи поверх настоящих карт игры. */
  readonly marks: readonly OverlayMark[];
  /** Номера советуемой расстановки над своими миньонами. */
  readonly order: readonly OverlayOrderMark[];
}

export const EMPTY_VIEW: OverlayView = {
  active: false,
  header: 'жду партию',
  board: [],
  shop: [],
  actions: [],
  position: null,
  plan: null,
  tempo: null,
  forecast: null,
  marks: [],
  order: [],
};

/**
 * Сколько советов по таверне помещается, не превращая оверлей в простыню.
 *
 * Три, а не два: с появлением «разыграть» и подъёма-приоритета в топе
 * обычно сочетание разных действий, и обрезка до двух прятала бы покупку
 * за подъёмом и розыгрышем.
 */
const MAX_ACTIONS = 3;

/**
 * Сколько шагов плана помещается в блок.
 *
 * Не то же, что `MAX_PLAN_STEPS` у строки: та обрезка придумана под ОДНУ
 * строку — план из шести шагов занимал в оверлее три строки из трёх, вытесняя
 * расстановку, — и вертикальный блок это основание снимает. Сам план считается
 * до восьми шагов.
 *
 * Честная оговорка: пятёрка не замерена, распределения длины планов у нас нет
 * ни в одном замере. Цена ошибки ограничена `restVerbs` — глагол
 * непоместившегося шага остаётся на экране, целиком пропасть шаг не может.
 */
const MAX_PLAN_ROWS = 5;

export interface ViewInput {
  readonly state: GameState;
  readonly tavern: TavernAdvice | null;
  /**
   * План трат хода: чем занять ВСЁ золото, а не только первым действием.
   *
   * Отдельным полем, а не внутри `TavernAdvice`: план — это цепочка тех же
   * советов на гипотетических состояниях, и модуль плана зависит от модуля
   * советов. Обратная зависимость сделала бы круг.
   */
  readonly spendPlan?: SpendPlan | null;
  /** Идёт ли счёт расстановки прямо сейчас. */
  readonly thinking: boolean;
  readonly position:
    | { readonly kind: 'advice'; readonly advice: PositionAdvice; readonly target: PositionTarget }
    | { readonly kind: 'dropped' }
    | { readonly kind: 'noOpponent'; readonly opponent: ResolvedOpponent }
    | null;
  /** Досчёт покупок боем; `null` — не считался или брошен. */
  readonly buyCheck?: {
    readonly result: BuyCheckResult;
    readonly target: PositionTarget;
  } | null;
  /** Предупреждение продукта (снапшот отстал от патча); держится всю партию. */
  readonly warning?: string | null;
  /**
   * Прогноз места, посчитанный снаружи (`src/ml/forecast.ts`).
   *
   * Полем, а не расчётом внутри вида: модель читает ИСТОРИЮ точек решения
   * партии, а вид знает одно состояние — «сейчас». Накопитель истории живёт
   * там же, где рекордер датасета, и по тому же правилу точки.
   */
  readonly forecast?: PlaceForecast | null;
  /**
   * Отношение ширины окна игры к высоте — под метки на картах.
   *
   * Длины раскладки замерены ВЫСОТОЙ (игра масштабирует стол по ней),
   * а наружу идут долями ширины, и без этого числа перевод не сделать.
   * Окно оверлея во весь экран, поэтому его соотношение и есть игровое.
   */
  readonly aspect?: number;
}

/**
 * Соотношение сторон, когда его не передали.
 *
 * Не «типичное разрешение», а то, на котором СНЯТА калибровка: если число
 * не пришло, метки встанут ровно так, как на замеренных кадрах, и ошибка
 * будет видна глазом, а не спрятана в правдоподобной середине.
 */
const CALIBRATED_ASPECT = 2553 / 1599;

export function buildView(input: ViewInput, cards: CardIndex): OverlayView {
  const { state } = input;

  // Выбор героя — самый первый экран партии. Сущность героя-заготовки
  // в состоянии уже может быть (part14), поэтому признак — сам открытый
  // выбор, а не отсутствие героя.
  const heroPick = input.tavern?.heroChoice ?? [];
  if (heroPick.length > 0) {
    return {
      active: true,
      header: 'выбор героя',
      board: [],
      shop: [],
      actions: heroPick.map((h, i) => ({
        text: `ВЗЯТЬ? ${h.name} — ${h.reason}`,
        tone: i === 0 && h.averagePosition !== null ? 'good' : 'normal',
      })),
      position: null,
      // На экране выбора героя нет ни золота, ни тира: тратить и подниматься
      // ещё нечем и некуда. Стола с картами тоже нет — помечать нечего.
      plan: null,
      tempo: null,
      // Прогноз молчит и здесь: точек решения ещё нет, а модель считает
      // по ним — на экране выбора героя ей нечего читать.
      forecast: null,
      marks: [],
      order: [],
    };
  }
  if (state.hero === null) return EMPTY_VIEW;

  // Предупреждение продукта — первой строкой и поверх лимита советов:
  // «снапшот отстал от патча» обесценивает советы ниже, и прятать его
  // за ними нельзя.
  const warning = input.warning ?? null;
  const actions = actionLines(input, cards);
  if (warning !== null) actions.unshift({ text: warning, tone: 'warn' });

  // Открытый выбор гасит и план, и темп — по той же причине, по которой он уже
  // вытесняет советы: в игре это модальный экран, и пока он открыт, игрок
  // решает именно его. План трат вдобавок посчитан на состоянии, которого
  // сейчас на экране нет.
  const modal = (input.tavern?.trinkets.length ?? 0) > 0 || (input.tavern?.choice.length ?? 0) > 0;

  return {
    active: true,
    header: situationLine(state),
    board: state.board.map((m) => minionLabel(m, cards)),
    shop: state.shop.map((m) => minionLabel(m, cards)),
    actions,
    position: positionView(input, cards),
    plan: modal ? null : planView(input, cards),
    tempo: modal ? null : tempoView(input),
    forecast: forecastView(input),
    // Пока открыт модальный экран, стол игре не принадлежит: карты витрины
    // и борда за ним, и кольцо на них показывало бы в никуда. А вот сам
    // модальный экран пометить можно — у лавки аксессуаров ряд свой.
    marks: modal ? trinketMarks(input) : marksView(input),
    order: modal ? [] : orderView(input),
  };
}

function actionLines(input: ViewInput, cards: CardIndex): OverlayLine[] {
  // Открытый выбор тринкета вытесняет обычные советы: в игре это модальный
  // экран, и пока он открыт, игрок решает именно его.
  const trinkets = input.tavern?.trinkets ?? [];
  if (trinkets.length > 0) {
    // Лучший помечается и при выборе по статистике: нейтральный тринкет
    // с хорошим средним местом — обоснованный совет, а не «первый попавшийся»
    // (JeefHS: сильный нейтральный лучше слабого племенного).
    return trinkets.map((t, i) => ({
      text: `ВЗЯТЬ? ${trinketLine(t)}`,
      tone: i === 0 && (t.tribeMinions > 0 || t.averagePlacement != null) ? 'good' : 'normal',
    }));
  }

  // Открытый выбор карт — награда за тройку, раскопка, сокровища — такой же
  // модальный экран, и пока он открыт, игрок решает именно его. Показывается
  // всегда: спрятанный выбор выглядел так, будто помощник его не заметил
  // (part10, ход 17 — три сокровища-заклинания и советы про покупки поверх).
  const choice = input.tavern?.choice ?? [];
  if (choice.length > 0) {
    return choice.map((c, i) => ({
      text: `ВЫБРАТЬ? ${choiceLine(c)}`,
      tone: i === 0 && c.score !== null ? 'good' : 'normal',
    }));
  }

  // План на несколько розыгрышей заменяет отдельные строки «разыграть»:
  // игрок читает верхнюю строку, и она должна описывать весь ход.
  const recommendations = input.tavern?.recommendations ?? [];
  const plan = input.tavern?.playPlan ?? [];
  // План трат — первой строкой: ход состоит из нескольких действий, и верхняя
  // строка должна описывать весь ход, а не первое из них. Отдельные советы
  // остаются ниже: план их не отменяет, а собирает.
  const spend = input.spendPlan ?? null;
  const lines: string[] = [];
  let planShown = false;
  for (const r of recommendations) {
    if (plan.length >= 2 && r.action === 'play') {
      if (!planShown) {
        lines.push(planLine(plan, cards));
        planShown = true;
      }
      continue;
    }
    lines.push(recommendationLine(r, cards));
  }

  // План уехал в свой блок над советами, но места в списке по-прежнему
  // занимает ровно одно. Решение «верхняя строка обязана описывать весь ход»
  // блок исполняет строже — ход виден целиком, без обрезки на четырёх шагах,
  // — а слот остаётся за ним потому, что первый шаг плана почти всегда и есть
  // верхний совет: третья строка списка была бы платой за повтор. Зелёный
  // акцент при живом блоке отдан блоку, и держится это флагом, а не побочным
  // эффектом ветки.
  const planned = spend !== null && spend.steps.length >= 2;
  const shown: OverlayLine[] = lines
    .slice(0, planned ? MAX_ACTIONS - 1 : MAX_ACTIONS)
    .map((text, i) => ({ text, tone: i === 0 && !planned ? 'good' : 'normal' }));

  // Досчёт покупок боем — строкой поверх лимита, как и напоминание ниже:
  // это дополнение к эвристике, а не её замена. Несогласие боя с эвристикой
  // выделено тоном — ради него досчёт и существует; разброс в шуме
  // приглушён: «лучший» там случаен.
  const buyCheck = input.buyCheck ?? null;
  if (buyCheck !== null) {
    shown.push({
      text: buyCheckLine(buyCheck.result, buyCheck.target, cards),
      tone: !buyCheck.result.decisive ? 'muted' : buyCheck.result.agreed ? 'normal' : 'warn',
    });
  }

  // Напоминание о тринкетах — приглушённой строкой ПОВЕРХ лимита советов:
  // это подготовка борда к следующему ходу (тьюторинг, docs/jeefhs.md),
  // и прятаться за тремя покупками ей нельзя — тогда её не видно никогда.
  const forecast = input.tavern?.trinketForecast ?? null;
  if (forecast !== null) shown.push({ text: forecast, tone: 'muted' });

  return shown;
}

/** Кнопка таверны, которой распоряжается действие; `null` — действие про карту. */
function buttonOf(action: Recommendation['action']): TavernButton | null {
  if (action === 'levelUp') return 'levelUp';
  if (action === 'reroll') return 'refresh';
  if (action === 'freeze') return 'freeze';
  return null;
}

/** Каким смыслом красить действие. */
function toneOf(action: Recommendation['action']): MarkTone {
  if (action === 'sell') return 'sell';
  if (action === 'freeze') return 'keep';
  return 'buy';
}

/**
 * Одна карта ряда витрины: миньон или заклинание — на экране они равноправны.
 */
interface ShopCard {
  readonly entityId: number;
  readonly cardId: string;
  readonly spell: boolean;
}

/**
 * Ряд ВИТРИНЫ так, как он стоит на экране.
 *
 * Складывать два списка подряд нельзя, и это стоило игроку двух пунктов
 * обратной связи по part41 («съехала обводка», «для заклинаний обводки
 * вовсе нет»). Витрина у нас разложена по типу карты — `shop` отдельно,
 * `shopSpells` отдельно, — а игра держит их в ОДНОЙ зоне с общей сквозной
 * нумерацией: part41, ход 5 — миньоны на местах 1, 2, 4, «Recruit
 * a Trainee» ТРЕТЬИМ; ход 7 — четыре миньона и «Enchanted Lasso» пятым.
 * Пока состав ряда считался по одним миньонам, ряд из пяти карт советник
 * считал рядом из четырёх, и кольцо уезжало на полшага вправо — ровно
 * на разницу центровки.
 *
 * Порядок берётся из `zonePos`, а не из порядка списков: «заклинание
 * последнее» — догадка, которую тот же ход 5 и опровергает.
 */
function shopRow(state: GameState): ShopCard[] {
  const cards: { readonly card: ShopCard; readonly pos: number }[] = [
    ...state.shop.map((m) => ({
      card: { entityId: m.entityId, cardId: m.cardId, spell: false },
      pos: m.zonePos,
    })),
    ...state.shopSpells.map((s) => ({
      card: { entityId: s.entityId, cardId: s.cardId, spell: true },
      pos: s.zonePos,
    })),
  ];
  return cards.sort((a, b) => a.pos - b.pos).map((c) => c.card);
}

/**
 * Метки поверх настоящих карт.
 *
 * Порядок сборки — от главного к второстепенному: сначала шаги плана (весь
 * ход читается с самого стола), потом жертва и цель верхнего совета. Одна
 * карта помечается ОДИН раз: первая метка выигрывает, и это тот же довод,
 * по которому в списке советов план занимает одно место, — два кольца на
 * одной карте спорят, какое из них главное.
 */
function marksView(input: ViewInput): OverlayMark[] {
  const { state } = input;
  const aspect = input.aspect ?? CALIBRATED_ASPECT;
  const marks: OverlayMark[] = [];
  const taken = new Set<string>();

  const shop = shopRow(state);

  /** Метка на месте `index` ряда `row` из `count` карт. */
  const mark = (
    row: SlotRow,
    index: number,
    count: number,
    tone: MarkTone,
    label: string | null,
    step: number | null,
  ): void => {
    const key = `${row}:${String(index)}`;
    if (taken.has(key)) return;
    const rect = slotRect(row, index, count, aspect);
    if (rect === null) return;
    taken.add(key);
    marks.push({ row, button: null, index, count, tone, label, step, rect });
  };

  const place = (
    minion: { readonly entityId: number } | null,
    tone: MarkTone,
    label: string | null,
    step: number | null,
  ): void => {
    if (minion === null) return;
    const inShop = shop.findIndex((c) => c.entityId === minion.entityId);
    if (inShop >= 0) {
      mark('shop', inShop, shop.length, tone, label, step);
      return;
    }
    const onBoard = state.board.findIndex((m) => m.entityId === minion.entityId);
    if (onBoard >= 0) {
      mark('board', onBoard, state.board.length, tone, label, step);
      return;
    }
    // Карты нет ни в витрине, ни на борде — она в руке, и разместить её
    // негде: рука лежит веером, её геометрия не замерена. Действие остаётся
    // в панели, и это честнее кольца, поставленного наугад.
  };

  /**
   * Метка на ЗАКЛИНАНИИ витрины — по карте, потому что сущности у совета нет.
   *
   * Совет называет заклинание полем `spellCardId`, и этого достаточно: две
   * копии одного заклинания в витрине — это две одинаковые карты по одной
   * цене, и любая из них верный ответ на «купить вот это». Ищется карта
   * только в витрине и только у действий витрины: у заклинания РУКИ то же
   * поле значит карту в руке, а её место на экране не замерено.
   */
  const placeSpell = (cardId: string | null | undefined, tone: MarkTone, label: string | null, step: number | null): void => {
    if (cardId == null) return;
    const index = shop.findIndex((c) => c.spell && c.cardId === cardId);
    if (index < 0) return;
    mark('shop', index, shop.length, tone, label, step);
  };

  const button = (which: TavernButton, tone: MarkTone, label: string, step: number | null): void => {
    const key = `button:${which}`;
    if (taken.has(key)) return;
    taken.add(key);
    marks.push({
      row: null,
      button: which,
      index: 0,
      count: 1,
      tone,
      label,
      step,
      rect: buttonRect(which, aspect),
    });
  };

  const priced = (rec: Recommendation): string =>
    rec.cost > 0 ? `${ACTION_LABEL[rec.action]} · ${String(rec.cost)}` : ACTION_LABEL[rec.action];

  const apply = (rec: Recommendation, step: number | null): void => {
    const which = buttonOf(rec.action);
    if (which !== null) {
      button(which, 'tavern', priced(rec), step);
      // Заморозка держит витрину ради НАЗВАННОЙ карты, и без кольца на ней
      // совет читается как «заморозить просто так» — тот же дефект, что
      // голое «ОБНОВИТЬ» без цели (part37).
      if (rec.action === 'freeze') {
        place(rec.minion, 'keep', null, null);
        // Витрину держат и ради ЗАКЛИНАНИЯ (part17 → part23 → part29):
        // у такого совета `minion` пуст, и без кольца на карте он читался бы
        // как «заморозить просто так».
        placeSpell(rec.spellCardId, 'keep', null, null);
      }
      return;
    }
    place(rec.minion, toneOf(rec.action), priced(rec), step);
    // Покупка заклинания витрины — тоже покупка, и карта у неё на столе есть.
    // Прежде кольца у неё не было вовсе: `minion` пуст, а по `spellCardId`
    // никто не искал (жалоба игрока по part41, ход 5: советник предлагал
    // «КУПИТЬ Recruit a Trainee за 2», а на столе не помечал ничего).
    if (rec.minion === null && rec.action === 'buy') {
      placeSpell(rec.spellCardId, toneOf(rec.action), priced(rec), step);
    }
    // Жертва, цель и носитель — отдельные карты, и все трое названы словами
    // в строке действия; на столе им нужны свои кольца, иначе игрок ищет их
    // глазами.
    //
    // Подпись у каждого своя, и это не украшение: у действия с целью
    // (активация, усиление, магнит) на столе оказывается ДВА кольца, и без
    // слова второе читается как «тут тоже что-то делать». Хуже всего это
    // у активации с целью — нажимают одну карту, а меняется другая.
    //
    // Совпасть действие и цель НЕ могут, и это проверено, а не предположено:
    // в пуле 17 активаций, цель заполняют ровно две ветви, обе фильтруют
    // саму карту (`entityId !== minion.entityId`), и обе стоят на картах,
    // чей текст говорит «another» (Suspicious Prisonguard, Тираэль);
    // у прочих пятнадцати цели нет вовсе. Поэтому «первая метка побеждает»
    // тут ничего не съедает. Появится активация НА СЕБЯ — она придёт новым
    // классом, и узнать о ней лучше падением теста, чем молча перекрытой
    // подписью.
    place(rec.sellFirst, 'sell', ACTION_LABEL.sell, null);
    place(rec.targetMinion ?? null, 'target', 'ЦЕЛЬ', null);
    place(rec.magnetizeTo ?? null, 'target', 'НОСИТЕЛЬ', null);
  };

  const steps = input.spendPlan?.steps ?? [];
  if (steps.length >= 2) {
    for (const [i, s] of steps.entries()) apply(s.recommendation, i + 1);
  } else {
    // Плана нет — помечается верхний совет, без номера: номер шага у одного
    // действия обещал бы цепочку, которой не существует.
    const top = input.tavern?.recommendations[0];
    if (top !== undefined) apply(top, null);
  }
  return marks;
}

/**
 * Метка на лавке аксессуаров — кольцо на том тринкете, который советуем взять.
 *
 * Панель ранжирует все варианты словами, но выбирают их НЕ в панели: игрок
 * смотрит на четыре карты посреди экрана и там же жмёт. Просьба игрока
 * (part41) дословно: «хочу, чтобы также подсказывало на ui с тринкетами,
 * как и с картами».
 *
 * Порядок вариантов на экране берётся из КАНАЛА ВЫБОРОВ, и это не вкус,
 * а единственный источник: у сущностей тринкетов в `SETASIDE` позиция
 * не проставлена вовсе — все четыре с `zonePos=0` (part41, 01:26:07), —
 * а `trinketOffer` собран обходом таблицы сущностей и порядка экрана
 * не хранит. Строки `Entities[0..3]` выбора id=8 идут ровно так, как карты
 * стоят слева направо: Путеводная свеча, Восковое копьё, Удочка Пэгла,
 * Чешуя волшебного дракона — сверено с кадром игрока.
 *
 * Молчание тут честнее догадки: нет открытого выбора (зонный путь тринкетов
 * опаздывает — в part9 в точке решения было 3 варианта из 4) или советуемый
 * тринкет в вариантах не нашёлся — метки нет, а панель остаётся на месте.
 */
function trinketMarks(input: ViewInput): OverlayMark[] {
  const best = input.tavern?.trinkets[0];
  const choice = input.state.openChoice;
  if (best === undefined || choice === null || choice.options.length === 0) return [];

  // Кольцо ставится только там, где ранжирование НА ЧЁМ-ТО основано:
  // свои миньоны названного племени или среднее место по статистике.
  // Это то же условие, по которому первый вариант выделяется в панели, —
  // порядок «оценить не берёмся» задан обходом сущностей, и кольцо на нём
  // утверждало бы выбор, которого мы не делали.
  if (best.tribeMinions === 0 && best.averagePlacement == null) return [];

  // Сначала по сущности, потом по карте: id варианта и id зонной копии
  // совпадают не всегда (part9), а карта одна и та же в обоих путях.
  // Двух одинаковых тринкетов в одном предложении не бывает.
  const byEntity = choice.options.findIndex((o) => o.entityId === best.offer.entityId);
  const index =
    byEntity >= 0 ? byEntity : choice.options.findIndex((o) => o.cardId === best.offer.cardId);
  if (index < 0) return [];

  const rect = slotRect('trinket', index, choice.options.length, input.aspect ?? CALIBRATED_ASPECT);
  if (rect === null) return [];

  // Цена называется в метке по той же причине, по которой она названа
  // в строке совета: в одном предложении варианты стоят РАЗНОГО (part32,
  // ход 17: 4, 5, 5 и 2 при десяти золотых), и «взять вот этот» без цены
  // не решение. Тега `COST` иногда нет вовсе — тогда цены нет и в метке.
  const cost = best.offer.cost;
  return [
    {
      row: 'trinket',
      button: null,
      index,
      count: choice.options.length,
      tone: 'buy',
      label: cost === null ? 'ВЗЯТЬ' : `ВЗЯТЬ · ${String(cost)}`,
      step: null,
      rect,
    },
  ];
}

/**
 * Номера советуемой расстановки над своими миньонами.
 *
 * Считаются только когда совет ДЕЙСТВИТЕЛЬНО что-то меняет: расстановка
 * молчит большую часть партии (соперник почти всегда не из виденных), и
 * номера «1 2 3 4», повторяющие нынешний порядок, были бы шумом на каждом
 * кадре — игрок перестал бы их замечать ровно к тому ходу, где они важны.
 */
function orderView(input: ViewInput): OverlayOrderMark[] {
  const position = input.position;
  if (position === null || position.kind !== 'advice') return [];
  if (!position.advice.improves) return [];

  const best = position.advice.top[0]?.board ?? [];
  const board = input.state.board;
  if (best.length !== board.length || board.length === 0) return [];

  const aspect = input.aspect ?? CALIBRATED_ASPECT;
  const order: OverlayOrderMark[] = [];
  for (const [index, minion] of board.entries()) {
    const to = best.findIndex((m) => m.entityId === minion.entityId);
    if (to < 0) return [];
    const rect = slotRect('board', index, board.length, aspect);
    if (rect === null) return [];
    order.push({ index, count: board.length, rect, order: to + 1, moved: to !== index });
  }
  return order;
}

/**
 * План трат хода — блоком.
 *
 * Порог в два шага прежний и по прежней причине: план из одного шага дословно
 * повторяет верхний совет, и решать это — дело интерфейса, а не советника.
 */
function planView(input: ViewInput, cards: CardIndex): OverlayPlan | null {
  // Нет совета — нет и хода таверны, который можно планировать. В живом пути
  // план и так гасится вместе с советом, но вид не должен на это опираться:
  // блок «ПЛАН ХОДА», переживший переход в бой, — прескриптивная строка
  // о положении, которого уже нет.
  if (input.tavern === null) return null;
  const plan = input.spendPlan ?? null;
  if (plan === null || plan.steps.length < 2) return null;

  const shown = plan.steps.slice(0, MAX_PLAN_ROWS);
  const rest = plan.steps.slice(MAX_PLAN_ROWS);
  // Сгорает золото только у плана, дошедшего до конца: у оборванного остаток
  // потратит уже новая витрина, и «сгорит» про него сказать нельзя.
  const burns = !plan.truncated && plan.goldLeft > 0;

  const steps: OverlayPlanStep[] = shown.map((s, i) => ({
    no: i + 1,
    text: recommendationLine(s.recommendation, cards),
    goldAfter: s.goldAfter,
    // Помечается остаток ПОСЛЕДНЕГО шага всего плана, а не последнего
    // показанного: у обрезанного блока хвост считает не он.
    goldTone: burns && i === plan.steps.length - 1 ? 'warn' : 'muted',
  }));

  // Сила героя, дающая золото броском кубика, кладёт в план нижнюю грань
  // (part39): столбик после неё — минимум, и подпись обязана это сказать.
  // Прочие источники золота называют точное число, поэтому признак узкий —
  // золото именно от силы героя.
  const lowerBound = plan.steps.some(
    (s) => s.recommendation.action === 'heroPower' && (s.recommendation.grantsGold ?? 0) > 0,
  );
  const outcome = spendPlanOutcome(plan);

  return {
    gold: plan.steps[0]?.goldBefore ?? 0,
    steps,
    restVerbs: rest.map((s) => ACTION_LABEL[s.recommendation.action]),
    goldCaption: lowerBound ? 'остаток не меньше' : 'остаток',
    tail: outcome === null ? null : { text: outcome, tone: plan.truncated ? 'muted' : 'warn' },
  };
}

/**
 * Где мы на кривой подъёма.
 *
 * Вне таверны блока нет: советовать подъём в бою не о чем, и советник там
 * ничего не считает.
 */
function tempoView(input: ViewInput, rules: TavernRules = DEFAULT_TAVERN_RULES): OverlayTempo | null {
  const advice = input.tavern;
  if (advice === null) return null;
  const { state } = input;

  // Целевой тир берётся готовым полем совета, а не пересчитывается здесь:
  // второе вычисление того же правила разъедется с первым молча.
  const curveTier = advice.targetTier;
  // Длина шкалы — верхний тир САМОЙ КРИВОЙ, и это не выдуманная шестёрка:
  // блок рисует кривую, значит её область определения он и показывает.
  // Литерала «6» тут быть не должно — это было бы вторым определением предела
  // тира, — но и «до нынешнего тира» не годится: тег предела
  // (`BACON_MAX_PLAYER_TECH_LEVEL`) не встречается НИ В ОДНОЙ из 39 фикстур,
  // то есть `maxTechLevel` в жизни всегда `null`, и шкала, кончающаяся
  // на клетке игрока, читалась бы как «вы на вершине» — прямая ложь на любом
  // ходу партии. Известный предел шкалу только расширяет и гасит клетки выше
  // себя.
  const curveTop = rules.levelling.reduce((top, row) => Math.max(top, row.tier), 1);
  const top = Math.max(curveTop, state.techLevel, curveTier, state.maxTechLevel ?? 0);

  const cells: OverlayTempoCell[] = [];
  for (let tier = 1; tier <= top; tier += 1) {
    cells.push({
      tier,
      you: tier === state.techLevel,
      curve: tier === curveTier,
      locked: state.maxTechLevel !== null && tier > state.maxTechLevel,
    });
  }

  const note = advice.recommendations.find((r) => r.action === 'levelUp')?.reason ?? null;
  const upgrade =
    note === null && state.tavernUpgradeCost !== null && state.tavernUpgradeTarget !== null
      ? { cost: state.tavernUpgradeCost, target: state.tavernUpgradeTarget }
      : null;

  return {
    cells,
    tavernTurn: tavernTurnOf(state.turn),
    tier: state.techLevel,
    curveTier,
    note,
    upgrade,
    label: 'темп — кривая сообщества, не замер',
  };
}

/**
 * Блок прогноза: число, его ошибка и выборка — или молчание.
 *
 * Когда молчать, решает сам прогнозист (`src/ml/forecast.ts`): нет модели,
 * нет таблицы лобби, нет ни одной точки решения, идёт бой. Вид эти условия
 * не повторяет — второе определение того же правила разъехалось бы молча,
 * и оверлей с терминалом стали бы показывать разное.
 *
 * На МОДАЛЬНОМ экране, в отличие от плана и темпа, блок остаётся: он
 * не про золото и не про витрину, которых за модалкой нет, а про партию
 * целиком — выбор тринкета его не устаревает.
 */
function forecastView(input: ViewInput): OverlayForecast | null {
  const forecast = input.forecast ?? null;
  if (forecast === null) return null;
  return {
    place: forecast.place,
    error: forecast.error,
    games: forecast.games,
    label: 'прогноз, не совет',
  };
}

function positionView(input: ViewInput, cards: CardIndex): OverlayLine | null {
  // Отметка о счёте идёт впереди прошлого ответа: показывать старый совет как
  // действующий, пока считается новый, — это ровно тот случай, когда игрок
  // делает ход по числам, которых уже нет.
  if (input.thinking) return { text: 'считаю расстановку…', tone: 'muted' };

  const position = input.position;
  if (position === null) return null;

  if (position.kind === 'dropped') {
    return { text: 'счёт брошен: положение изменилось', tone: 'muted' };
  }
  if (position.kind === 'noOpponent') {
    return { text: noOpponentReason(position.opponent), tone: 'muted' };
  }

  const text = positionLine(position.advice, position.target, cards, [
    paidSlotNote(input.state, cards),
    // Раж, платящий картой: советник по-прежнему может двинуть носителя
    // вправо — если бой РАЗЛИЧИМО этого требует, — но молча делать этого
    // не должен. Курса «карта в руке → проценты боя» у нас нет, и пока его
    // нет, решает игрок, а наше дело — назвать цену (part41).
    position.advice.rallyNote,
  ]);
  if (opponentStale(position.target)) {
    // Не «плохой совет», а совет по устаревшим данным: разница существенная,
    // и прятать её нельзя.
    return { text: `${text} — картинка устарела, верить нельзя`, tone: 'warn' };
  }
  return { text, tone: position.advice.improves ? 'good' : 'normal' };
}
