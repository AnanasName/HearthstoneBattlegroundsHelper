import { RACE_ALL, type CardIndex, type CardInfo } from '../../data/cards.js';
import { baseHeroCardId, sharedBgStats, type BgStats } from '../../data/bgStats.js';
import type { ChoiceOption, GameState, HandSpell, Minion, TrinketOffer } from '../../state/types.js';
import { DEFAULT_TAVERN_RULES, targetTier, tavernTurnOf, type TavernRules } from './rules.js';

/**
 * TavernAdvisor: что делать в фазе таверны.
 *
 * Каждое правило — отдельная экспортированная функция от состояния и таблиц
 * правил. Так их можно проверять по одному, чего ТЗ и требует, и так видно,
 * что логика ничего не решает сама: все пороги и веса приходят из `rules.ts`.
 *
 * ## Про шкалу
 *
 * Все рекомендации сравниваются одним числом — «очками». У покупки это
 * ценность миньона, у остальных действий — насколько действие лучше
 * бездействия. Смешивать абсолютную величину с разностью не идеально,
 * но альтернатива хуже: разные шкалы у разных действий означали бы, что
 * упорядочить их между собой нельзя вовсе, а игроку нужен один список.
 *
 * ## Чего эти правила не знают
 *
 * Ровно того, чего не знает ни одна эвристика: чем покупка обернётся в бою.
 * Это умеет считать симулятор — `checkBuysWithBattle` в `simulated.ts`
 * досчитывает верхние покупки в живом воркере, — но там своя цена
 * в полсекунды. Эвристики остаются быстрым первым словом.
 */

export type TavernAction =
  | 'levelUp'
  | 'buy'
  | 'play'
  | 'sell'
  | 'reroll'
  | 'freeze'
  | 'heroPower'
  | 'darkGift'
  | 'activate'
  | 'spin'
  | 'pass';

export interface Recommendation {
  readonly action: TavernAction;
  /** К какому миньону относится действие. */
  readonly minion: Minion | null;
  /** Очки: чем больше, тем настойчивее совет. */
  readonly score: number;
  /** Во сколько золота обойдётся. */
  readonly cost: number;
  /** Нужно ли освободить место на борде. */
  readonly requiresSlot: boolean;
  /**
   * Кого продать, чтобы место появилось.
   *
   * Заполняется у покупок при полном борде. Без этого совет «купить, борд
   * полон, нужно продать» перекладывает на игрока ровно ту работу, ради
   * которой советник и нужен, — а отдельная рекомендация «продать» стоит
   * в списке ниже трёх покупок и на глаза не попадается.
   */
  readonly sellFirst: Minion | null;
  /**
   * К кому примагнитить магнитного миньона.
   *
   * Заполняется у магнитных механизмов при полном борде: примагничивание
   * не занимает места, и продавать ради него никого не нужно — на что
   * игрок и указал. Цель — самый крупный свой мех: усиление достаётся
   * тому, кто дольше живёт в бою.
   */
  readonly magnetizeTo?: Minion | null;
  /** Заклинание, к которому относится совет «разыграть». У миньонов пусто. */
  readonly spellCardId?: string | null;
  /**
   * Что ИЩЕТ обновление витрины — цель, под которую его крутят.
   *
   * Отдельным полем по той же причине, что цель усиления (part12) и ветвь
   * модального заклинания (part19): на экран идёт короткая строка действия,
   * а у обновления в ней нет ни миньона, ни заклинания. Игрок видел «ОБНОВИТЬ»
   * и справедливо возражал, что покупать всё равно не на что (part37, ход 21),
   * — притом что правило крутило витрину под НАЗВАННУЮ цель заморозки
   * и называло её в `reason`, которого оверлей не показывает.
   *
   * Пусто у обновления «витрина мусорная»: там цель — любая карта получше,
   * и называть нечего.
   */
  readonly searchGoal?: string | null;
  /**
   * Племя, которое надо ВЫБРАТЬ у витринного баффа «своего типа».
   *
   * «Choose a minion. Give minions of its type in the Tavern +3/+3 this
   * game» (Eonar's Favor, part43): игра сразу после покупки просит выбрать
   * миньона, а его племя и решает, кому достанется усиление. Без этого поля
   * совет читается как «купите заклинание», и выбор молча возвращается
   * игроку — та же дыра, что голое «ОБНОВИТЬ» без цели (part37).
   *
   * Это НЕ `targetMinion`: усиление получает не наш миньон, а витрина, —
   * ровно то, что советник и обещал ошибочно, пока не читал такие карты.
   */
  readonly shopBuffPick?: string | null;
  /**
   * Сколько золота действие ПРИНОСИТ — ВАЛОВЫМИ, как написано в тексте.
   *
   * У золотых заклинаний эффект известен числом («Gain 1 Gold»), и прятать
   * его за словом «непрозрачный шаг» нельзя: план обязан считать этим
   * золотом дальше. На part24 (ход 9) без этого выходила бессмыслица —
   * совет «разыграть Hasty Excavation, откроется покупка Ominous Seer»,
   * а следующим шагом плана покупка НЕ открывалась: золото не доезжало,
   * и план брал заклинание за 2 вместо миньона за 3. Игрок это и увидел.
   *
   * Именно валовыми: цену действия `applyRecommendation` вычитает САМА,
   * общей для всех шагов строкой `gold − rec.cost`. Чистое значение здесь
   * означало бы вычесть цену дважды — и заклинание руки, дающее 3 золота
   * за 1, доезжало бы до следующего шага как +1 вместо +2, то есть ровно
   * тем же симптомом part24, ради которого поле и появилось.
   */
  readonly grantsGold?: number;
  /**
   * Золото, которое действие обещает к СЛЕДУЮЩЕМУ ходу («Gain N Gold next
   * turn»). В текущий кошелёк оно не идёт (D012), но план переносит его
   * в `extraGoldNextTurn` своего состояния — тем же счётчиком, что игра
   * ведёт тегом (Private Investigator `BG36_509`, part54, part55).
   */
  readonly grantsGoldNextTurn?: number;
  /**
   * Цель заклинания-усиления — свой миньон, на которого его кастовать.
   *
   * Отдельным полем, а не только словами в reason: оверлей показывает
   * короткую строку действия, и совет «РАЗЫГРАТЬ Fortify» без цели
   * перекладывал выбор на игрока (part12).
   */
  readonly targetMinion?: Minion | null;
  /**
   * Цель — магнит-ХРАНИТЕЛЬ, и совет тратит его дневной заряд («The first
   * Spellcraft spell … each turn is permanent»).
   *
   * Нужно ПЛАНУ хода: заряд один на ход, и второе чародейское заклинание
   * той же цепочки постоянным уже не станет. Без пометки план обещал бы
   * постоянство дважды — тихо и неверно (part21).
   */
  readonly spendsMagnetCharge?: boolean;
  /**
   * Какую ветвь брать у модального заклинания «Choose One».
   *
   * Отдельным полем по той же причине, что и цель: оверлей показывает
   * короткую строку действия, а «Alliance Flag» без ветви оставлял игрока
   * с выбором «Булава или Щит» наедине (part19, ход 7). Список из двух
   * элементов означает, что ветви равны по нашей шкале и выбор честно
   * возвращается игроку.
   */
  readonly spellBranches?: readonly SpellBranch[];
  /**
   * Ключевое слово, которое действие ДАРИТ цели, — «Give a minion Reborn»
   * силой героя (part32). Нужно плану: эффект известен целиком, и слово
   * ложится на `targetMinion` гипотетического борда, а не прячется
   * за «непрозрачным шагом».
   */
  readonly grantsKeyword?: BinaryKeywordField;
  /**
   * Статы, которые действие КЛАДЁТ на цель, — «Give a minion Attack equal
   * to your Tier» силой героя (part45). Нужно плану ровно затем же, зачем
   * `grantsKeyword`: прибавка постоянная и известна числом, значит шаг
   * прозрачен, и следующий шаг обязан видеть цель уже усиленной.
   */
  readonly grantsStats?: { readonly stat: 'attack' | 'health'; readonly amount: number };
  /**
   * Прибавка от превращения цели в ЗОЛОТУЮ — «make a friendly minion Golden»
   * силой Рено (part48). Числа берутся с золотой карты снапшота, а не
   * удвоением: у двух карт пула из 379 золотая копия статы не удваивает.
   *
   * Нужно плану по той же причине, что `grantsStats`: шаг прозрачен, и цель
   * обязана достаться следующему шагу уже золотой — иначе продажа посчитает
   * её по старым статам.
   */
  readonly grantsGolden?: { readonly attack: number; readonly health: number };
  /**
   * Остаток счётчика силы «после N покупок с механикой — награда» ПОСЛЕ
   * этой покупки (part34, «Бранное дело»). Заполняется у покупки, которую
   * сила засчитывает; план кладёт число в `heroPowerScriptData[0]`
   * гипотетического героя, чтобы следующий шаг не считал тот же шаг дважды.
   */
  readonly heroPowerBuyLeft?: number;
  /**
   * Цена силы героя ПОСЛЕ этой покупки — у сил, дешевеющих от покупок своего
   * племени («After you buy a Pirate, your next Hero Power costs (1) less»,
   * Патчес, part40).
   *
   * Того же рода поле, что `heroPowerBuyLeft`, и по той же причине: живую
   * цену тегом `COST` читает редьюсер, но скидку, которую приносит СОБСТВЕННЫЙ
   * шаг плана, взять неоткуда — `applyRecommendation` карт не видит. Считается
   * там, где справочник есть, и едет к плану полем.
   */
  readonly heroPowerCostAfter?: number;
  /**
   * На сколько подешевеют заклинания ВИТРИНЫ после этой покупки — у миньонов,
   * чей клич говорит «The next Tavern spell you buy costs (N) less» (Зловещая
   * пророчица `BG31_330`, part49).
   *
   * Родня `heroPowerCostAfter` и заведено по той же причине: цену заклинания
   * редьюсер читает тегом `COST` и в списке всегда прав, но скидку, которую
   * приносит СОБСТВЕННЫЙ шаг плана, взять неоткуда. Оценка ВЕРХНЯЯ: текст
   * обещает скидку СЛЕДУЮЩЕМУ заклинанию, а план роняет цену всем сразу —
   * различие видно только в ходу, где план покупает ДВА заклинания подряд.
   */
  readonly spellDiscountAfter?: number;
  /**
   * Заклинание усиливает КАЖДОГО своего миньона (`SpellEffect.boardWide`,
   * part51): его ценность растёт с числом тел, и сыгранное ДО покупки тела
   * оно купленному не достанется. Нужно плану — он откладывает такой шаг,
   * пока есть кого выставить (`spend.ts`), как откладывает заморозку.
   */
  readonly buffsWholeBoard?: boolean;
  /**
   * Сила, ОБМЕНИВАЮЩАЯ атакой двух миньонов, — «Choose 2 minions. They gain
   * each other's Attack until next turn» (Вольджин, part56). Первым жмётся
   * `targetMinion`, вторым — `partner`; у второго шага силы (первый уже
   * нажат) партнёра нет, и `targetMinion` — единственное, что осталось
   * выбрать. Второй миньон бывает и В ВИТРИНЕ: игрок так и жал семь ходов
   * из девяти.
   *
   * `last` — шаг конца хода: план откладывает его за покупки (`spend.ts`),
   * как усиление всего борда, потому что лучший партнёр может прийти
   * покупкой, а цель — уйти продажей.
   */
  readonly sharesAttack?: {
    readonly partner: Minion | null;
    readonly last: boolean;
  };
  /**
   * Прибавка статов по сущностям СВОЕГО борда, известная числом, — у силы,
   * обменивающей атакой (`sharesAttack`), и у активации Lurking Lionfish,
   * чью приманку бьёт свой зверь (part56). Плану: шаг становится
   * прозрачным, и следующий шаг видит борд уже усиленным.
   */
  readonly boardGains?: readonly {
    readonly entityId: number;
    readonly attack: number;
    readonly health: number;
  }[];
  /**
   * Сколько действие стоит САМО ПО СЕБЕ — без чужой ценности внутри очков.
   *
   * Заполняется у подъёма таверны и у прокрутки — у обоих по одной причине:
   * их `score` устроен иначе, чем у всех, и содержит внутри себя ЛУЧШУЮ
   * ПОКУПКУ. У подъёма это «лучшая покупка плюс срочность», где первое
   * слагаемое — не ценность подъёма, а планка, которую он обязан перебить
   * в СПИСКЕ (part25). У прокрутки это бамп порядка `max(base, лучшая
   * покупка + 0.5)`, отвечающий на вопрос «идти ли ей впереди покупки»,
   * а не «сколько она стоит» (part39). В цепочке плана эта покупка делается
   * по-настоящему и отдельным шагом, поэтому складывать её ещё и внутри
   * первого шага значило бы считать одно и то же дважды.
   *
   * Цена ошибки замерена на part39 (ход 1, жалоба игрока «посоветовало ход
   * со сгорающим золотом»): жадная цепочка «ПРОКРУТИТЬ → Cord Puller →
   * банан» набирала 12.50 при сгорающей монете против 12.00 у цепочки,
   * которую игрок сыграл сам и которая тратила все семь золотых, — то есть
   * ровно на величину бампа. Развилка сгорающего золота (part23) при этом
   * отработала честно: она запустилась и взяла линию игрока в альтернативы,
   * но проиграла ей же, потому что сравнивала с числом, посчитанным
   * не про прокрутку. Со своей ценностью цепочка падает до 11.50,
   * и развилка уходит от сгорающего золота.
   *
   * Третий случай уже записанного правила «число, которым СОРТИРУЮТ список,
   * и число, которым ОТБИРАЮТ кандидата, — разные числа»: к ним добавилось
   * «число, которым СКЛАДЫВАЮТ цепочку».
   */
  readonly standaloneScore?: number;
  /**
   * Ноль у подъёма поставлен ПОРОГОМ ЗДОРОВЬЯ, а не графиком.
   *
   * У нуля две природы, и они требуют разного (part51, part52). «По графику»
   * значит «тир и так свой» — подъёма не нужно. Порог `levellingHpFloor`
   * значит другое: тир нужен, но ход без покупки ослабит бой, который
   * при низком здоровье может стать последним. Довод порога держится
   * на том, что подъём ВЫТЕСНЯЕТ покупку, — а когда тратить больше не на
   * что, вытеснять нечего, и золото просто сгорает.
   *
   * part52, ход 23: hp 1, золото 10, все шаги плана бесплатны, и план
   * печатал «остаётся 10 — сгорит», пока игрок поднимался до шестого тира
   * (00:56:26). То же в part51 на ходу 29 при hp 2 (17:31:45).
   *
   * Поле читает только план (`spend.ts`), список советов оно не трогает:
   * там порог по-прежнему ранжирует подъём против покупок.
   */
  readonly blockedByHp?: boolean;
  /**
   * Действие ЗАМЕНЯЕТ витрину: «Refresh the Tavern with Battlecry minions»
   * заклинанием руки (part35). Нужно плану: после такого шага всё, что мы
   * знали о витрине, больше не про неё, и цепочка обрывается там же, где
   * после обновления кнопкой, — а не тянет старые покупки дальше.
   */
  readonly refreshesShop?: boolean;
  /**
   * Золото, которое заберут покупки, обещанные ПОСЛЕ обновления витрины
   * (`refreshesShop`): «на 4 золота покупок 4 по 1» — это четыре золота.
   * Нужно плану: шаг обрывает цепочку, и без этого поля остаток числился
   * бы сгоревшим — а развилка плана штрафует сгоревшее золото и ставила бы
   * заклинание туда, где остаток меньше, вместо того места, где оно даёт
   * больше тел (part35, ход 19: четыре тела на остаток четыре, а не одно
   * на остаток один).
   */
  readonly refreshSpend?: number;
  /** Обоснование с числами — то, что читает человек. */
  readonly reason: string;
}

/** Из чего сложилась ценность миньона. Для демо и для разбора спорных советов. */
export interface ValueBreakdown {
  readonly techLevel: number;
  readonly stats: number;
  readonly tribe: number;
  readonly keywords: number;
  readonly copies: number;
  readonly golden: number;
  /** Экономический эффект, распознанный по тексту карты. */
  readonly economy: number;
  /** Боевой эффект из текста: ралли, призывы — в бою сильнее статов. */
  readonly battle: number;
  /** Синергия с племенем, которое карта называет словами, не входя в него. */
  readonly textTribe: number;
  /** Синергия с механикой, названной словами в тексте (хрипы у Titus). */
  readonly textMech: number;
  /** Связь по имени карты: текст называет карту своих — или их тексты его. */
  readonly namedCard: number;
  /** Магнит заклинаний: выгода от заклинаний руки, применённых к нему. */
  readonly spellMagnet: number;
  /** Удвоитель механики на борде: лишняя принесённая карта по курсу. */
  readonly doubler: number;
  /** Синергия с СИЛОЙ ГЕРОЯ: её текст называет племя кандидата или продажу. */
  readonly heroPower: number;
  /**
   * Статы, которые кладёт на борд одно нажатие АКТИВАЦИИ этого миньона.
   *
   * Считается только там, где число читается точно и достаётся нашему
   * борду; цена нажатия в золоте не вычитается — подробности
   * у `activationBoardStats`.
   */
  readonly activation: number;
  readonly total: number;
  /**
   * Слово, которое кандидат получит этим ходом, добрав порог атаки
   * (`thresholdKeywordReached`, D221), и атака, на которой он его возьмёт.
   * Его цена уже внутри `keywords`; поле — для причины совета.
   */
  readonly thresholdKeyword: { readonly field: BinaryKeywordField; readonly attack: number } | null;
  /**
   * Слово, которое стартовый эффект кандидата подарит своему (D223), и кому
   * (лучший получатель). Цена — внутри `battle`; поле — для причины совета.
   */
  readonly combatGrant: { readonly field: BinaryKeywordField; readonly recipient: Minion } | null;
  /**
   * Статы, которые розыгрыш этого кличевого положит на борд через своих
   * плательщиков за клич (Kalecgos, D224). Про ПРИОБРЕТЕНИЕ, как `copies`:
   * у своего миньона борда клич уже отыграл, и `ownValue` его вычитает.
   */
  readonly battlecryPayoff: number;
  /**
   * Статы, которые Discover этого кличевого положит на борд через своих
   * плательщиков за Discover (Hooktusk, D232). Про ПРИОБРЕТЕНИЕ, как
   * `battlecryPayoff`: у своего миньона борда клич уже отыграл.
   */
  readonly discoverPayoff: number;
  /** Сколько своих того же племени уже на борде. */
  readonly tribeMates: number;
  /** Сколько своих миньонов племён, названных в тексте карты. */
  readonly textTribeMates: number;
  /** Сколько своих миньонов с механиками, названными в тексте карты. */
  readonly textMechMates: number;
  /** Сколько своих связано с картой по имени (в обе стороны). */
  readonly namedCardMates: number;
  /** Сколько таких же карт уже есть на борде и в руке. */
  readonly copiesOwned: number;
  /**
   * Соберёт ли ПОКУПКА этой карты тройку прямо сейчас.
   *
   * Отдельным полем, а не сравнением `copiesOwned >= 2` по месту: сколько
   * копий нужно, решает сила героя (`copiesForTriple`), и разъехавшиеся
   * копии этого сравнения — ровно тот способ, которым правило живёт
   * в одном месте и не живёт в семи (урок `CURRENT_BUILD_PARTS`).
   */
  readonly completesTriple: boolean;
  /** Копия есть, но тройку она пока не собирает — ставка на будущую. */
  readonly tripleBet: boolean;
  /** Статы, которые даёт розыгрыш этой карты по силе героя (Hat Trick). */
  readonly heroPowerPlay: number;
  /**
   * Доля награды силы «after you buy N <механика> minions, get a <карта>»
   * (part34): ценность награды на этом борде, делённая на оставшиеся
   * покупки. Про ПРИОБРЕТЕНИЕ, как `copies`: у своего миньона и у розыгрыша
   * из руки вычитается.
   */
  readonly heroPowerBuy: number;
  /** Остаток счётчика той силы ПОСЛЕ этой покупки; `null` — не засчитывается. */
  readonly heroPowerBuyLeft: number | null;
  /** Имя награды той силы — для причины совета. */
  readonly heroPowerBuyReward: string | null;
}

/** Один вариант открытого предложения тринкетов с оценкой. */
export interface TrinketAdvice {
  readonly offer: TrinketOffer;
  readonly name: string;
  /** Своих миньонов из племён, которые текст тринкета называет словами. */
  readonly tribeMinions: number;
  /** Среднее место по статистике Firestone. `null` — нет данных. */
  readonly averagePlacement?: number | null;
  readonly reason: string;
}

/** Один вариант выбора героя со статистикой мест. */
export interface HeroChoiceAdvice {
  readonly option: ChoiceOption;
  readonly name: string;
  /** Среднее место по статистике Firestone. `null` — нет данных. */
  readonly averagePosition: number | null;
  readonly reason: string;
}

/**
 * Совет по выбору героя — ранжирование статистикой мест.
 *
 * Своих правил ценности у героев нет и не выдумывается: сила героя,
 * стартовая броня и кривая — это ровно то, что уже свёрнуто в среднем месте
 * по реальным партиям (снапшот Firestone, `npm run update:bgstats`).
 * Скины приводятся к базовой карте внутри справочника статистики.
 * Без снапшота честно говорится «статистики нет».
 */
export function heroChoiceAdvice(
  state: GameState,
  deps: TavernAdvisorDeps,
): HeroChoiceAdvice[] {
  const choice = state.heroChoice;
  if (choice === null || choice.options.length === 0) return [];
  const stats = bgStatsOf(deps);

  return choice.options
    .map((option) => {
      const stat = stats?.hero(option.cardId) ?? null;
      return {
        option,
        name: deps.cards.info(option.cardId)?.name ?? option.cardId,
        averagePosition: stat?.averagePosition ?? null,
        reason:
          stat === null
            ? 'статистики по герою нет'
            : `по статистике среднее место ${stat.averagePosition.toFixed(2)}` +
              ` (${stat.dataPoints.toLocaleString('ru-RU')} партий)`,
      };
    })
    .sort((a, b) => (a.averagePosition ?? 9) - (b.averagePosition ?? 9));
}

export interface TavernAdvice {
  /** Рекомендации по убыванию очков. Первая — то, что советуем сделать. */
  readonly recommendations: readonly Recommendation[];
  readonly gold: number;
  /** Какой тир полагается по таблице на этом ходу. */
  readonly targetTier: number;
  /** Ценность каждого миньона витрины — в том же порядке, что и магазин. */
  readonly shopValues: readonly { readonly minion: Minion; readonly value: ValueBreakdown }[];
  /**
   * Открытое предложение тринкетов, лучший первым. Пусто, когда выбора нет.
   *
   * Отдельным полем, а не рекомендацией в общем списке: в игре это модальный
   * выбор со своим экраном, он не соревнуется с покупками за золото.
   */
  readonly trinkets: readonly TrinketAdvice[];
  /**
   * Открытый выбор «возьмите одно из» с оценками, лучший первым.
   * Пусто, когда выбора на экране нет.
   */
  readonly choice: readonly ChoiceAdvice[];
  /**
   * План розыгрыша на ход, когда разыграть стоит больше одной карты.
   * Пусто, когда карт меньше двух — там хватает обычной рекомендации.
   */
  readonly playPlan: readonly PlanStep[];
  /**
   * Открытый выбор героя в начале партии, лучший по статистике первым.
   * Пусто всю остальную партию.
   */
  readonly heroChoice: readonly HeroChoiceAdvice[];
  /**
   * Напоминание за ход до предложения тринкетов (тьюторинг, docs/jeefhs.md).
   * `null` всю остальную партию.
   */
  readonly trinketForecast: string | null;
}

export interface TavernAdvisorDeps {
  readonly cards: CardIndex;
  /**
   * Статистика мест из снапшота Firestone (`npm run update:bgstats`).
   *
   * Необязательна: `undefined` — взять общий снапшот с диска (его может
   * не быть, тогда советы живут без статистики), `null` — явно без неё
   * (тесты правил, которым статистика мешала бы).
   */
  readonly bgStats?: BgStats | null;
}

/** Статистика: из зависимостей или общий снапшот с диска. */
function bgStatsOf(deps: TavernAdvisorDeps): BgStats | null {
  return deps.bgStats === undefined ? sharedBgStats() : deps.bgStats;
}

/** Племена миньона по справочнику. Пустой список у нейтральных. */
function racesOf(minion: Minion, cards: CardIndex): readonly string[] {
  return cards.info(minion.cardId)?.races ?? [];
}

/**
 * Племена, которые текст карты называет словами, БЕЗ собственных племён карты.
 *
 * Собственные исключаются, чтобы не считать одну синергию дважды: Turbo
 * Hogrider — свинобраз, называющий в тексте свинобразов же. А вот Kangor's
 * Apprentice — миньон без племени с текстом про мехов, и эта связь видна
 * только отсюда.
 */
function textTribesOf(cardId: string, cards: CardIndex, rules: TavernRules): readonly string[] {
  return memoByCard(TEXT_TRIBES_CACHE, cardId, cards, rules, () => {
    const info = cards.info(cardId);
    const text = info?.text ?? '';
    if (text === '') return [];
    const own = new Set(info?.races ?? []);
    return Object.entries(rules.tribeTextWords)
      .filter(([race, word]) => !own.has(race) && new RegExp(`\\b(?:${word})\\b`, 'i').test(text))
      .map(([race]) => race);
  });
}

const TEXT_TRIBES_CACHE = new WeakMap<
  TavernRules,
  WeakMap<CardIndex, Map<string, readonly string[]>>
>();

/**
 * Кэш разбора ТЕКСТА карты: ответ зависит только от карты, справочника
 * и таблиц слов, а спрашивают его на КАЖДОГО кандидата. При усреднении
 * по пулу это сотни одинаковых вопросов подряд (тиры 1..6 — 382 заготовки),
 * и каждый строил свои регулярные выражения заново.
 *
 * Первым ключом идут ПРАВИЛА: тесты подают собственные таблицы слов, и общий
 * кэш выдал бы им ответ по чужой таблице. Дальше справочник и сама карта.
 */
function memoByCard<T>(
  cache: WeakMap<TavernRules, WeakMap<CardIndex, Map<string, T>>>,
  cardId: string,
  cards: CardIndex,
  rules: TavernRules,
  build: () => T,
): T {
  let byCards = cache.get(rules);
  if (byCards === undefined) {
    byCards = new WeakMap();
    cache.set(rules, byCards);
  }
  let byId = byCards.get(cards);
  if (byId === undefined) {
    byId = new Map();
    byCards.set(cards, byId);
  }
  const hit = byId.get(cardId);
  if (hit !== undefined) return hit;
  const built = build();
  byId.set(cardId, built);
  return built;
}

/**
 * Механики, которые текст карты называет словами, БЕЗ собственных механик карты.
 *
 * Та же логика, что у textTribesOf: Buzzing Vermin сам хрип и в тексте пишет
 * «Deathrattle:» — это не синергия, а описание себя. А вот Titus Rivendare
 * («Your Deathrattles trigger an extra time», механика AURA) и Deathstrider
 * («After a friendly Rally minion attacks, trigger your left-most
 * Deathrattle», TRIGGER_VISUAL) — усилители чужих механик, и без этой связи
 * оба на борде хрипов были голыми статами (part15, ход 17: советник
 * предложил продать Titus ради Wolf Pup 3/5).
 */
function textMechanicsOf(
  cardId: string,
  cards: CardIndex,
  rules: TavernRules,
): readonly string[] {
  return memoByCard(TEXT_MECHANICS_CACHE, cardId, cards, rules, () => {
    const info = cards.info(cardId);
    const text = info?.text ?? '';
    if (text === '') return [];
    const own = new Set(info?.mechanics ?? []);
    return Object.entries(rules.mechanicTextWords)
      .filter(([mech, word]) => !own.has(mech) && new RegExp(`\\b(?:${word})\\b`, 'i').test(text))
      .map(([mech]) => mech);
  });
}

const TEXT_MECHANICS_CACHE = new WeakMap<
  TavernRules,
  WeakMap<CardIndex, Map<string, readonly string[]>>
>();

/**
 * Свои миньоны, связанные с кандидатом МЕХАНИКОЙ, — в обе стороны.
 *
 * Прямая сторона: текст кандидата называет механику, а свои её несут
 * (Titus Rivendare «Your Deathrattles trigger an extra time» на борде
 * хрипов, part15).
 *
 * Обратная сторона: кандидат НЕСЁТ механику, а тексты своих её называют.
 * Случай part18 (ход 17): борд наг на заклинаниях — Abyssal Bruiser
 * («+{0}/+{1} for each Tavern spell you've cast»), Fleeing Fugitive
 * («Whenever you cast a spell on this…»), — а в витрине Deep-Sea Angler,
 * нага со Spellcraft, то есть источник этих самых заклинаний. Связь была
 * невидима, и советник предпочёл ему демона на два тира выше, «который
 * совсем не подходит композиции», — на что игрок и указал. Двусторонность
 * здесь та же, что у связи по имени карты (`namedCardMates`).
 *
 * Миньон, который сам несёт механику и сам же её называет («Spellcraft: …»),
 * в обратную сторону не считается: он производитель, а не потребитель, —
 * то же исключение, что у собственной механики в прямую сторону.
 */
function boardMatesOfMechanics(
  mechanics: readonly string[],
  candidate: Minion,
  board: readonly Minion[],
  cards: CardIndex,
  rules: TavernRules,
): number {
  const own = cards.info(candidate.cardId)?.mechanics ?? [];

  return board.filter((m) => {
    const theirs = cards.info(m.cardId)?.mechanics ?? [];
    // Прямая сторона: текст кандидата называет механику, а сосед её несёт.
    if (mechanics.some((mech) => theirs.includes(mech))) return true;
    // Обратная сторона — тот же вопрос с другого конца, и считается он ТОЙ ЖЕ
    // функцией: какие механики называет текст соседа, сам их не неся. Своя
    // копия этого разбора здесь молча расходилась бы с `textMechanicsOf`
    // при первой же правке таблицы слов.
    return textMechanicsOf(m.cardId, cards, rules).some((mech) => own.includes(mech));
  }).length;
}

/**
 * Свои миньоны, связанные с кандидатом ИМЕНЕМ карты, — в обе стороны:
 * текст кандидата называет их карту, или их текст называет его.
 *
 * Automaton Portrait («…summon an Ancestral Automaton») при своих
 * автоматонах — прямой множитель их роста; и наоборот, автоматон
 * из витрины ценнее при портрете на борде. Имена и тексты — из снапшота,
 * не выдуманная таблица пар. Копии (одно имя) не считаются — у них
 * своя ветка тройки.
 *
 * Пробелы в текстах ненадёжны (урок part16: переносы строк посреди
 * предложения), поэтому обе стороны сравнения приводятся к одиночным
 * пробелам. Имена короче шести символов не ищутся: односложное имя
 * в тексте — совпадение случайных слов, а не связь.
 */
function namedCardMates(candidate: Minion, board: readonly Minion[], cards: CardIndex): number {
  const info = cards.info(candidate.cardId);
  if (info === null) return 0;
  const flatten = (text: string | null): string => (text ?? '').replace(/\s+/g, ' ');
  const names = (name: string, text: string): boolean => name.length >= 6 && text.includes(name);
  const candidateText = flatten(info.text);

  return board.filter((m) => {
    if (m.entityId === candidate.entityId) return false;
    const theirs = cards.info(m.cardId);
    if (theirs === null || theirs.name === info.name) return false;
    return names(theirs.name, candidateText) || names(info.name, flatten(theirs.text));
  }).length;
}

/**
 * Механики, которые УДВАИВАЕТ хотя бы один свой миньон на борде.
 *
 * Удвоитель — читаемый факт: его текст говорит «trigger twice» / «trigger
 * an extra time» и называет механику словом. В пуле таких ровно трое, и они
 * делят три механики между собой (Бранн — кличи, Titus — хрипы, Drakkari —
 * конец хода). Собственный текст кандидата тут ни при чём: удваивает ЧУЖОЙ
 * миньон, стоящий на борде.
 */
function doubledMechanicsOnBoard(
  board: readonly Minion[],
  candidate: Minion,
  cards: CardIndex,
  rules: TavernRules,
): string[] {
  const doubled = new Set<string>();
  for (const m of board) {
    if (m.entityId === candidate.entityId) continue;
    for (const mech of doubledMechanicsOf(m.cardId, cards, rules)) doubled.add(mech);
  }
  return [...doubled];
}

/**
 * Что удваивает ЭТА карта — ответ про карту, а не про борд, и потому
 * кэшируется тем же `memoByCard`, что и разбор текста на племена
 * и механики. Без кэша три регулярки строились заново на каждого соседа
 * КАЖДОГО кандидата, а кандидатов при усреднении по пулу тиров 1..6 — 382.
 */
function doubledMechanicsOf(
  cardId: string,
  cards: CardIndex,
  rules: TavernRules,
): readonly string[] {
  return memoByCard(DOUBLED_MECHANICS_CACHE, cardId, cards, rules, () => {
    const text = cards.info(cardId)?.text ?? '';
    if (text === '') return [];
    if (!rules.mechanicDoublerWords.some((w) => new RegExp(w, 'i').test(text))) return [];
    return Object.entries(rules.doubledMechanicWords)
      .filter(([, word]) => new RegExp(`\\b(?:${word})\\b`, 'i').test(text))
      .map(([mech]) => mech);
  });
}

const DOUBLED_MECHANICS_CACHE = new WeakMap<
  TavernRules,
  WeakMap<CardIndex, Map<string, readonly string[]>>
>();

/** Сколько своих миньонов принадлежит хотя бы одному из племён. */
function boardMatesOfTribes(
  tribes: readonly string[],
  board: readonly Minion[],
  cards: CardIndex,
): number {
  if (tribes.length === 0) return 0;
  return board.filter((m) => {
    const races = racesOf(m, cards);
    return races.includes(RACE_ALL) || races.some((r) => tribes.includes(r));
  }).length;
}

/**
 * Сколько своих миньонов делят племя с этим.
 *
 * Амальгамы (`ALL`) считаются своими для любого племени — и с той, и с другой
 * стороны сравнения.
 */
export function tribeMates(candidate: Minion, board: readonly Minion[], cards: CardIndex): number {
  const mine = racesOf(candidate, cards);
  if (mine.length === 0) return 0;

  return board.filter((m) => {
    const theirs = racesOf(m, cards);
    if (theirs.length === 0) return false;
    if (mine.includes(RACE_ALL) || theirs.includes(RACE_ALL)) return true;
    return theirs.some((r) => mine.includes(r));
  }).length;
}

/**
 * Сколько таких же карт уже есть на борде и в руке.
 *
 * Считаются только незолотые копии: тройка собирается из трёх обычных,
 * золотой с обычными не складывается.
 *
 * Сам кандидат из счёта исключается по entityId. Для витрины это ничего
 * не меняет — её миньонов в руке нет, — а вот карта ИЗ РУКИ без этого
 * считала бы копией саму себя и получала бонус «вторая копия» на ровном месте.
 */
export function copiesOwned(candidate: Minion, state: GameState): number {
  if (candidate.golden) return 0;
  const same = (m: Minion): boolean =>
    m.cardId === candidate.cardId && !m.golden && m.entityId !== candidate.entityId;
  return state.board.filter(same).length + state.hand.filter(same).length;
}

/**
 * Сколько копий собирают золотого В ЭТОЙ партии.
 *
 * Правило игры — три, но сила героя его меняет, и число написано в её
 * тексте: «You only need 2 copies to make minions Golden» (Double Time).
 * Проверено логом part7 — все три золотых там собрались на двух копиях,
 * при контроле в три на обычных героях (part17, part19).
 *
 * Ниже двух не опускается: одна копия — это сам купленный миньон, и тройка
 * «из одного» сломала бы весь счёт копий, а не улучшила его.
 */
export function copiesForTriple(
  state: GameState,
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): number {
  const powerId = state.hero?.heroPowerCardId ?? null;
  if (powerId === null) return rules.tripleCopies;
  return memoByCard(TRIPLE_COPIES_CACHE, powerId, cards, rules, () => {
    const text = cards.info(powerId)?.text ?? '';
    for (const word of rules.tripleCopiesWords) {
      const hit = new RegExp(word, 'i').exec(text);
      const n = hit?.[1] === undefined ? NaN : Number.parseInt(hit[1], 10);
      if (Number.isFinite(n) && n >= 2) return n;
    }
    return rules.tripleCopies;
  });
}

const TRIPLE_COPIES_CACHE = new WeakMap<
  TavernRules,
  WeakMap<CardIndex, Map<string, number>>
>();

/**
 * Статы, которые сила героя даёт КАЖДОМУ разыгранному миньону.
 *
 * «When you play a minion, give it a +1/+1 hat…» (Hat Trick, part27):
 * миньон, попавший на борд, стоит на эти статы больше, и число читается
 * из текста той же шкалой `perStatPoint`, что и всё остальное. Сила
 * пассивная, нажимать нечего — без этого слагаемого советник не брал
 * из неё вообще ничего за всю партию.
 */
export function heroPowerPlayStats(
  state: GameState,
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): number {
  const powerId = state.hero?.heroPowerCardId ?? null;
  if (powerId === null) return 0;
  return memoByCard(HERO_POWER_PLAY_CACHE, powerId, cards, rules, () => {
    const text = cards.info(powerId)?.text ?? '';
    for (const word of rules.heroPowerPlayStatsWords) {
      const hit = new RegExp(word, 'i').exec(text);
      if (hit === undefined || hit === null) continue;
      const attack = Number.parseInt(hit[1] ?? '', 10);
      const health = Number.parseInt(hit[2] ?? '', 10);
      if (Number.isFinite(attack) && Number.isFinite(health)) return attack + health;
    }
    return 0;
  });
}

const HERO_POWER_PLAY_CACHE = new WeakMap<
  TavernRules,
  WeakMap<CardIndex, Map<string, number>>
>();

/** Сила «после N покупок с механикой — награда», разобранная из текста. */
export interface HeroPowerBuyReward {
  /** Сколько покупок нужно всего — число из текста. */
  readonly count: number;
  /** Механика снапшота, которую покупка обязана нести (BATTLECRY). */
  readonly mechanic: string;
  /** Награда — миньон пула, найденный по имени. */
  readonly reward: CardInfo;
  /** Сколько покупок ещё осталось: живой счётчик силы, без тега — `count`. */
  readonly remaining: number;
}

/**
 * Сила героя, платящая за ПОКУПКИ миньонов с механикой, — или `null`.
 *
 * «After you buy 4 Battlecry minions, get a Brann Bronzebeard. (Once per
 * game.)» («Бранное дело», part34). Три вещи читаются из текста: число
 * покупок, слово механики (сводится к механике снапшота той же таблицей
 * `mechanicTextWords`, что синергия по тексту) и имя награды (ищется среди
 * миньонов пула — «Brann Bronzebeard» в снапшоте пятнадцать карт, из пула
 * одна). Четвёртая — остаток — живой тег `TAG_SCRIPT_DATA_NUM_1` на сущности
 * силы: при создании его нет (остаток равен числу из текста), с первой
 * засчитанной покупки 3 → 2 → 1 → 0. Ноль — сила отработала («Once per
 * game»), и слагаемого больше нет.
 *
 * Разбор текста кэшируется по карте, остаток — нет: он меняется покупкой.
 */
export function heroPowerBuyReward(
  state: GameState,
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): HeroPowerBuyReward | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;
  const parsed = memoByCard(HERO_POWER_BUY_CACHE, hero.heroPowerCardId, cards, rules, () =>
    parseHeroPowerBuyReward(hero.heroPowerCardId ?? '', cards, rules),
  );
  if (parsed === null) return null;
  const remaining = hero.heroPowerScriptData[0] ?? parsed.count;
  if (remaining <= 0) return null;
  return { ...parsed, remaining };
}

/**
 * Насколько подешевеет сила героя от покупки миньона названного племени.
 *
 * `null` — сила так не работает (подавляющее большинство). Число ЖИВОЙ цены
 * тут не участвует: скидку применяет план на своём гипотетическом состоянии,
 * а список советов и так читает цену тегом `COST`.
 */
export function heroPowerBuyDiscount(
  state: GameState,
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): { readonly race: string; readonly amount: number } | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;
  const text = cards.info(hero.heroPowerCardId)?.text ?? '';
  if (text === '') return null;
  for (const word of rules.heroPowerBuyDiscountWords) {
    const m = new RegExp(word, 'i').exec(text);
    if (m?.[1] === undefined || m[2] === undefined) continue;
    const race = Object.entries(rules.tribeTextWords).find(([, w]) =>
      new RegExp(`^(?:${w})$`, 'i').test(m[1] ?? ''),
    )?.[0];
    if (race === undefined) return null;
    return { race, amount: Number(m[2]) };
  }
  return null;
}

/**
 * На сколько КЛИЧ этого миньона дешевит следующее заклинание витрины.
 *
 * `null` — карта так не работает (подавляющее большинство: в пуле миньонов
 * такая одна). Живая цена тут не участвует: скидку применяет план на своём
 * гипотетическом состоянии, а список читает цену тегом `COST` — игра
 * проставляет её в тот же миг, что срабатывает клич (part49).
 */
export function spellBuyDiscount(
  cardId: string,
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): number | null {
  return memoByCard(SPELL_BUY_DISCOUNT_CACHE, cardId, cards, rules, () => {
    const text = cards.info(cardId)?.text ?? '';
    if (text === '') return null;
    const hit = firstMatchAll(rules.spellBuyDiscountWords, text);
    if (hit === null) return null;
    const amount = Number.parseInt(hit[2] ?? '', 10);
    return Number.isFinite(amount) && amount > 0 ? amount : null;
  });
}

const SPELL_BUY_DISCOUNT_CACHE = new WeakMap<
  TavernRules,
  WeakMap<CardIndex, Map<string, number | null>>
>();

function parseHeroPowerBuyReward(
  powerId: string,
  cards: CardIndex,
  rules: TavernRules,
): Omit<HeroPowerBuyReward, 'remaining'> | null {
  const text = cards.info(powerId)?.text ?? '';
  if (text === '') return null;
  const hit = firstMatchAll(rules.heroPowerBuyRewardWords, text);
  if (hit === null) return null;
  const count = Number.parseInt(hit[1] ?? '', 10);
  const word = (hit[2] ?? '').toLowerCase();
  const name = (hit[3] ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!Number.isFinite(count) || count <= 0 || word === '' || name === '') return null;
  const mechanic =
    Object.entries(rules.mechanicTextWords).find(([, w]) =>
      new RegExp(`^(?:${w})$`, 'i').test(word),
    )?.[0] ?? null;
  if (mechanic === null) return null;
  for (let tier = 1; tier <= 6; tier += 1) {
    const reward = cards.poolOfTier(tier).find((c) => c.name.toLowerCase() === name);
    if (reward !== undefined) return { count, mechanic, reward };
  }
  return null;
}

const HERO_POWER_BUY_CACHE = new WeakMap<
  TavernRules,
  WeakMap<CardIndex, Map<string, Omit<HeroPowerBuyReward, 'remaining'> | null>>
>();

/**
 * Бонус за уже имеющиеся копии — по РАССТОЯНИЮ до тройки, а не по их числу.
 *
 * Последний элемент таблицы достаётся тому, кого покупка делает золотым;
 * остальные — ставке на будущую тройку. При обычных трёх копиях выходит
 * ровно прежняя таблица (0 → 0, 1 → 3, 2+ → 12), при двух — 0 → 0, 1 → 12.
 */
function copiesBonusOf(owned: number, needed: number, rules: TavernRules): number {
  const last = rules.copiesBonus.length - 1;
  const index = owned >= needed - 1 ? last : Math.min(owned, Math.max(0, last - 1));
  return rules.copiesBonus[index] ?? 0;
}

/**
 * Какая по счёту копия собирает тройку — словом, для причины совета.
 * У Double Time это вторая, у всех остальных третья, и совет обязан
 * называть её правильно: игрок сверяет причину, а не число.
 *
 * Падеж — параметром: причина заморозки говорит «третья копия под тройку»,
 * а цель обновления — «искать третью копию X». Одна форма на оба места
 * даёт «третья копию» — заметно и стыдно.
 */
function nthCopyWord(needed: number, form: 'nom' | 'acc'): string {
  if (needed === 2) return form === 'nom' ? 'вторая' : 'вторую';
  if (needed === 3) return form === 'nom' ? 'третья' : 'третью';
  return `${String(needed)}-${form === 'nom' ? 'я' : 'ю'}`;
}

/** «ещё одна такая покупка», «ещё 2 такие покупки», «ещё 5 таких покупок». */
function purchasesWord(n: number): string {
  if (n === 1) return 'одна такая покупка';
  if (n >= 2 && n <= 4) return `${String(n)} такие покупки`;
  return `${String(n)} таких покупок`;
}

/**
 * Молчит ли надбавка за ТИР на этом кандидате.
 *
 * Надбавка `perTechLevel` — прокси: «карта высокого тира несёт сильный
 * ТЕКСТ». У ауры над чужими весь текст обращён наружу, и когда обращаться
 * не к кому, прокси лжёт полной ставкой. Проект этот тезис уже сформулировал
 * («ценность миньона — то, что он делает с остальным бордом, а не собственное
 * тело», `isAuraOverOthers`), но применял его только при выборе жертвы
 * продажи. part53 показала вторую половину: на ПОКУПКЕ он нужен ровно так же.
 *
 * **Отличать механику БОЯ от механики РОЗЫГРЫША обязательно.** У Титуса
 * это хрип: он срабатывает смертью носителя в бою, — нет носителей, нет
 * эффекта. У БРАННА это клич: он срабатывает РОЗЫГРЫШЕМ, то есть окупается
 * теми, кого мы ЕЩЁ купим, и пустой борд ему не приговор (D059 куплен ровно
 * этим доводом). Обнулить обе разом значило бы сломать единственную
 * правильную покупку Бранна в пустой борд. Проверено числами: Титус на этом
 * борде падает 14.0 → 4.0, Бранн остаётся 13.0.
 *
 * Список механик боя ПОЗИТИВНЫЙ: незнакомая механика надбавку сохраняет,
 * и гаснет она только там, где связь с боем доказана (`combatBoundMechanics`).
 *
 * Скидка вместо обнуления не лечит: половина тира даёт Титусу 9.0 — он всё
 * ещё выше лучшей альтернативы того хода (6.5) и всё ещё в плане.
 */
function tierPremiumSilent(
  candidate: Minion,
  textMechMates: number,
  state: GameState,
  cards: CardIndex,
  rules: TavernRules,
): boolean {
  return (
    auraWithoutCarriers(candidate, textMechMates, cards, rules) ||
    tribePayoffWithoutCarriers(candidate, state, cards, rules)
  );
}

function auraWithoutCarriers(
  candidate: Minion,
  textMechMates: number,
  cards: CardIndex,
  rules: TavernRules,
): boolean {
  if (textMechMates > 0) return false;
  if (!isAuraOverOthers(candidate, cards, rules)) return false;
  const named = textMechanicsOf(candidate.cardId, cards, rules);
  if (named.length === 0) return false;
  return named.every((m) => rules.combatBoundMechanics.includes(m));
}

/**
 * Племя-получатель без носителей (D220, part54).
 *
 * Тот же довод, что у ауры Титуса, только текст обращён к ПЛЕМЕНИ, а не
 * к механике: Тихондрий («After your hero takes damage, give your Demons
 * +{0}/+{1}») на драконьем борде без единого демона — это тело 4/4, и тир
 * за его текст платить нечем. На кадре игрока (16:24:52) он стоял первым
 * шагом плана с баллом 14.0 = тир 10 + статы 4; игрок его не купил.
 *
 * Носители считаются на борде И В РУКЕ, кроме самого кандидата: карта руки
 * встанет на борд этим же ходом, и гасить надбавку при демоне в руке было бы
 * ошибкой в опасную сторону. Самого кандидата не считаем, хотя «your Demons»
 * задевает и его: прибавка одному себе — это рост тела, а не то, за что
 * берётся тир (у Тихондрия +4/+4 за каждый полученный героем удар).
 *
 * Защищены карты, которые окупаются не соседями по бою
 * (`tribePremiumKeepWords`, `tavernTriggerWords`, `triggerGetWords`).
 */
function tribePayoffWithoutCarriers(
  candidate: Minion,
  state: GameState,
  cards: CardIndex,
  rules: TavernRules,
): boolean {
  const tribes = payoffTribesOf(candidate.cardId, cards, rules);
  if (tribes.length === 0) return false;
  return ![...state.board, ...state.hand].some((m) => {
    if (m.entityId === candidate.entityId) return false;
    const races = racesOf(m, cards);
    return races.includes(RACE_ALL) || tribes.some((r) => races.includes(r));
  });
}

/**
 * Племена-получатели, за которые карта берёт надбавку тира (D220), —
 * пусто, если получателей нет или карта окупается вне боя. Ответ про карту,
 * кэшируется по ней: без кэша три десятка регулярок собирались на каждый
 * вызов ценности.
 */
function payoffTribesOf(cardId: string, cards: CardIndex, rules: TavernRules): readonly string[] {
  return memoByCard(PAYOFF_TRIBES_CACHE, cardId, cards, rules, () => {
    const text = cards.info(cardId)?.text ?? '';
    if (text === '') return [];
    const tribes = Object.entries(rules.tribeTextWords)
      .filter(([, word]) =>
        rules.tribeRecipientWords.some((w) =>
          new RegExp(w.replace('{tribe}', `(?:${word})`), 'i').test(text),
        ),
      )
      .map(([race]) => race);
    if (tribes.length === 0) return [];
    const kept = [...rules.tavernTriggerWords, ...rules.triggerGetWords, ...rules.tribePremiumKeepWords];
    return kept.some((w) => new RegExp(w, 'i').test(text)) ? [] : tribes;
  });
}

const PAYOFF_TRIBES_CACHE = new WeakMap<
  TavernRules,
  WeakMap<CardIndex, Map<string, readonly string[]>>
>();

/** Ценность миньона: во что складываются веса из таблицы правил. */
export function minionValue(
  candidate: Minion,
  state: GameState,
  { cards }: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): ValueBreakdown {
  const w = rules.value;
  const info = cards.info(candidate.cardId);

  // Надбавка за ТИР — прокси «у карты тира N сильный ТЕКСТ». Платится она
  // не всегда: у ауры над чужими текст — это и есть чужие, и когда носителей
  // названной механики нет, платить не за что. Решение — ниже, после того
  // как носители посчитаны (`tierPremiumSilent`).
  const techFull = (candidate.techLevel ?? info?.techLevel ?? 1) * w.perTechLevel;
  const stats = ((candidate.attack ?? 0) + (candidate.health ?? 0)) * w.perStatPoint;

  const mates = tribeMates(candidate, state.board, cards);
  const tribe = mates * w.perTribeMate;

  // Веса и капы слов — в `keywordValue` (щит не дороже тела, part7).
  // Яд и токсин — одно слово с одним весом, дважды не считаются.
  // Слово по порогу атаки, который усиления ЭТОГО хода добирают (D221):
  // Scarlet Survivor 3/3 с бананом и Major Hymn на первом ходу — 7/5 со щитом.
  const reached = thresholdKeywordReached(candidate, state, cards, rules);
  const keywords =
    BINARY_KEYWORDS.filter(([, field]) => candidate[field])
      .filter(([, field]) => field !== 'venomous' || !candidate.poisonous)
      .reduce(
        (sum, [, field]) =>
          sum + keywordValue(field, candidate.attack ?? 0, candidate.health ?? 0, rules),
        0,
      ) +
    (reached === null
      ? 0
      : keywordValue(reached.field, reached.attack, candidate.health ?? 0, rules));

  const owned = copiesOwned(candidate, state);
  // Сколько копий собирают золотого, решает сила героя, а не константа:
  // «Double Time» делает тройку из двух (part7). Выше порога бонус не растёт.
  const needed = copiesForTriple(state, cards, rules);
  const completesTriple = owned >= needed - 1;
  const copies = copiesBonusOf(owned, needed, rules);

  const golden = candidate.golden ? w.golden : 0;

  // Экономика видна только в тексте карты: River Skipper 1/1 по статам
  // мусор, а при продаже возвращает миньона. Шаблоны — из реальных текстов
  // пула, вес честно помечен как непроверяемый ближайшим боем.
  const text = info?.text ?? '';
  const economy =
    text !== '' && rules.economyTextWords.some((word) => new RegExp(word, 'i').test(text))
      ? w.economy
      : 0;

  // Боевой эффект из текста: ралли и призывы делают миньона в бою сильнее
  // его статов, и сверка с симулятором показала это ценой до 100 п.п.
  // (part6, ход 1: Flittering Bat с «Rally: Summon a Beast»).
  //
  // Оговорка part14 (ход 21): эффект «вашим <племени>» («Rally: Your Undead
  // have +1 Attack») пуст, когда своих этого племени нет, — на борде
  // элементалей нежить-ралли не делает ничего. Племя после «your» ищется
  // той же таблицей слов; призывов («Summon a Beast») это не касается —
  // призыв приносит тело независимо от борда.
  const battleMatch =
    text !== '' && rules.battleTextWords.some((word) => new RegExp(word, 'i').test(text));
  let battle = 0;
  if (battleMatch) {
    const yourRaces = Object.entries(rules.tribeTextWords)
      .filter(([, word]) => new RegExp(`\\byour\\s+(?:${word})\\b`, 'i').test(text))
      .map(([race]) => race);
    const anyMates =
      yourRaces.length === 0 ||
      state.board.some((m) => {
        if (m.entityId === candidate.entityId) return false;
        const races = racesOf(m, cards);
        return races.includes(RACE_ALL) || yourRaces.some((r) => races.includes(r));
      });
    if (anyMates) battle = w.battleEffect;
  }
  // Стартовый эффект, дарящий своему слово и статы (D223): цена — на той же
  // шкале слов и статов, что у покупки, своего веса у слагаемого нет.
  const combatGrant = combatKeywordGrant(candidate, state, cards, rules);
  if (combatGrant !== null) battle += combatGrant.value;

  // Клич кормит плательщиков борда (D224): розыгрыш кличевого — это
  // прибавка их племени, известная числом.
  const payoff = (info?.mechanics ?? []).includes('BATTLECRY')
    ? battlecryPayoffOf(state.board, cards, rules)
    : null;
  const battlecryPayoff =
    payoff === null ? 0 : battlecryPayoffPoints(payoff, state.board, candidate, cards, rules);

  // Discover кормит плательщиков борда (D232): кличевой с Discover — это
  // прибавка их племени за каждое срабатывание клича (при Бранне — два).
  // Сам кандидат к тому моменту на борде и получает свою долю.
  const discoverEvents = (info?.mechanics ?? []).includes('BATTLECRY')
    ? discoverCountOf(text, 'battlecry', rules) * battlecryTimesOn(state.board, cards, rules)
    : 0;
  const discoverPay =
    discoverEvents === 0
      ? null
      : discoverPayoffOf(
          state.board.some((m) => m.entityId === candidate.entityId)
            ? state.board
            : [...state.board, candidate],
          cards,
          rules,
        );
  const discoverPayoff = discoverPay === null ? 0 : discoverPay.points * discoverEvents;

  // Племя, названное словами в тексте, — та же связь с композицией, что
  // у тринкетов. Без неё Kangor's Apprentice (без племени, «…your first
  // 2 Mechs that died») на борде из мехов была слабейшей по голым статам,
  // и советник предлагал продать её ради чужого племени (part9, ход 19).
  const textMates = boardMatesOfTribes(
    textTribesOf(candidate.cardId, cards, rules),
    state.board.filter((m) => m.entityId !== candidate.entityId),
    cards,
  );
  const textTribe = textMates * w.perTextTribeMate;

  // Механика — та же связь, что у племён, и в обе стороны: кандидат её
  // называет, а свои несут (Titus Rivendare на борде хрипов, part15), либо
  // кандидат её несёт, а свои называют (нага со Spellcraft на борде,
  // живущем заклинаниями, part18).
  const textMechMates = boardMatesOfMechanics(
    textMechanicsOf(candidate.cardId, cards, rules),
    candidate,
    state.board.filter((m) => m.entityId !== candidate.entityId),
    cards,
    rules,
  );
  const textMech = textMechMates * w.perTextMechMate;

  // Надбавка за тир, решённая носителями. Случай part53 (ход таверны 9,
  // 01:18:32): Titus Rivendare `BG25_354` («Your Deathrattles trigger an extra
  // time») при ШЕСТИ своих миньонах, из которых с хрипом НОЛЬ, стоял вторым
  // шагом плана с баллом 14.0 = тир 10 + статы 4 + механика 0. То есть
  // синергия отработала верно и дала ноль, а балл целиком собрала надбавка
  // за тир — она платила за текст, стоящий на этом борде ровно ничего.
  // Жалоба игрока («не очень понимал смысла от него в той стадии игры») была
  // об этом, и Титуса он не купил.
  const tech = tierPremiumSilent(candidate, textMechMates, state, cards, rules) ? 0 : techFull;

  // Связь по ИМЕНИ карты — прямее племени: Automaton Portrait называет
  // Ancestral Automaton, а племени у портрета нет вовсе.
  const namedMates = namedCardMates(candidate, state.board, cards);
  const namedCard = namedMates * w.perNamedCardMate;

  // Магнит заклинаний ценен ровно теми заклинаниями, что у нас ЕСТЬ: Fleeing
  // Fugitive получает свои +1 здоровья с каждого применённого к нему,
  // Lava Lurker оставляет навсегда временное усиление. Заклинания руки —
  // читаемый факт состояния, и выгода считается тем же `spellMagnetGain`,
  // что и у выбора цели: одна формула на покупку и на применение
  // (part21, ход 5 — три заклинания в руке при беглеце в витрине).
  //
  // Отдельного веса у слагаемого нет: выгода измерена в СТАТАХ, а у статов
  // цена уже есть. Будущие заклинания (свой чародей на борде выдаёт по одному
  // за ход) не считаются — это ставка, а не факт; связь с чародеем и так
  // даёт `perTextMechMate`.
  //
  // Заклинания перебираются ЦИКЛОМ, а не складываются: у ХРАНИТЕЛЯ («The
  // first Spellcraft spell played from hand on this each turn is permanent»)
  // заряд ОДИН на ход, и второе чародейское заклинание руки постоянным
  // на нём уже не станет. `spellMagnetGain` читает счётчик с самого миньона
  // и на всех вопросах отвечает одинаково — значит, считать его обязан
  // тот, кто спрашивает. Прежняя сумма давала два трезубца в руке как
  // +4 стата вместо +2, и хранитель обгонял заведомо лучшие тела. У
  // РАСТУЩЕГО («gain +{0} Health») суммирование верно: он получает своё
  // с каждого заклинания, заряда у него нет.
  let charges = candidate.scriptData[0] ?? 1;
  let magnetStats = 0;
  for (const spell of state.handSpells) {
    const effect = spellEffect(spell.cardId, spell.scriptData, cards, rules);
    if (effect === null || effect.untargeted || effect.destroysFriendly) continue;
    if (effect.stats <= 0 && !effect.divineShield && !effect.grantsTaunt) continue;
    const gain = spellMagnetGain(candidate, effect, spell.cardId, cards, rules);
    if (gain === null) continue;
    if (gain.spendsCharge === true) {
      if (charges <= 0) continue;
      charges -= 1;
    }
    magnetStats += gain.gain;
  }
  const spellMagnet = magnetStats * w.perStatPoint;

  // Удвоитель механики на борде множит эффект кандидата, а не добавляет
  // «ещё одного своего»: при Бранне «Battlecry: Get a Deepwater Clan»
  // приносит ДВЕ карты, а `perTextMechMate` начислял за него полторы очка,
  // как за рядовую связь (part22, ход 23 — кличевой мурлок стоял вторым
  // после карты с эффектом конца хода, удваивать который некому).
  //
  // Очки начисляются только там, где известно ЧТО удваивается: у триггера,
  // ПРИНОСЯЩЕГО карту, есть курс — тот же `heroPowerSpellValue`, которым
  // считается прокрутка генератора и заклинание от силы героя. Удвоение
  // эффекта без добычи (аура, статы) остаётся обычной связью: множитель
  // там реален, а цены у него нет, и выдумывать её мы не будем.
  const carried = new Set(info?.mechanics ?? []);
  const doubles = doubledMechanicsOnBoard(state.board, candidate, cards, rules).filter((mech) =>
    carried.has(mech),
  );
  const brings =
    text !== '' && rules.triggerGetWords.some((word) => new RegExp(word, 'i').test(text));
  const doubler = doubles.length > 0 && brings ? rules.heroPowerSpellValue : 0;

  // Сила героя — такой же читаемый текст, как текст миньона борда, и связи
  // из неё читаются теми же таблицами. Прежде ценность покупки смотрела
  // только на борд и на саму карту, и герой не влиял ни на что (part22,
  // ход 1: Грибомант Флургл, «After you sell 5 minions, get a random
  // Murloc», — а советник предложил дракона вместо мурлока, чья ценность
  // реализуется ровно продажей).
  //
  // Два слагаемых, оба однократные — это факт о КАНДИДАТЕ, а не о числе
  // своих на борде:
  //  - племя, названное силой: вес как у племени из текста карты
  //    (`perTextTribeMate`) — упоминание слабее принадлежности;
  //  - продажа: сила платит за то же действие, которым карта отдаёт своё
  //    обещание, поэтому вес тот же, что у собственной экономики карты.
  const heroPowerCardId = state.hero?.heroPowerCardId ?? null;
  const heroPowerText = heroPowerCardId === null ? '' : (cards.info(heroPowerCardId)?.text ?? '');
  let heroPower = 0;
  if (heroPowerCardId !== null && heroPowerText !== '') {
    // Племена, названные силой, читаются той же функцией, что и у карт борда,
    // а принадлежность кандидата — той же, что у соседей по борду. Вычитание
    // СВОИХ рас внутри `textTribesOf` здесь ничего не меняет: у сил героя
    // племён в снапшоте нет вовсе.
    const heroTribes = textTribesOf(heroPowerCardId, cards, rules);
    if (boardMatesOfTribes(heroTribes, [candidate], cards) > 0) {
      heroPower += w.perTextTribeMate;
    }
    const heroSells = rules.heroPowerSellWords.some((word) =>
      new RegExp(word, 'i').test(heroPowerText),
    );
    const cardSells =
      text !== '' && rules.sellValueWords.some((word) => new RegExp(word, 'i').test(text));
    if (heroSells && cardSells) heroPower += w.economy;
  }

  // Сила, платящая за ПОКУПКИ миньонов с механикой (part34, «Бранное дело»:
  // «After you buy 4 Battlecry minions, get a Brann Bronzebeard»). Игрок
  // купил четыре кличевых за четыре хода таверны и получил Бранна на 4-м;
  // советник на ходу 1 звал Risen Rider вместо Busker, на ходу 3 — золотую
  // Laureate вместо Busker, потому что клич как условие силы не читал.
  //
  // Число без нового веса: ценность НАГРАДЫ на этом же борде той же
  // функцией (тир, тело, удвоитель кличей своих — всё настоящее), делённая
  // на ОСТАВШИЕСЯ покупки. Последняя покупка стоит целого Бранна — она его
  // и приносит; первая из четырёх — четверть. Сумма долей больше целого,
  // и это сказано вслух: каждая доля считается так, будто остальные шаги
  // будут сделаны, — оценка ВЕРХНЯЯ, как и у выбора из трёх (part30).
  // Награду считаем при герое без силы: иначе Бранн, будь он сам кличевым,
  // считал бы себя же наградой за собственную покупку.
  const buyReward = heroPowerBuyReward(state, cards, rules);
  let heroPowerBuy = 0;
  let heroPowerBuyLeft: number | null = null;
  let heroPowerBuyRewardName: string | null = null;
  if (buyReward !== null && (info?.mechanics ?? []).includes(buyReward.mechanic)) {
    const rewardValue = minionValue(
      minionFromCard(buyReward.reward, -1, true),
      { ...state, hero: null },
      { cards },
      rules,
    ).total;
    heroPowerBuy = rewardValue / buyReward.remaining;
    heroPowerBuyLeft = buyReward.remaining - 1;
    heroPowerBuyRewardName = buyReward.reward.name;
  }

  // Статы за сам розыгрыш (Hat Trick, part27). Слагаемое ОДИНАКОВО у всех
  // кандидатов и потому порядок покупок не меняет — оно меняет другое:
  // покупку против обновления, розыгрыш против «ничего». Считается
  // на нашей шкале статов, своего веса у него нет намеренно.
  const heroPowerPlay = heroPowerPlayStats(state, cards, rules) * w.perStatPoint;

  // Активация (part44): на нашей же шкале статов, своего веса нет.
  const activation = activationBoardStats(candidate, state, cards, rules) * w.perStatPoint;

  return {
    techLevel: tech,
    stats,
    tribe,
    keywords,
    copies,
    golden,
    economy,
    battle,
    textTribe,
    textMech,
    namedCard,
    spellMagnet,
    doubler,
    heroPower,
    activation,
    heroPowerPlay,
    heroPowerBuy,
    heroPowerBuyLeft,
    heroPowerBuyReward: heroPowerBuyRewardName,
    thresholdKeyword: reached,
    combatGrant:
      combatGrant === null ? null : { field: combatGrant.field, recipient: combatGrant.recipient },
    battlecryPayoff,
    discoverPayoff,
    total:
      tech +
      stats +
      tribe +
      keywords +
      copies +
      golden +
      economy +
      battle +
      textTribe +
      textMech +
      namedCard +
      spellMagnet +
      doubler +
      heroPower +
      activation +
      heroPowerPlay +
      heroPowerBuy +
      battlecryPayoff +
      discoverPayoff,
    tribeMates: mates,
    textTribeMates: textMates,
    textMechMates,
    namedCardMates: namedMates,
    copiesOwned: owned,
    completesTriple,
    tripleBet: owned > 0 && !completesTriple,
  };
}

/**
 * Ключевые слова, которые второй раз не дарятся: они у миньона либо есть,
 * либо нет, и магнитить их носителю, у которого они уже есть, — потеря.
 * Слева — механика в снапшоте, справа — живой признак миньона из лога.
 */
/**
 * Ключевые слова, которые у миньона живут булевым полем: механика снапшота ↔
 * поле `Minion`. Таблица одна на всех, потому что вопросов к ней два — «есть
 * ли оно у живого миньона» (магниты, дары) и «поставить ли его заготовке
 * из справочника» (`minionFromCard`). Двумя списками новое слово доезжало бы
 * до одного вопроса и молча пропадало во втором.
 */
const BINARY_KEYWORDS = [
  ['REBORN', 'reborn'],
  ['DIVINE_SHIELD', 'divineShield'],
  ['TAUNT', 'taunt'],
  ['WINDFURY', 'windfury'],
  ['POISONOUS', 'poisonous'],
  ['VENOMOUS', 'venomous'],
  ['STEALTH', 'stealth'],
] as const;

export type BinaryKeywordField = (typeof BINARY_KEYWORDS)[number][1];

/** Тот же миньон, но со словом: гипотетический борд плана после дара силы. */
export function withKeyword(m: Minion, field: BinaryKeywordField): Minion {
  switch (field) {
    case 'reborn':
      return { ...m, reborn: true };
    case 'divineShield':
      return { ...m, divineShield: true };
    case 'taunt':
      return { ...m, taunt: true };
    case 'windfury':
      return { ...m, windfury: true };
    case 'poisonous':
      return { ...m, poisonous: true };
    case 'venomous':
      return { ...m, venomous: true };
    case 'stealth':
      return { ...m, stealth: true };
  }
}

/** Слово текста → живой признак миньона; слова — как в текстах снапшота. */
const KEYWORD_BY_WORD: Readonly<Partial<Record<string, BinaryKeywordField>>> = {
  reborn: 'reborn',
  'divine shield': 'divineShield',
  taunt: 'taunt',
  windfury: 'windfury',
  poisonous: 'poisonous',
  venomous: 'venomous',
  stealth: 'stealth',
};

const KEYWORD_WORD: Readonly<Record<BinaryKeywordField, string>> = {
  reborn: 'reborn',
  divineShield: 'divine shield',
  taunt: 'taunt',
  windfury: 'windfury',
  poisonous: 'poisonous',
  venomous: 'venomous',
  stealth: 'stealth',
};

const KEYWORD_NAME_RU: Readonly<Record<BinaryKeywordField, string>> = {
  reborn: 'перерождение',
  divineShield: 'божественный щит',
  taunt: 'провокация',
  windfury: 'неистовство ветра',
  poisonous: 'яд',
  venomous: 'токсичность',
  stealth: 'маскировка',
};

/**
 * Чего стоит ключевое слово на теле — те же веса и те же капы, что
 * у покупки. Щит, вихрь и перерождение усиливают САМО тело и не могут
 * стоить дороже него: щит на 2/1 спасает полтора очка статов, а не три
 * (сверка с симулятором, part7, ход 3: Crackling Cyclone 2/1 со щитом
 * и вихрем против Molten Rock 3/3 при цене промаха 50 п.п.). Провокация
 * и яд телом не меряются: они меняют чужое поведение и чужие тела.
 *
 * Одна функция на два вопроса — «чего стоит купить миньона со словом»
 * (`minionValue`) и «чего стоит подарить слово своему» (сила героя,
 * part32): вторая копия формулы разъехалась бы молча.
 */
function keywordValue(
  field: BinaryKeywordField,
  attack: number,
  health: number,
  rules: TavernRules,
): number {
  const w = rules.value;
  const stats = (attack + health) * w.perStatPoint;
  switch (field) {
    case 'taunt':
      return w.taunt;
    case 'divineShield':
      return Math.min(w.divineShield, stats);
    case 'poisonous':
    case 'venomous':
      return w.poisonous;
    case 'windfury':
      return Math.min(w.windfury, attack * w.perStatPoint);
    case 'reborn':
      return Math.min(w.reborn, stats);
    case 'stealth':
      return 0;
  }
}

/**
 * Слово, которое кандидат получит ЭТИМ ходом, добрав порог атаки (D221).
 *
 * Жалоба игрока по part54 (ход 1): Scarlet Survivor 3/3 («Once this reaches
 * {0} Attack, gain Divine Shield», порог 6 на сущности) советник ставил ниже
 * Glim Guardian 1/4, не видя, что банан (+2) и сила Инге (+1 по тиру) делают
 * из неё 6/5 со щитом до конца хода. Замер против поля: 100 % боёв первого
 * хода против 96.7 % у Glim, а без щита Survivor берёт лишь 90.2 %.
 *
 * Атака хода — бесплатные заклинания руки с выбором своей цели и одно
 * нажатие бесплатной силы «Attack equal to your Tier» (одно, как в плане:
 * сколько нажатий положено, лог не пишет, D187). Досталось бы всё это
 * кандидату только тогда, когда он станет КРУПНЕЙШИМ телом борда (D142),
 * поэтому второй Survivor при своём же 17/19 щита не получает — усиления
 * уйдут старшему. Выбор цели через `buffTarget` здесь недоступен: он сам
 * спрашивает ценность миньонов (жертвы продажи), и круг замкнулся бы.
 */
function thresholdKeywordReached(
  candidate: Minion,
  state: GameState,
  cards: CardIndex,
  rules: TavernRules,
): { field: BinaryKeywordField; attack: number } | null {
  const parsed = memoByCard(THRESHOLD_CACHE, candidate.cardId, cards, rules, () => {
    const text = cards.info(candidate.cardId)?.text ?? '';
    for (const pattern of rules.attackThresholdKeywordWords) {
      const m = new RegExp(pattern, 'i').exec(text);
      if (m === null) continue;
      const named = (m[2] ?? '').toLowerCase().replace(/\s+/g, ' ');
      const field = BINARY_KEYWORDS.map(([, f]) => f).find((f) => KEYWORD_WORD[f] === named);
      return field === undefined ? null : { index: Number(m[1]), field };
    }
    return null;
  });
  if (parsed === null) return null;
  const threshold = candidate.scriptData[parsed.index] ?? null;
  if (threshold === null || candidate[parsed.field]) return null;
  const size = (x: Minion): number => (x.attack ?? 0) + (x.health ?? 0);
  const rival = state.board.some(
    (o) => o.entityId !== candidate.entityId && size(o) >= size(candidate),
  );
  if (rival) return null;
  const attack = (candidate.attack ?? 0) + turnAttackGain(state, cards, rules);
  return attack >= threshold ? { field: parsed.field, attack } : null;
}

const THRESHOLD_CACHE = new WeakMap<
  TavernRules,
  WeakMap<CardIndex, Map<string, { index: number; field: BinaryKeywordField } | null>>
>();

/**
 * Стартовый эффект боя, дарящий своему миньону племени статы и слово (D223).
 *
 * part54, ход 9: Thousandth Paper Drake («Start of Combat: Give your
 * left-most Dragon +1/+2 and Windfury») стоил 9.5 с «текст 0, бой 0»,
 * и советник звал вместо него вторую Scarlet Survivor. Игрок взял Drake
 * и поставил свою Survivor 17/19 со щитом крайней левой — вихрь достался
 * главному телу борда, и против поля 6-го хода таверны это 83.6 % боёв
 * против 74.9 %.
 *
 * Получатель «left-most» — ЛУЧШИЙ свой того племени: крайним левым игрок
 * ставит его сам, и расстановка это найдёт. «Two left-most» (золотой) —
 * два лучших. «Another friendly» — случайный из своих, и цена средняя.
 *
 * Слово, которое у получателя уже есть, не платится; статы — всегда.
 * Крайнему левому слово уже может дарить СВОЙ миньон борда: второй Drake
 * даёт вихрь тому же дракону, что и первый, и за слово платить нечего —
 * складываются только статы.
 */
function combatKeywordGrant(
  candidate: Minion,
  state: GameState,
  cards: CardIndex,
  rules: TavernRules,
): { field: BinaryKeywordField; recipient: Minion; value: number } | null {
  const grant = combatGrantSpec(candidate, cards, rules);
  if (grant === null) return null;
  const others = state.board.filter((o) => o.entityId !== candidate.entityId);
  const mates = others.filter((o) => {
    const races = racesOf(o, cards);
    return races.includes(grant.race) || races.includes(RACE_ALL);
  });
  if (mates.length === 0) return null;

  const statsGain = (grant.attack + grant.health) * rules.value.perStatPoint;
  const wordGain = (o: Minion): number =>
    o[grant.field]
      ? 0
      : keywordValue(grant.field, (o.attack ?? 0) + grant.attack, (o.health ?? 0) + grant.health, rules);
  const ranked = [...mates].sort((a, b) => wordGain(b) - wordGain(a));

  if (grant.recipients === null) {
    const value = ranked.reduce((s, o) => s + wordGain(o), 0) / ranked.length + statsGain;
    return { field: grant.field, recipient: ranked[0]!, value };
  }
  const covered = others
    .map((o) => combatGrantSpec(o, cards, rules))
    .filter((g) => g !== null && g.recipients !== null && g.field === grant.field && g.race === grant.race)
    .reduce((s, g) => s + (g?.recipients ?? 0), 0);
  const hit = ranked.slice(0, grant.recipients);
  const value =
    hit.slice(covered).reduce((s, o) => s + wordGain(o), 0) + hit.length * statsGain;
  return { field: grant.field, recipient: ranked[0]!, value };
}

/**
 * Что даёт своим один сработавший клич (D224): прибавки плательщиков
 * борда («After you trigger a Battlecry, give your Dragons +{0}/+{1}»)
 * и кратность от удвоителей клича. `null` — плательщиков нет.
 *
 * part54: золотой Kalecgos и Бранн делали каждый розыгрыш кличевого
 * прибавкой +8/+8 каждому дракону. Игрок крутил кличевых десятками, план
 * не предложил ни одной прокрутки — клич без добычи стоил для советника
 * ноль. Замер хода 27: план 31 % против поля, тот же план с четырьмя
 * прокрутками — 37.5 %, фактический конец хода игрока — 54 %.
 */
export interface BattlecryPayoff {
  readonly buffs: readonly { readonly race: string; readonly attack: number; readonly health: number }[];
  /** Сколько раз срабатывает один клич: 1, при Бранне 2, при золотом — 3. */
  readonly times: number;
  /** Имена плательщиков — для причины совета. */
  readonly payers: readonly string[];
}

export function battlecryPayoffOf(
  board: readonly Minion[],
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): BattlecryPayoff | null {
  const buffs: { race: string; attack: number; health: number }[] = [];
  const payers: string[] = [];
  let times = 1;
  for (const m of board) {
    const text = battlecryPayoffTextOf(m.cardId, cards, rules);
    if (text.times > times) times = text.times;
    if (text.payoff === null) continue;
    const read = (ph: string | undefined, lit: string | undefined): number =>
      ph !== undefined ? (m.scriptData[Number(ph)] ?? 0) : Number(lit ?? 0);
    const attack = read(text.payoff.attack[0], text.payoff.attack[1]);
    const health = read(text.payoff.health[0], text.payoff.health[1]);
    if (attack + health <= 0) continue;
    buffs.push({ race: text.payoff.race, attack, health });
    payers.push(cards.info(m.cardId)?.name ?? m.cardId);
  }
  return buffs.length === 0 ? null : { buffs, times, payers };
}

/**
 * Статы, которые один клич кладёт на борд, в очках. `played` — сам кличевой:
 * после розыгрыша он уже на борде и получает свою долю, если он того племени.
 */
export function battlecryPayoffPoints(
  payoff: BattlecryPayoff,
  board: readonly Minion[],
  played: Minion | null,
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): number {
  const bodies = played === null || board.some((m) => m.entityId === played.entityId)
    ? board
    : [...board, played];
  let stats = 0;
  for (const buff of payoff.buffs) {
    const members = bodies.filter((m) => {
      const races = racesOf(m, cards);
      return races.includes(buff.race) || races.includes(RACE_ALL);
    }).length;
    stats += (buff.attack + buff.health) * members;
  }
  return stats * payoff.times * rules.value.perStatPoint;
}

/**
 * Борд после одного сработавшего клича: прибавки плательщиков на своих
 * того племени, столько раз, сколько клич срабатывает. Эффект известен
 * числом, и план обязан его видеть — иначе прокрутка выглядела бы тратой
 * без результата, а следующий шаг считал бы драконов по старым статам.
 */
export function withBattlecryPayoff(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): GameState {
  const payoff = battlecryPayoffOf(state.board, deps.cards, rules);
  if (payoff === null) return state;
  const board = state.board.map((m) => {
    const races = racesOf(m, deps.cards);
    let attack = 0;
    let health = 0;
    for (const buff of payoff.buffs) {
      if (!races.includes(buff.race) && !races.includes(RACE_ALL)) continue;
      attack += buff.attack * payoff.times;
      health += buff.health * payoff.times;
    }
    return attack + health === 0
      ? m
      : { ...m, attack: (m.attack ?? 0) + attack, health: (m.health ?? 0) + health };
  });
  return { ...state, board };
}

/** «Kalecgos, Arcane Aspect: драконам +2/+2 ×2» */
function payoffNote(payoff: BattlecryPayoff, cards: CardIndex): string {
  void cards;
  const buffs = payoff.buffs
    .map((b) => `${b.race} +${String(b.attack)}/+${String(b.health)}`)
    .join(', ');
  const times = payoff.times > 1 ? ` ×${String(payoff.times)}` : '';
  return `${payoff.payers.join(', ')}: ${buffs}${times} за клич`;
}

/** Плательщик за клич или удвоитель клича — такого не продают ради места. */
function feedsBattlecries(m: Minion, cards: CardIndex, rules: TavernRules): boolean {
  const text = battlecryPayoffTextOf(m.cardId, cards, rules);
  return text.payoff !== null || text.times > 1;
}

interface BattlecryPayoffText {
  readonly payoff: {
    readonly race: string;
    readonly attack: readonly [string | undefined, string | undefined];
    readonly health: readonly [string | undefined, string | undefined];
  } | null;
  readonly times: number;
}

const BATTLECRY_TIMES: Readonly<Record<string, number>> = {
  twice: 2,
  'three times': 3,
  'an extra time': 2,
};

function battlecryPayoffTextOf(
  cardId: string,
  cards: CardIndex,
  rules: TavernRules,
): BattlecryPayoffText {
  return memoByCard(BATTLECRY_PAYOFF_CACHE, cardId, cards, rules, () => {
    const text = cards.info(cardId)?.text ?? '';
    if (!/battlecr/i.test(text)) return { payoff: null, times: 1 };
    let times = 1;
    for (const pattern of rules.battlecryTimesWords) {
      const word = new RegExp(pattern, 'i').exec(text)?.[1]?.toLowerCase().replace(/\s+/g, ' ');
      if (word !== undefined) times = Math.max(times, BATTLECRY_TIMES[word] ?? 1);
    }
    for (const [race, tribe] of Object.entries(rules.tribeTextWords)) {
      for (const pattern of rules.battlecryPayoffWords) {
        const found = new RegExp(pattern.replace('{tribe}', `(?:${tribe})`), 'i').exec(text);
        if (found === null) continue;
        return {
          payoff: {
            race,
            attack: [found[1], found[2]] as const,
            health: [found[3], found[4]] as const,
          },
          times,
        };
      }
    }
    return { payoff: null, times };
  });
}

const BATTLECRY_PAYOFF_CACHE = new WeakMap<
  TavernRules,
  WeakMap<CardIndex, Map<string, BattlecryPayoffText>>
>();

/** Во сколько раз клич срабатывает на этом борде: 1, при Бранне 2, при золотом 3. */
function battlecryTimesOn(board: readonly Minion[], cards: CardIndex, rules: TavernRules): number {
  return board.reduce(
    (times, m) => Math.max(times, battlecryPayoffTextOf(m.cardId, cards, rules).times),
    1,
  );
}

interface DiscoverPayoffText {
  readonly race: string;
  readonly other: boolean;
  readonly attack: readonly [string | undefined, string | undefined];
  readonly health: readonly [string | undefined, string | undefined];
}

function discoverPayoffTextOf(
  cardId: string,
  cards: CardIndex,
  rules: TavernRules,
): DiscoverPayoffText | null {
  return memoByCard(DISCOVER_PAYOFF_CACHE, cardId, cards, rules, () => {
    const text = cards.info(cardId)?.text ?? '';
    if (!/discover/i.test(text)) return null;
    for (const [race, tribe] of Object.entries(rules.tribeTextWords)) {
      for (const pattern of rules.discoverPayoffWords) {
        const found = new RegExp(pattern.replace('{tribe}', `(?:${tribe})`), 'i').exec(text);
        if (found === null) continue;
        return {
          race,
          other: found[1] !== undefined,
          attack: [found[2], found[3]] as const,
          health: [found[4], found[5]] as const,
        };
      }
    }
    return null;
  });
}

const DISCOVER_PAYOFF_CACHE = new WeakMap<
  TavernRules,
  WeakMap<CardIndex, Map<string, DiscoverPayoffText | null>>
>();

/**
 * Что даёт своим ОДИН Discover (D232): прибавки плательщиков борда
 * («After you Discover a card, give your other Pirates +{0}/+{1}», Hooktusk)
 * в очках на шкале статов. `null` — плательщиков нет.
 *
 * Числа — живые плейсхолдеры носителя (у Hooktusk они растут от сыгранных
 * золотых: на part55 +4/+4 к ходу 17, +11/+11 к ходу 23). Получатели —
 * свои того племени на `board`, кроме самого носителя при «other»; тело,
 * которое к моменту Discover уже продано или ещё не выставлено, решает
 * вызывающий — тем, какой борд передаёт.
 */
export function discoverPayoffOf(
  board: readonly Minion[],
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): { readonly points: number; readonly payers: readonly string[] } | null {
  let stats = 0;
  const payers: string[] = [];
  for (const m of board) {
    const spec = discoverPayoffTextOf(m.cardId, cards, rules);
    if (spec === null) continue;
    const read = (ph: string | undefined, lit: string | undefined): number =>
      ph !== undefined ? (m.scriptData[Number(ph)] ?? 0) : Number(lit ?? 0);
    const each = read(spec.attack[0], spec.attack[1]) + read(spec.health[0], spec.health[1]);
    if (each <= 0) continue;
    const members = board.filter((o) => {
      if (spec.other && o.entityId === m.entityId) return false;
      const races = racesOf(o, cards);
      return races.includes(spec.race) || races.includes(RACE_ALL);
    }).length;
    if (members === 0) continue;
    stats += each * members;
    payers.push(cards.info(m.cardId)?.name ?? m.cardId);
  }
  return payers.length === 0 ? null : { points: stats * rules.value.perStatPoint, payers };
}

/**
 * Сколько Discover делает текст там, где Discover — ДЕЙСТВИЕ (D232):
 * `where` — клич, продажа или начало текста (заклинание, активация, сила).
 * Число — после глагола («Discover 2 Tavern spells»); плейсхолдер и прочие
 * формы — один (оценка нижняя). Нет такого действия — ноль.
 */
function discoverCountOf(
  text: string,
  where: 'battlecry' | 'sell' | 'lead',
  rules: TavernRules,
): number {
  const patterns =
    where === 'battlecry'
      ? rules.discoverBattlecryWords
      : where === 'sell'
        ? rules.discoverSellWords
        : rules.discoverLeadWords;
  if (!patterns.some((w) => new RegExp(w, 'i').test(text))) return 0;
  const numbers: Readonly<Record<string, number>> = { two: 2, three: 3 };
  const raw = firstMatch(rules.discoverCountWords, text)?.toLowerCase();
  if (raw === undefined || raw === null) return 1;
  const count = numbers[raw] ?? Number(raw);
  return Number.isFinite(count) && count > 0 ? count : 1;
}

/** Причина к совету: чем Discover платит на этом борде. */
function discoverPayoffNote(
  payoff: { readonly points: number; readonly payers: readonly string[] },
  count: number,
): string {
  const times = count > 1 ? ` ×${String(count)}` : '';
  return `${payoff.payers.join(', ')}: Discover кормит своих (${payoff.points.toFixed(1)}${times})`;
}

/**
 * Что обещает стартовый эффект миньона — по тексту и тегам самого миньона.
 * `recipients` — сколько крайних левых получат дар; `null` — случайный свой.
 */
function combatGrantSpec(
  m: Minion,
  cards: CardIndex,
  rules: TavernRules,
): {
  race: string;
  field: BinaryKeywordField;
  attack: number;
  health: number;
  recipients: number | null;
} | null {
  const parsed = combatGrantTextOf(m.cardId, cards, rules);
  if (parsed === null) return null;
  const read = (ph: string | undefined, lit: string | undefined): number =>
    ph !== undefined ? (m.scriptData[Number(ph)] ?? 0) : Number(lit ?? 0);
  return {
    race: parsed.race,
    field: parsed.field,
    attack: read(parsed.attack[0], parsed.attack[1]),
    health: read(parsed.health[0], parsed.health[1]),
    recipients: parsed.recipients,
  };
}

interface CombatGrantText {
  readonly race: string;
  readonly field: BinaryKeywordField;
  /** Плейсхолдер и литерал: одно из двух задано. */
  readonly attack: readonly [string | undefined, string | undefined];
  readonly health: readonly [string | undefined, string | undefined];
  readonly recipients: number | null;
}

/**
 * Разбор текста стартового эффекта — ответ про КАРТУ, кэшируется по ней:
 * без кэша десять племён на шаблон пересобирались на каждого соседа каждого
 * кандидата, и план хода дорожал впятеро (part25: 0.3 → 1.4 с).
 */
function combatGrantTextOf(
  cardId: string,
  cards: CardIndex,
  rules: TavernRules,
): CombatGrantText | null {
  return memoByCard(COMBAT_GRANT_CACHE, cardId, cards, rules, () => {
    const text = cards.info(cardId)?.text ?? '';
    if (text === '' || !/start\s+of\s+combat/i.test(text)) return null;
    for (const [race, word] of Object.entries(rules.tribeTextWords)) {
      for (const pattern of rules.combatKeywordGrantWords) {
        const found = new RegExp(pattern.replace('{tribe}', `(?:${word})`), 'i').exec(text);
        if (found === null) continue;
        const named = (found[6] ?? '').toLowerCase().replace(/\s+/g, ' ');
        const field = BINARY_KEYWORDS.map(([, f]) => f).find((f) => KEYWORD_WORD[f] === named);
        if (field === undefined) return null;
        const who = (found[1] ?? '').toLowerCase();
        return {
          race,
          field,
          attack: [found[2], found[3]] as const,
          health: [found[4], found[5]] as const,
          recipients: /left-most/.test(who) ? (/\btwo\b/.test(who) ? 2 : 1) : null,
        };
      }
    }
    return null;
  });
}

const COMBAT_GRANT_CACHE = new WeakMap<
  TavernRules,
  WeakMap<CardIndex, Map<string, CombatGrantText | null>>
>();

/** «в бою даст неистовство ветра: Scarlet Survivor 17/19» */
function combatGrantNote(
  grant: { field: BinaryKeywordField; recipient: Minion },
  cards: CardIndex,
): string {
  const r = grant.recipient;
  return (
    `в бою даст ${KEYWORD_NAME_RU[grant.field]}: ` +
    `${cards.info(r.cardId)?.name ?? r.cardId} ${String(r.attack ?? '?')}/${String(r.health ?? '?')}`
  );
}

/** «усиления хода доведут атаку до 6: божественный щит» */
function thresholdKeywordNote(reached: { field: BinaryKeywordField; attack: number }): string {
  return `усиления хода доведут атаку до ${String(reached.attack)}: ${KEYWORD_NAME_RU[reached.field]}`;
}

/** Атака, которую этот ход может положить на одного своего миньона даром. */
function turnAttackGain(state: GameState, cards: CardIndex, rules: TavernRules): number {
  let gain = 0;
  for (const spell of state.handSpells) {
    if (spell.cost > 0 || spell.unplayable) continue;
    const effect = spellEffect(spell.cardId, spell.scriptData, cards, rules);
    if (effect === null || effect.stats <= 0) continue;
    if (effect.untargeted || effect.boardWide || effect.destroysFriendly) continue;
    if (effect.targetRace !== null) continue;
    const plus = /\+(?:\{(\d)\}|(\d+))(?=\s*(?:\/|attack\b))/i.exec(
      cards.info(spell.cardId)?.text ?? '',
    );
    if (plus === null) continue;
    gain +=
      plus[1] !== undefined ? (spell.scriptData[Number(plus[1])] ?? 0) : Number(plus[2] ?? 0);
  }
  const hero = state.hero;
  if (
    hero?.heroPowerCardId != null &&
    hero.heroPowerHasActivate &&
    heroPowerReady(hero) &&
    (hero.heroPowerCost ?? 0) === 0
  ) {
    const powerText = cards.info(hero.heroPowerCardId)?.text ?? '';
    const stat = rules.heroPowerTierStatsWords
      .map((w) => new RegExp(w, 'i').exec(powerText)?.[1]?.toLowerCase())
      .find((s) => s !== undefined);
    if (stat === 'attack') gain += state.techLevel;
  }
  return gain;
}

const BINARY_KEYWORD_FLAGS: readonly (readonly [string, (m: Minion) => boolean])[] =
  BINARY_KEYWORDS.map(([mech, field]) => [mech, (m: Minion): boolean => m[field]]);

/**
 * Виден ли яд у соперников — по накопленным бордам поля.
 *
 * Ядовитый миньон (poisonous/venomous) убивает любым касанием в обе
 * стороны: и когда атакует сам, и когда об него разбиваются. Против него
 * статы, сложенные магнитами в одно тело, обнуляются одним касанием —
 * на это указал игрок после part13. Гадать тут не нужно: борды соперников
 * мы уже видели, и яд в них — читаемый факт, а не оценка.
 */
export function poisonAmongSeen(state: GameState): boolean {
  return Object.values(state.lastSeenBoards).some((board) =>
    board.some((m) => m.poisonous || m.venomous),
  );
}

/**
 * Лучший носитель для магнитного миньона.
 *
 * Магнитный миньон можно не ставить в отдельный слот, а присоединить
 * к своему миньону: статы и способности перейдут носителю.
 *
 * Кому магнититься — читается с карты магнита и из виденного, не
 * выдумывается:
 *
 *  - **племена носителя** — поле `races` самого магнита: обычный магнит
 *    несёт `MECH`, а «Рука-протез» — `MECH, UNDEAD` («Can Magnetize to
 *    Mechs or Undead», part13);
 *  - **дар магнита** — его механики: если магнит дарит перерождение,
 *    носитель, у которого перерождение уже есть, получит его впустую.
 *    На part13 (ход 19) «Рука-протез» советовалась на Rescue Bot, уже
 *    перерождённого прошлой такой же рукой, — на что игрок и указал;
 *  - **яд у соперников** (`poisonThreat`) — при виденном яде носитель
 *    со щитом предпочтительнее просто крупного: щит поглощает ядовитое
 *    касание, а голые статы об него обнуляются. Если сам магнит дарит
 *    щит, угроза для носителя снята и размер снова главный.
 *
 * Порядок предпочтений: носитель с ВКЛЮЧЁННЫМ удвоением (и только для того
 * модуля, который на него притязает) → пригодные по племени → кому дар
 * не пропадёт → при яде со щитом → самый крупный. Каждый следующий фильтр
 * отступает, если оставляет пусто: статы складываются всегда, и совсем без
 * носителя магнит остаётся телом.
 */
export function magnetizeTarget(
  magnet: Minion,
  board: readonly Minion[],
  cards: CardIndex,
  poisonThreat = false,
  /**
   * Притязает ли ЭТОТ модуль на носителя с включённым удвоением.
   *
   * Решает не сам `magnetizeTarget`, а вызывающий: удвоение достаётся
   * ОДНОМУ модулю за нажатие, и выбирать его надо по РАЗНИЦЕ, которую оно
   * даёт (лишние статы модуля), а не по очкам розыгрыша целиком. Очки
   * несут ещё тир, племя и ключевые слова — величины про сам модуль,
   * от носителя не зависящие, — и по ним удвоение доставалось бы
   * не крупнейшему модулю, а самому дорогому (part44, ход 17: советник
   * клал на удвоенного носителя Annoy-o-Module 2/4 при Shield of the Legion
   * 7/3 в той же руке). Тот же урок, что «число, которым СОРТИРУЮТ,
   * и число, которым ОТБИРАЮТ, — разные» (part39).
   */
  claimsDoubler = false,
): Minion | null {
  const magnetInfo = cards.info(magnet.cardId);
  const carrierRaces =
    magnetInfo !== null && magnetInfo.races.length > 0
      ? magnetInfo.races.filter((r) => r !== RACE_ALL)
      : ['MECH'];

  const eligible = board.filter((m) => {
    const races = racesOf(m, cards);
    return races.includes(RACE_ALL) || carrierRaces.some((r) => races.includes(r));
  });
  if (eligible.length === 0) return null;

  const largest = (list: readonly Minion[]): Minion =>
    list.reduce((a, b) =>
      (b.attack ?? 0) + (b.health ?? 0) > (a.attack ?? 0) + (a.health ?? 0) ? b : a,
    );

  let pool = eligible;

  // УДВОЕНИЕ носителя разбирается ПЕРВЫМ — раньше дара и размера.
  //
  // Оно одноразовое: нажатие включает режим на одном миньоне, и гасит его
  // первый же модуль. Значит вопрос не «кому лучше», а «кто заберёт»,
  // и забирать должен крупнейший модуль: разница — это его лишние статы.
  // На part44 (ход 17) числа таковы: у Shield of the Legion 7/3 удвоение
  // стоит 5.0 очка, у Annoy-o-Module 2/4 — 3.0, а дар провокации, ради
  // которого правило ключевых слов вело туда мелкий модуль, — 1.0.
  //
  // Оговорка названа: при близких по размеру модулях уступленный дар
  // (щит — 3.0) может стоить дороже сбережённых статов, и тогда порядок
  // фильтров неверен. Общего сравнения тут нет НАМЕРЕННО — цену дара
  // на конкретном носителе `magnetizeTarget` не считает вовсе, а класс
  // узкий: карт с удвоением в пуле ОДНА.
  const doubledHosts = pool.filter((m) => magnetDoublerOf(m, cards) !== null);
  if (doubledHosts.length > 0) {
    if (claimsDoubler) pool = doubledHosts;
    else if (doubledHosts.length < pool.length) {
      pool = pool.filter((m) => magnetDoublerOf(m, cards) === null);
    }
  }

  const grants = BINARY_KEYWORD_FLAGS.filter(([mech]) =>
    magnetInfo?.mechanics.includes(mech) ?? false,
  );
  if (grants.length > 0) {
    const keepsGift = pool.filter((m) => grants.some(([, has]) => !has(m)));
    if (keepsGift.length > 0) pool = keepsGift;
  }

  const magnetGivesShield = magnetInfo?.mechanics.includes('DIVINE_SHIELD') ?? false;
  if (poisonThreat && !magnetGivesShield) {
    const shielded = pool.filter((m) => m.divineShield);
    if (shielded.length > 0) pool = shielded;
  }

  return largest(pool);
}

/**
 * Тег «следующее примагничивание к этому миньону удвоено».
 *
 * Игра его не именует — в логе он числом (как `2442` у связки кнопки
 * покупки с миньоном, part35). Ставится нажатием активации и гаснет тем
 * самым примагничиванием, которое удвоил: на part44 пять пар «1 → 0»
 * за партию, все на Дрон-дубликаторе и все внутри своего хода.
 */
const MAGNET_DOUBLE_TAG = '4945';

/**
 * Во сколько раз ляжет следующий модуль на этого носителя; `null` — режим
 * выключен или карта про удвоение не говорит.
 *
 * Нужны ОБА факта, и они из разных мест: «режим включён сейчас» — тег
 * (иначе советник обещал бы удвоение всю партию), «во сколько раз» — слово
 * из текста карты. У золотой копии слово своё («tripled»), и берётся оно
 * с золотой карты, а не подстановкой тройки по признаку `golden`: карта
 * говорит прямо, гадать незачем.
 */
export function magnetDoublerOf(
  carrier: Minion,
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): number | null {
  if ((carrier.tags[MAGNET_DOUBLE_TAG] ?? 0) <= 0) return null;
  const golden =
    carrier.golden && !carrier.cardId.endsWith('_G')
      ? cards.info(`${carrier.cardId}_G`)
      : null;
  const text = (golden ?? cards.info(carrier.cardId))?.text ?? '';
  for (const w of rules.magnetDoubleWords) {
    const m = new RegExp(w, 'i').exec(text);
    const word = m?.[1]?.toLowerCase();
    if (word !== undefined) return rules.magnetMultiplierWords[word] ?? null;
  }
  // Вторая формулировка той же активации — через число ЛИШНИХ раз
  // (баланс 251952): «happens an extra time» — это два раза, а не один.
  for (const w of rules.magnetExtraTimesWords) {
    const raw = new RegExp(w, 'i').exec(text)?.[1]?.toLowerCase();
    if (raw === undefined) continue;
    const extra = raw === 'an' ? 1 : Number(raw);
    if (Number.isFinite(extra) && extra > 0) return 1 + extra;
  }
  return null;
}

/**
 * Борд, на котором удвоение носителя ПОТРАЧЕНО этим примагничиванием.
 *
 * Нужно плану: он кладёт модули цепочкой, а удвоение достаётся ОДНОМУ
 * из них — на part44 (ход 17) в руке лежало четыре модуля при одном
 * включённом носителе. Без гашения второй и третий шаги считались бы
 * по тегу, которого в игре к тому моменту уже нет, — тот же класс, что
 * счётчик «после N покупок» (part34) и скидка силы от покупки (part40):
 * число, которое меняет СОБСТВЕННЫЙ шаг плана.
 */
export function withMagnetDoublingSpent(
  board: readonly Minion[],
  host: Minion | null,
): readonly Minion[] {
  if (host === null) return board;
  return board.map((m) =>
    m.entityId === host.entityId && (m.tags[MAGNET_DOUBLE_TAG] ?? 0) > 0
      ? { ...m, tags: { ...m.tags, [MAGNET_DOUBLE_TAG]: 0 } }
      : m,
  );
}

/**
 * Притязает ли модуль на носителя с включённым удвоением.
 *
 * Удвоение достаётся одному модулю, и достаться должно КРУПНЕЙШЕМУ: разница
 * — это лишние статы модуля, то есть его собственная сумма атаки и здоровья.
 * Соперники считаются по РУКЕ: модули оттуда кладутся даром и в любом
 * порядке, тогда как модуль витрины сначала надо купить. Ничья отдаёт
 * притязание обоим — это безвредно: первый же розыгрыш гасит тег, и второй
 * пересчитается уже без удвоения.
 */
function claimsMagnetDoubler(minion: Minion, state: GameState, cards: CardIndex): boolean {
  const stats = (m: Minion): number => (m.attack ?? 0) + (m.health ?? 0);
  return !state.hand.some(
    (m) => m.entityId !== minion.entityId && isMagnetic(m, cards) && stats(m) > stats(minion),
  );
}

/**
 * Работает ли миньон ИЗ РУКИ — по собственному тексту.
 *
 * Признак читаемый и в пуле массовый ровно настолько, насколько нужен:
 * карт с «in your hand» четырнадцать, и ВСЕ мурлоки. Трое из них работают
 * из руки сами (Flighty Scout, Bream Counter, Timewarped Astrogill),
 * остальные одиннадцать рукой питаются — тех этот признак не ловит,
 * и правильно: они как раз хотят на борд.
 */
export function isHandWorker(
  minion: Minion,
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): boolean {
  const text = cards.info(minion.cardId)?.text ?? '';
  return text !== '' && rules.handWorkerWords.some((w) => new RegExp(w, 'i').test(text));
}

/** Магнитный ли миньон — механика MODULAR в справочнике. */
function isMagnetic(minion: Minion, cards: CardIndex): boolean {
  return cards.info(minion.cardId)?.magnetic === true;
}

/**
 * Сколько стоит купить именно этого миньона.
 *
 * Первый источник — ЖИВАЯ цена с кнопки покупки (`Minion.buyCost`, тег
 * `COST` кнопки `TB_BaconShop_DragBuy`, привязанной к миньону; part35).
 * Это единственный источник, который не пропускает: «Refresh the Tavern
 * with Battlecry minions. They cost (1)» («Мозаика Стылой Межи») пишет
 * цену только на кнопки, и по тегу миньона витрина числилась по три —
 * при двух золотых совет был «НИЧЕГО», а игрок купил двоих по одному.
 *
 * Запасной путь — правило игры (3 золота, тега цены у миньонов витрины
 * нет) со скидкой на самом миньоне: тег `BACON_REDUCE_BUY_COST` — сколько
 * золота скинуто; парный `BACON_SHOW_OVERRIDEN_MINION_COST=1` велит
 * клиенту рисовать новую цену. Фактура: part3 — 9999 на ранних витринах
 * (миньоны бесплатны, кламп в ноль), part4 — скидка 2 на части витрины
 * (цена 1); там же кнопка показывает то же самое (`COST` 3 → 1 строкой
 * раньше тега на миньоне). По окончании эффекта тег сбрасывается в 0.
 * Запасной путь живёт ради старых записей датасета и тестов без кнопок.
 */
export function buyCostOf(minion: Minion, rules: TavernRules = DEFAULT_TAVERN_RULES): number {
  // `!= null`, а не `!== null`: у записей датасета до part35 поля нет вовсе,
  // и `undefined` обязан идти запасным путём, а не превращаться в NaN.
  if (minion.buyCost != null) return Math.max(0, minion.buyCost);
  const reduce = minion.tags['BACON_REDUCE_BUY_COST'] ?? 0;
  return Math.max(0, rules.minionCost - reduce);
}

/**
 * Сколько тел из ЭТОЙ витрины можно купить на `gold` — по живым ценам.
 *
 * Считается дешёвыми вперёд: это верхняя граница числа покупок, и она же
 * единственная, которую можно назвать, не решая, ЧТО именно покупать.
 * Когда вся витрина по правилу игры, число совпадает с прежним
 * `floor(gold / minionCost)` — то есть правки поведения там нет вовсе.
 *
 * Зачем понадобилось (part35): «Мозаика Стылой Межи» («They cost (1)»)
 * делает витрину по одному, а расчёты «сколько тел по карману» делили
 * золото на тройку из правил. Симптом игрок и назвал: при двух золотых
 * причина заморозки говорила «хватает лишь на 0 покупок», хотя купить
 * можно было двоих. Скидка part3/part4 (`BACON_REDUCE_BUY_COST`) даёт
 * тот же перекос в другую сторону.
 *
 * Граница проведена сознательно: этой функцией считается только ТЕКУЩАЯ
 * витрина. Там, где вопрос про витрину БУДУЩЕГО хода (планка заморозки,
 * `turnAffordingBoth`, `purchasesAfter`), цен ещё не существует, и цена
 * по правилу игры остаётся честной оценкой — менять её значило бы
 * выдумывать будущую скидку.
 */
export function bodiesAffordable(
  state: GameState,
  gold: number,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): number {
  if (gold <= 0) return 0;
  // Пустая витрина — это «цен не видно», а не «купить не на что»: вопрос
  // у зовущих про ЗОЛОТО («хватит ли остатка на тело»), и отвечать на него
  // нулём из-за отсутствия витрины значило бы путать нехватку денег
  // с отсутствием товара. Тогда — цена по правилу игры, ровно как
  // в запасном пути `buyCostOf`.
  if (state.shop.length === 0) return Math.floor(gold / rules.minionCost);
  const prices = state.shop.map((m) => buyCostOf(m, rules)).sort((a, b) => a - b);
  let left = gold;
  let bought = 0;
  for (const price of prices) {
    if (price > left) break;
    left -= price;
    bought += 1;
  }
  return bought;
}

/**
 * Цена обновления витрины — живая, из кнопки; таблица только запасной путь.
 *
 * Экономику меняют не только тринкеты: «Leaf Through the Pages» («Gain 2
 * free Refreshes», part17 ходы 19 и 21; part13 ход 23) и напарник Magnus
 * Manastorm («Two Refreshes each turn are free», part12 ходы 15–27) роняют
 * `COST` кнопки в ноль на целый ход. Советник считал по таблице и в эти
 * ходы честно не знал, что обновление бесплатно, — то же самое было бы
 * с любым экономическим тринкетом. Правило прежнее: читать факт, а не
 * моделировать эффект.
 */
export function rerollCostOf(state: GameState, rules: TavernRules = DEFAULT_TAVERN_RULES): number {
  return state.rerollCost ?? rules.rerollCost;
}

/**
 * Есть ли смысл в ПЛАТНОМ обновлении витрины прямо сейчас.
 *
 * Смысл появляется, когда найденное будет на что купить: обновление ради
 * взгляда — это потеря золота, а заморозить найденное значит отдать даром
 * бесплатное обновление следующего хода. Случай part18 (ход 7, скриншот
 * игрока): план советовал «подняться за 5 и обновить на оставшийся 1»,
 * хотя на витрину нового тира этого золота уже не хватало ни на что.
 * Игрок указал прямо: в ранней игре обновлять нежелательно.
 *
 * С `lateRerollTier` правило снимается: в лейте обновление — это поиск
 * конкретной карты под заморозку, и «не хватит купить сейчас» ему не довод
 * (part11, тот же игрок: «ценны рероллы позже»). Бесплатное обновление
 * не тратит ничего и не спрашивается вовсе.
 */
function paidRerollIsUseful(
  state: GameState,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): boolean {
  const cost = rerollCostOf(state, rules);
  if (cost === 0) return true;
  if (state.techLevel >= rules.lateRerollTier) return true;
  return state.gold - cost >= rules.minionCost;
}

/**
 * Племена, доказанные витриной, — состав партии, накопленный по факту.
 *
 * Прямого тега состава в логе нет. Витрина предлагает только пул партии,
 * поэтому ОДНОПЛЕМЕННЫЙ миньон витрины доказывает своё племя. Двуплеменные
 * доказательством не являются: «Рука-протез» (MECH/UNDEAD) была в пуле
 * part11 из-за нежити — мехов в той партии не было. Амальгамы (ALL) тоже
 * мимо. Тег `CARDRACE` не годится вдвойне: он строковый и показывает одно
 * племя даже у двуплеменной карты (part11: MECHANICAL на руке-протезе).
 *
 * Множество растёт по ходу партии и полноты не обещает: редкое племя может
 * долго не выпадать. Поэтому потребители сверяются с ним только когда
 * накоплено хотя бы `rules.lobbyRacesKnownAfter` племён.
 */
export function lobbyRaces(state: GameState, cards: CardIndex): ReadonlySet<string> {
  const races = new Set<string>();
  for (const cardId of state.seenShopCardIds) {
    const own = (cards.info(cardId)?.races ?? []).filter((r) => r !== RACE_ALL);
    if (own.length === 1 && own[0] !== undefined) races.add(own[0]);
  }
  return races;
}

/**
 * Энчант карты, добытой заклинанием или наградой, — сам по себе означает
 * лишь «розыгрыш бесплатен» (текст энчанта — «Costs (0)»).
 *
 * Урок part16: правило part11 читало его как «умрёт, если разыграть в этот
 * ход» — но смертность несёт ТЕКСТ ИСТОЧНИКА, а не энчант. «Восстание
 * из гробницы» (BG34_888, part11) пишет «It dies if you play it this turn»;
 * а карты от «Friendly Bounty», «Chef's Choice» и награды за тройку носят
 * тот же энчант и не умирают вовсе — прежнее правило прятало розыгрыш всей
 * руки (part16, ход 21: три миньона в руке, место на борде, совет «НИЧЕГО»,
 * на что игрок и указал). Источник читается тегом CREATOR_DBID.
 */
const DOOMED_ENCHANTMENT = 'TB_BaconShopBadsongE';
// Пробелы — \s+: тексты снапшота переносят строки посреди предложения.
const DOOMED_CREATOR_WORDS = /dies\s+if\s+you\s+play\s+it\s+this\s+turn/i;

/** Здоровье с бронёй — то, чем игрок реально расплачивается за слабый ход. */
function effectiveHp(state: GameState): number {
  const hero = state.hero;
  if (hero === null) return 0;
  return (hero.health ?? 0) - hero.damage + hero.armor;
}

/**
 * Правило подъёма таверны.
 *
 * Подъём — это ход без покупки, то есть заведомо более слабый бой. На полном
 * здоровье такой размен окупается будущим доступом к сильным миньонам,
 * на остатках здоровья он и есть проигрыш партии. Поэтому порог по здоровью,
 * а не только по золоту.
 *
 * ## Почему очки привязаны к лучшей покупке
 *
 * У покупки очки — ценность миньона, она к середине партии доходит до 20+.
 * Прежние очки подъёма («отставание × 3», максимум ~9) жили в другой шкале
 * и проигрывали любой покупке всегда: за девять ходов партии подъём попадал
 * в советы один раз. Число можно было бы подкрутить, но честнее признать
 * само правило: когда таверна отстаёт от графика и здоровье позволяет,
 * подъём ВАЖНЕЕ покупок — поэтому его очки ставятся выше лучшей из них
 * ровно на величину отставания.
 *
 * Одно исключение: если золота хватает только на что-то одно, тройка
 * важнее подъёма — она даёт золотого миньона и открытие карты. Когда золота
 * хватает на обоих, подъём всё равно идёт первым: сыгранная ПОСЛЕ подъёма
 * тройка открывает карту уже с нового тира.
 */
export function levelUpRule(
  state: GameState,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
  buys: readonly Recommendation[] = [],
  // Сколько копий собирают тройку. Числом, а не справочником: правилу
  // подъёма `CardIndex` не нужен ни для чего другого, а ответ на этот
  // вопрос уже посчитан у того, кто правило зовёт (`copiesForTriple`).
  copiesToTriple: number = rules.tripleCopies,
): Recommendation | null {
  const cost = state.tavernUpgradeCost;
  const target = state.tavernUpgradeTarget;
  if (cost === null || target === null) return null;
  if (state.maxTechLevel !== null && state.techLevel >= state.maxTechLevel) return null;
  if (cost > state.gold) return null;

  const hp = effectiveHp(state);
  if (hp < rules.levellingHpFloor) {
    return {
      action: 'levelUp',
      minion: null,
      score: 0,
      cost,
      requiresSlot: false,
      sellFirst: null,
      blockedByHp: true,
      reason:
        `поднять таверну можно за ${String(cost)}, но здоровья ${String(hp)} ` +
        `при пороге ${String(rules.levellingHpFloor)} — ход без покупки сейчас дороже тира`,
    };
  }

  const wanted = targetTier(state.turn, rules);
  const behind = Math.max(0, wanted - state.techLevel);

  // Расширение витрины — отдельная ценность подъёма: на чётных тирах
  // миньонов в ней становится больше (замерено по фикстурам, 3/4/4/5/5).
  const widens =
    (rules.shopSizeByTier[target] ?? 0) > (rules.shopSizeByTier[state.techLevel] ?? 0);
  const widerShop = widens ? `, витрина расширится до ${String(rules.shopSizeByTier[target])}` : '';

  let score = behind * rules.levellingUrgencyPerTier;
  // Своя ценность подъёма — та, с которой он идёт в развилку плана: одно
  // отставание от кривой, без чужой покупки внутри. В очках СПИСКА ниже
  // к ней примешивается ЛУЧШАЯ ПОКУПКА — она стоит там ради места над
  // покупками, — и с этого места два числа расходятся.
  let standalone: number | null = behind * rules.levellingUrgencyPerTier;
  // Витрина из мусора — довод подняться, а не покупать: лучший кандидат
  // ниже порога «покупать нечего» (тот же порог, что у реролла), и слабая
  // покупка выигрывала у подъёма только тем, что подъём по графику получал
  // ноль очков. Правило из базы знаний JeefHS («если в таверне только
  // мусор — повышайте уровень», docs/jeefhs.md), внесено по указанию игрока.
  const trashThreshold = rules.value.perTechLevel * state.techLevel + rules.rerollMarginOverTier;
  const bestBuy = buys.length > 0 ? Math.max(...buys.map((b) => b.score)) : null;
  const shopIsTrash = bestBuy !== null && bestBuy < trashThreshold;
  if (behind > 0 && bestBuy !== null) {
    const triple = buys
      .filter((b) => b.minion !== null && copiesOwned(b.minion, state) >= copiesToTriple - 1)
      .reduce((best: number | null, b) => (best === null || b.score > best ? b.score : best), null);
    const affordBoth = bodiesAffordable(state, state.gold - cost, rules) >= 1;

    score =
      triple !== null && !affordBoth
        ? // Золота на одно: тройку упускать нельзя, подъём сразу за ней.
          triple - 0.5
        : bestBuy + behind * rules.levellingUrgencyPerTier;
  } else if (behind === 0 && bestBuy !== null && shopIsTrash && rerollCostOf(state, rules) > 0) {
    // Довод «витрина из мусора» держится на том, что обновление стоит золота.
    // Когда оно бесплатно (заклинание «Gain 2 free Refreshes», напарник
    // Magnus Manastorm, тринкеты), мусор — довод обновиться, а не подняться:
    // подъём того же мусора не отменяет.
    score = bestBuy + rules.levellingUrgencyPerTier;
    // А вот здесь своей ценности у подъёма НЕТ, и развилка его не судит:
    // довод этой ветки — «покупать нечего», и цепочка из тех же покупок,
    // которые правило только что назвало мусором, ему не возражение.
    standalone = null;
  }

  // Судьба остатка, которого не хватит на покупку, зависит от стадии.
  // Поздно (от lateRerollTier) обновление за 1 — полноценная трата: идёт
  // поиск конкретных карт. Рано реролл на сдачу — пустая трата: найденное
  // пришлось бы морозить, теряя бесплатное обновление, и честнее назвать
  // остаток ценой подъёма (указано игроком, part10 ход 7 и part11).
  const leftover = state.gold - cost;
  const late = (state.tavernUpgradeTarget ?? state.techLevel + 1) >= rules.lateRerollTier;
  const leftoverTail =
    leftover >= rerollCostOf(state, rules) && bodiesAffordable(state, leftover, rules) === 0
      ? late
        ? `; остаток ${String(leftover)} — на обновление витрины нового тира`
        : `; остаток ${String(leftover)} сгорит — это цена подъёма`
      : '';

  // Остаток НАЗЫВАЕТСЯ ценой подъёма, но из очков СПИСКА не вычитается,
  // и это сознательно. 17.08 по жалобе игрока (part24, ход 7) вычитание
  // было написано и откачено: `goldPointValue` (3) и
  // `levellingUrgencyPerTier` (3) численно совпадают, поэтому один сгоревший
  // золотой ровно съедал один тир срочности, и на part20 (ход 7) исчезал
  // подъём на шести золотых. Совпадение двух не связанных констант не должно
  // решать вопрос стратегии.
  //
  // Судит сгоревший остаток теперь ПЛАН, а не список: 17.08 по третьей
  // подряд жалобе (part25, ход 7) игрок выбрал развилку — «пусть план
  // сравнивает подъём с цепочкой». Список остаётся прежним: он ранжирует
  // ОТДЕЛЬНЫЕ действия, и там подъём честно стоит выше лучшей покупки.
  // Ниже — своя ценность подъёма для этого сравнения.

  return {
    action: 'levelUp',
    minion: null,
    score,
    ...(standalone === null ? {} : { standaloneScore: standalone }),
    cost,
    requiresSlot: false,
    sellFirst: null,
    reason:
      (behind > 0
        ? `таверна ${String(state.techLevel)} при ожидаемых ${String(wanted)} к ${String(tavernTurnOf(state.turn))}-му ходу таверны` +
          `, подъём до ${String(target)} стоит ${String(cost)} из ${String(state.gold)}${widerShop}`
        : shopIsTrash
          ? `таверна ${String(state.techLevel)} по графику, но витрина без покупок ` +
            `(лучшее ${(bestBuy ?? 0).toFixed(1)} при пороге ${trashThreshold.toFixed(0)}) — ` +
            `подъём до ${String(target)} за ${String(cost)} вместо слабой покупки${widerShop}`
          : `таверна ${String(state.techLevel)} и так по графику, подъём до ${String(target)} за ${String(cost)} — на опережение${widerShop}`) +
      leftoverTail,
  };
}

/**
 * Ценность своего миньона — против ОСТАЛЬНОГО борда, а не против пустого.
 *
 * Разница не косметическая. Кандидат из витрины получает племенную синергию
 * от всех семи своих, а его конкурент с борда, посчитанный в пустоте, — ноль,
 * и любой чужой выглядит выгоднее любого своего. На бордах одного племени
 * это давало советы продавать заведомо не того.
 */
function ownBreakdown(
  m: Minion,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): ValueBreakdown {
  const rest = state.board.filter((x) => x.entityId !== m.entityId);
  return minionValue(m, { ...state, board: rest }, deps, rules);
}

function ownValue(
  m: Minion,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): number {
  const value = ownBreakdown(m, state, deps, rules);
  // Бонус за копии — про приобретение, а не про удержание: он оценивает, что
  // покупка соберёт тройку. У миньона, который уже на борде, ничего собирать
  // не надо, и оставленный бонус делает своих неотчуждаемыми — борд из семи
  // одинаковых токенов оценивался бы дороже любой витрины.
  //
  // Статы за розыгрыш вычитаются по той же причине, но довод сильнее: шляпа
  // Hat Trick — это НАСТОЯЩИЙ энчант на миньоне, и его +1/+1 уже посчитаны
  // в `stats` этого же разбора. Оставить слагаемое значило бы посчитать
  // одну и ту же шляпу дважды (part27).
  //
  // Доля награды за покупку (part34) — тоже про приобретение: свой кличевой
  // миньон второй раз не покупается, и Бранна за него больше не дадут.
  // Цена клича через плательщиков (D224) — туда же: клич своего миньона
  // борда уже отыграл. И Discover его клича (D232) — тоже.
  return (
    value.total -
    value.copies -
    value.heroPowerPlay -
    value.heroPowerBuy -
    value.battlecryPayoff -
    value.discoverPayoff
  );
}

/**
 * Аура на ЧУЖИХ: ценность миньона — то, что он делает с остальным бордом,
 * а не собственное тело. Признак — механика `AURA` в снапшоте, кроме аур
 * О СЕБЕ («Has +{0}/+{1} for each…»), у которых эффект и есть статы.
 *
 * В пуле 17 карт с AURA, и разделяются они этим признаком начисто: восемь
 * пумпят себя (Eternal Knight, Abyssal Bruiser, Maritime Extortionist…),
 * девять усиливают чужое (Brann «Your Battlecries trigger twice», Titus
 * «Your Deathrattles trigger an extra time», Drakkari Enchanter, Timewarped
 * Swirler…).
 */
function isAuraOverOthers(m: Minion, cards: CardIndex, rules: TavernRules): boolean {
  const info = cards.info(m.cardId);
  if (!(info?.mechanics.includes('AURA') ?? false)) return false;
  const text = info?.text ?? '';
  return !rules.selfAuraWords.some((w) => new RegExp(w, 'i').test(text));
}

/**
 * Слабейший свой — кандидат на продажу, когда борд полон.
 *
 * Ауры на чужих в жертвы не идут, пока есть хоть одно обычное тело (part19,
 * ход 27). Наша шкала меряет ТЕЛА: тир, статы, ключевые слова. У Бранна
 * Бронзоборода тело 27/29 при борде в сотни статов — по шкале он слабейший
 * и первым уходил в продажу, хотя ценность его в том, что он удваивает
 * боевые кличи ВСЕХ будущих покупок (в витрине того хода стоял Mind Muck
 * с кличем-поглощением). Продавать по числу, про которое сами знаем, что
 * оно не про эту карту, — это не осторожность, а ошибка.
 *
 * Если весь борд из таких аур, выбор честно возвращается к слабейшему
 * из них: место под покупку взять всё равно откуда-то надо. Тот же приём,
 * что у цели провокации с миньонами-движками (part15).
 *
 * Носителей АКТИВАЦИИ этот фильтр НЕ трогает, и это решено замером,
 * а не рассуждением: запрет их продавать был написан по part44 и на
 * корпусе (469 точек 41 партии) в худших случаях предлагал продать
 * Kalecgos 190/159 ради Hired Mount 40/52. Активация входит теперь
 * ЧИСЛОМ в саму ценность (`activationBoardStats`), и на большом борде
 * это число мало само собой.
 */
export function weakestOwn(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): { minion: Minion; value: number } | null {
  if (state.board.length === 0) return null;
  const bodies = state.board.filter((m) => !isAuraOverOthers(m, deps.cards, rules));
  const pool = bodies.length > 0 ? bodies : state.board;
  return pool
    .map((m) => ({ minion: m, value: ownValue(m, state, deps, rules) }))
    .reduce((a, b) => (b.value < a.value ? b : a));
}

/**
 * Почему остаток сгорает на ПОЛНОМ борде — словами, без новых весов
 * (долг part51, ход 19: «остаётся 10 — сгорит» при покупках по карману).
 *
 * Покупок нет законно: `buyRules` требует, чтобы кандидат против борда
 * без жертвы перевешивал её с запасом `sellMargin`. Строка называет лучшую
 * такую покупку, жертву и запас — ровно те числа, которыми решено.
 * Магниты и копии под тройку мест не требуют и сюда не идут: если сгорает
 * золото при них, причина другая, и строка молчит.
 */
export function fullBoardBurnNote(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): string | null {
  if (state.board.length < rules.boardSize) return null;
  const victim = weakestOwn(state, deps, rules);
  if (victim === null) return null;
  const budget = state.gold + rules.sellGold;
  const without = state.board.filter((m) => m.entityId !== victim.minion.entityId);
  const best = state.shop
    .filter((m) => buyCostOf(m, rules) <= budget && !isMagnetic(m, deps.cards))
    .map((m) => ({ minion: m, value: minionValue(m, { ...state, board: without }, deps, rules) }))
    .filter((c) => !c.value.completesTriple && !c.value.tripleBet)
    .reduce<{ minion: Minion; value: ValueBreakdown } | null>(
      (a, b) => (a === null || b.value.total > a.value.total ? b : a),
      null,
    );
  if (best === null || best.value.total > victim.value + rules.sellMargin) return null;
  const name = (m: Minion): string => deps.cards.info(m.cardId)?.name ?? m.cardId;
  // Строка короткая намеренно: в оверлее она хвост блока плана, а переполнение
  // панели обрезается молча (D164).
  return (
    `борд полон — ${name(best.minion)} (${best.value.total.toFixed(1)}) ` +
    `не лучше ${name(victim.minion)} (${victim.value.toFixed(1)}) с запасом ${String(rules.sellMargin)}`
  );
}

/**
 * Жертва продажи ПО ВЫБОРУ — на неполном борде, ради золотого (part51).
 *
 * На полном борде продажа вынуждена: место под покупку взять неоткуда,
 * и `weakestOwn` честно возвращает кого-нибудь даже из пар и аур. Здесь
 * место есть, продажа лишь добывает монету, и подчиняется она правилам
 * продажи по выбору — тем же, что у `sellForGoldRule` (part18): копия,
 * из которой собирается тройка, не продаётся. Без этого жертвой на кадре
 * part51 выходил Fleeing Fugitive 6/3 (11.0 против 11.5 у Mini-Myrmidon)
 * — одна из ДВУХ его копий на борде, то есть живая ставка на тройку.
 * Ауры на чужих не продаются по той же причине, что и в `weakestOwn`.
 *
 * **Миньон с триггером в тексте тоже не продаётся** («After you…»,
 * «Whenever…», «At the start/end of…» — `engineTextWords`), и это взято
 * из корпусного A/B, а не из рассуждения. Первая версия правила меняла
 * план в 17 точках 14 партий, и восемь из них поле бордов оценило ХУЖЕ;
 * две — ровно этим: жертвой уходили Prodigious Tusker (part44, «Whenever
 * another friendly minion attacks, this plays a Blood Gem on it», 7.5 по
 * шкале) и растущий Molten Rock (part9). Шкала меряет их телом, а цена
 * у них в тексте — тот же довод, что у аур (part19). На полном борде
 * такой запрет был бы опасен (part44: продать Kalecgos ради Hired Mount),
 * а здесь продажа не вынуждена: некого — значит, размена нет вовсе.
 *
 * Некого — `null`: продажа не вынуждена, и «откуда-то взять» не нужно.
 */
function electiveVictim(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): { minion: Minion; value: number } | null {
  const triggered = (m: Minion): boolean => {
    const text = deps.cards.info(m.cardId)?.text ?? '';
    return rules.engineTextWords.some((w) => new RegExp(w, 'i').test(text));
  };
  const pool = state.board.filter(
    (m) =>
      !isAuraOverOthers(m, deps.cards, rules) && copiesOwned(m, state) === 0 && !triggered(m),
  );
  if (pool.length === 0) return null;
  return pool
    .map((m) => ({ minion: m, value: ownValue(m, state, deps, rules) }))
    .reduce((a, b) => (b.value < a.value ? b : a));
}

/**
 * Во что обходится миньон, приходящий В РУКУ, когда борд ПОЛОН, — и как
 * это назвать в причине совета.
 *
 * «Discover a Tier 1 minion» (A New Sprout за 3, part31 ход 13), «Discover
 * a Mech» силой героя (part30), «Get a random Quilboar» ветвью (part28) —
 * всё это карта в руке, а не тело на борде. На полном борде место ей
 * освободит только продажа слабейшего, и считать такую карту полной
 * ценностью значит обещать слот, которого нет: на скриншоте part31 план
 * начинался с «купить A New Sprout за 3» (7.1 — средний миньон первого
 * тира) при семи своих от 4/5 до 17/21, где слабейший стоил 9.0. Ветвь
 * модального миньона вычитала жертву с part28; покупка заклинания и сила
 * героя — нет, и это одно и то же число, посчитанное не про то.
 *
 * Вычет — ценность жертвы (`weakestOwn`, та же, что у покупок на полном
 * борде); её имя идёт в причину. На неполном борде — `null`, вычета нет.
 */
function handMinionVictim(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): { readonly value: number; readonly note: string; readonly minion: Minion } | null {
  if (state.board.length < rules.boardSize) return null;
  const victim = weakestOwn(state, deps, rules);
  if (victim === null) return null;
  const name = deps.cards.info(victim.minion.cardId)?.name ?? victim.minion.cardId;
  return {
    value: victim.value,
    minion: victim.minion,
    note: `борд полон — место через продажу ${name} (${victim.value.toFixed(1)})`,
  };
}

/**
 * Правило покупки: по рекомендации на каждого миньона витрины, что по карману.
 *
 * **На полном борде «по карману» считается ВМЕСТЕ с продажей** (part36,
 * ход 13). Покупка туда всё равно идёт через продажу слабейшего, а продажа
 * приносит золотой — и сравнивать цену витрины с остатком ДО неё значит
 * отказываться от размена, который сам себя и оплачивает. На скриншоте
 * после подъёма на тир 5 осталось 2 золота при витрине по три, и оверлей
 * сказал «ОБНОВИТЬ за 1» и «НИЧЕГО»; игрок продал Water Droplet (5.0)
 * и купил Fearless Foodie (18.5) — ровно то, что советник считал
 * недоступным. Прибавка идёт ТОЛЬКО ветке с продажей: тройка сливается
 * сама, вторая копия уходит в руку, магнит садится на носителя — там
 * продавать некого, и лишнего золотого неоткуда взять.
 */
export function buyRules(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation[] {
  const full = state.board.length >= rules.boardSize;
  // На НЕполном борде продажа тоже бывает оплатой — когда без её золотого
  // покупка закрыта (part51, ход 11: золото 2 при витрине по три). Жертва
  // ищется только тогда: в остальных точках она не нужна, а считать её
  // каждый раз — лишний проход `ownValue` по борду.
  //
  // «Закрыта» значит закрыта ДАРОМ тоже: монета или «Gain 1 Gold» в руке
  // приносят тот же золотой, не отдавая тела. Без этой проверки план
  // part24 (ход 9) продавал миньона вместо бесплатного Hasty Excavation
  // из руки — жадный первый шаг брал размен, и золото уже не горело.
  const freeGold = state.handSpells.reduce((best, s) => {
    if (s.unplayable || s.cost > state.gold) return best;
    const e = spellEffect(s.cardId, s.scriptData, deps.cards, rules);
    return e === null ? best : Math.max(best, e.gold - s.cost);
  }, 0);
  //
  // И молчит, когда на борде есть карта, чья ценность САМА в продаже
  // («When you sell this…», `sellForGoldRule`, part18): тот же вопрос
  // «продать ради ещё одной покупки» она решает лучше — продаёт то, что
  // за продажу платит. Без этой границы корпусный A/B показал два хода
  // part36, где план вместо Sellemental продавал Risen Rider и терял
  // по полю 2.8 и 7.4 п.п.
  const sellValueOnBoard = state.board.some((m) => {
    const text = deps.cards.info(m.cardId)?.text ?? '';
    return (
      copiesOwned(m, state) === 0 &&
      rules.sellValueWords.some((w) => new RegExp(w, 'i').test(text))
    );
  });
  const saleOpensBuy =
    !full &&
    state.board.length > 0 &&
    freeGold < rules.sellGold &&
    !sellValueOnBoard &&
    state.shop.some((m) => {
      const cost = buyCostOf(m, rules);
      return cost > state.gold && cost <= state.gold + rules.sellGold;
    });
  const elective = saleOpensBuy ? electiveVictim(state, deps, rules) : null;
  const victim = full ? weakestOwn(state, deps, rules) : elective;
  const budget = state.gold + (victim === null ? 0 : rules.sellGold);
  // Скидка на силу от покупки своего племени (Патчес, part40): считается
  // здесь, где есть справочник, и едет в план полем `heroPowerCostAfter`.
  const powerDiscount = heroPowerBuyDiscount(state, deps.cards, rules);
  const powerCost = state.hero?.heroPowerCost ?? null;

  return state.shop
    // Цена у каждого миньона своя: скидки героев и даров видны тегом
    // на самом миньоне, и «не по карману» решается по ней, а не по трём.
    .filter((m) => buyCostOf(m, rules) <= budget)
    .flatMap((minion) => {
      const cost = buyCostOf(minion, rules);
      let value = minionValue(minion, state, deps, rules);
      const name = deps.cards.info(minion.cardId)?.name ?? minion.cardId;
      // Скидка заполняется, только когда в витрине есть что дешевить: текст
      // обещает её СЛЕДУЮЩЕМУ купленному заклинанию, хоть бы и через ход, —
      // но ход через ход советник не считает (тот же отказ, что у отложенного
      // золота, part46), а пустая приписка «заклинания подешевеют» на витрине
      // без заклинаний была бы советом ни о чём.
      const spellDiscount =
        state.shopSpells.length > 0 ? spellBuyDiscount(minion.cardId, deps.cards, rules) : null;

      // Магнитному миньону носитель называется всегда, а не только на полном
      // борде: игрок решает «телом или примагнитить», и совет без носителя
      // перекладывал половину решения на него (part13, ход 15). На полном
      // борде носитель ещё и освобождает от продажи: слот магниту не нужен.
      const host = isMagnetic(minion, deps.cards)
        ? magnetizeTarget(
            minion,
            state.board,
            deps.cards,
            poisonAmongSeen(state),
            claimsMagnetDoubler(minion, state, deps.cards),
          )
        : null;
      // Удвоение на носителе — те же лишние статы, что и у розыгрыша из руки.
      const doubler = host === null ? null : magnetDoublerOf(host, deps.cards, rules);
      const magnetStats = (minion.attack ?? 0) + (minion.health ?? 0);
      const doubledGain =
        doubler === null ? 0 : (doubler - 1) * magnetStats * rules.value.perStatPoint;

      // Сколько копий кандидата стоит на борде: тройка сливает их в золотого,
      // и место освобождается само.
      const copiesOnBoard = minion.golden
        ? 0
        : state.board.filter((b) => b.cardId === minion.cardId && !b.golden).length;

      const notes: string[] = [];
      let sellFirst: Minion | null = null;
      let requiresSlot = false;

      if (full && host === null) {
        if (value.completesTriple && copiesOnBoard >= 1) {
          // Тройка собирается, и хотя бы одна копия на борде: слияние заберёт
          // её и освободит слот — продавать никого не нужно (part10, ход 13:
          // советник предлагал продать Тавматурга ради третьего дракончика).
          notes.push('соберёт тройку — место освободится само');
        } else if (value.tripleBet) {
          // Вторая копия покупается В РУКУ, под будущую тройку: слот ей
          // не нужен, пока её не разыгрываешь.
          notes.push('борд полон — в руку, под тройку');
        } else if (victim !== null) {
          // Продажа оправдана только явным превосходством, и считать его надо
          // против борда БЕЗ жертвы: иначе кандидат получает бонусы от
          // миньона, которого сам же и продаёт, — на part10 дракончик
          // предлагал продать такого же дракончика ради «второй копии».
          const without = state.board.filter((x) => x.entityId !== victim.minion.entityId);
          const replacing = minionValue(minion, { ...state, board: without }, deps, rules);
          if (replacing.total <= victim.value + rules.sellMargin) return [];
          value = replacing;
          sellFirst = victim.minion;
          requiresSlot = true;
          const victimName = deps.cards.info(victim.minion.cardId)?.name ?? victim.minion.cardId;
          notes.push(`борд полон, продать ${victimName} (${victim.value.toFixed(1)})`);
        } else {
          notes.push('борд полон');
        }
      }

      // Неполный борд, и на покупку не хватает ровно золотого от продажи
      // (part51, ход 11). Место тут есть, поэтому это не «освободить слот»,
      // а размен тела на тело: сколько миньонов было, столько и останется,
      // а два золотых сверх цены жертвы уходят. Судится он той же арифметикой,
      // что продажа на полном борде, — кандидат против борда БЕЗ жертвы
      // и с запасом `sellMargin`, — и советуется только там, где иначе
      // покупки нет вовсе: если золота хватает, `cost > gold` не выполнится.
      //
      // Магнитный миньон сюда не идёт: он садится на носителя и слота
      // не занимает, то есть продажа ради него теряла бы тело. Копия самого
      // кандидата жертвой не бывает — `electiveVictim` пары не отдаёт.
      if (!full && cost > state.gold) {
        if (elective === null || host !== null) return [];
        const without = state.board.filter((x) => x.entityId !== elective.minion.entityId);
        const replacing = minionValue(minion, { ...state, board: without }, deps, rules);
        if (replacing.total <= elective.value + rules.sellMargin) return [];
        value = replacing;
        sellFirst = elective.minion;
        const victimName =
          deps.cards.info(elective.minion.cardId)?.name ?? elective.minion.cardId;
        notes.push(
          `золота ${String(state.gold)} при цене ${String(cost)} — ` +
            `продать ${victimName} (${elective.value.toFixed(1)})`,
        );
      }

      // Золотой продажи хватает только тому, кто продажу и делает: у прочих
      // веток бюджет остаётся прежним, и «по карману» решается остатком.
      if (cost > state.gold && sellFirst === null) return [];

      // Пометка про копии не дублирует ветку тройки на полном борде выше.
      if (value.completesTriple && !notes.some((n) => n.includes('тройку'))) {
        notes.unshift('собирает тройку');
      } else if (value.tripleBet && !notes.some((n) => n.includes('тройку'))) {
        notes.unshift('вторая копия');
      }
      if (value.thresholdKeyword !== null) notes.push(thresholdKeywordNote(value.thresholdKeyword));
      if (value.combatGrant !== null) notes.push(combatGrantNote(value.combatGrant, deps.cards));
      if (value.tribeMates > 0) notes.push(`своих по племени ${String(value.tribeMates)}`);
      if (value.textTribeMates > 0) {
        notes.push(`племя из текста: своих ${String(value.textTribeMates)}`);
      }
      if (value.textMechMates > 0) {
        notes.push(`механика из текста: своих ${String(value.textMechMates)}`);
      }
      if (value.namedCardMates > 0) {
        notes.push(`связана по имени: своих ${String(value.namedCardMates)}`);
      }
      if (value.doubler > 0) notes.push('свой удвоитель на борде — триггер принесёт вдвое');
      if (value.heroPowerBuyLeft !== null && value.heroPowerBuyReward !== null) {
        notes.push(
          value.heroPowerBuyLeft === 0
            ? `сила героя: эта покупка приносит ${value.heroPowerBuyReward}`
            : `сила героя: до ${value.heroPowerBuyReward} ещё ` +
                `${purchasesWord(value.heroPowerBuyLeft)} (${value.heroPowerBuy.toFixed(1)})`,
        );
      }
      if (value.economy > 0) notes.push('вернёт часть цены при продаже');
      if (minion.golden) notes.push('золотой');
      if (host !== null) {
        const hostName = deps.cards.info(host.cardId)?.name ?? host.cardId;
        const shieldHint =
          poisonAmongSeen(state) && host.divineShield ? ' (у соперников яд — носитель со щитом)' : '';
        notes.push(
          full
            ? `борд полон, но магнитится — примагнитить к ${hostName}${shieldHint}`
            : `магнитный — носитель ${hostName}${shieldHint}`,
        );
        if (doubler !== null) {
          notes.push(
            `у ${hostName} включено удвоение — модуль ляжет ${String(doubler)} раза ` +
              `(+${String((doubler - 1) * magnetStats)} статов)`,
          );
        }
      }

      // Скидка — не деталь: покупка за 0–1 меняет весь план хода, и совет
      // обязан говорить о ней вслух, а не прятать в поле cost.
      if (cost < rules.minionCost) {
        notes.push(`скидка — за ${String(cost)} вместо ${String(rules.minionCost)}`);
      }

      // Тир берётся с тем же запасным вариантом, что и в оценке: у миньона
      // витрины тега `TECH_LEVEL` может ещё не быть, и подпись «тир ?» рядом
      // с посчитанной по тиру ценностью выглядела бы противоречием.
      const tier = minion.techLevel ?? deps.cards.info(minion.cardId)?.techLevel ?? null;

      return [
        {
          action: 'buy' as const,
          minion,
          score: value.total + doubledGain,
          cost,
          requiresSlot,
          sellFirst,
          magnetizeTo: host,
          ...(value.heroPowerBuyLeft === null ? {} : { heroPowerBuyLeft: value.heroPowerBuyLeft }),
          // Пол был ЕДИНИЦЕЙ по краю наблюдений: в логе part40 цена силы
          // принимает ровно три значения — 3 (десять раз), 2 (десять)
          // и 1 (дважды), нуля нет ни разу. Считать ниже виденного значило бы
          // гадать в сторону, где наше же правило силы уходило в молчание
          // (`cost <= 0` возвращал null), то есть правка создала бы тихую дыру
          // вместо совета. Там же было записано условие снятия: «появится
          // фикстура с нулём — пол снимется вместе с ней».
          //
          // part53 и есть та фикстура. У Нобундо цена силы доходит до НУЛЯ
          // тегом дважды за партию (01:09:58 и 01:14:36), оба раза игрок силу
          // нажимал, а советник молчал. Правила силы ноль больше не отсекают,
          // и пол опущен туда, где он и должен быть.
          ...(powerDiscount !== null &&
          powerCost !== null &&
          (deps.cards.info(minion.cardId)?.races ?? []).includes(powerDiscount.race)
            ? { heroPowerCostAfter: Math.max(0, powerCost - powerDiscount.amount) }
            : {}),
          // Клич, дешевящий заклинание витрины (Зловещая пророчица, part49).
          // Поле заполняется у ЛЮБОЙ такой покупки, а применяет его план —
          // и только когда миньон встаёт на борд: клич срабатывает розыгрышем,
          // а на полном борде без продажи карта осталась бы в руке.
          ...(spellDiscount === null ? {} : { spellDiscountAfter: spellDiscount }),
          reason:
            `${name} ${String(minion.attack ?? '?')}/${String(minion.health ?? '?')} ` +
            `тир ${tier === null ? '?' : String(tier)}, ` +
            `ценность ${(value.total + doubledGain).toFixed(1)}` +
            (notes.length > 0 ? ` — ${notes.join(', ')}` : ''),
        },
      ];
    });
}

/**
 * Правило розыгрыша из руки.
 *
 * Купленный миньон попадает в руку, а бой играет только борд: карта, забытая
 * в руке, — это потраченное золото без миньона в бою. Пока на борде есть
 * место, разыграть сильнее руки почти всегда правильно; на полном борде —
 * только через продажу кого-то слабее.
 *
 * Ценность считается той же функцией, что у витрины, поэтому «разыграть»
 * и «купить» сравнимы напрямую. Розыгрыш при этом бесплатный.
 */
export function playRules(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation[] {
  const full = state.board.length >= rules.boardSize;
  const weakest = full ? weakestOwn(state, deps, rules) : null;

  return state.hand.flatMap((minion) => {
    // Копию из СОБРАННОЙ тройки в жертвы не берут. В игре третья купленная
    // копия сразу сливается в золотую, но план слияния не моделирует и кладёт
    // в руку обычную копию — part54, ход 19: «РАЗЫГРАТЬ Shipwrecked Rascal,
    // продав Shipwrecked Rascal 7/4» (всплыло, когда клич при Kalecgos стал
    // стоить очков, D224). Пару это не трогает: слабую копию ради сильной
    // из руки продавать можно (part10, ход 11).
    const copy = (b: Minion): boolean => !minion.golden && !b.golden && b.cardId === minion.cardId;
    const tripled =
      copiesOwned(minion, state) + 1 >= copiesForTriple(state, deps.cards, rules);
    const victim =
      weakest !== null && tripled && copy(weakest.minion)
        ? weakestOwn({ ...state, board: state.board.filter((b) => !copy(b)) }, deps, rules)
        : weakest;
    // Заблокированную карту разыграть нельзя, и советовать её — тихо неверно.
    // Пример из part8: Polarizing Beatboxer 5/10, выданный тринкетом
    // с замком на два хода, — тег LITERALLY_UNPLAYABLE, тикает и снимается.
    if ((minion.tags['LITERALLY_UNPLAYABLE'] ?? 0) > 0) return [];

    // Карта-смертник: источник («Восстание из гробницы», part11) пишет
    // «It dies if you play it this turn», и розыгрыш в ход получения
    // оправдан только предсмертным хрипом или перерождением. Смертность —
    // по ТЕКСТУ создателя (тег CREATOR_DBID), а не по энчанту Badsong:
    // энчант значит лишь «бесплатно» и висит на любых добытых картах —
    // от наград за тройку до пиратской экономики (part16, ход 21).
    // NUM_TURNS_IN_HAND=1 отличает ход получения.
    const creatorDbf = minion.tags['CREATOR_DBID'];
    const creator = creatorDbf === undefined ? null : deps.cards.infoByDbfId(creatorDbf);
    const doomed =
      minion.enchantments.some((e) => e.cardId === DOOMED_ENCHANTMENT) &&
      (minion.tags['NUM_TURNS_IN_HAND'] ?? 1) <= 1 &&
      DOOMED_CREATOR_WORDS.test(creator?.text ?? '');
    const doomedWorthIt =
      minion.reborn ||
      (deps.cards.info(minion.cardId)?.mechanics.some(
        (m) => m === 'DEATHRATTLE' || m === 'REBORN',
      ) ??
        false);
    if (doomed && !doomedWorthIt) return [];

    // Карта, РАБОТАЮЩАЯ ИЗ РУКИ, розыгрышем себя же и отменяет. Признак —
    // её собственный текст (`handWorkerWords`), и пород две:
    //
    //  - «Start of Combat: If this minion is in your hand, summon a copy
    //    of it» (Flighty Scout). Тел в бою поровну: копия приходит и без
    //    розыгрыша. Разница только в слоте — разыгранная карта занимает
    //    место на борде НАВСЕГДА, а лежащая в руке воюет бесплатно. Это
    //    арифметика из текста карты, а не мнение.
    //  - «While this is in your hand, after you play a Murloc, gain
    //    +{0}/+{1}» (Bream Counter). Розыгрыш ОСТАНАВЛИВАЕТ рост, и цена
    //    остановки ближайшему бою невидима — ровно как у экономики.
    //    На part22 план каждый ход предлагал выставить счетовода; игрок
    //    держал его в руке, и тот дорос с 208/206 до 670/668.
    //
    // Замер (`npm run spike:hand`) правило НЕ доказывает и на это не
    // претендует: он объявлен негодным по собственному предрегистрированному
    // критерию — контроль своего порога не взял (0.648 при 1.170), потому
    // что на 59 точках из 68 лишнее тело ближайший бой не меняет вовсе.
    // Что он показал — согласие: у «играет из руки» разность розыгрыша
    // −0.05 п.п., то есть ровно ноль, при +0.65 у обычной карты. Числа
    // и оговорки — в docs/tavern.md.
    //
    // Купить такую карту по-прежнему советуется: из руки она и работает.
    if (isHandWorker(minion, deps.cards, rules)) return [];

    let value = minionValue(minion, state, deps, rules);

    // Магнитный миньон при полном борде идёт не через продажу, а через
    // примагничивание: слот ему не нужен (part9, ход 13: советник предлагал
    // продать Molten Rock ради Accord-o-Tron). Носитель называется и на
    // неполном борде — игрок решает «телом или примагнитить», и совет без
    // носителя перекладывал половину решения на него (part13, ход 15).
    const host = isMagnetic(minion, deps.cards)
      ? magnetizeTarget(
          minion,
          state.board,
          deps.cards,
          poisonAmongSeen(state),
          claimsMagnetDoubler(minion, state, deps.cards),
        )
      : null;

    // На полном борде розыгрыш идёт через продажу. Ценность кандидата
    // считается против борда БЕЗ жертвы — иначе он получает бонусы от
    // миньона, которого сам вытесняет: на part10 дракончик из руки
    // предлагал «продать» такого же дракончика с борда, потому что тот
    // числился его «второй копией». И превосходство обязано быть явным,
    // с тем же порогом, что у правила продажи: менять почти равного
    // на почти равного — потерянный ход.
    if (full && host === null) {
      if (victim === null) return [];
      const without = state.board.filter((x) => x.entityId !== victim.minion.entityId);
      const replacing = minionValue(minion, { ...state, board: without }, deps, rules);
      if (replacing.total <= victim.value + rules.sellMargin) return [];
      value = replacing;
    }

    // КОПИЯ, КОТОРОЙ МЫ УЖЕ ВЛАДЕЕМ, розыгрышем копией быть не начинает.
    //
    // `copiesOwned` считает борд И РУКУ, и это не наше допущение, а факт,
    // который игра сообщает сама: тег `BACON_PAIR_CANDIDATE` она ставит
    // на карту витрины и тогда, когда единственная наша копия лежит
    // в РУКЕ (проверено разбором — семь таких случаев на part22 и part29,
    // и ни одного «пара без копии»). Значит ставка на тройку от розыгрыша
    // не выигрывает ничего: число копий до и после него одно и то же,
    // а слот на борде тратится навсегда.
    //
    // Пока бонус входил в очки розыгрыша, он входил в них ДВАЖДЫ — как
    // ценность владения и как ценность выкладывания, — и советник называл
    // «вторая копия» ПРИЧИНОЙ выставить карту. На part29 (ход 19) это
    // и вышло наружу: второй Бранн 2/4 при борде из 18/16, 24/23 и 25/34
    // стоял верхней строкой с 16.0 очков, из которых три — за копию.
    // Игрок: «непонятно, зачем ставить Бранна, ведь на следующий ход мне
    // придётся его продавать, если я не найду 3 копию».
    // Доля награды за покупку (part34) — тем более: карта уже куплена.
    const playValue = value.total - value.copies - value.heroPowerBuy;

    // Удвоение на носителе: модуль ложится на него не один раз, а `k`, —
    // значит его статы достаются борду `k` раз. Своего веса тут нет
    // и не нужно: величина считается тем же `perStatPoint`, что и любые
    // другие статы, а `k` называет сама карта носителя.
    const doubler = host === null ? null : magnetDoublerOf(host, deps.cards, rules);
    const magnetStats = (minion.attack ?? 0) + (minion.health ?? 0);
    const doubledGain =
      doubler === null ? 0 : (doubler - 1) * magnetStats * rules.value.perStatPoint;

    // Ставка на тройку, занимающая ПОСЛЕДНИЙ свободный слот, разменивается
    // на ОДИН бой.
    //
    // Пока слот свободен, он достаётся следующей покупке даром. Занятый
    // ставкой, он ту же покупку встречает продажей — и продана будет
    // именно ставка: копия под тройку берётся не телом, тело у неё
    // и ни при чём (второй Бранн — 2/4 при борде из 18/16 и 25/34).
    // Значит розыгрыш меняет ставку на тройку на лишнее тело в ОДНОМ бою,
    // и советуется он, только когда это тело в бою стоит дороже ставки:
    // `combatValue` против `copiesBonus`, обе величины — наши же веса.
    //
    // При равенстве ставка остаётся в руке. Это не осторожность ради
    // осторожности: розыгрыш необратим (слот назад не выкупить), а рука
    // не стоит ничего, и число копий в ней игра считает наравне с бордом.
    //
    // Тройки это не касается — её собирают немедленно, и слот тут не цена.
    const fillsLastSlot = state.board.length + 1 >= rules.boardSize;
    if (
      value.tripleBet &&
      !value.completesTriple &&
      fillsLastSlot &&
      combatValue(minion, state, deps, rules) <= value.copies
    ) {
      return [];
    }

    const name = deps.cards.info(minion.cardId)?.name ?? minion.cardId;
    const notes: string[] = [];
    if (doomed) notes.push('умрёт при розыгрыше в этот ход — но хрип/перерождение сработают');
    if (value.completesTriple) notes.push('собирает тройку');
    else if (value.tripleBet) notes.push('копия уже есть — ставка на тройку живёт и в руке');
    if (minion.golden) notes.push('золотой');
    if (value.thresholdKeyword !== null) notes.push(thresholdKeywordNote(value.thresholdKeyword));
    if (value.combatGrant !== null) notes.push(combatGrantNote(value.combatGrant, deps.cards));
    if (value.tribeMates > 0) notes.push(`своих по племени ${String(value.tribeMates)}`);
    if (value.textTribeMates > 0) {
      notes.push(`племя из текста: своих ${String(value.textTribeMates)}`);
    }
    if (value.namedCardMates > 0) {
      notes.push(`связана по имени: своих ${String(value.namedCardMates)}`);
    }
    if (host !== null) {
      const hostName = deps.cards.info(host.cardId)?.name ?? host.cardId;
      const shieldHint =
        poisonAmongSeen(state) && host.divineShield ? ' (у соперников яд — носитель со щитом)' : '';
      notes.push(
        full
          ? `борд полон, но магнитится — к ${hostName}${shieldHint}`
          : `магнитный — носитель ${hostName}${shieldHint}`,
      );
      // Удвоение называется словами: игрок нажал активацию сам и вправе
      // знать, на какой модуль советник её тратит и почему на этот.
      if (doubler !== null) {
        notes.push(
          `у ${hostName} включено удвоение — модуль ляжет ${String(doubler)} раза ` +
            `(+${String((doubler - 1) * magnetStats)} статов)`,
        );
      }
    } else if (full && victim !== null) {
      const victimName = deps.cards.info(victim.minion.cardId)?.name ?? victim.minion.cardId;
      notes.push(`борд полон, продать ${victimName} (${victim.value.toFixed(1)})`);
    }

    // Модальный миньон: игра спросит «эту ветвь или ту», и совет обязан
    // отвечать — иначе выбор целиком остаётся на игроке (part28, ход 13).
    // Считается ветвь на том борде, который БУДЕТ к моменту выбора: сам
    // миньон уже стоит (у «случайного соплеменника» он же и соплеменник),
    // а жертва, если борд был полон, уже продана — иначе место под второе
    // тело обещалось бы дважды одной и той же продажей.
    const boardAfter =
      host !== null
        ? state.board
        : [
            ...state.board.filter((x) => x.entityId !== victim?.minion.entityId),
            minion,
          ];
    const modal = modalBranchAdvice(minion, { ...state, board: boardAfter }, deps, rules);
    if (modal !== null) notes.push(modal.note);

    return [
      {
        action: 'play' as const,
        minion,
        score: playValue + doubledGain,
        cost: 0,
        requiresSlot: full && host === null,
        sellFirst: full && host === null ? (victim?.minion ?? null) : null,
        magnetizeTo: host,
        spellBranches: modal?.branches,
        // Цель ветви — в самой строке действия: «Choose One» у миньона игра
        // спрашивает сразу после розыгрыша, и «на кого» — половина вопроса
        // (part43). Цель считается на борде ПОСЛЕ розыгрыша: сам миньон уже
        // стоит и годится в цели, а жертва, освободившая ему место, продана.
        targetMinion: modal?.target ?? null,
        reason:
          `${name} ${String(minion.attack ?? '?')}/${String(minion.health ?? '?')} из руки, ` +
          `ценность ${(playValue + doubledGain).toFixed(1)}` +
          (notes.length > 0 ? ` — ${notes.join(', ')}` : ''),
      },
    ];
  });
}

/**
 * Порода генератора, который стоит прокрутить, — чем он платит за цепочку.
 *
 * `battlecry` — обещанное отдаёт РОЗЫГРЫШ: «Battlecry: Get two Slimy
 * Shields…» (Oozeling Gladiator, part16), а продажа лишь возвращает золото.
 * `sell` — обещанное отдаёт сама ПРОДАЖА: «When you sell this, get a random
 * Tier 1 minion» (River Skipper), «When you sell this, Discover a Tier 1
 * minion» (Patient Scout, part25). Цепочка у обоих одна и та же —
 * купить-разыграть-продать, — и чистая цена тоже.
 *
 * Продажный генератор обязан обещать МИНЬОНА: «get a 3/3 Elemental»
 * (Sellemental) и «give your minions +{0} Attack» (Ballers) — эффекты
 * другой природы, и мерить их пулом тира нельзя. В пуле девять карт
 * с «when you sell this», из них миньона обещают три, и все три называют
 * его тир: River Skipper и Patient Scout — первый, Timewarped Scout —
 * седьмой.
 */
function spinKindOf(text: string, rules: TavernRules): 'battlecry' | 'sell' | null {
  if (rules.battlecryGetWords.some((w) => new RegExp(w, 'i').test(text))) return 'battlecry';
  const sells = rules.sellValueWords.some((w) => new RegExp(w, 'i').test(text));
  const givesMinion = rules.givesMinionWords.some((w) => new RegExp(w, 'i').test(text));
  return sells && givesMinion ? 'sell' : null;
}

/**
 * Сколько КАРТ обещает текст: «Get two Slimy Shields», «Get 2 Blood Gems»,
 * «Get 3 Pointy Arrows». Ноль — счёт не назван.
 *
 * Счёт пишется и словом, и цифрой, и читать надо оба (D093, part38: одна
 * непрочитанная цифра роняла счёт на единицу, а с ним и всё правило).
 * Функция одна на два места: прокрутку кличевого генератора (`spinRule`)
 * и заклинание, которое кроме карт не обещает ничего (`givesCards`).
 */
function promisedCardCount(text: string, rules: TavernRules): number {
  const numbers: Readonly<Record<string, number>> = { two: 2, three: 3, four: 4 };
  for (const word of rules.battlecryGetCountWords) {
    const raw = new RegExp(word, 'i').exec(text)?.[1]?.toLowerCase();
    if (raw === undefined) continue;
    const count = numbers[raw] ?? Number(raw);
    if (Number.isFinite(count) && count > 0) return count;
  }
  return 0;
}

/**
 * Что стоят ОБЕЩАННЫЕ карты: «Get 3 Pointy Arrows» (Weapons Forge, part52).
 *
 * Считается по числам самой обещанной карты, а не курсом: база плейсхолдеров
 * из снапшота (`baseScriptData`) плюс ЖИВАЯ надбавка заклинаниям таверны,
 * которую редьюсер уже читает (`globalInfo.tavernSpellAttackBuff` и
 * `HealthBuff`). Проверено на трёх картах, семь наблюдений: Pointy Arrow
 * база 4/0 — в логе 7/3 при счётчике 3/3 и 8/4 при 4/4; Repair Job база
 * 4/8 — 6/10 при 2/2 и 8/12 при 4/4; Shiny Ring база 1/1 — 4/4 при 3/3.
 *
 * Почему не курс `heroPowerSpellValue` (D069, D094): корпусный прогон
 * показал цену ошибки. Три стрелы по шесть очков стоили 12 и на part36
 * (ход 11) вытесняли из плана ТЕЛО — при том, что на нулевом счётчике
 * стрела даёт 4 стата, то есть вся тройка равна цене покупки. Числа карты
 * калибруют сами себя: в начале партии ветка молчит, к 17-му ходу part52
 * (счётчик 4/4) три стрелы стоят 36 статов.
 *
 * Оценка НИЖНЯЯ: спутники Glambot и триггеры Царицы за каст сюда не входят
 * (долг, docs/next-steps.md), а карта, названная не по имени («Get 3 random
 * Spellcraft spells»), не оценивается вовсе.
 */
function promisedCardsValue(
  effect: SpellEffect,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
  goldCost: number,
): { score: number; reason: string } | null {
  if (effect.givesCards <= 0 || effect.givesCardId === null || effect.stats > 0) return null;
  const card = deps.cards.info(effect.givesCardId);
  if (card === null) return null;
  const base = card.baseScriptData;
  if (base.length === 0) return null;
  const attack = (base[0] ?? 0) + (state.globalInfo.tavernSpellAttackBuff ?? 0);
  const health = (base[1] ?? 0) + (state.globalInfo.tavernSpellHealthBuff ?? 0);
  const stats = effect.givesCards * (attack + health);
  if (stats <= 0) return null;
  const score = stats * rules.value.perStatPoint - goldCost * rules.goldPointValue;
  if (score <= 0) return null;
  return {
    score,
    reason:
      `${String(effect.givesCards)} × ${card.name} (+${String(attack)}/+${String(health)}), ` +
      `итого ${String(stats)} статов; оценка нижняя`,
  };
}

/**
 * Карта, названная ПО ИМЕНИ после счёта: «Get 3 **Pointy Arrows**».
 *
 * Имя в тексте карты пишется с заглавных, и это единственный признак,
 * по которому «Get 3 Pointy Arrows» отличается от «Get 3 random Spellcraft
 * spells»: там после счёта идёт строчное «random», имени нет, и считать
 * нечего. Множественное число снимается: карта в наборе одна и зовётся
 * «Pointy Arrow». Тот же приём уже применён к награде силы героя (part34)
 * и к «Get a Gem Day» (part48) — там поиск шёл по пулу миньонов, здесь
 * обещанной картой бывает заклинание.
 */
function promisedCardId(text: string, cards: CardIndex): string | null {
  // Регистр здесь значащий, и флага `i` тут быть не может: глагол пишется
  // с любой буквы («Get 3 …», «…and get 3 …»), а ИМЯ карты опознаётся
  // ровно по заглавным — иначе «Get 3 random Spellcraft spells» прочиталось
  // бы как обещание карты «random Spellcraft spells».
  const m = /\b(?:[Gg]et|[Dd]iscover|[Aa]dd)s?\s+(?:\d+|two|three|four)\s+((?:[A-Z][\w'’-]*)(?:\s+[A-Z][\w'’-]*)*)/.exec(
    text.replace(/<\/?[a-z]>/gi, ''),
  );
  const name = m?.[1];
  if (name === undefined) return null;
  const found = cards.byName(name)[0] ?? cards.byName(name.replace(/s$/i, ''))[0];
  return found?.id ?? null;
}

/**
 * Что даёт прокрутка ПРОДАЖНОГО генератора — тем же числом, что заклинание
 * витрины, дающее миньона.
 *
 * Купить за 3 и продать за 1 — это тело за чистых 2, ровно как «Steal
 * a random minion from the Tavern» за 2 (part17). Поэтому и считается оно
 * той же функцией: ожидание по пулу НАЗВАННОГО тира плюс разница с ценой
 * покупки по курсу золота. Ожидание нижнее: «(Improves each turn!)»
 * у Patient Scout поднимает тир к концу партии, а у Timewarped Scout
 * растёт ещё и число миньонов — мы считаем один и по тиру из текста.
 *
 * `spendNow` разделяет два вопроса. У действия ПРЯМО СЕЙЧАС скидка
 * засчитывается, только если остатка хватит ещё на покупку; у заморозки —
 * всегда: она и есть ставка на ход, где золота хватит на оба действия
 * (та же оговорка, что у заклинаний витрины).
 */
function sellSpinValue(
  minion: Minion,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
  spendNow: boolean,
): { readonly score: number; readonly net: number; readonly tier: number | null } | null {
  const text = deps.cards.info(minion.cardId)?.text ?? '';
  if (text === '' || spinKindOf(text, rules) !== 'sell') return null;

  const net = buyCostOf(minion, rules) - rules.sellGold;
  const tiered = namedTierPool(text, state, deps, rules);
  const { score } = givesMinionValue(
    state,
    deps,
    rules,
    net,
    spendNow,
    tiered ?? state.shop,
  );
  return { score, net, tier: tiered?.tier ?? null };
}

/**
 * Правило прокрутки: купить генератора, разыграть, продать.
 *
 * Случай part16 (ход 3 игрока): Oozeling Gladiator 2/2 («Battlecry: Get two
 * Slimy Shields…») стоил 3, продажа вернула бы 1 — два заклинания за чистых
 * два золота, и на остаток всё ещё покупалась золотая пиратка. Советник же
 * предлагал сразу пиратку, и два золота сгорали — на что игрок и указал.
 *
 * Случай part25 (ход 7 игрока): та же цепочка, только обещанное отдаёт
 * ПРОДАЖА. Patient Scout 1/1 («When you sell this, Discover a Tier 1
 * minion») стоил 3, продажа вернула 1 — миньон за чистых два, и на остаток
 * покупалось ещё тело. Советник предлагал поднять таверну за 5 из 6
 * с горящей монетой; игрок сыграл цепочку и вышел из хода на три тела
 * больше.
 *
 * Порядок в цепочке важен: прокрутка идёт ПЕРВОЙ, пока золота хватает
 * и на неё, и на лучшую покупку, — поэтому при выполнимости обоих её очки
 * ставятся не ниже лучшей покупки, и reason называет, что купить следом.
 * «Не ниже», а не «ровно на полбалла выше»: у продажного генератора
 * собственная ценность считается числом, и занижать её ради порядка незачем.
 *
 * Границы честные: копия под тройку не прокручивается (продажа ломает
 * тройку), на полном борде разыгрывать некуда. БАТЛКРАЙНЫЙ генератор,
 * который сам является лучшей покупкой, тоже не прокручивается — его
 * хочется оставить телом; у продажного этот запрет был бы неверен: его
 * обещание отдаёт только продажа, и «оставить телом» значит не получить
 * обещанного никогда (part18).
 */
export function spinRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
  buys: readonly Recommendation[] = [],
): Recommendation | null {
  // Клич кормит плательщиков борда (D224): тогда прокручивается ЛЮБОЙ
  // кличевой, а не только генератор карт, и полный борд прокрутке не помеха —
  // первая продаёт слабейшего (не плательщика и не удвоителя), и дальше
  // слот свободен. Без плательщика полный борд, как прежде, прокрутку
  // не допускает.
  const payoff = battlecryPayoffOf(state.board, deps.cards, rules);
  // Плательщик за Discover (D232) открывает полный борд так же, как
  // плательщик за клич: Discover прокрутки кормит своих, и слот под неё
  // стоит продажи слабейшего.
  const discoverPayer = discoverPayoffOf(state.board, deps.cards, rules) !== null;
  const full = state.board.length >= rules.boardSize;
  let victim: { minion: Minion; value: number } | null = null;
  if (full) {
    if (payoff === null && !discoverPayer) return null;
    for (const m of state.board) {
      if (feedsBattlecries(m, deps.cards, rules)) continue;
      if (discoverPayoffTextOf(m.cardId, deps.cards, rules) !== null) continue;
      const value = ownValue(m, state, deps, rules);
      if (victim === null || value < victim.value) victim = { minion: m, value };
    }
    if (victim === null) return null;
  }
  const refund = victim === null ? 0 : rules.sellGold;
  const boardAfterSale =
    victim === null ? state.board : state.board.filter((m) => m.entityId !== victim.minion.entityId);

  // Соперник по цепочке — лучшая покупка, КРОМЕ названного кандидата:
  // продажный генератор бывает и лучшей покупкой сразу, и сравнивать его
  // с собой бессмысленно. `null` не исключает никого: у покупки без миньона
  // `entityId` не `null`, а `undefined`, и ветка исключения не срабатывает.
  const bestBuyExcept = (exceptId: number | null): Recommendation | null =>
    buys.reduce(
      (a: Recommendation | null, b) =>
        b.minion?.entityId === exceptId ? a : a === null || b.score > a.score ? b : a,
      null,
    );
  const bestBuy = bestBuyExcept(null);

  /** Сколько карт обещает клич; не названо — одна (`promisedCardCount`). */
  const promisedCards = (text: string): number =>
    Math.max(1, promisedCardCount(text, rules));

  // `base` — собственная ценность прокрутки, `score` — она же после бампа
  // порядка. Отбор кандидата идёт по BASE, и это не мелочь: бамп отвечает
  // на вопрос «идти ли прокрутке впереди лучшей покупки», а не «какая
  // из прокруток лучше». Считая отбор по бампнутому числу, слабый генератор
  // выигрывал у сильного просто потому, что помещался в один ход с дорогой
  // покупкой, — и совет называл его же число, посчитанное не про него.
  let best: {
    minion: Minion;
    net: number;
    base: number;
    score: number;
    note: string;
  } | null = null;
  for (const minion of state.shop) {
    const cost = buyCostOf(minion, rules);
    if (cost > state.gold + refund) continue;
    // Копию не прокручивают: продажа ломает будущую тройку.
    if (copiesOwned(minion, state) > 0) continue;

    const info = deps.cards.info(minion.cardId);
    const text = info?.text ?? '';
    if (text === '') continue;
    const generator = spinKindOf(text, rules);
    const fed =
      payoff !== null && (info?.mechanics ?? []).includes('BATTLECRY')
        ? // Прокрученное тело продаётся, своя доля прибавки ему не впрок.
          battlecryPayoffPoints(payoff, boardAfterSale, null, deps.cards, rules)
        : 0;
    const kind = generator ?? (fed > 0 ? 'battlecry' : null);
    if (kind === null) continue;
    // Discover прокрутки (D232): клич — столько раз, сколько клич срабатывает,
    // продажа — один. Прокрученное тело к тому моменту продано или будет
    // продано, и своя доля ему не впрок.
    const discovers =
      kind === 'battlecry'
        ? discoverCountOf(text, 'battlecry', rules) * battlecryTimesOn(boardAfterSale, deps.cards, rules)
        : discoverCountOf(text, 'sell', rules);
    const discoverPay = discovers > 0 ? discoverPayoffOf(boardAfterSale, deps.cards, rules) : null;
    const discoverFed = discoverPay === null ? 0 : discoverPay.points * discovers;
    // Через проданный слот крутится только то, что кормит плательщиков.
    if (victim !== null && !((kind === 'battlecry' && fed > 0) || discoverFed > 0)) continue;
    // Батлкрайного генератора, который сам — лучшая покупка, не прокручивают.
    // Кличевого без добычи при плательщике — прокручивают: лучшей покупкой
    // его делает та же прибавка, что получит и прокрутка, а «купить или
    // крутить» решают очки двух советов. Генератор с Discover при плательщике
    // (D232) — тот же случай.
    if (
      generator === 'battlecry' &&
      discoverFed <= 0 &&
      bestBuy?.minion?.entityId === minion.entityId
    ) {
      continue;
    }

    const net = cost - rules.sellGold;
    let base: number;
    let note: string;
    if (kind === 'battlecry') {
      const count = generator === 'battlecry' ? promisedCards(text) : 0;
      base =
        count * rules.heroPowerSpellValue +
        fed +
        discoverFed -
        net * rules.goldPointValue -
        (victim?.value ?? 0);
      const notes: string[] = [];
      if (count > 0) notes.push(`клич даст ${String(count)} карт.`);
      if (fed > 0 && payoff !== null) notes.push(payoffNote(payoff, deps.cards));
      if (discoverPay !== null) notes.push(discoverPayoffNote(discoverPay, discovers));
      note = notes.join(', ');
    } else {
      const spun = sellSpinValue(minion, state, deps, rules, true);
      if (spun === null) continue;
      base = spun.score + discoverFed - (victim?.value ?? 0);
      note =
        (spun.tier === null
          ? 'продажа даст миньона'
          : `продажа даст миньона тира ${String(spun.tier)}`) +
        (discoverPay === null ? '' : `, ${discoverPayoffNote(discoverPay, discovers)}`);
    }
    if (base <= 0) continue;

    // Пока выполнимы и прокрутка, и лучшая покупка, прокрутка идёт первой:
    // начатая с покупки цепочка умирает — золота на генератора не остаётся.
    const rival = bestBuyExcept(minion.entityId);
    const affordBoth =
      rival?.minion != null && state.gold + refund - net >= buyCostOf(rival.minion, rules);
    const score = affordBoth && rival !== null ? Math.max(base, rival.score + 0.5) : base;
    if (best === null || base > best.base) best = { minion, net, base, score, note };
  }
  if (best === null) return null;

  const name = deps.cards.info(best.minion.cardId)?.name ?? best.minion.cardId;
  const next = bestBuyExcept(best.minion.entityId);
  const followUp =
    next?.minion != null && state.gold + refund - best.net >= buyCostOf(next.minion, rules)
      ? `; потом ${deps.cards.info(next.minion.cardId)?.name ?? next.minion.cardId}`
      : '';

  return {
    action: 'spin',
    minion: best.minion,
    score: best.score,
    // Своя ценность — БЕЗ бампа порядка: в цепочке лучшая покупка делается
    // отдельным шагом, и внутри прокрутки её считать нельзя (part39).
    standaloneScore: best.base,
    cost: best.net,
    requiresSlot: false,
    // На полном борде место под прокрутку освобождает продажа (D224).
    sellFirst: victim?.minion ?? null,
    reason:
      `купить ${name}, разыграть (${best.note}) и продать — ` +
      `чистая цена ${String(best.net)}${followUp}`,
  };
}

/**
 * Правило продажи.
 *
 * Осмысленно только при полном борде: миньона продают, чтобы освободить место
 * под явно лучшего. Порог не даёт советовать размен ради полутора очков —
 * продажа возвращает одно золото из трёх потраченных, и просто так она убыток.
 */
export function sellRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  if (state.board.length < rules.boardSize) return null;
  if (state.shop.length === 0) return null;

  const worst = weakestOwn(state, deps, rules);
  if (worst === null) return null;

  const best = state.shop
    .map((m) => ({ minion: m, value: minionValue(m, state, deps, rules).total }))
    .reduce((a, b) => (b.value > a.value ? b : a));
  // По карману ли лучший — по его собственной цене (скидка на него видна
  // тегом на миньоне, и трёх золотых может не понадобиться) И с золотым
  // ЭТОЙ ЖЕ продажи: она предшествует покупке, ради которой советуется.
  // Прежде правило молчало при двух золотых, хотя после продажи их три
  // (part36, ход 13: игрок так и сыграл — продал и купил).
  if (buyCostOf(best.minion, rules) > state.gold + rules.sellGold) return null;

  const gain = best.value - worst.value;
  if (gain <= rules.sellMargin) return null;

  const worstName = deps.cards.info(worst.minion.cardId)?.name ?? worst.minion.cardId;
  const bestName = deps.cards.info(best.minion.cardId)?.name ?? best.minion.cardId;

  return {
    action: 'sell',
    minion: worst.minion,
    score: gain - rules.sellMargin,
    cost: 0,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `борд полон; ${worstName} слабейший (${worst.value.toFixed(1)}), ` +
      `а ${bestName} в витрине стоит ${best.value.toFixed(1)} — разница ${gain.toFixed(1)}`,
  };
}

/**
 * Правило продажи карты, чья ценность РЕАЛИЗУЕТСЯ ПРОДАЖЕЙ.
 *
 * «When you sell this, get a random Tier 1 minion» (River Skipper),
 * «…get a Water Droplet» (Sellemental): обещанное записано в тексте, но
 * получить его можно только продав. Прежний `sellRule` продаёт лишь ради
 * МЕСТА на полном борде, и такие карты держались телом до конца партии.
 *
 * Условие продажи — золото должно открыть ЕЩЁ ОДНУ покупку: пять золотых
 * покупают одного миньона, шесть — двоих. Без этого продажа даёт монету,
 * которой некуда деться, и теряет тело. Случай part18 (ход 5): скипер 1/1
 * при пяти золотых — игрок продал его и купил два тела вместо одного тела
 * и заклинания.
 *
 * Удерживаемая ценность считается БЕЗ слагаемого экономики: оно и есть
 * то, что придёт при продаже, и держать карту ради него — не получить его
 * никогда.
 */
export function sellForGoldRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  if (state.board.length === 0 || state.shop.length === 0) return null;

  // Продажа открывает покупку только если меняет ЧИСЛО доступных покупок.
  const affordable = (gold: number): number => bodiesAffordable(state, gold, rules);
  if (affordable(state.gold + rules.sellGold) <= affordable(state.gold)) return null;

  const sellable = state.board.filter((m) => {
    const text = deps.cards.info(m.cardId)?.text ?? '';
    if (text === '' || !rules.sellValueWords.some((w) => new RegExp(w, 'i').test(text))) {
      return false;
    }
    // Копия, из которой собирается тройка, не продаётся: тройка стоит
    // больше любого обещания текста, и вторая копия — ставка на неё.
    return copiesOwned(m, state) === 0;
  });
  if (sellable.length === 0) return null;

  // Что купится на открывшееся золото: лучшее в витрине, чего мы ещё не
  // держим на борде. Цена читается с миньона — скидки видны тегом.
  //
  // Берётся ровно ДОПОЛНИТЕЛЬНАЯ покупка — та, что стоит в очереди сразу
  // за теми, которые нам по карману и без продажи. Если витрина такой
  // не предлагает (карт в ней меньше, чем покупок по карману), продавать
  // не за чем: подстановка «последней доступной» возвращала бы миньона,
  // которого сегодняшнее золото и так покупает, — то есть отдавала тело
  // за монету, которой некуда деться, вопреки собственному условию правила.
  const buys = state.shop
    .filter((m) => buyCostOf(m, rules) <= state.gold + rules.sellGold)
    .map((m) => ({ minion: m, value: minionValue(m, state, deps, rules).total }))
    .sort((a, b) => b.value - a.value);
  const unlocked = buys[affordable(state.gold)];
  if (unlocked === undefined) return null;

  const scored = sellable
    .map((minion) => {
      // Удерживаемая ценность считается ПРОТИВ ОСТАЛЬНОГО БОРДА, той же
      // функцией, что у `weakestOwn`. Прежний борд из одного кандидата
      // считал его собственным соплеменником (`tribeMates` себя не
      // исключает), обнулял связи по тексту и имени, а боевой эффект
      // «вашим мурлокам» — вместе со всем бордом: скипер на борде из пяти
      // мурлоков выходил на несколько очков дешевле, чем его же оценивают
      // все остальные правила, и продавался тем охотнее, чем лучше
      // синергия, которую он теряет.
      const value = ownBreakdown(minion, state, deps, rules);
      // Экономика этой карты — обещание продажи, а не причина держать;
      // бонус за копии и статы за розыгрыш — про приобретение, а не про
      // удержание, и шляпа вдобавок уже сидит в статах (`ownValue`).
      return {
        minion,
        retained:
          value.total - value.copies - value.economy - value.heroPowerPlay - value.heroPowerBuy,
      };
    })
    .sort((a, b) => a.retained - b.retained);
  const victim = scored[0];
  if (victim === undefined) return null;

  const gain = unlocked.value - victim.retained;
  if (gain <= 0) return null;

  const name = deps.cards.info(victim.minion.cardId)?.name ?? victim.minion.cardId;
  const buyName = deps.cards.info(unlocked.minion.cardId)?.name ?? unlocked.minion.cardId;
  return {
    action: 'sell',
    minion: victim.minion,
    score: gain,
    cost: 0,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `${name} отдаёт обещанное текстом только при продаже, а золото ` +
      `${String(state.gold)} → ${String(state.gold + rules.sellGold)} открывает ещё одну ` +
      `трату (лучшая сейчас — ${buyName}, ${unlocked.value.toFixed(1)}); держать его ` +
      `дальше — ${victim.retained.toFixed(1)} очков телом`,
  };
}

/**
 * Ради чего обновлять витрину, когда найденное НЕ НА ЧТО купить.
 *
 * Обновление, после которого золота на покупку нет, годится только под
 * заморозку: найденное подождёт следующего хода. Так и говорит правило
 * «в лейте обновление — поиск карты под заморозку» (`paidRerollIsUseful`),
 * но КОГО искать, оно не спрашивало, а в причине писало «покупать нечего»
 * — при золоте 0 и полном борде (part27, ход 19, скриншот игрока: «даже
 * если я обновлю, то не смогу купить существ без продажи»). Игрок читал
 * совет как обещание покупки, которой быть не могло.
 *
 * Цель берётся из тех же веток, что у самой заморозки, и только из тех,
 * ради которых стоит крутить: ТРЕТЬЯ копия под тройку (пара на борде или
 * в руке — тройка собирается сразу и места не просит) и соплеменник
 * на неполном борде. Вторую копию ради «ставки на тройку» целью
 * не считаем: под неё заморозка сработает, если карта выпадет сама,
 * но крутить ради неё — искать ставку, а не карту. Нет цели — обновление
 * молчит: бесплатное или нет, оно ничего не даст.
 */
/**
 * Цель обновления двумя частями: ЧТО ищем и ПОЧЕМУ.
 *
 * Разделено ради оверлея. Правило part27 требует, чтобы цель была названа,
 * и она называлась — но только в `reason`, а на экран идёт короткая строка
 * действия (`recommendationLine`), и у обновления в ней нет ни миньона,
 * ни заклинания: игрок видел голое «ОБНОВИТЬ» и читал его как «покрути
 * просто так» (part37, ход 21 — «предлагает обновить таверну, хотя я всё
 * равно ничего не смогу купить»). Правило было право, а на экране от него
 * не оставалось ничего.
 *
 * `what` идёт в строку действия, `why` остаётся в причине: короткая строка
 * обязана отвечать «зачем крутить», а не пересказывать всю арифметику.
 */
interface FreezeGoal {
  readonly what: string;
  readonly why: string;
}

function rerollFreezeGoal(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): FreezeGoal | null {
  // Пары считаются так же, как `copiesOwned`: незолотые копии на борде
  // и в руке, золотая с обычными в тройку не складывается.
  // Пара годится в цель, только если витрина МОЖЕТ предложить третью копию:
  // карта из пула, миньон, тира не выше таверны. Без этого целью
  // назывались пара Goldrinn шестого тира на пятом тире (part8, ход 21)
  // и пара капель Water Droplet — токенов вне пула (part17, ход 23):
  // обновление обещало то, чего не найдёт никогда (находка состязательной
  // проверки 26.08). Из нескольких пар берётся старшая по тиру — тройка
  // из неё дороже, а порядок сущностей на борде тут ни при чём.
  const own = [...state.board, ...state.hand].filter((m) => !m.golden);
  const counts = new Map<string, number>();
  for (const m of own) counts.set(m.cardId, (counts.get(m.cardId) ?? 0) + 1);
  const offerable = (cardId: string): CardInfo | null => {
    const info = deps.cards.info(cardId);
    if (info === null || !info.isBaconPool || info.type !== 'MINION') return null;
    if (info.techLevel === null || info.techLevel > state.techLevel) return null;
    return info;
  };
  // «Пара» — это столько копий, что следующая собирает тройку, а сколько
  // их нужно, решает сила героя: у Double Time тройку собирает ВТОРАЯ копия,
  // и целью обновления там становится одиночка, а не пара (part7).
  const needed = copiesForTriple(state, deps.cards, rules);
  const pair = own
    .filter((m) => (counts.get(m.cardId) ?? 0) >= needed - 1)
    .map((m) => offerable(m.cardId))
    .filter((info): info is CardInfo => info !== null)
    .sort((a, b) => (b.techLevel ?? 0) - (a.techLevel ?? 0))[0];
  if (pair !== undefined) {
    return { what: `${nthCopyWord(needed, 'acc')} копию ${pair.name}`, why: 'соберётся тройка' };
  }

  if (state.board.length >= rules.boardSize) return null;
  // В ход подъёма заморозка ради племени молчит (свежая витрина будет
  // нового тира — part11) — значит, и искать соплеменника незачем: цель
  // обязана быть той, которую заморозка возьмёт.
  if (state.techLevelUpTurn === state.turn) return null;

  // Собираемое племя — как у заморозки: без амальгам, они свои любому
  // племени и потому не признак того, что племя собирается. Заморозка
  // берёт соплеменника не ниже тира таверны — в пуле этого тира племя
  // обязано быть, иначе цель шире правила.
  const byRace = new Map<string, number>();
  for (const m of state.board) {
    for (const race of racesOf(m, deps.cards)) {
      if (race === RACE_ALL) continue;
      byRace.set(race, (byRace.get(race) ?? 0) + 1);
    }
  }
  const ownTierPool = deps.cards.poolOfTier(state.techLevel);
  const tribe = [...byRace]
    .filter(([race, n]) => n >= rules.freeze.minTribeMates && ownTierPool.some((c) => c.races.includes(race)))
    .sort((a, b) => b[1] - a[1])[0];
  return tribe === undefined
    ? null
    : {
        what: `соплеменника ${tribe[0]} тира ${String(state.techLevel)}`,
        why: `своих ${String(tribe[1])}`,
      };
}

/**
 * Есть ли у золота применение, кроме обновления витрины.
 *
 * Перечислены все действия, которые тратят ЗОЛОТО: покупка миньона
 * (по живой цене со скидкой), заклинание витрины (кроме цены в здоровье —
 * она золота не трогает), подъём таверны, тёмный дар, платная сила героя.
 * Розыгрыши из руки и заморозка золота не тратят и в список не входят.
 */
function goldHasOtherUse(state: GameState, rules: TavernRules): boolean {
  const gold = state.gold;
  if (state.shop.some((m) => buyCostOf(m, rules) <= gold)) return true;
  if (state.shopSpells.some((s) => !s.unplayable && !s.costsHealth && s.cost <= gold)) {
    return true;
  }
  const upgrade = state.tavernUpgradeCost;
  if (upgrade !== null && upgrade <= gold) return true;
  const dark = state.darkGiftCost;
  if (dark !== null && dark <= gold) return true;
  const hero = state.hero;
  if (
    hero !== null &&
    hero.heroPowerCost !== null &&
    hero.heroPowerCost > 0 &&
    hero.heroPowerCost <= gold &&
    heroPowerReady(hero)
  ) {
    return true;
  }
  return false;
}

/**
 * Обновление как СТОК сгорающего золота (part30, ход 19).
 *
 * Золото 1/10, борд полон, в витрине ничего дешевле трёх: золотой сгорит
 * концом хода, а совет говорил «НИЧЕГО». Игрок: «я могу на крайний случай
 * потратить золото на обновление — это позволит активировать эффекты моих
 * карт, а это золото я потеряю в любом случае». На его борде трату считали
 * ДВОЕ: Dual-Wield Corsair («Whenever you spend 5 Gold…») и Enterprising
 * Escapee («After you spend {2} Gold…») — и последний золотой он потратил
 * на обновление сам.
 *
 * Границы. Сгорание — не мнение, а перебор всех трат (`goldHasOtherUse`);
 * без триггера трат или обновления на борде совет по-прежнему молчит —
 * это граница part27 («цель обязана быть названа»), и обновление ради
 * пустого взгляда ею и остаётся. Бесплатное обновление стоком не является:
 * оно не тратит золота, и сгорание его не касается. Замороженная витрина
 * и живой совет заморозки выключают ветку — обновление уничтожило бы то,
 * что решено держать.
 */
function burningGoldSink(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
  cost: number,
): Recommendation | null {
  if (cost <= 0 || state.gold < cost) return null;
  if (goldHasOtherUse(state, rules)) return null;
  if (state.shop.some((m) => m.frozen)) return null;

  const feeders = state.board.filter((m) => {
    const text = deps.cards.info(m.cardId)?.text ?? '';
    return rules.goldSinkTriggerWords.some((w) => new RegExp(w, 'i').test(text));
  });
  if (feeders.length === 0) return null;
  if (freezeRule(state, deps, rules) !== null) return null;

  const names = feeders
    .map((m) => deps.cards.info(m.cardId)?.name ?? m.cardId)
    .filter((name, i, all) => all.indexOf(name) === i);
  return {
    action: 'reroll',
    minion: null,
    score: rules.goldSinkRerollValue,
    cost,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `золото ${String(state.gold)} сгорит — тратить больше не на что, ` +
      `а обновление за ${String(cost)} кормит триггеры трат: ${names.join(', ')}`,
  };
}

/**
 * Правило обновления витрины.
 *
 * Советуется, когда покупать нечего: лучший кандидат ниже порога. Отдельно
 * учтено, что реролл нельзя советовать, если золото копится на подъём —
 * иначе совет ворует ход у более важного действия.
 */
export function rerollRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const cost = rerollCostOf(state, rules);
  if (state.gold < cost) return null;

  // Сгорающее золото — сток в триггеры борда: проверяется ДО всех прочих
  // условий, потому что они судят обновление как ТРАТУ («полезно ли платить»),
  // а сгорающему золоту цена — ноль (part30, ход 19).
  const sink = burningGoldSink(state, deps, rules, cost);
  if (sink !== null) return sink;
  // Обновление ради взгляда — потеря золота: найденное должно быть на что
  // купить (part18, ход 7).
  if (!paidRerollIsUseful(state, rules)) return null;

  // Найденное не на что купить даже после обновления — крутить можно
  // только под заморозку, и цель обязана быть названа (part27, ход 19).
  // «Не на что» — по самому дешёвому товару таверны, а не по миньону:
  // на два золота покупается заклинание витрины (part12, ход 19).
  const cannotBuy = state.gold - cost < rules.cheapestShopPrice;
  const freezeGoal = cannotBuy ? rerollFreezeGoal(state, deps, rules) : null;
  if (cannotBuy && freezeGoal === null) return null;

  const best =
    state.shop.length === 0
      ? 0
      : Math.max(...state.shop.map((m) => minionValue(m, state, deps, rules).total));

  // Порог относителен тиру: плоский порог к пятому тиру не срабатывал
  // никогда — любой миньон там дороже шести очков одним тиром.
  const threshold = rules.value.perTechLevel * state.techLevel + rules.rerollMarginOverTier;
  if (best >= threshold) return null;

  // Копим на подъём: если после реролла на него уже не хватит, а сейчас
  // хватает — реролл дороже, чем кажется.
  const upgrade = state.tavernUpgradeCost;
  if (upgrade !== null && state.gold >= upgrade && state.gold - cost < upgrade) {
    return null;
  }

  // До лейта реролл не соревнуется с подъёмом. Мусорная витрина в ранней
  // партии — довод подняться, а не крутить (JeefHS: роллы до лейта
  // запрещены, docs/jeefhs.md; тот же вывод игрока в part11 — «ценны
  // рероллы позже»). Пока подъём доступен и по карману, ход — подъём;
  // обновление советуется уже сдачей после него. Условия зеркалят входные
  // проверки levelUpRule: недоступный подъём реролл не блокирует.
  // Бесплатное обновление с подъёмом не соревнуется вовсе: оно не отнимает
  // золота. Запрет раннего реролла — про трату, а не про сам факт обновления.
  if (
    cost > 0 &&
    state.techLevel < rules.lateRerollTier &&
    upgrade !== null &&
    state.gold >= upgrade &&
    (state.maxTechLevel === null || state.techLevel < state.maxTechLevel) &&
    effectiveHp(state) >= rules.levellingHpFloor
  ) {
    return null;
  }

  const price = cost === 0 ? 'обновление бесплатно' : `обновление стоит ${String(cost)}`;
  return {
    action: 'reroll',
    minion: null,
    score: threshold - best,
    cost,
    requiresSlot: false,
    sellFirst: null,
    searchGoal: freezeGoal?.what ?? null,
    reason:
      freezeGoal !== null
        ? `золота ${String(state.gold)} — купить нечего и после обновления, но ${price}: ` +
          `искать под заморозку ${freezeGoal.what} — ${freezeGoal.why}`
        : `лучшее в витрине стоит ${best.toFixed(1)} при пороге ${threshold.toFixed(0)} для тира ` +
          `${String(state.techLevel)} — покупать нечего, ${price}`,
  };
}

/**
 * Прошёл бы кандидат ту же планку, что при покупке на ПОЛНОМ борде.
 *
 * Планка одна с `buyRules`: тело в полный борд оправдано только явным
 * превосходством над жертвой, и считать его надо против борда БЕЗ жертвы.
 * Копия (тройка или вторая в руку) и магнит слота не требуют вовсе.
 *
 * Заморозке это нужно ровно затем же, зачем покупке: держать витрину ради
 * карты, которую мы сами не купим, — потеря бесплатного обновления. Порог
 * ценности от тира этого не ловит, потому что к концу партии статы витрины
 * растут вместе с бордом: part17, ход 25 — Crackling Cyclone 38/43
 * (56 очков против порога 14) при полном борде из миньонов по 100–800
 * статов, слабейший из которых стоит 150 очков.
 */
function worthFullBoardSlot(
  minion: Minion,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): boolean {
  if (state.board.length < rules.boardSize) return true;

  if (minionValue(minion, state, deps, rules).copiesOwned >= 1) return true;
  if (
    isMagnetic(minion, deps.cards) &&
    magnetizeTarget(minion, state.board, deps.cards, poisonAmongSeen(state)) !== null
  ) {
    return true;
  }

  const victim = weakestOwn(state, deps, rules);
  if (victim === null) return true;

  const without = state.board.filter((x) => x.entityId !== victim.minion.entityId);
  const replacing = minionValue(minion, { ...state, board: without }, deps, rules);
  return replacing.total > victim.value + rules.sellMargin;
}

/**
 * Правило заморозки.
 *
 * Незамороженная витрина обновляется в начале хода БЕСПЛАТНО. Значит,
 * заморозка не «сохраняет хорошее», а отказывается от нового даром, и голые
 * статы её не окупают: свежая витрина в среднем не хуже нынешней. Окупает
 * только то, чего свежая витрина не даст, — копия под тройку, миньон
 * племени, которое уже собирается на борде, или заклинание витрины, дающее
 * миньона. И только когда купить это прямо сейчас не хватает золота:
 * что по карману, надо просто покупать.
 */
export function freezeRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  if (state.shop.length === 0) return null;
  if (state.shop.every((m) => m.frozen)) return null;

  const affordable = bodiesAffordable(state, state.gold, rules);

  // Порог относителен тиру таверны, как у реролла: плоский порог к четвёртому
  // тиру пробивала любая дешёвка со статами (part10, Snow Baller).
  const threshold = rules.value.perTechLevel * state.techLevel + rules.freeze.marginOverTier;

  // «Собираемое племя» считается строго: без амальгам и без одноимённых.
  // Амальгама своя для любого племени и потому не признак того, что племя
  // собирается; одноимённая карта — это копия, у копий своя ветка. На part10
  // (ход 3) золотая Aureate Laureate морозилась ради «своих по племени 2»,
  // где свои — она же на борде и амальгама. Одноимённость сверяется по
  // базовому cardId: золотая копия носит суффикс `_G` и без нормализации
  // считалась «другой картой» (ход 13, дракончик при золотом дракончике).
  const baseCardId = (id: string): string => (id.endsWith('_G') ? id.slice(0, -2) : id);
  const strictMates = (candidate: Minion): number => {
    const mine = racesOf(candidate, deps.cards).filter((r) => r !== RACE_ALL);
    return state.board.filter((m) => {
      if (baseCardId(m.cardId) === baseCardId(candidate.cardId)) return false;
      const theirs = racesOf(m, deps.cards).filter((r) => r !== RACE_ALL);
      if (theirs.length === 0) return false;
      if (racesOf(candidate, deps.cards).includes(RACE_ALL)) return true;
      return theirs.some((r) => mine.includes(r));
    }).length;
  };

  // В ход подъёма таверны заморозка ради племени молчит: свежая витрина
  // будет уже НОВОГО тира, и держать старую ради соплеменников — потеря
  // (part11, ход 9: заморозка наги сразу после подъёма на третий тир).
  // Копия под тройку — другое дело: копию не даст и новая витрина.
  const justLevelled = state.techLevelUpTurn === state.turn;

  const valued = state.shop
    .map((m) => {
      const value = minionValue(m, state, deps, rules);
      return {
        minion: m,
        value: value.total,
        completes: value.completesTriple,
        bet: value.tripleBet,
        copies: value.copiesOwned,
        tier: m.techLevel ?? deps.cards.info(m.cardId)?.techLevel ?? 1,
        mates: justLevelled ? 0 : strictMates(m),
      };
    })
    .sort((a, b) => b.value - a.value);

  // Ценное, до чего в этом ходу руки не дойдут: денег хватает не на всех.
  //
  // Вторая копия (copies === 1) — это ставка на будущую тройку, а не тройка:
  // третью копию ещё предстоит встретить. Такая ставка оправдана только
  // картой не ниже тира таверны — пара дешёвки отнимает бесплатное
  // обновление ради того, что свежая витрина предлагает и так (part15,
  // ход 5: заморозка Buzzing Vermin 1/1 первого тира при таверне 2 — на что
  // игрок и указал). Третья копия (copies >= 2) собирает тройку немедленно
  // и от тира не зависит.
  //
  // Тот же порог тира — и у ветки ПЛЕМЕНИ, и это part22 (ход 5): снова
  // Buzzing Vermin 1/1 первого тира, снова при таверне 2, только на этот
  // раз его держали не как пару, а как «своего по племени» — на борде два
  // зверя. Довод тот же самый: витрина второго тира предложит зверя
  // не хуже, и отдавать за карту НИЖЕ тира бесплатное обновление незачем.
  // Племя тем и отличается от копии, что заменимо: конкретную третью копию
  // ждут, а соплеменника — нет.
  const keepers = valued
    .slice(affordable)
    .filter(
      (v) =>
        v.value >= threshold &&
        (v.completes ||
          (v.bet && v.tier >= state.techLevel) ||
          (v.mates >= rules.freeze.minTribeMates && v.tier >= state.techLevel)) &&
        // Карта, которую мы сами не купим, витрины не стоит: на полном борде
        // она обязана перебивать жертву так же, как при покупке (part17,
        // ход 25 — заморозка Crackling Cyclone 38/43 при борде из сотен).
        worthFullBoardSlot(v.minion, state, deps, rules),
    );
  const best = keepers[0];

  // Заклинание витрины, дающее миньона, — та же «покупка, до которой в этом
  // ходу руки не дошли»: за два золота оно даёт тело, и свежая витрина
  // такого не обещает. Случай part17, ход 1: при нулевом золоте в витрине
  // лежал Enchanted Lasso («Steal a random minion from the Tavern»), и связка
  // «заморозить сейчас — на пять золота купить одного и украсть второго»
  // даёт два тела там, где две покупки стоят шесть. Игрок сыграл её сам;
  // советник заклинания не видел вовсе.
  //
  // Полный борд эту ветку выключает: телу неоткуда взяться месту, а какой
  // миньон придёт — заранее неизвестно, и сравнить его с жертвой нечем.
  //
  // А вот подъём таверны её НЕ выключает, и это правка part19 (ход 3). Запрет
  // на заморозку в ход подъёма — про миньонов: свежая витрина будет нового
  // тира, и держать старых соплеменников ради племени значит менять тир
  // на племя. Заклинания в свежей витрине не будет ВООБЩЕ — ни нового тира,
  // ни старого, — и терять его подъём не повод.
  //
  // Оговорка 17.08: сам совет, ради которого правка part19 делалась, теперь
  // на втором тире не появляется — но по ЦЕНЕ, а не по подъёму (см. планку
  // ниже). Ветка в ход подъёма по-прежнему не отключается.
  //
  // Планка складывается из двух слагаемых, и оба — ценности КАРТЫ, а не
  // разности с чем-то другим:
  //
  //  1. заклинание тратит золото ТОГО ЖЕ хода, что и покупка, поэтому обязано
  //     перебить обычную покупку — «свежую карту своего тира». Разница в цене
  //     у него уже учтена: `givesMinionValue` переводит её в очки курсом
  //     `goldPointValue`, в обе стороны;
  //  2. и сверх того — окупить саму заморозку: витрина следующего хода будет
  //     старой, а не свежей.
  //
  // Прежде первого слагаемого не было вовсе, и заклинание сравнивалось
  // с одной лишь разностью. Числа при этом были РАЗНОЙ НАЧИНКИ: «свежая
  // карта» бралась голым числом от тира (2×тир+4, без всякой связи с бордом),
  // а доживающая — полной ценностью НА НАШЕМ БОРДЕ, со связями по племени
  // и копиям. На собранном борде вторая обгоняет первую, разность падает
  // в ноль, и витрину начинает держать ЛЮБОЕ заклинание, дающее миньона:
  // на part23 (ход 11, конец) так морозил витрину ЧЕТВЁРТОГО тира Recruit
  // a Trainee («Get a random Tier 1 minion»), на что игрок и указал —
  // «это работает для ранней игры». Тот же класс тихой ошибки, что склеенный
  // золотой текст (part17) и сложенные ветви «Choose One» (part19).
  //
  // Теперь обе стороны считаются одной функцией на одном борде: свежая карта
  // — ожидание по пулам ТИРОВ ВИТРИНЫ, от первого до своего (`shopTiers`),
  // доживающая — ожидание по тому, что останется в витрине после сегодняшних
  // покупок (`slice(affordable)`: что по карману сегодня, того завтра
  // в витрине уже не будет).
  //
  // «От первого до своего» — не мелочь: витрина второго тира на part24
  // (ход 3) состояла целиком из карт ПЕРВОГО тира, и оценка свежей карты
  // одним лишь своим тиром завышала планку тем сильнее, чем выше таверна.
  // Из-за этого на втором тире умолкала заморозка, которую игрок только что
  // сделал по совету на первом, — на что он и указал.
  //
  // Оговорка честная: покупают ЛУЧШУЮ карту витрины, а не среднюю, — то есть
  // настоящая покупка сильнее нашей оценки. Считать порядковую статистику
  // мы не станем (это был бы выдуманный коэффициент), и планка остаётся
  // скорее мягкой, чем строгой.
  //
  // Второе слагаемое считается по той же оговорке, и это правка part27
  // (ход 1). Прежде «доживающая» бралась СРЕДНЕЙ по остатку витрины —
  // а игрок покупает из замороженной витрины лучшее, как и из свежей,
  // и дешёвка рядом с лучшей картой ему ничего не стоит. Средняя же от неё
  // проседала: при Risen Rider 6.0 и Harmless Bonehead 3.0 в остатке цена
  // заморозки выходила 0.98 (свежая 5.48 против средней 4.5), и лассо
  // (6.0) планку 6.45 не брало, — а в гипотетическом состоянии ПЛАНА, где
  // куплен был другой из двух равных миньонов и Bonehead стал соплеменником
  // на 4.5, та же планка выходила 5.70, и план обещал «КУПИТЬ → ЗАМОРОЗИТЬ
  // Enchanted Lasso». Игрок сделал первый шаг, и второй исчез. Число,
  // которое решает совет, не может зависеть от того, какой из двух равных
  // купили. Теперь цена заморозки — недобор ЛУЧШИХ доживающих до свежей,
  // по одной на каждую покупку того хода.
  //
  // И не на каждую: замороженную витрину игра ДОЗАПОЛНЯЕТ свежими картами
  // до размера витрины своего тира (`shopSizeByTier`). Проверено по всем
  // девятнадцати заморозкам шести фикстур (part17, part19, part22, part24,
  // part25, part27): замороженные карты возвращаются новыми сущностями,
  // а пустые слоты приходят свежими — part27 ход 1→3: два замороженных
  // и купленный слот, витрина из трёх, третьим пришёл Molten Rock; part24
  // ход 13→15: три замороженных на четвёртом тире, витрина из пяти, два
  // свежих. Подъём таверны в ход заморозки добавляет слот сам (3 → 4 на
  // втором тире: part19, part24, part17, part25 — ход 3→5). Первые
  // `refills` покупок следующего хода игрок делает из этих свежих карт
  // по цене свежей карты, и недобор платят только покупки сверх них.
  // Планка от этого мягче, а не строже, и это записано: свежая сторона
  // по-прежнему среднее, а не лучшее-из-N (состязательная проверка 26.08
  // назвала асимметрию прямо; принято сознательно — ранних заморозок
  // игрок просил четыре партии подряд, а ручка, если их станет много, —
  // свежая сторона, порядковой статистикой по пулу).

  // Золото хода, ради которого держат витрину, — правило игры, записанное
  // у `tavernTurnOf`: `min(2 + N, 10)`. Сколько ПОКУПОК из витрины игрок
  // сделает сверх самого предложения — зависит от его цены: на четырёх
  // золотых после лассо за 2 покупок ноль, и штрафовать доживающих
  // за покупки, которых не будет, нельзя (состязательная проверка 26.08).
  //
  // К СЛЕДУЮЩЕМУ ходу сверх правила придёт обещанное золото («Gain N Gold
  // next turn») — живой тег игры, `extraGoldNextTurn` (долг part46).
  const nextTavernTurn = tavernTurnOf(state.turn) + 1;
  const tavernGold = (t: number): number =>
    Math.min(2 + t, 10) + (t === nextTavernTurn ? state.extraGoldNextTurn : 0);
  const nextGold = tavernGold(nextTavernTurn);
  const purchasesAfter = (spent: number): number =>
    Math.max(0, Math.floor((nextGold - spent) / rules.minionCost));

  // Замороженная витрина следующего хода — доживающие плюс `refills` свежих
  // слотов; игрок забирает из неё `purchases` лучших. Планка считает свежие
  // слоты за свежую карту, а вот ПУЛ ЛАССО (что останется на кражу) берётся
  // из одних доживающих, без свежих слотов, — и это намеренная
  // несогласованность в строгую сторону: свежий слот в пуле кражи поднимал
  // лассо над продажным генератором на part22 (ход 7) и возвращал в план
  // ровно тот совет, про который игрок сказал «практического эффекта
  // не вижу» (состязательная проверка 26.08).
  const survivors = valued.slice(affordable);
  const freshValueOf = (): number =>
    averagePoolValue(shopTiers(state.techLevel), state, deps, rules) ?? threshold;
  // Свежих слотов в замороженной витрине: до размера витрины своего тира.
  // Тир уже новый, если таверну подняли в этот ход, — и в гипотетическом
  // состоянии плана после подъёма тоже.
  const refills = Math.max(
    0,
    (rules.shopSizeByTier[state.techLevel] ?? survivors.length) - survivors.length,
  );
  // Считается ЛЕНИВО и кэшируется по числу покупок: ожидание по пулу тира —
  // это `minionValue` на сотне карт, а заклинание, дающее миньона, в витрине
  // лежит редко.
  const thresholdByPurchases = new Map<number, number>();
  const spellThresholdOf = (purchases: number): number => {
    const cached = thresholdByPurchases.get(purchases);
    if (cached !== undefined) return cached;
    const freshValue = freshValueOf();
    const keptShortfall = Array.from({ length: Math.max(0, purchases - refills) }, (_, i) => {
      const kept = survivors[i];
      return kept === undefined ? 0 : Math.max(0, freshValue - kept.value);
    }).reduce((sum, x) => sum + x, 0);
    const bar = freshValue + keptShortfall;
    thresholdByPurchases.set(purchases, bar);
    return bar;
  };
  // Первый ход таверны, на котором хватит и на предложение, и на покупку.
  const turnAffordingBoth = (spent: number): number => {
    const need = spent + rules.minionCost;
    for (let t = nextTavernTurn; t < 12; t++) {
      if (tavernGold(t) >= need) return t;
    }
    return nextTavernTurn;
  };

  /**
   * Даст ли предложение дешевле покупки ЛИШНЕЕ ТЕЛО — то самое, которое
   * ветка обещает словами «два тела вместо одного».
   *
   * Ветка держит витрину ради того, что предложение стоит меньше трёх
   * и потому занимает золото, которое иначе сгорит. Но сгорает оно
   * не всегда: на пяти золотых обычная покупка одна и две монеты пропадают
   * (лассо за 2 плюс покупка за 3 — уже два тела), а на ШЕСТИ покупок
   * ровно две, и лассо за 2 плюс покупка за 3 дают те же два тела,
   * только одно из них случайное. Считать это выгодой значит платить
   * свежей витриной за худшее из двух одинаковых.
   *
   * Ровно на это указал игрок (part29, ход 5 — «5 золота скорее всего
   * последнее выгодное значение для его заморозки, дальше я уже смогу
   * покупать два существа за 6 золота и существо + улучшение таверны
   * за 7»), и тем же счётом закрывается ход 7 той же партии: заморозка
   * Patient Scout 1/1 обещала цепочку за чистых 2 при семи золотых, где
   * покупок и без неё две.
   *
   * Арифметика, а не порог по тиру: тел без предложения
   * `⌊золото / 3⌋`, с предложением `1 + ⌊(золото − цена) / 3⌋`, и совет
   * живёт, только если второе больше первого. На восьми золотых, например,
   * оно снова больше (2 → 3), и ветка честно возвращается.
   *
   * Золото берётся ТОГО хода, который называет сам совет
   * (`turnAffordingBoth`): на первом ходу таверны заморозка обещает
   * не следующий ход, а третий — там впервые хватит и на предложение,
   * и на покупку (part17, ход 1).
   */
  const addsExtraBody = (spent: number): boolean => {
    const gold = tavernGold(turnAffordingBoth(spent));
    const without = Math.floor(gold / rules.minionCost);
    const withOffer = 1 + Math.floor((gold - spent) / rules.minionCost);
    return withOffer > without;
  };

  const spellKeeper =
    state.board.length >= rules.boardSize
      ? undefined
      : state.shopSpells
          .flatMap((spell) => {
            if (spell.unplayable || spell.cost <= state.gold) return [];
            // Цена в ЗДОРОВЬЕ этой веткой не судится: вся ветка про то,
            // что предложение занимает золото, которое иначе сгорит, —
            // а здоровьем золото не тратится вовсе. Такое заклинание
            // покупается сразу, если по карману здоровьем (part29).
            if (spell.costsHealth) return [];
            // Витрину держат ради заклинания только тогда, когда оно ДЕШЕВЛЕ
            // покупки, — в этом весь смысл ветки (part17, ход 1: тело за два
            // золота там, где покупка стоит три; заморозка ставит на ход,
            // где хватит и на покупку, и на него). Заклинание ДОРОЖЕ покупки
            // такой ставкой не является: в тот же ход то же тело просто
            // покупается, и дешевле. Planar Telescope за 4 при цене миньона 3
            // держал витрину — и отнимал бесплатное обновление ради наценки
            // (part23, ход 15: «заклинание и таверна слабые, а обновления
            // из-за этого не будет»).
            //
            // Дешевле — СТРОГО: заклинание по цене покупки («Discover
            // a Tier 1 minion» за 3, A New Sprout) на первом тире стоит
            // ровно свежую карту, проходило планку с запасом 0.00 и вставало
            // верхней строкой списка (part12, part18 — ход 1 после покупки;
            // состязательная проверка 26.08). Сравнение с планкой — тоже
            // строгое: нулевой запас советом не становится.
            if (spell.cost >= rules.minionCost) return [];
            const spellText = deps.cards.info(spell.cardId)?.text ?? '';
            const effect = spellEffect(spell.cardId, spell.scriptData, deps.cards, rules);
            if (effect === null || !effect.givesMinion) return [];

            // Заморозка судится не сегодняшним золотом, а тем ходом, ради
            // которого держат витрину: там хватит и на покупку, и на неё.
            //
            // Заклинание, крадущее ИЗ ВИТРИНЫ, получает то, что в ней
            // ОСТАНЕТСЯ после покупок того хода: лучшие карты мы к тому
            // моменту купим сами. Заклинание НАЗВАННОГО ТИРА не берёт
            // из витрины вовсе — там свой пул, и витрина ему не мерка.
            const stealsFromShop = rules.givesMinionFromShopWords.some((w) =>
              new RegExp(w, 'i').test(spellText),
            );

            // Ветка обещает ЛИШНЕЕ тело, и обещание проверяется счётом.
            if (!addsExtraBody(spell.cost)) return [];

            const purchases = purchasesAfter(spell.cost);
            const tiered = namedTierPool(spellText, state, deps, rules);
            const pool =
              tiered ??
              (stealsFromShop ? valued.slice(purchases).map((v) => v.minion) : state.shop);
            const { score } = givesMinionValue(state, deps, rules, spell.cost, false, pool);
            const bar = spellThresholdOf(purchases);
            return score > bar
              ? [{ spell, score: score - bar, bothOn: turnAffordingBoth(spell.cost) }]
              : [];
          })
          .sort((a, b) => b.score - a.score)[0];

  // Миньон, чьё обещание отдаёт ПРОДАЖА, — та же «покупка дешевле трёх»,
  // только не заклинанием, а цепочкой: купить за 3, разыграть, продать за 1
  // — тело за чистых 2, и на остаток покупается ещё одно.
  //
  // Случай part25 (ход 3, скриншот игрока): при нулевом золоте в витрине
  // стоял River Skipper («When you sell this, get a random Tier 1 minion»),
  // и на следующем ходу пять золотых давали ДВА гарантированных тела вместо
  // одного и двух сгоревших монет. Советник молчал: у заморозки не было
  // ветки для такой карты, а витрину игрок заморозил сам — и на ходу 5
  // сыграл ровно эту цепочку.
  //
  // Планка у ветки та же, что у заклинания, и это не совпадение, а один
  // и тот же вопрос: стоит ли витрина того, чтобы держать её ради
  // предложения дешевле покупки. Полный борд её так же выключает —
  // прокручивать некуда.
  const spinKeeper =
    state.board.length >= rules.boardSize
      ? undefined
      : valued
          .flatMap((v) => {
            // Что по карману сегодня — то сегодня и прокручивается
            // (`spinRule`), витрины это не стоит.
            if (buyCostOf(v.minion, rules) <= state.gold) return [];
            if (v.copies > 0) return [];
            const spun = sellSpinValue(v.minion, state, deps, rules, false);
            if (spun === null) return [];
            // То же обещание и та же проверка, что у заклинания: цепочка
            // стоит витрины, только если её чистая цена даёт лишнее тело.
            if (!addsExtraBody(spun.net)) return [];
            // Покупок сверх самой цепочки: её чистая цена уже вычтена.
            const bar = spellThresholdOf(purchasesAfter(spun.net));
            return spun.score > bar ? [{ minion: v.minion, spun, score: spun.score - bar }] : [];
          })
          .sort((a, b) => b.score - a.score)[0];

  // Между миньоном и предложением дешевле покупки выбирает превышение над
  // своим порогом: пороги у них разные, и сравнивать сырые очки значило бы
  // сравнивать ответы на разные вопросы. Заклинание и прокрутка меряются
  // одной планкой и потому сравниваются между собой напрямую; при равенстве
  // остаётся заклинание.
  const freezeForSpell = (keeper: NonNullable<typeof spellKeeper>): Recommendation => {
    const spellName = deps.cards.info(keeper.spell.cardId)?.name ?? keeper.spell.cardId;
    // «Два тела в один ход» обещаются только тем ходом, где золота хватит
    // на оба: на первом ходу таверны это третий (пять золота), а не второй.
    const when =
      keeper.bothOn <= nextTavernTurn
        ? 'со следующего хода это'
        : `с ${String(keeper.bothOn)}-го хода таверны (заморозку продлевать) это`;
    return {
      action: 'freeze',
      minion: null,
      spellCardId: keeper.spell.cardId,
      score: keeper.score,
      cost: 0,
      requiresSlot: false,
      sellFirst: null,
      reason:
        `${spellName} за ${String(keeper.spell.cost)} даёт миньона, а золота ` +
        `${String(state.gold)} на него не хватает; ${when} ` +
        `покупка и заклинание в один ход — два тела вместо одного`,
    };
  };

  const freezeForSpin = (keeper: NonNullable<typeof spinKeeper>): Recommendation => {
    const name = deps.cards.info(keeper.minion.cardId)?.name ?? keeper.minion.cardId;
    const what =
      keeper.spun.tier === null ? 'миньона' : `миньона тира ${String(keeper.spun.tier)}`;
    return {
      action: 'freeze',
      minion: keeper.minion,
      score: keeper.score,
      cost: 0,
      requiresSlot: false,
      sellFirst: null,
      reason:
        `${name} отдаёт обещанное продажей, а золота ${String(state.gold)} ` +
        `на покупку не хватает; со следующего хода это цепочка ` +
        `«купить-разыграть-продать» за чистых ${String(keeper.spun.net)} — ` +
        `${what} и золото на ещё одну покупку`,
    };
  };

  const cheap: Recommendation | null =
    spellKeeper !== undefined && (spinKeeper === undefined || spellKeeper.score >= spinKeeper.score)
      ? freezeForSpell(spellKeeper)
      : spinKeeper !== undefined
        ? freezeForSpin(spinKeeper)
        : null;

  if (cheap !== null && (best === undefined || cheap.score > best.value - threshold)) {
    return cheap;
  }

  if (best === undefined) return null;

  const name = deps.cards.info(best.minion.cardId)?.name ?? best.minion.cardId;
  const why =
    best.completes
      ? `${nthCopyWord(copiesForTriple(state, deps.cards, rules), 'nom')} копия под тройку`
      : best.bet
        ? 'вторая копия'
        : `своих по племени ${String(best.mates)}`;

  return {
    action: 'freeze',
    minion: best.minion,
    score: best.value - threshold,
    cost: 0,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `${name} — ${why}, а золота ${String(state.gold)} хватает лишь на ` +
      `${String(affordable)} покупок; свежая витрина такого не обещает`,
  };
}

/**
 * Можно ли нажать силу героя ПРЯМО СЕЙЧАС — все запреты одним местом.
 *
 * Запретов пять, и каждый читается из лога: сила уже нажата в этом ходу
 * (блок PLAY на её сущности), сила временно неиграбельна
 * (`LITERALLY_UNPLAYABLE`), сила ещё не открыта (`LOCK_VISUAL` — замок
 * «Unlocks at Tier N», part37), сила исчерпана на этот ход (`EXHAUSTED`)
 * и сила ЗАПРЕЩЕНА игрой (`HERO_POWER_DISABLED`, part48).
 *
 * Одной функцией, а не условиями в пяти правилах: первые два запрета
 * и были размножены по пяти местам, и добавление третьего в четыре из пяти
 * прошло бы молча — ровно тот способ, которым разъезжаются списки
 * (`CURRENT_BUILD_PARTS`, docs/journal.md). Прочие условия у правил свои:
 * `heroPowerHasActivate` (пассивную силу не «нажимают»), цена, место
 * на борде.
 *
 * **`EXHAUSTED` СИЛЬНЕЕ «нажата в этом ходу», и это правка part45.**
 * Сила Инге жмётся ДВАЖДЫ за ход, и по блокам PLAY второе нажатие
 * неотличимо от исчерпанной силы: после первого советник замолкал
 * до конца хода и молча терял половину бесплатного усиления. Тег говорит
 * прямо — на первом нажатии игра ставит `EXHAUSTED=1` и тут же снимает
 * его в `0`, на втором оставляет `1`. Поэтому: тег есть — отвечает он,
 * тега нет (`null`, part8 — десять нажатий и ни одного тега) — отвечает
 * прежний признак. Обратный порядок («жать нельзя, если ЛИБО нажата,
 * ЛИБО исчерпана») вернул бы ровно ту дыру, ради которой всё и затевалось.
 *
 * **`HERO_POWER_DISABLED` — пятый запрет, и он про ПАРТИЮ, а не про ход
 * (part48).** Сила Рено «Нас ждёт богатство!» жмётся ОДИН РАЗ ЗА ПАРТИЮ:
 * на нажатии игра ставит этот тег и не снимает его больше никогда, а вот
 * `EXHAUSTED` со сменой хода возвращается в `0`. То есть без пятого запрета
 * потраченная сила выглядела бы готовой до самого конца партии — и правило,
 * которое её советует, звало бы жать несуществующее. Тег читается как
 * «сейчас нельзя», а не «потрачена навсегда»: у «Трёх желаний» (part15)
 * он возвращается в ноль, и возможность возвращается вместе с ним.
 */
export function heroPowerReady(hero: {
  readonly heroPowerUsedThisTurn: boolean;
  readonly heroPowerUnplayable: boolean;
  readonly heroPowerLocked: boolean;
  readonly heroPowerExhausted?: boolean | null;
  readonly heroPowerDisabled?: boolean;
}): boolean {
  if (hero.heroPowerUnplayable || hero.heroPowerLocked) return false;
  if (hero.heroPowerDisabled === true) return false;
  const exhausted = hero.heroPowerExhausted ?? null;
  return exhausted === null ? !hero.heroPowerUsedThisTurn : !exhausted;
}

/**
 * Правило силы героя.
 *
 * Советуется только сила, которая ДАЁТ МИНЬОНА, — это видно по тексту
 * (`heroPowerMinionWords`). Скаббс: покупка за 3 плюс сила за 2 — два
 * существа за 5 золота. Про урон, баффы и прочее совет не берётся судить.
 *
 * Ценность — как у среднего миньона витрины: сила приносит существо того же
 * разбора, а стоит дешевле покупки. Нажатая в этом ходу, неиграбельная
 * или ещё не открытая сила не советуется — все три случая читаются
 * из лога (`heroPowerReady`).
 */
/**
 * Ценность действия «даёт миньона» — силы героя или заклинания витрины.
 *
 * Приходящий миньон — из той же витрины, поэтому его ценность оценивается
 * СРЕДНИМ по витрине. У «Enchanted Lasso» («Steal a random minion from the
 * Tavern») это не приближение, а точное ожидание: миньон берётся случайным
 * из тех же карт, что мы уже оценили. Второе слагаемое — сэкономленное
 * золото: действие дешевле покупки, а золото переводится в очки курсом
 * `goldPointValue`.
 *
 * Скидка засчитывается не всегда, и это не мелочь: при трёх золотых
 * и заклинании за два остаётся золотой, который просто сгорит, — «дешевле
 * покупки» превращается в «слабее покупки», и совет обязан ставить обычную
 * покупку выше. Поэтому у действия ПРЯМО СЕЙЧАС (`spendNow`) скидка
 * считается, только если остатка хватает ещё на покупку. У заморозки
 * наоборот: она и есть ставка на ход, где золота хватит на оба действия,
 * — там скидка и есть весь смысл (part17, ход 1: заморозить при нулевом
 * золоте, чтобы на пяти купить одного и украсть второго).
 *
 * `pool` — из чего именно придёт миньон. По умолчанию это вся витрина, и для
 * «Get a random minion» так и есть. Но «Steal a random minion FROM THE
 * TAVERN» (Enchanted Lasso) берёт из ТОЙ ЖЕ витрины, которую мы сейчас
 * оцениваем, — а к моменту применения лучшие карты из неё уже куплены.
 * Считать ожидание по всей витрине значило считать лучшую карту дважды:
 * и «мы её купим», и «лассо может её дать». Случай part22 (ход 7 и дальше):
 * игрок про повторяющийся совет заморозить лассо сказал «не вижу
 * практического эффекта от этой карты» — и был прав ровно этим.
 *
 * Третий источник — ПУЛ НАЗВАННОГО ТИРА (`namedTierPool`): витрина тут ни
 * при чём, и подставлять её вместо пула — тихая ошибка тем большая, чем
 * дальше тир таверны ушёл от названного (part23, ход 11).
 *
 * НАЦЕНКА считается тем же курсом, что скидка. Прежний `Math.max(0, …)`
 * делал разницу односторонней: заклинание дешевле покупки получало прибавку,
 * а заклинание ДОРОЖЕ покупки не платило ничего — Planar Telescope за 4
 * при цене миньона 3 стоял в списке так, будто лишнее золото ничего не стоит
 * (part23, ход 15). Односторонность тут не осторожность, а ошибка знака:
 * золото у нас уже переведено в очки, и курс один в обе стороны.
 */
function givesMinionValue(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
  cost: number,
  spendNow: boolean,
  // Источник миньона — либо СПИСОК карт (витрина или её остаток), либо целый
  // ПУЛ ТИРА. Пул передаётся тиром, а не материализованным списком: ожидание
  // по нему считает `averagePoolValue`, у которого есть кэш по борду, — иначе
  // сотня `minionValue` пересчитывалась бы на каждый вызов правила.
  // Третий источник — пул НАЗВАННОГО ПЛЕМЕНИ (part30, «Discover a Mech»):
  // тиры от первого до своего, фильтр по расе, а `discover` меняет само
  // ожидание — Discover это ВЫБОР, и берётся лучший из трёх, а не средний.
  pool: readonly Minion[] | TierPoolSource | { readonly tier: number } = state.shop,
): { readonly score: number; readonly average: number; readonly discounted: boolean } {
  const fallback = rules.value.perTechLevel * state.techLevel;
  const average =
    'tier' in pool
      ? (averagePoolValue([pool.tier], state, deps, rules) ?? fallback)
      : 'tiers' in pool
        ? ((pool.discover
            ? discoverPoolValue(pool.tiers, state, deps, rules, pool.race)
            : averagePoolValue(pool.tiers, state, deps, rules, pool.race)) ?? fallback)
        : pool.length > 0
          ? pool.reduce((sum, m) => sum + minionValue(m, state, deps, rules).total, 0) / pool.length
          : fallback;

  // Скидка засчитывается не всегда (см. выше), наценка — всегда: лишнее
  // золото уходит независимо от того, на что хватило бы остатка.
  const delta = (rules.minionCost - cost) * rules.goldPointValue;
  const discounted = delta <= 0 || !spendNow || state.gold - cost >= rules.minionCost;
  return { score: average + (discounted ? delta : 0), average, discounted };
}

/**
 * Пул миньонов названного племени — источник для `givesMinionValue`.
 *
 * `discover` различает два обещания текста, и различие это арифметика,
 * а не вес: «Get a random Quilboar» приносит СЛУЧАЙНУЮ карту пула
 * (ожидание — среднее), а «Discover a Mech» даёт ВЫБОР из трёх —
 * ожидание лучшего из трёх случайных (part30, ход 1: средний мех
 * первого тира стоит 6.25, а выбор из Lullabot 5.0 и Cord Puller 7.5
 * почти всегда отдаёт Cord Puller — его игрок и взял).
 */
interface TierPoolSource {
  readonly tiers: readonly number[];
  readonly race: string;
  readonly discover: boolean;
}

/** Первая захваченная группа первого совпавшего шаблона — или `null`. */
function firstMatch(patterns: readonly string[], text: string): string | null {
  for (const pattern of patterns) {
    const m = new RegExp(pattern, 'i').exec(text);
    if (m !== null) return m[1] ?? '';
  }
  return null;
}

/**
 * Все группы первого совпавшего шаблона — или `null`.
 *
 * Отличается от `firstMatch` тем, что отдаёт совпадение целиком: у чисел,
 * которые бывают и плейсхолдером, и литералом, групп две, и выбирать между
 * ними умеет `placeholderValue`.
 */
function firstMatchAll(patterns: readonly string[], text: string): RegExpExecArray | null {
  for (const pattern of patterns) {
    const m = new RegExp(pattern, 'i').exec(text);
    if (m !== null) return m;
  }
  return null;
}

/**
 * Миньон-заготовка из карты снапшота — чтобы оценить пул той же шкалой,
 * что и витрину.
 *
 * Ключевые слова берутся из механик карты: это её собственные свойства,
 * а не наложенные в партии. Энчантов и тегов у заготовки нет — их и не
 * бывает у карты, которую ещё не выдали.
 */
function poolMinion(info: CardInfo, index: number): Minion {
  // Отрицательный id не совпадёт ни с одной живой сущностью: заготовка
  // не должна считать копией саму себя или чужого миньона борда.
  return minionFromCard(info, -1000 - index, true);
}

/**
 * Миньон-заготовка из карточки справочника — там, где живой сущности с тегами
 * нет: пул тира и варианты открытого выбора.
 *
 * `keywords` разделяет два случая, и разделяет намеренно. У заготовки ПУЛА
 * ключевые слова настоящие: усреднение по пулу тем и честно, что щит и яд
 * у пришедшего миньона будут. А у варианта ВЫБОРА тегов нет вовсе, и ставить
 * слова по механикам карты значило бы менять уже откалиброванные очки выбора;
 * там по-прежнему считают тир, статы, племя и копии.
 */
function minionFromCard(info: CardInfo, entityId: number, keywords: boolean): Minion {
  const flags = {} as Record<BinaryKeywordField, boolean>;
  for (const [mech, field] of BINARY_KEYWORDS) {
    flags[field] = keywords && info.mechanics.includes(mech);
  }
  return {
    entityId,
    cardId: info.id,
    zonePos: 0,
    attack: info.attack,
    health: info.health,
    ...flags,
    golden: false,
    frozen: false,
    maxHealth: info.health,
    techLevel: info.techLevel,
    enchantments: [],
    scriptData: [],
    tags: {},
    // Заготовка не стоит в витрине — кнопки покупки у неё нет.
    buyCost: null,
  };
}

/**
 * Пул миньонов тира, названного в тексте, — или `null`, если тир не назван.
 *
 * «Get a random Tier 1 minion» приносит карту из пула первого тира, а не
 * из витрины: на четвёртом тире это разные вещи, и разница ровно в ту
 * сторону, на которую указал игрок. «Discover a minion of your Tier» —
 * тот же случай, только тир берётся из состояния.
 *
 * Ожидание считается ТОЙ ЖЕ шкалой на ТОМ ЖЕ борде: свои по племени,
 * ключевые слова и копии у пришедшего миньона будут настоящие, и усреднение
 * по пулу — честное их ожидание, а не поправочный коэффициент.
 */
function namedTierPool(
  text: string,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): { readonly pool: readonly Minion[]; readonly tier: number } | null {
  const numbered = new RegExp(rules.namedTierWords.numbered, 'i').exec(text);
  const own = rules.namedTierWords.ownTier.some((w) => new RegExp(w, 'i').test(text));
  const tier = numbered?.[1] !== undefined ? Number(numbered[1]) : own ? state.techLevel : null;
  if (tier === null || !Number.isFinite(tier)) return null;

  const pool = tierPool(tier, deps);
  return pool.length === 0 ? null : { pool, tier };
}

/**
 * Миньоны пула тира как сущности — заготовки для оценки той же шкалой.
 *
 * Заготовки от состояния не зависят (это карты, а не сущности партии),
 * поэтому строятся один раз на справочник: пул пятого тира — 121 карта,
 * а спрашивают его на каждом шаге плана.
 */
const TIER_POOLS = new WeakMap<CardIndex, Map<number, readonly Minion[]>>();

function tierPool(tier: number, deps: TavernAdvisorDeps): readonly Minion[] {
  let byTier = TIER_POOLS.get(deps.cards);
  if (byTier === undefined) {
    byTier = new Map();
    TIER_POOLS.set(deps.cards, byTier);
  }
  const cached = byTier.get(tier);
  if (cached !== undefined) return cached;
  const built = deps.cards.poolOfTier(tier).map((info, i) => poolMinion(info, i));
  byTier.set(tier, built);
  return built;
}

/**
 * Во что нам обходится НЕИЗВЕСТНАЯ карта названных тиров — среднее по их
 * пулам на нашем борде.
 *
 * Нужно там, где сравнивается «свежая витрина» с уже виденной: обе стороны
 * обязаны считаться одной функцией на одном борде, иначе сравниваются числа
 * с разной начинкой. `null` — пула таких тиров в снапшоте нет.
 *
 * Тиры передаются списком, потому что вопросы бывают разные. «Свежая карта
 * витрины» — это тиры ОТ ПЕРВОГО ДО СВОЕГО: витрина четвёртого тира полна
 * миньонов первого и второго, и на part24 (ход 3) это видно прямо — при
 * таверне 2 в ней стояли три карты первого тира. Считать свежую карту
 * по одному лишь своему тиру значило завышать её тем сильнее, чем выше
 * таверна. А у тёмного дара тиры названы таблицей и берутся как есть.
 *
 * Взвешивания по числу копий в пуле у нас нет — снапшот его не несёт,
 * и карты усредняются поровну. Настоящий пул смещён к низким тирам
 * (их копий больше), то есть наша оценка свежей карты скорее завышена,
 * чем занижена, — и это записано, а не подогнано.
 */
function averagePoolValue(
  tiers: readonly number[],
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
  // Племя, которым пул ОГРАНИЧЕН: «Get a random Quilboar» (part28) берёт
  // не любую карту тира, а квилбоара, и на борде квилбоаров это разные
  // числа — 18.8 против 11.6 по всему пулу тиров 1–4.
  race: string | null = null,
  // Механика, которой пул ограничен: «Refresh the Tavern with Battlecry
  // minions» (part35) наполняет витрину только кличевыми — 46 карт пула
  // из 396, — и ожидание по ним считается по ним, а не по всему тиру.
  mechanic: string | null = null,
): number | null {
  // Кэш по БОРДУ: ценность пула зависит только от того, что у нас стоит
  // (племя, копии), а сотня `minionValue` на вызов — дорого. План строит
  // до четырёх цепочек по восемь шагов, и без кэша один ход стоил 14 мс
  // против 7. Ключ — ссылка на массив борда: гипотетические состояния плана
  // создают новый массив при каждом изменении.
  //
  // Ключ обязан покрывать ВСЁ, от чего зависит `minionValue`, — иначе кэш
  // отдаёт ответ, посчитанный на другом вопросе, и это не падение, а тихо
  // неверное число. Зависимостей ровно шесть, и первые две те же, что
  // у `memoByCard`: правила и справочник (тесты подают свои таблицы и свои
  // крошечные снапшоты — общий кэш выдал бы им чужой ответ), борд ссылкой,
  // а дальше строкой:
  //
  //  - РУКА картами, а не длиной: `copiesOwned` считает копии и по руке,
  //    и два разных набора одной длины дают разные числа;
  //  - ЗАКЛИНАНИЯ РУКИ: слагаемое магнита считается по ним. Розыгрыш
  //    заклинания руки борда не трогает ВООБЩЕ (`withoutMagnetCharge`
  //    возвращает тот же массив, когда заряд не тратится) и длины руки
  //    не меняет — по прежнему ключу следующий шаг плана получал планку
  //    заморозки и дар, посчитанные с уже разыгранным заклинанием;
  //  - СИЛА ГЕРОЯ: её текст входит в ценность покупки с part22.
  const key =
    `${tiers.join(',')}|${race ?? ''}|${mechanic ?? ''}` +
    `|${state.hand.map((m) => `${m.cardId}${m.golden ? '_G' : ''}`).join(',')}` +
    `|${state.handSpells.map((s) => `${s.cardId}:${s.scriptData.join('.')}`).join(',')}` +
    `|${state.hero?.heroPowerCardId ?? ''}` +
    // Остаток счётчика силы «после N покупок» (part34): доля награды
    // у кличевых кандидатов пула зависит от него.
    `|${(state.hero?.heroPowerScriptData ?? []).join('.')}`;

  let byCards = POOL_VALUE_CACHE.get(rules);
  if (byCards === undefined) {
    byCards = new WeakMap();
    POOL_VALUE_CACHE.set(rules, byCards);
  }
  let byBoard = byCards.get(deps.cards);
  if (byBoard === undefined) {
    byBoard = new WeakMap();
    byCards.set(deps.cards, byBoard);
  }
  let byKey = byBoard.get(state.board);
  if (byKey === undefined) {
    byKey = new Map();
    byBoard.set(state.board, byKey);
  }
  const cached = byKey.get(key);
  if (cached !== undefined) return cached;

  // Пул склеивается только на ПРОМАХЕ: тиры 1..6 — это 382 заготовки,
  // и на попадании этот массив строился и выбрасывался впустую.
  const whole = tiers.flatMap((t) => tierPool(t, deps));
  const byRace =
    race === null
      ? whole
      : whole.filter((m) => deps.cards.info(m.cardId)?.races.includes(race) ?? false);
  const pool =
    mechanic === null
      ? byRace
      : byRace.filter((m) => deps.cards.info(m.cardId)?.mechanics.includes(mechanic) ?? false);
  if (pool.length === 0) return null;

  const value =
    pool.reduce((sum, m) => sum + minionValue(m, state, deps, rules).total, 0) / pool.length;
  byKey.set(key, value);
  return value;
}

const POOL_VALUE_CACHE = new WeakMap<
  TavernRules,
  WeakMap<CardIndex, WeakMap<object, Map<string, number>>>
>();

/**
 * Ожидание ЛУЧШЕГО из трёх случайных карт пула — то, что на деле обещает
 * «Discover»: три карты предложены, берётся одна.
 *
 * Это не надбавка-мнение, а другая случайная величина на той же шкале:
 * средним меряется «Get a random X», а у выбора из трёх ожидание считается
 * по порядковой статистике — P(максимум = i-я по возрастанию) =
 * C(i−1, 2) / C(n, 3) при выборе трёх без повторов. Пул меньше трёх карт
 * отдаёт лучшую: снапшот не несёт числа копий (записанное допущение
 * `averagePoolValue`), и предложение из двух карт почти наверняка содержит
 * обе. У тёмного дара надбавки за выбор по-прежнему нет (`bonus: 0`,
 * part24) — там пул искажён самим даром, и оценка нижняя сознательно.
 *
 * Кэш и его ключ — те же, что у `averagePoolValue`, с собственным
 * префиксом: зависимости ответа ровно те же.
 */
function discoverPoolValue(
  tiers: readonly number[],
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
  race: string | null = null,
): number | null {
  const key =
    `best3|${tiers.join(',')}|${race ?? ''}` +
    `|${state.hand.map((m) => `${m.cardId}${m.golden ? '_G' : ''}`).join(',')}` +
    `|${state.handSpells.map((s) => `${s.cardId}:${s.scriptData.join('.')}`).join(',')}` +
    `|${state.hero?.heroPowerCardId ?? ''}` +
    // Остаток счётчика силы «после N покупок» (part34): доля награды
    // у кличевых кандидатов пула зависит от него.
    `|${(state.hero?.heroPowerScriptData ?? []).join('.')}`;

  let byCards = POOL_VALUE_CACHE.get(rules);
  if (byCards === undefined) {
    byCards = new WeakMap();
    POOL_VALUE_CACHE.set(rules, byCards);
  }
  let byBoard = byCards.get(deps.cards);
  if (byBoard === undefined) {
    byBoard = new WeakMap();
    byCards.set(deps.cards, byBoard);
  }
  let byKey = byBoard.get(state.board);
  if (byKey === undefined) {
    byKey = new Map();
    byBoard.set(state.board, byKey);
  }
  const cached = byKey.get(key);
  if (cached !== undefined) return cached;

  const whole = tiers.flatMap((t) => tierPool(t, deps));
  const pool =
    race === null
      ? whole
      : whole.filter((m) => deps.cards.info(m.cardId)?.races.includes(race) ?? false);
  if (pool.length === 0) return null;

  const values = pool
    .map((m) => minionValue(m, state, deps, rules).total)
    .sort((a, b) => a - b);
  const n = values.length;
  let value: number;
  if (n < 3) {
    value = values[n - 1] ?? 0;
  } else {
    // C(n, 3) знаменателем, C(i, 2) — способы добрать двух снизу к максимуму.
    const total = (n * (n - 1) * (n - 2)) / 6;
    value =
      values.reduce((sum, v, i) => sum + (v * (i * (i - 1))) / 2, 0) / total;
  }
  byKey.set(key, value);
  return value;
}

/** Тиры, из которых витрина набирает карты: от первого до своего. */
function shopTiers(techLevel: number): number[] {
  return Array.from({ length: Math.max(1, techLevel) }, (_, i) => i + 1);
}

export function heroPowerRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;

  // Ноль ТЕГОМ — скидка, а не бесплатная сила: см. тот же разбор
  // в `heroPowerSpellRule` (part53). `null` — тега `COST` нет вовсе (D083),
  // и такую силу это правило по-прежнему не судит.
  const cost = hero.heroPowerCost;
  if (cost === null) return null;
  if (!heroPowerReady(hero)) return null;

  const info = deps.cards.info(hero.heroPowerCardId);
  const text = info?.text ?? '';

  // Награда, которая придёт ПОСЛЕ БОЯ, слота в этом ходу не занимает.
  //
  // Вычет жертвы ниже поставлен по фактуре part31/part40, где миньон приходит
  // в руку СЕЙЧАС и место ему нужно СЕЙЧАС. У Рафаама («Мне это нужно!»
  // `TB_BaconShop_HP_053`: «Next combat, get a plain copy of the first minion
  // you kill») карта приходит на конце СЛЕДУЮЩЕГО боя — к тому времени борд
  // уже перетасован боем и продажами, и платить за слот сейчас не за что.
  // А платило правило ценностью КРУПНЕЙШЕЙ карты борда, то есть ровно там,
  // где награда самая жирная: на part52 оно молчало на ходах 21 и 23 — обоих,
  // где борд полон и развит, и на 23-м игрок нажал силу последним золотым.
  //
  // Условие узкое НАМЕРЕННО — по словам, а не по «миньон приходит в руку»:
  // широкая формулировка развалила бы D008 и вернула ошибку part31 (план
  // начинался с покупки за 3 на полном борде). Карт, у которых есть и «next
  // combat», и слова `givesMinionWords`, в снапшоте РОВНО ОДНА — эта.
  const delayed = rules.delayedRewardWords.some((w) => new RegExp(w, 'i').test(text));

  // Найденный миньон приходит в руку, и на полном борде место ему освобождает
  // ПРОДАЖА — та самая, что приносит золотой. Значит «по карману» считается
  // вместе с ней, ровно как у покупки (part36, ход 13). Случай part40 (ход 13):
  // золото 1, борд полон, сила стоит 2 — оверлей сказал «НИЧЕГО», а игрок
  // продал Southsea Busker и нажал силу, получив золотого Aureate Laureate.
  // Прибавка идёт ТОЛЬКО там, где продажа и так подразумевается: `victim`
  // не пуст лишь на полном борде, и продавать «просто ради монеты» правило
  // по-прежнему не предлагает.
  const victim = delayed ? null : handMinionVictim(state, deps, rules);
  if (cost > state.gold + (victim === null ? 0 : rules.sellGold)) return null;

  // Миньона обещает и ПЛЕМЯ без слова «minion»: «Discover a Mech. Swaps
  // type each turn» у Крысиного короля (part30) — тот же случай, что
  // «Discover a Naga» в выборе сил (part26), только здесь сила НАЖИМАЕТСЯ
  // и у неё есть живая цена. Разбор общий — `tribeMinionRace`.
  const race = tribeMinionRace(text, rules);
  if (race === null && !rules.givesMinionWords.some((w) => new RegExp(w, 'i').test(text))) {
    return null;
  }

  const source =
    race !== null
      ? {
          tiers: shopTiers(state.techLevel),
          race,
          discover: /\bdiscover\b/i.test(text),
        }
      : (namedTierPool(text, state, deps, rules) ?? undefined);
  const { score, average, discounted } = givesMinionValue(state, deps, rules, cost, true, source);

  // Цена СПЕШКИ у силы с ЛЕСТНИЧНОЙ ценой — см. `heroPowerHurryCost`.
  const hurry = heroPowerHurryCost(text, source ?? null, average, state, deps, rules);
  // Сила с Discover при плательщике за Discover кормит своих (D232).
  const discovers = discoverCountOf(text, 'lead', rules);
  const discoverPay = discovers > 0 ? discoverPayoffOf(state.board, deps.cards, rules) : null;
  const hurried = score - hurry.cost + (discoverPay?.points ?? 0) * discovers;
  if (hurry.cost > 0 && hurried <= 0) return null;

  // Найденный миньон приходит в руку — на полном борде жертва вычитается,
  // как у заклинания витрины (part31).
  if (victim !== null && hurried - victim.value <= rules.sellMargin) return null;

  return {
    action: 'heroPower',
    minion: null,
    score: hurried - (victim?.value ?? 0),
    cost,
    requiresSlot: false,
    // Жертва называется полем только там, где без продажи силу НЕ НАЖАТЬ:
    // иначе совет читался бы как «продай, потом жми», хотя золота хватает
    // и так, а место игрок освободит сам, когда карта придёт в руку.
    sellFirst: victim !== null && cost > state.gold ? victim.minion : null,
    reason:
      `${info?.name ?? hero.heroPowerCardId} за ${String(cost)} даёт миньона — ` +
      `${minionSourceNote(source ?? null, average)}` +
      (discounted && cost < rules.minionCost
        ? `, но на ${String(rules.minionCost - cost)} золота дешевле покупки`
        : '') +
      // Слово про слот обязательно: без него совет «жать на полном борде»
      // читается как ошибка — игрок видит семь тел и не видит, куда придёт
      // обещанное. Приходит оно после боя, и место к тому времени будет.
      (delayed ? '; награда придёт после боя, слот сейчас не нужен' : '') +
      (hurry.note === null ? '' : `; ${hurry.note}`) +
      (discoverPay === null ? '' : `; ${discoverPayoffNote(discoverPay, discovers)}`) +
      (victim === null ? '' : `; ${victim.note}`),
  };
}

/**
 * Цена СПЕШКИ у силы, дорожающей от нажатий (part42, «Ведущая
 * исследовательница»: «Discover a minion from your Tier. Costs (1) more
 * after each use», цена в логе идёт 1 → 2 → 3 → 4 ровно по нажатиям).
 *
 * Жалоба игрока: «невыгодно нажимать рано, она дорожает с каждым
 * использованием, а на ранних ходах нет карт, которые помогут понять, через
 * кого играть». Советник же ставил её ВЕРХНЕЙ строкой с хода 3 и почти
 * каждый ход, тогда как игрок нажал все три раза в конце партии — на 10-м,
 * 12-м и 13-м ходах таверны.
 *
 * Арифметика тут своя, и она проще, чем у тёмного дара. У дара заряды
 * конечны, и нажатие ВЫТЕСНЯЕТ поздний ход. Здесь вытеснять нечего:
 * от ожидания цена не растёт вовсе — она растёт ТОЛЬКО от нажатий, — то есть
 * отложить нажатие стоит РОВНО НОЛЬ золота. А отложив, за ту же ступеньку
 * лестницы получаешь тело более высокого тира: по нашей же шкале Discover
 * своего тира стоит 6.5 очка на первом тире и 21 на шестом. Значит цена
 * спешки — это прирост тира, который мы отдаём, нажимая сейчас.
 *
 * Насколько далеко смотреть, решает горизонт партии: ходов таверны впереди
 * — замер `remainingTurns` (part28), а тир на последнем из них — кривая
 * `levelling`. Оценка получается ВЕРХНЕЙ, и это сказано вслух: она молчаливо
 * считает, что ждать можно до конца партии без потерь. Потеря там есть,
 * и она ровно одна — ТЕМП: тело, взятое сейчас, воюет в большем числе боёв.
 * Темпа наша мерка не считает (та же оговорка записана у дара, part31),
 * поэтому совет обязан назвать и горизонт, и цену словами — иначе игроку
 * нечему возразить.
 *
 * Условие узкое: цена спешки считается, только когда тело зависит от НАШЕГО
 * тира (источник — пул своего тира). Сила с фиксированным тиром от ожидания
 * не выигрывает ничего, и придерживать её незачем.
 */
function heroPowerHurryCost(
  text: string,
  source: readonly Minion[] | TierPoolSource | { readonly tier: number } | null,
  body: number,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): { readonly cost: number; readonly note: string | null } {
  const growth = firstMatch(rules.heroPowerCostGrowthWords, text);
  if (growth === null) return { cost: 0, note: null };
  if (source === null || !('tier' in source)) return { cost: 0, note: null };

  const ahead = remainingTurns(state, rules);
  const lastTavernTurn = Math.round(tavernTurnOf(state.turn) + ahead);
  const topTier = Math.max(source.tier, targetTier(2 * lastTavernTurn - 1, rules));
  const later = topTier > source.tier ? averagePoolValue([topTier], state, deps, rules) : null;
  if (later === null) {
    return {
      cost: 0,
      note:
        `цена растёт на ${growth} за нажатие, но выше тира ${String(source.tier)} ` +
        `таверна уже не поднимется — жать`,
    };
  }

  const cost = Math.max(0, later - body);
  return {
    cost,
    note:
      `но ступеньку лучше приберечь: цена растёт на ${growth} за нажатие, ` +
      `а ждать ничего не стоит — впереди ещё ${ahead.toFixed(1)} ходов таверны, ` +
      `и на тире ${String(topTier)} та же сила даст ${later.toFixed(1)} ` +
      `вместо ${body.toFixed(1)} — спешка стоит ${cost.toFixed(1)}`,
  };
}

/**
 * Как назвать источник миньона в причине совета.
 *
 * Игроку важно не число само по себе, а откуда оно взято: «средний из
 * витрины» и «средний миньон тира 1» — это разные обещания, и на четвёртом
 * тире разница между ними и есть весь вопрос (part23, ход 11).
 */
function minionSourceNote(
  tiered: { readonly tier: number } | TierPoolSource | null,
  average: number,
): string {
  if (tiered === null) return `как средний из витрины (${average.toFixed(1)})`;
  if ('tiers' in tiered) {
    const top = tiered.tiers[tiered.tiers.length - 1] ?? 1;
    const range = top <= 1 ? 'тира 1' : `тиров 1–${String(top)}`;
    // Discover — выбор, и обещание другое: «лучший из трёх», а не средний.
    return tiered.discover
      ? `как лучший из трёх ${tiered.race} ${range} (${average.toFixed(1)})`
      : `как случайный ${tiered.race} ${range} (${average.toFixed(1)})`;
  }
  return `как средний миньон тира ${String(tiered.tier)} (${average.toFixed(1)})`;
}

/**
 * Правило бесплатной силы героя.
 *
 * Прежнее правило силы отсекает бесплатные на входе (`cost > 0`): оно про
 * «сила как дешёвая покупка миньона». Но бесплатную активную силу игрок
 * просто забывает нажать — как монетку в руке. Случай part13 (Хроми,
 * «Мана в минуту»: «Refresh the Tavern with Tavern spells», HAS_ACTIVATE_POWER
 * без тега COST): за партию совет не напомнил про силу ни разу — на что
 * игрок и указал.
 *
 * Советуется только бесплатная И активная сила с текстом про обновление
 * витрины (`heroPowerRefreshWords`): про платные и пассивные вне «даёт
 * миньона» совет по-прежнему не берётся судить. Очки малые — напоминание
 * всплывает, когда покупки сделаны и список пустеет, то есть к концу хода.
 */
export function freeHeroPowerRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;
  if (!hero.heroPowerHasActivate) return null;
  if ((hero.heroPowerCost ?? 0) > 0) return null;
  if (!heroPowerReady(hero)) return null;

  const info = deps.cards.info(hero.heroPowerCardId);
  const text = info?.text ?? '';
  if (!rules.heroPowerRefreshWords.some((w) => new RegExp(w, 'i').test(text))) return null;

  return {
    action: 'heroPower',
    minion: null,
    score: rules.freeHeroPowerValue,
    cost: 0,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `${info?.name ?? hero.heroPowerCardId} бесплатна и обновляет витрину — ` +
      'нажать, когда нынешняя витрина отработана',
  };
}

/**
 * Правило силы героя, ДАЮЩЕЙ СВОЕМУ МИНЬОНУ КЛЮЧЕВОЕ СЛОВО.
 *
 * Фактура — part32 (Король-лич, «Ритуал перерождения» `TB_BaconShop_HP_024`:
 * «Give a minion Reborn until next turn»). Сила бесплатна и активна
 * (`HAS_ACTIVATE_POWER` без тега `COST`), игрок нажал её на каждом из
 * шестнадцати ходов таверны и по первому скриншоту написал: «не предлагает
 * сыграть силу героя, хотя её точно стоит сыграть». Советник молчал всю
 * партию: бесплатные силы советовались только с текстом про обновление
 * витрины (part13) и выстрел по витрине (part29), а «даёт своему миньону
 * слово» не читал никто — на первом ходу при золоте 0/3 совет был «НИЧЕГО».
 *
 * Лог (23:49:36): блок `PLAY` на сущности силы с `Target=` своим миньоном,
 * энчант `TB_BaconShop_HP_024e2` («Reborn until next turn») на цели;
 * после нажатия на силе `EXHAUSTED=1` — первый случай этого тега на силе
 * во всех фикстурах — и `EXHAUSTED=0` в начале следующего хода. «Нажато»
 * по-прежнему считается блоком, как у всех сил.
 *
 * Слово — группа шаблона `heroPowerKeywordWords`, сведённая к живому
 * признаку миньона той же таблицей `BINARY_KEYWORDS`, что у магнитов.
 * Цена — живой тег (у Boon of Light `COST=1`), очки — ценность слова
 * на цели теми же весами и капами, что у покупки (`keywordValue`), минус
 * цена по курсу золота. У бесплатной силы очки малые (перерождение — до 2):
 * это напоминание, которое всплывает, когда покупки сделаны, — как у силы-
 * обновления; платный щит за 1 по этому курсу молчит (3 − 3 = 0), и это
 * не порог, а честная цена на нашей шкале.
 *
 * Кому — арифметика самого слова, а не мнение:
 *
 *  1. **Тому, у кого его ещё нет** — второй раз слово не дарится (part13,
 *     дар магнита на уже перерождённого).
 *  2. **Перерождение — ВТОРАЯ СМЕРТЬ, и хрип срабатывает дважды**, поэтому
 *     носитель хрипа впереди тела без него. Хрип, который САМ дарит
 *     перерождение («Deathrattle: Give a different friendly Undead Reborn»,
 *     Mummifier), — цепочка: одно нажатие оборачивается тремя
 *     перерождениями, пока на борде есть кому его получить. Игрок так
 *     и играл: шесть нажатий подряд на Mummifier (ходы 13–23).
 *  3. **Возвращается с ОДНИМ здоровьем и полной атакой** — среди равных
 *     выбирается атака, а не сумма статов: здоровье вторая жизнь
 *     не наследует.
 *  4. Прочие слова — крупнейшее тело, как у баффа; провокация обходит
 *     движков (part15).
 *
 * Что НЕ решено и записано, а не спрятано: на ходу 11 игрок дал
 * перерождение золотому Deathswarmer 6/8 (без хрипа), правило называет
 * Friendly Geist 10/3 с хрипом; с хода 25 он выбирал Deathly Striker
 * (хрип-призыв из руки) при Mummifier рядом — чей выбор лучше, решил бы
 * только бой, и досчёт цели симулятором отложен (docs/tavern.md).
 */
export function heroPowerKeywordRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;
  if (!hero.heroPowerHasActivate) return null;
  if (!heroPowerReady(hero)) return null;
  const cost = hero.heroPowerCost ?? 0;
  if (cost > state.gold) return null;
  if (state.board.length === 0) return null;

  const info = deps.cards.info(hero.heroPowerCardId);
  const text = info?.text ?? '';
  const field = grantedKeyword(text, rules);
  if (field === null) return null;

  const chosen = keywordTarget(field, state, deps, rules);
  if (chosen === null) return null;
  const { target, notes } = chosen;

  const gift = keywordValue(field, target.attack ?? 0, target.health ?? 0, rules);
  const score = gift - cost * rules.goldPointValue;
  if (score <= 0) return null;

  const name = deps.cards.info(target.cardId)?.name ?? target.cardId;
  return {
    action: 'heroPower',
    minion: null,
    score,
    cost,
    requiresSlot: false,
    sellFirst: null,
    targetMinion: target,
    grantsKeyword: field,
    reason:
      `${info?.name ?? hero.heroPowerCardId} ${cost > 0 ? `за ${String(cost)}` : 'бесплатна'} — ` +
      `${KEYWORD_NAME_RU[field]} на ${name} ` +
      `${String(target.attack ?? '?')}/${String(target.health ?? '?')} (${gift.toFixed(1)})` +
      (notes.length > 0 ? `: ${notes.join('; ')}` : ''),
  };
}

/**
 * Правило силы героя, кладущей на СВОЕГО миньона статы величиной с ТИР.
 *
 * Инге Стальной Гимн (part45): «Give a minion Attack equal to your Tier»
 * и «…Health equal to your Tier», половины меняются местами каждый ход.
 * Сила БЕСПЛАТНА (тега `COST` у неё нет вовсе, как у Хроми в part13),
 * активна с первого хода и не под замком — а советник молчал про неё все
 * пятнадцать ходов партии, потому что величина прибавки названа СЛОВОМ,
 * а не цифрой, и ни один из шести каналов чтения силы её не видел. Игрок
 * нажимал силу сам каждый ход и написал: «не предлагает нажать силу героя».
 *
 * Считается без единого нового веса: прибавка — `тир × perStatPoint`, цена
 * (у платной силы этого класса, если такая появится) — по `goldPointValue`,
 * как у слова в `heroPowerKeywordRule`. Тир берётся живой из состояния:
 * в тексте числа нет, а прибавка равна тиру НА МОМЕНТ НАЖАТИЯ — это видно
 * по борду (Клыкастый походник 2/3 → 4/3 после двух нажатий на тире 1).
 *
 * Цель — общая `buffTarget`, то есть крупнейшее своё тело мимо кандидатов
 * в продажу (part17, part36). Отдельного правила у неё нет намеренно:
 * усиление постоянное, и вопрос «кому» тут ровно тот же, что у заклинания
 * с +N/+M, — второе определение той же вещи разъехалось бы молча.
 *
 * Очки малые (на первом тире 0.5, на пятом 2.5), и это НЕ порог, а честная
 * цена бесплатного действия на нашей шкале: в списке сила стоит внизу,
 * а в план входит всегда — шаг стоит ноль золота и ничего не вытесняет.
 * Ровно так же ведёт себя бесплатная сила-обновление (part13).
 */
export function heroPowerStatsRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;
  if (!hero.heroPowerHasActivate) return null;
  if (!heroPowerReady(hero)) return null;
  const cost = hero.heroPowerCost ?? 0;
  if (cost > state.gold) return null;
  if (state.board.length === 0) return null;

  const info = deps.cards.info(hero.heroPowerCardId);
  const text = info?.text ?? '';
  let stat: 'attack' | 'health' | null = null;
  for (const word of rules.heroPowerTierStatsWords) {
    const found = new RegExp(word, 'i').exec(text)?.[1]?.toLowerCase();
    if (found === 'attack' || found === 'health') {
      stat = found;
      break;
    }
  }
  if (stat === null) return null;

  const amount = state.techLevel;
  if (amount <= 0) return null;

  const target = buffTarget(state, deps, rules, false, stat === 'attack');
  if (target === null) return null;

  const score = amount * rules.value.perStatPoint - cost * rules.goldPointValue;
  if (score <= 0) return null;

  const name = deps.cards.info(target.cardId)?.name ?? target.cardId;
  const statRu = stat === 'attack' ? 'атаки' : 'здоровья';
  return {
    action: 'heroPower',
    minion: null,
    score,
    cost,
    requiresSlot: false,
    sellFirst: null,
    targetMinion: target,
    grantsStats: { stat, amount },
    reason:
      `${info?.name ?? hero.heroPowerCardId} ${cost > 0 ? `за ${String(cost)}` : 'бесплатна'} — ` +
      `+${String(amount)} ${statRu} (по тиру таверны) на ${name} ` +
      `${String(target.attack ?? '?')}/${String(target.health ?? '?')}`,
  };
}

/**
 * Правило силы героя, ОБМЕНИВАЮЩЕЙ АТАКОЙ двух миньонов.
 *
 * Вольджин (part56), «Духовный обмен»: «Choose 2 minions. They gain each
 * other's Attack until next turn». Сила бесплатна (тега `COST` нет),
 * активна с первого хода — а советник не назвал её ни в одной из девяти
 * точек решения партии, хотя игрок жал её каждый ход. Жалоба игрока
 * дословно: «мне не предлагало применить силу героя».
 *
 * Как игрок жал — из лога, и это определило правило целиком:
 *
 *  - **Второй миньон бывает ИЗ ВИТРИНЫ.** Семь ходов из девяти игрок брал
 *    своего и самого атакующего миньона таверны (`player=14` — Боб):
 *    Glim Guardian 1/4 + Fleeing Fugitive 5/2 дали своему 6/4. Прибавка
 *    миньону витрины бесполезна, зато своему достаётся чужая атака целиком.
 *  - **Когда свои крупнее витрины, пара — двое своих**, и растут оба: ход 17,
 *    золотой Lurking Lionfish 30/14 и Tasty Lobster 17/8 — +17 и +30.
 *
 * Отсюда выбор без новых весов: пара «двое самых атакующих своих» даёт
 * сумму их атак, пара «свой + самый атакующий из витрины» — атаку
 * витринного; берётся большее. Своего в паре с витриной выбирает общая
 * `buffTarget` с признаком «только атака» (D225).
 *
 * **Прибавка временная, и считается она всё же `perStatPoint`.** Это
 * решение (D240), и оговорка у него та же, что у заклинаний с «until next
 * turn», которые советник давно считает полной ценой: сила жмётся КАЖДЫЙ
 * ход, и её ценность хода — ровно ближайший бой. От очков зависит только
 * место в списке: шаг бесплатен и в план входит всегда, а в плане он
 * ПОСЛЕДНИЙ (`sharesAttack.last`) — лучший партнёр приходит покупкой.
 *
 * Второй шаг (первый уже нажат, сила стала `BG20_HERO_201p2`) решается
 * тем же выбором при известной первой цели: её id лежит на силе
 * в `TAG_SCRIPT_DATA_NUM_1`. Второй плейсхолдер — НЕ атака цели: на ходу 17
 * там 1 при атаке 30.
 */
export function heroPowerShareAttackRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;
  if (!hero.heroPowerHasActivate) return null;
  if (!heroPowerReady(hero)) return null;
  const cost = hero.heroPowerCost ?? 0;
  if (cost > state.gold) return null;
  if (state.board.length === 0) return null;

  const cards = deps.cards;
  const info = cards.info(hero.heroPowerCardId);
  const text = info?.text ?? '';
  const says = (words: readonly string[]): boolean =>
    words.some((w) => new RegExp(w, 'i').test(text));
  const second = says(rules.heroPowerShareAttackSecondWords);
  if (!second && !says(rules.heroPowerShareAttackWords)) return null;

  const attackOf = (m: Minion): number => m.attack ?? 0;
  const byAttack = (list: readonly Minion[]): Minion[] =>
    [...list].sort((a, b) => attackOf(b) - attackOf(a));
  // Кандидаты в продажу из пары НЕ исключаются: шаг в плане последний
  // (`sharesAttack.last`), и проданное к нему уже ушло с борда. Исключение
  // ломало пару на малом борде, где кандидат в продажу есть всегда (part56,
  // ход 5: Glim Guardian 1/4 и Lava Lurker 2/5 — пара своих давала 3, а не 2).
  const own = state.board;
  const bestShop = byAttack(state.shop)[0] ?? null;
  const label = (m: Minion): string =>
    `${cards.info(m.cardId)?.name ?? m.cardId} ${String(m.attack ?? '?')}/${String(m.health ?? '?')}`;

  let target: Minion;
  let partner: Minion | null = null;
  let gains: { entityId: number; attack: number }[];
  let words: string;
  if (second) {
    const firstId = hero.heroPowerScriptData[0];
    const firstOwn = state.board.find((m) => m.entityId === firstId);
    const firstShop = state.shop.find((m) => m.entityId === firstId);
    if (firstOwn !== undefined) {
      const mate = byAttack(own.filter((m) => m.entityId !== firstOwn.entityId))[0] ?? null;
      const viaOwn = mate === null ? 0 : attackOf(firstOwn) + attackOf(mate);
      const viaShop = bestShop === null ? 0 : attackOf(bestShop);
      if (mate !== null && viaOwn >= viaShop) {
        target = mate;
        gains = [
          { entityId: firstOwn.entityId, attack: attackOf(mate) },
          { entityId: mate.entityId, attack: attackOf(firstOwn) },
        ];
      } else if (bestShop !== null) {
        target = bestShop;
        gains = [{ entityId: firstOwn.entityId, attack: attackOf(bestShop) }];
      } else {
        return null;
      }
      words = `второе нажатие — ${label(target)} в пару к ${label(firstOwn)}`;
    } else if (firstShop !== undefined) {
      const recipient = buffTarget(state, deps, rules, false, true);
      if (recipient === null) return null;
      target = recipient;
      gains = [{ entityId: recipient.entityId, attack: attackOf(firstShop) }];
      words = `второе нажатие — ${label(recipient)} в пару к ${label(firstShop)} из витрины`;
    } else {
      return null;
    }
  } else {
    const [top, next] = byAttack(own);
    const recipient = buffTarget(state, deps, rules, false, true);
    const viaOwn = top !== undefined && next !== undefined ? attackOf(top) + attackOf(next) : 0;
    const viaShop = recipient !== null && bestShop !== null ? attackOf(bestShop) : 0;
    if (top !== undefined && next !== undefined && viaOwn >= viaShop) {
      target = top;
      partner = next;
      gains = [
        { entityId: top.entityId, attack: attackOf(next) },
        { entityId: next.entityId, attack: attackOf(top) },
      ];
      words = `${label(top)} и ${label(next)} обмениваются атакой`;
    } else if (recipient !== null && bestShop !== null) {
      target = recipient;
      partner = bestShop;
      gains = [{ entityId: recipient.entityId, attack: attackOf(bestShop) }];
      words = `${label(recipient)} берёт атаку ${label(bestShop)} из витрины`;
    } else {
      return null;
    }
  }

  const total = gains.reduce((sum, g) => sum + g.attack, 0);
  const score = total * rules.value.perStatPoint - cost * rules.goldPointValue;
  if (score <= 0) return null;

  return {
    action: 'heroPower',
    minion: null,
    score,
    cost,
    requiresSlot: false,
    sellFirst: null,
    targetMinion: target,
    sharesAttack: { partner, last: !second },
    boardGains: gains.map((g) => ({ ...g, health: 0 })),
    reason:
      `${info?.name ?? hero.heroPowerCardId} ${cost > 0 ? `за ${String(cost)}` : 'бесплатна'} — ` +
      `${words}: +${gains.map((g) => String(g.attack)).join(' и +')} атаки до следующего хода` +
      (second ? '' : '; жать в конце хода, после покупок'),
  };
}

/**
 * Насколько вырастет миньон, став ЗОЛОТЫМ, — по снапшоту, а не удвоением.
 *
 * Игра превращает цель в золотую карту и прибавляет ровно разницу базовых
 * статов, СОХРАНЯЯ накопленные усиления: part48, 13:29:04 — Бирюзовый
 * быстролап 35/14 становится 40/19 при базовых 5/5 и золотых 10/10.
 *
 * Считать «вдвое» было бы почти верно и потому опасно: по снапшоту золотая
 * копия удваивает статы у 377 карт пула из 379, а у двух — нет (Aureate
 * Laureate 2/2 → 2/2, Sky-hatch Runaway 4/7 → 10/14). Числа лежат в карте,
 * и брать их надо оттуда.
 *
 * `null` — карты в снапшоте нет или прибавки не выходит: советовать
 * превращение, которое ничего не даёт, нечестно.
 */
function goldenGain(
  cardId: string,
  cards: CardIndex,
): { readonly attack: number; readonly health: number } | null {
  const base = cards.info(cardId);
  if (base === null) return null;
  const golden = cards.info(`${cardId}_G`);
  // `info` при промахе снимает суффикс и возвращает ту же карту — тогда
  // золотой копии в снапшоте нет, и остаётся правило игры «вдвое».
  const real = golden !== null && golden.id !== base.id;
  const attack = (real ? (golden.attack ?? 0) : 2 * (base.attack ?? 0)) - (base.attack ?? 0);
  const health = (real ? (golden.health ?? 0) : 2 * (base.health ?? 0)) - (base.health ?? 0);
  if (attack + health <= 0) return null;
  return { attack, health };
}

/**
 * Средняя прибавка от превращения в золото по пулу тира — в СТАТАХ.
 *
 * Нужна цене спешки: заряд у силы один на партию, и «нажать позже» значит
 * нажать на теле, которое у нас будет к концу партии. Каким оно будет,
 * известно ровно с той же точностью, что у тёмного дара (part31) и лестницы
 * цен Элизы (part42), — по пулу тира, до которого дорастём.
 */
function averageGoldenGain(tier: number, cards: CardIndex): number | null {
  const pool = cards.poolOfTier(tier);
  if (pool.length === 0) return null;
  let sum = 0;
  for (const card of pool) {
    const gain = goldenGain(card.id, cards);
    sum += (gain?.attack ?? 0) + (gain?.health ?? 0);
  }
  return sum / pool.length;
}

/**
 * Правило силы героя, ДЕЛАЮЩЕЙ СВОЕГО МИНЬОНА ЗОЛОТЫМ.
 *
 * Рено Джексон (part48), «Нас ждёт богатство!» `TB_BaconShop_HP_046`:
 * «Once per game, make a friendly minion Golden». Сила БЕСПЛАТНА (тега
 * `COST` нет вовсе), активна с первого хода и не под замком — а советник
 * не назвал её ни в одной из двенадцати точек решения партии. Игрок нажал
 * её сам на 11-м ходу таверны и написал: «снова не видел силу героя, так
 * как не рекомендовал её нажать».
 *
 * Прибавка — читаемое число (`goldenGain`), шкала общая (`perStatPoint`),
 * своих весов у правила нет. Цель — крупнейшая прибавка среди НЕзолотых
 * своих мимо кандидатов в продажу: усиление тут вечное, и довод тот же,
 * что у заклинания-баффа (part17, part36).
 *
 * **Цена спешки обязательна, потому что заряд ОДИН НА ПАРТИЮ.** Без неё
 * бесплатный шаг встал бы в план первым же ходом и сжёг единственное
 * нажатие на теле 2/3: у нашей шкалы бесплатное действие с любыми
 * положительными очками в план входит всегда (part45). Арифметика — дара
 * (part31) при одном заряде: отложить значит нажать на ПОСЛЕДНЕМ ходу
 * партии, тир там даёт кривая `levelling`, а тело того тира — средняя
 * прибавка по его пулу. Спешка стоит разницу, и правило молчит, пока
 * она эту разницу не окупает.
 *
 * Оценка НИЖНЯЯ, и это сказано вслух в самом совете: золотая карта — это
 * не только двойные статы, но и усиленный ТЕКСТ (золотой Бирюзовый
 * быстролап призывает ДВУХ жуков вместо одного), а текст наша шкала тут
 * не считает. Занизить честнее: цена ошибки — «сила стоит ниже в списке»,
 * тогда как выдуманная надбавка сожгла бы единственный заряд раньше срока.
 */
export function heroPowerGoldenRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;
  if (!hero.heroPowerHasActivate) return null;
  if (!heroPowerReady(hero)) return null;
  const cost = hero.heroPowerCost ?? 0;
  if (cost > state.gold) return null;

  const cards = deps.cards;
  const info = cards.info(hero.heroPowerCardId);
  const text = info?.text ?? '';
  if (!rules.heroPowerGoldenWords.some((w) => new RegExp(w, 'i').test(text))) return null;

  // Золотого золотым не сделать — цель обязана быть незолотой; так это
  // и написано у соседней силы пула («Swap a friendly non-Golden minion»).
  const candidates = state.board
    .filter((m) => !m.golden)
    .map((m) => ({ minion: m, gain: goldenGain(m.cardId, cards) }))
    .filter((c): c is { minion: Minion; gain: { attack: number; health: number } } =>
      c.gain !== null,
    );
  if (candidates.length === 0) return null;
  const sellCandidates = sellCandidateIds(state, deps, rules);
  const keepers = candidates.filter((c) => !sellCandidates.has(c.minion.entityId));
  const pool = keepers.length > 0 ? keepers : candidates;

  const statsOf = (g: { attack: number; health: number }): number => g.attack + g.health;
  const body = (m: Minion): number => (m.attack ?? 0) + (m.health ?? 0);
  // При равной прибавке выбирается тело покрупнее: удвоение базы у них
  // одинаковое, а живёт в бою дольше тот, на ком уже стоят усиления.
  const best = pool.reduce((a, b) => {
    const diff = statsOf(b.gain) - statsOf(a.gain);
    if (diff !== 0) return diff > 0 ? b : a;
    return body(b.minion) > body(a.minion) ? b : a;
  });

  const now = statsOf(best.gain) * rules.value.perStatPoint;
  const hold = goldenHoldCost(now, state, cards, rules);
  const score = now - hold.cost - cost * rules.goldPointValue;
  if (score <= 0) return null;

  const name = cards.info(best.minion.cardId)?.name ?? best.minion.cardId;
  return {
    action: 'heroPower',
    minion: null,
    score,
    cost,
    requiresSlot: false,
    sellFirst: null,
    targetMinion: best.minion,
    grantsGolden: best.gain,
    reason:
      `${info?.name ?? hero.heroPowerCardId} ${cost > 0 ? `за ${String(cost)}` : 'бесплатна'} — ` +
      `сделать золотым ${name} ` +
      `${String(best.minion.attack ?? '?')}/${String(best.minion.health ?? '?')} ` +
      `(+${String(best.gain.attack)}/+${String(best.gain.health)}, ${now.toFixed(1)}); ` +
      `${hold.note}; текст золотой карты сильнее — этого счёт не считает`,
  };
}

/**
 * Цена спешки у силы с ОДНИМ зарядом на партию — см. `heroPowerGoldenRule`.
 *
 * Считается той же арифметикой, что у тёмного дара (part31): заряд один,
 * значит отложенное нажатие достаётся последнему ходу партии — горизонт
 * `remainingTurns` (замер part28), тир там — кривая `levelling` (part20),
 * тело того тира — средняя прибавка по его пулу. Оценка ВЕРХНЯЯ по той же
 * причине, что у дара: ТЕМП не считается — золотое тело, сделанное сейчас,
 * воюет в большем числе боёв, — поэтому совет обязан назвать и горизонт,
 * и цену словами.
 */
function goldenHoldCost(
  now: number,
  state: GameState,
  cards: CardIndex,
  rules: TavernRules,
): { readonly cost: number; readonly note: string } {
  const ahead = remainingTurns(state, rules);
  if (ahead <= 0) {
    return { cost: 0, note: 'заряд один на партию, но ходов впереди не осталось — жать' };
  }
  const lastTavernTurn = Math.round(tavernTurnOf(state.turn) + ahead);
  const tier = Math.max(state.techLevel, targetTier(2 * lastTavernTurn - 1, rules));
  const laterStats = averageGoldenGain(tier, cards);
  if (laterStats === null) {
    return { cost: 0, note: `заряд один на партию, впереди ещё ${ahead.toFixed(1)} ходов таверны` };
  }
  const later = laterStats * rules.value.perStatPoint;
  const cost = Math.max(0, later - now);
  return {
    cost,
    note:
      cost > 0
        ? `но заряд лучше придержать: он один на партию, впереди ещё ` +
          `${ahead.toFixed(1)} ходов таверны, а на тире ${String(tier)} среднее тело даёт ` +
          `${later.toFixed(1)} вместо ${now.toFixed(1)} — спешка стоит ${cost.toFixed(1)}`
        : `заряд один на партию, но тело крупнее среднего на тире ${String(tier)} ` +
          `(${later.toFixed(1)}) — ждать нечего`,
  };
}

/**
 * Правило силы героя, РАСКАПЫВАЮЩЕЙ золотого миньона за несколько нажатий.
 *
 * Капитан Юдора (part55), «Зарытое сокровище» `TB_BaconShop_HP_074`:
 * «Dig for a Golden minion! (4 Digs left.)», цена 1. Игрок нажимал её каждый
 * ход таверны начиная со второго и по кадру хода 3 написал: «не предложило
 * нажать силу героя, которую желательно нажимать на этом герое почаще».
 * Советник молчал всю партию: под шаблоны «даёт миньона» текст не подходит
 * ни одним словом, а награду приносит не каждое нажатие, а каждое четвёртое.
 *
 * Фактура из лога. Счётчик — `TAG_SCRIPT_DATA_NUM_1` на силе: 4 уже при
 * создании (FULL_ENTITY ID=198, 17:00:20), 3 → 2 → 1 по нажатиям ходов 3, 5
 * и 7, на ходу 9 — 0: в руку приходит ЗОЛОТОЙ миньон (`BG23_002_G`,
 * `CREATOR=198`), и счётчик тут же снова 4. Наград за партию три: Shell
 * Collector тира 2 при таверне 3, Firescale Hoarder тира 5 при таверне 5,
 * Bigwig Bandit тира 4 при таверне 6, — то есть случайный миньон тиров
 * от первого до своего. Розыгрыш каждой награды приносил Triple Reward
 * (17:04:35 → 17:04:37, 17:12:27 → 17:12:46, 17:22:10 → 17:22:18).
 *
 * Ценность — доля награды ПО ОСТАТКУ счётчика, та же арифметика, что у силы
 * «после N покупок» (D005): последнее нажатие стоит целой награды, первое
 * из четырёх — четверть, и сумма долей больше целого (оценка ВЕРХНЯЯ).
 * Награда — средний миньон тиров от первого до своего на этом борде плюс
 * бонус СОБРАННОЙ ТРОЙКИ из `copiesBonus`: золотая карта с наградой за
 * розыгрыш — ровно то, что приносит тройка, и своего веса правило
 * не заводит. Эта часть НИЖНЯЯ: тройка стоит двух копий, а раскопка их
 * не берёт.
 *
 * Цена в очки не переводится: золото списывает бюджет плана, как у покупки.
 * Награда, до которой партия по замеру горизонта не доживёт
 * (`remainingTurns` меньше, чем нажатий после этого), не стоит ничего.
 *
 * Чего правило НЕ считает: карт, растущих от сыгранных золотых (Maritime
 * Extortionist и Hooktusk на борде part55), — связь есть, числа у неё нет.
 */
export function heroPowerDigRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;
  if (!heroPowerReady(hero)) return null;
  // `null` — тега `COST` нет вовсе (D083); ноль тегом — скидка (D216).
  const cost = hero.heroPowerCost;
  if (cost === null) return null;

  const info = deps.cards.info(hero.heroPowerCardId);
  const hit = firstMatch(rules.heroPowerDigWords, info?.text ?? '');
  if (hit === null) return null;
  const written = Number.parseInt(hit, 10);
  const remaining = hero.heroPowerScriptData[0] ?? written;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const total = Number.isFinite(written) && written >= remaining ? written : remaining;

  // Место награде нужно только на том нажатии, которое её приносит (D008).
  const victim = remaining === 1 ? handMinionVictim(state, deps, rules) : null;
  if (cost > state.gold + (victim === null ? 0 : rules.sellGold)) return null;

  // Нажатий после этого — `remaining − 1`, и на каждое нужен свой ход.
  if (remaining - 1 > remainingTurns(state, rules)) return null;

  const tiers = shopTiers(state.techLevel);
  const body =
    averagePoolValue(tiers, state, deps, rules) ?? rules.value.perTechLevel * state.techLevel;
  const triple = rules.copiesBonus[rules.copiesBonus.length - 1] ?? 0;
  const reward = body + triple;
  const share = reward / remaining;
  if (victim !== null && share - victim.value <= rules.sellMargin) return null;

  const top = tiers[tiers.length - 1] ?? 1;
  const range = top <= 1 ? 'тира 1' : `тиров 1–${String(top)}`;
  return {
    action: 'heroPower',
    minion: null,
    score: share - (victim?.value ?? 0),
    cost,
    requiresSlot: false,
    // Жертва — полем только там, где без продажи силу не нажать (как у
    // `heroPowerRule`).
    sellFirst: victim !== null && cost > state.gold ? victim.minion : null,
    reason:
      `${info?.name ?? hero.heroPowerCardId} за ${String(cost)} — ` +
      `раскопка ${String(total - remaining + 1)} из ${String(total)}: ` +
      `золотой миньон ${range} (средний ${body.toFixed(1)} + тройка ${String(triple)})` +
      (remaining === 1
        ? ' приходит этим нажатием'
        : ` — доля ${share.toFixed(1)} из ${reward.toFixed(1)}, нажимать каждый ход`) +
      (victim === null ? '' : `; ${victim.note}`),
  };
}

/** Какое слово дарит сила — по тексту; `null`, если никакого. */
function grantedKeyword(text: string, rules: TavernRules): BinaryKeywordField | null {
  for (const word of rules.heroPowerKeywordWords) {
    const found = new RegExp(word, 'i').exec(text)?.[1]?.toLowerCase();
    if (found === undefined) continue;
    return KEYWORD_BY_WORD[found] ?? null;
  }
  return null;
}

/** Дарит ли хрип миньона то же слово — «Deathrattle: Give … Reborn». */
function deathrattleGrants(m: Minion, field: BinaryKeywordField, cards: CardIndex): boolean {
  const text = cards.info(m.cardId)?.text ?? '';
  return new RegExp(`deathrattle:[^.]*\\b${KEYWORD_WORD[field]}\\b`, 'i').test(text);
}

/**
 * Кому подарить слово — см. `heroPowerKeywordRule`. `null` — некому:
 * слово уже у всех.
 */
function keywordTarget(
  field: BinaryKeywordField,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): { readonly target: Minion; readonly notes: string[] } | null {
  const cards = deps.cards;
  const eligible = state.board.filter((m) => !m[field]);
  if (eligible.length === 0) return null;

  const notes: string[] = [];
  const sum = (m: Minion): number => (m.attack ?? 0) + (m.health ?? 0);
  const largest = (list: readonly Minion[]): Minion =>
    list.reduce((a, b) => (sum(b) > sum(a) ? b : a));
  let pool: readonly Minion[] = eligible;

  if (field === 'reborn') {
    const rattlers = pool.filter(
      (m) => cards.info(m.cardId)?.mechanics.includes('DEATHRATTLE') ?? false,
    );
    if (rattlers.length > 0) {
      pool = rattlers;
      notes.push('хрип сработает дважды');
    }
    const chains = pool.filter(
      (m) =>
        deathrattleGrants(m, field, cards) &&
        state.board.some((o) => o.entityId !== m.entityId && !o[field]),
    );
    if (chains.length > 0) {
      pool = chains;
      notes.push('его хрип сам дарит перерождение — цепочка');
    }
    const target = pool.reduce((a, b) =>
      (b.attack ?? 0) > (a.attack ?? 0) ||
      ((b.attack ?? 0) === (a.attack ?? 0) && sum(b) > sum(a))
        ? b
        : a,
    );
    notes.push('вернётся с полной атакой на одно здоровье');
    if (eligible.length < state.board.length) notes.push('у остальных оно уже есть');
    return { target, notes };
  }

  if (field === 'taunt') {
    const bodies = pool.filter((m) => !isEffectEngine(m, cards, rules));
    if (bodies.length > 0 && bodies.length < pool.length) {
      pool = bodies;
      notes.push('провокация зовёт удары, миньоны-эффекты не подставляются');
    }
  }
  if (eligible.length < state.board.length) notes.push('у остальных оно уже есть');
  return { target: largest(pool), notes };
}

/**
 * Правило силы героя, ВЫСТРЕЛИВАЮЩЕЙ миньоном витрины.
 *
 * Фактура — part29 (Scoutmaster Tavish, «Lock and Load» `BG22_HERO_000p_Alt`:
 * «Remove a minion in the Tavern. When you have space next combat, fire it
 * at a random enemy minion»). Сила БЕСПЛАТНА, активна (`HAS_ACTIVATE_POWER`
 * без тега `COST`) и жмётся каждый ход; игрок нажал её 13 раз за партию
 * и написал: «мне не рекомендует, на кого лучше применить силу героя
 * (стоит 0, даёт много вэлью на первых ходах)».
 *
 * Что делает лог (01:09:37): блок `PLAY` на сущности силы с `Target=`
 * миньоном витрины, копия цели уходит в `SETASIDE` под нашим контроллером
 * (`TAG_SCRIPT_DATA_ENT_1` силы), счётчик заряда `TAG_SCRIPT_DATA_NUM_1`
 * 0 → 1, а сам миньон витрины — в `REMOVEDFROMGAME`. В начале боя заряд
 * тратится обратно в ноль, копия выходит на пустой слот и меняется ударом
 * с чужим миньоном (01:10:40: Клыкастый походник получает 4 урона
 * и уходит).
 *
 * Отсюда три следствия, и все три — арифметика, а не мнение:
 *
 *  1. **Цель судится БОЕМ, а не покупкой.** Выстреленный миньон живёт один
 *     размен и не остаётся ни на борде, ни в композиции: тир, племя, копии
 *     и экономика к нему не относятся вовсе. Считается ровно то, что
 *     миньон приносит в драку, — статы, ключевые слова и боевой эффект
 *     текста (`combatValue`), теми же весами, что и везде.
 *  2. **Стрелять надо тем, чего мы не купим.** Карта уходит из витрины
 *     насовсем, и выстрел в лучшую покупку — это выстрел себе в ход.
 *     Отбрасываются `affordable` лучших по обычной ценности, где
 *     `affordable` ограничено и золотом, и свободными слотами борда:
 *     купить больше, чем есть места, нельзя. Так игрок и играл — на ходах
 *     1, 3 и 5 стрелял ровно тем, что оставалось после покупки.
 *  3. **Без свободного слота выстрела не будет** — это сказано в самом
 *     тексте силы («when you have space next combat»), и тратить на него
 *     карту витрины впустую незачем.
 *
 * Совет бесплатный, поэтому в плане он не спорит с покупками за золото:
 * он лишь называет цель. Порядок в списке решают очки цели.
 */
/**
 * Сила героя, ПОДНИМАЮЩАЯ карту витрины на тир выше, — «Алчность
 * Галакронда» `TB_BaconShop_HP_011` (part47): «Choose a minion in the
 * Tavern. Then choose a higher Tier minion to replace it», цена 1.
 *
 * **Молчание было полным, и это его цена:** сила активна с первого хода,
 * не под замком и стоит золотой, а под шаблоны «даёт миньона» не подходит
 * ни одним словом — ни «discover», ни «get», ни «add … to your hand»,
 * — поэтому `heroPowerRule` отбрасывал её ещё до счёта. За part47 игрок
 * нажал её ПЯТЬ раз, советник не назвал её ни в одной из десяти точек
 * решения, и пришла жалоба: «на данном герое выгоднее нажимать силу героя
 * и получать рано сильных существ».
 *
 * **Фактура прочитана из лога, а не из текста карты.** Пять нажатий подряд
 * дают одно и то же: цель — миньон ВИТРИНЫ (`Target=… player=16`), следом
 * `DebugPrintEntityChoices` с ТРЕМЯ вариантами, и у всех трёх
 * `TECH_LEVEL` ровно на единицу выше тира цели (1→2, 2→3, 3→4, 4→5, 5→6).
 * Выбранный встаёт В ВИТРИНУ на место цели, а сама цель уходит
 * в `REMOVEDFROMGAME`, — то есть тело мы получаем не бесплатно, за него
 * ещё надо заплатить обычную цену покупки.
 *
 * **Оценка считается ПОКУПКАМИ, а не слотом, и это не вкус.** Слотовая
 * форма («ожидание тира N+1 минус ценность цели») на part47 переворачивает
 * ход 7: там шесть золотых покупают ДВА тела по 18.5, а нажатие оставляет
 * пять — то есть одно, — и слотовая форма звала бы жать, теряя 18.5.
 * Поэтому форма та же, что у `discountRefreshRule`: лучшие покупки,
 * которые витрина отдаёт ПОСЛЕ нажатия на остаток золота, минус лучшие
 * покупки по карману СЕЙЧАС. Цена силы при этом вычитается ровно один раз
 * — уменьшением бюджета, — а не ещё и по курсу золота: двойной счёт делал
 * ход 3 отрицательным (−1.88 вместо +1.12) и гасил ровно тот случай,
 * на который игрок и жаловался.
 *
 * **Цель выбирается по РАЗНИЦЕ, а не по тиру** (урок part44): поднимать
 * надо ту карту, чей подъём даёт больше всего, — на ходу 11 part47 это
 * Eternal Knight тира 2 (+7.4), а не Costume Enthusiast тира 5 (+4.8),
 * потому что вторую мы и так купим. Карта, которая ЛУЧШЕ ожидания своего
 * тира+1, целью не становится вовсе: на ходу 19 подъём Motley Phalanx
 * стоил бы −9.8.
 *
 * **Чего правило НЕ считает, названо вслух.** Игрок играл ЛЕСТНИЦЕЙ:
 * морозил витрину (8 заморозок за партию) и каждый ход поднимал ОДНУ
 * И ТУ ЖЕ карту на тир — 1→2→3→4→5→6, — так что к 11-му ходу при таверне 2
 * в витрине стоял тир 5. Одноходовая оценка этого не видит: она меряет
 * прирост ЭТОГО хода, а лестница копится ходами. Складывать её в число
 * мы не станем — горизонта у неё нет, а выдуманный коэффициент перевернул
 * бы и подъём таверны; лестница получается САМА, если каждый её шаг
 * положителен и витрину держит `freezeRule`.
 */
export function heroPowerUpgradeRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;
  if (!heroPowerReady(hero)) return null;

  const cost = hero.heroPowerCost;
  if (cost === null || cost < 0) return null;
  if (cost > state.gold) return null;

  const info = deps.cards.info(hero.heroPowerCardId);
  const text = info?.text ?? '';
  if (text === '') return null;
  if (!rules.heroPowerUpgradeWords.some((w) => new RegExp(w, 'i').test(text))) return null;

  // Поднятая карта остаётся В ВИТРИНЕ, и без покупки она этот ход
  // не значит ничего — то же условие, что у платного обновления
  // (`paidRerollIsUseful`, part18). Держать её заморозкой ради следующего
  // хода правило не обещает: это уже лестница, а её мы не считаем.
  const goldAfter = state.gold - cost;
  if (bodiesAffordable(state, goldAfter, rules) <= 0) return null;

  // Что витрина отдаёт при данном золоте: лучшие по ценности, пока хватает
  // денег. Одной функцией на оба вопроса — «сейчас» и «после», — иначе
  // сравнивались бы числа с разной начинкой.
  const bestBuys = (offers: readonly { cost: number; value: number }[], gold: number): number => {
    let left = gold;
    let sum = 0;
    for (const offer of [...offers].sort((a, b) => b.value - a.value)) {
      if (offer.cost > left) continue;
      left -= offer.cost;
      sum += offer.value;
    }
    return sum;
  };

  const offers = state.shop.map((m) => ({
    minion: m,
    cost: buyCostOf(m, rules),
    value: minionValue(m, state, deps, rules).total,
  }));
  if (offers.length === 0) return null;
  const now = bestBuys(offers, state.gold);

  let best: {
    minion: Minion;
    expected: number;
    tier: number;
    score: number;
    value: number;
  } | null = null;
  for (const offer of offers) {
    const tier = offer.minion.techLevel ?? state.techLevel;
    const expected = discoverPoolValue([tier + 1], state, deps, rules);
    // Пула выше нет — с верхнего тира поднимать некуда, и это не ошибка.
    if (expected === null) continue;
    // Цена поднятой карты — обычная цена покупки: живой цены у неё ещё
    // нет вовсе (её создаст игра), а тег скидки к новой сущности
    // не относится.
    const after = bestBuys(
      offers
        .filter((o) => o !== offer)
        .concat([{ minion: offer.minion, cost: rules.minionCost, value: expected }]),
      goldAfter,
    );
    const score = after - now;
    // При РАВНЫХ очках цель — та, которой жальче меньше. На ходу 3 part47
    // подъём Ominous Seer и подъём Molten Rock дают одно и то же (+1.12:
    // тир цели один, и в обоих случаях покупается поднятая карта), но Seer
    // мы собираем в тройку — игрок и поднял Molten Rock. Без этого правило
    // выбирало бы просто первую карту ряда.
    const better =
      best === null ||
      score > best.score ||
      (score === best.score && offer.value < best.value);
    if (better) best = { minion: offer.minion, expected, tier, score, value: offer.value };
  }
  if (best === null || best.score <= 0) return null;

  const name = info?.name ?? hero.heroPowerCardId;
  const targetName = deps.cards.info(best.minion.cardId)?.name ?? best.minion.cardId;
  return {
    action: 'heroPower',
    minion: best.minion,
    score: best.score,
    cost,
    requiresSlot: false,
    sellFirst: null,
    // Что предложит выбор из трёх, решает игра, поэтому план после шага
    // обрывается, как после обновления витрины (`discountRefreshRule`),
    // а золото обещанной покупки списывается — иначе остаток числился бы
    // сгоревшим и развилка ставила бы нажатие не туда.
    refreshesShop: true,
    refreshSpend: Math.min(goldAfter, rules.minionCost),
    searchGoal: `${targetName} т${String(best.tier)} → тир ${String(best.tier + 1)}`,
    reason:
      `${name} за ${String(cost)} — поднять ${targetName} ` +
      `с тира ${String(best.tier)} на ${String(best.tier + 1)} ` +
      `(выбор из трёх, тело по пулу ≈ ${best.expected.toFixed(1)}); ` +
      `покупки хода ${(now + best.score).toFixed(1)} против ${now.toFixed(1)} без нажатия`,
  };
}

export function heroPowerShotRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;
  if (!hero.heroPowerHasActivate) return null;
  if ((hero.heroPowerCost ?? 0) > 0) return null;
  if (!heroPowerReady(hero)) return null;
  if (state.board.length >= rules.boardSize) return null;
  if (state.shop.length === 0) return null;

  const info = deps.cards.info(hero.heroPowerCardId);
  const text = info?.text ?? '';
  if (!rules.heroPowerShotWords.some((w) => new RegExp(w, 'i').test(text))) return null;

  // Купить можно не больше, чем позволяют и золото, и место на борде.
  const affordable = Math.min(
    bodiesAffordable(state, state.gold, rules),
    rules.boardSize - state.board.length,
  );
  const leftovers = state.shop
    .map((m) => ({ minion: m, value: minionValue(m, state, deps, rules).total }))
    .sort((a, b) => b.value - a.value)
    .slice(affordable);
  if (leftovers.length === 0) return null;

  const best = leftovers
    .map((v) => ({ minion: v.minion, shot: combatValue(v.minion, state, deps, rules) }))
    .sort((a, b) => b.shot - a.shot)[0];
  if (best === undefined || best.shot <= 0) return null;

  const name = deps.cards.info(best.minion.cardId)?.name ?? best.minion.cardId;
  return {
    action: 'heroPower',
    minion: best.minion,
    score: best.shot,
    cost: 0,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `${info?.name ?? hero.heroPowerCardId} бесплатна — выстрелить ` +
      `${name} ${String(best.minion.attack ?? '?')}/${String(best.minion.health ?? '?')} ` +
      `(в бою он стоит ${best.shot.toFixed(1)}); ` +
      'из витрины он уходит насовсем, поэтому стреляем тем, что не покупаем',
  };
}

/**
 * Чего миньон стоит в ОДНОМ бою — без тира, племени, копий и экономики.
 *
 * Обычная `minionValue` отвечает на вопрос «стоит ли его купить», и больше
 * половины её очков — про будущее: тир, соплеменники, тройка, обещание
 * продажи. У выстреленного миньона будущего нет, он живёт один размен.
 * Поэтому берутся ровно три слагаемых той же разбивки — статы, ключевые
 * слова и боевой эффект текста, — и никаких своих весов не заводится.
 */
function combatValue(
  minion: Minion,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): number {
  const v = minionValue(minion, state, deps, rules);
  return v.stats + v.keywords + v.battle;
}

/**
 * Правило силы героя, дающей заклинание таверны.
 *
 * Случай part15 (Холли'дэй, «Благословение девяти лягушек»: «Get a random
 * Tavern spell», HAS_ACTIVATE_POWER, COST=1): на ходу 7 у игрока оставалось
 * 1 золото, совет молчал, и золото сгорало — на что игрок и указал.
 *
 * Ценность — примерно цена заклинания таверны в витрине (два золота
 * по курсу), очки — ценность минус цена силы. При силе за 1 очков мало,
 * и совет всплывает к концу хода, когда крупные траты сделаны, — ровно
 * как напоминание о бесплатной силе. Про платные силы вне «даёт миньона»
 * и «даёт заклинание» совет по-прежнему не берётся судить.
 */
export function heroPowerSpellRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;
  if (!hero.heroPowerHasActivate) return null;
  if (!heroPowerReady(hero)) return null;

  // НОЛЬ ТЕГОМ — это СКИДКА, а не «бесплатная сила», и отсекать его нельзя.
  // Различие несёт сам тип: `null` — тега `COST` нет вовсе, сила бесплатна
  // по устройству (D083), и ею занимается `freeHeroPowerRule`; `0` — живая
  // цена, доехавшая до нуля. part53, Нобундо «Галактическая линза»
  // `BG31_HERO_003p` («Each turn, your next Hero Power costs (1) less»):
  // цена в логе идёт 3 → 2 → 1 → 0 по ходам и сбрасывается в 3 нажатием
  // (01:08:21, 01:09:01, 01:09:58, сброс 01:10:28). На нуле сила бесплатна
  // и приносит заклинание в руку — а советник молчал ровно там, потому что
  // «дешевле некуда» читалось как «цены нет». Жалоба игрока была об этом.
  const cost = hero.heroPowerCost;
  if (cost === null || cost > state.gold) return null;

  const info = deps.cards.info(hero.heroPowerCardId);
  const text = info?.text ?? '';
  if (!rules.heroPowerSpellWords.some((w) => new RegExp(w, 'i').test(text))) return null;

  const score = rules.heroPowerSpellValue - cost * rules.goldPointValue;
  if (score <= 0) return null;

  return {
    action: 'heroPower',
    minion: null,
    score,
    cost,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `${info?.name ?? hero.heroPowerCardId} ${cost > 0 ? `за ${String(cost)}` : 'бесплатна'} ` +
      'даёт заклинание таверны — ' +
      (cost > 0
        ? 'оно стоит дороже своей цены, нажать, пока золото не сгорело'
        : // На нуле ждать больше нечего: ниже цена не опускается, а каждый
          // непрожатый ход — потерянное заклинание. Слово «бесплатно» тут
          // не украшение: оно единственное объясняет, почему шаг стоит
          // делать даже при пустом кошельке.
          'нажать в любом случае: дешевле уже не станет, а ход без нажатия ' +
          'теряет его совсем'),
  };
}

/**
 * Правило силы героя, ДАЮЩЕЙ ЗОЛОТО.
 *
 * Случай part39 (Змеиный Глаз, «Удачный бросок» `BG28_HERO_400p` за 1:
 * «Roll a 6-sided die. Gain that much Gold»). Советник молчал про неё все
 * десять точек решения партии, хотя игрок нажимал её всякий раз, как она
 * открывалась, — и жалоба игрока по скриншоту хода 13 была ровно об этом.
 * Дыра ЧИСТО ТЕКСТОВАЯ: пять прежних правил силы читают «даёт миньона»,
 * «обновляет витрину», «даёт заклинание таверны», «дарит слово»
 * и «выстреливает миньона», а разбор золота у заклинаний требует ЦИФРУ
 * («gain \d+ gold») и «that much» не видит — тот же класс, что счёт словом
 * против цифры в part38.
 *
 * КУЛДАУН СЛЕПОТОЙ НЕ ЯВЛЯЕТСЯ, и нового канала для него не нужно.
 * У этой силы кулдаун равен выпавшему числу («Cannot be used again for that
 * many turns»), и на перезарядке игра подменяет сущность силы: вместо
 * `BG28_HERO_400p` (COST=1, HAS_ACTIVATE_POWER=1) стоит `BG28_HERO_400p2`
 * с `LOCK_VISUAL=1`, без цены и без активности, а остаток ходов живёт
 * в `TAG_SCRIPT_DATA_NUM_1` (5→4→3→2→1→0 по ходам таверны). Все три
 * признака уже читаются: `heroPowerHasActivate` (part13) и `heroPowerReady`
 * с замком `LOCK_VISUAL` (part37). Замерено на part39: сила по-настоящему
 * доступна ровно в двух точках решения из десяти — ходы 11 и 13, — и обе
 * это те, где игрок её нажал.
 *
 * ДВА ЧИСЛА ДЛЯ ДВУХ ВОПРОСОВ. В СПИСОК идёт ОЖИДАНИЕ: `(N+1)/2` золота
 * по числу граней из текста, минус цена, по курсу `goldPointValue`.
 * В ПЛАН идёт НИЖНЯЯ ГРАНЬ (`grantsGold: 1`), и это не осторожность,
 * а факт: цепочку нельзя строить на 3.5 золота — суммы, которой у игрока
 * не бывает никогда, — иначе вернётся симптом part24 «откроется покупка X»,
 * а покупка не открывается. При цене 1 и поле 1 остаток не меняется,
 * и план не обещает ничего, чего не гарантирует худший бросок.
 *
 * Оценка НИЖНЯЯ ещё и по курсу: `goldPointValue` выведен из «покупка за 3
 * даёт миньона на ~9 очков», а на ходу 13 part39 верхняя покупка стоила
 * 20.5 за три золота. Двигать курс под этот случай нельзя — он держит
 * десяток мест и требует замера с предрегистрацией.
 *
 * Цены спешки по образцу тёмного дара (part31) здесь нет НАМЕРЕННО:
 * у дара заряды конечны и предложение растёт по ходам, поэтому раннее
 * нажатие вытесняет позднее. Тут ресурс — ходы, кулдаун РАВЕН броску,
 * и скорость выходит одна и та же при любой грани: приберегать нечего,
 * а ненажатая готовая сила просто теряет готовые ходы.
 */
export function heroPowerGoldRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;
  if (!hero.heroPowerHasActivate) return null;
  if (!heroPowerReady(hero)) return null;

  const cost = hero.heroPowerCost ?? 0;
  if (cost > state.gold) return null;

  const info = deps.cards.info(hero.heroPowerCardId);
  const text = info?.text ?? '';
  let sides: number | null = null;
  for (const word of rules.heroPowerGoldWords) {
    const raw = new RegExp(word, 'i').exec(text)?.[1];
    if (raw === undefined) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      sides = parsed;
      break;
    }
  }
  if (sides === null) return null;

  const expected = (sides + 1) / 2;
  const score = (expected - cost) * rules.goldPointValue;
  if (score <= 0) return null;

  const name = info?.name ?? hero.heroPowerCardId;
  const net = expected - cost;
  return {
    action: 'heroPower',
    minion: null,
    score,
    cost,
    requiresSlot: false,
    sellFirst: null,
    // В план идёт ХУДШИЙ бросок, а не среднее: см. «два числа» выше.
    grantsGold: 1,
    reason:
      `${name}${cost > 0 ? ` за ${String(cost)}` : ''} — кубик 1–${String(sides)}, ` +
      `в среднем ${expected.toFixed(1)} золота (чистыми ${net.toFixed(1)}); ` +
      'после броска сила молчит столько ходов таверны, сколько выпало — ' +
      'жать, пока открыта',
  };
}

/**
 * Сколько статов принесёт «поглощение витрины» — или `null`, если текст
 * не про это.
 *
 * Все три множителя читаемы: племя едоков названо в тексте («your Demons»),
 * их число — на борде, средние статы съедаемого — в витрине. Золотая версия
 * удваивает. Пустая витрина (её ещё не видели) честно даёт `null`:
 * без съедаемого числа нет.
 */
function consumeGain(
  effectText: string,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): { readonly eaters: number; readonly stats: number } | null {
  const match = firstMatch(rules.consumeTavernWords, effectText);
  if (match === null || match === '') return null;

  const race = Object.entries(rules.tribeTextWords).find(([, word]) =>
    new RegExp(`^(?:${word})$`, 'i').test(match),
  )?.[0];
  if (race === undefined) return null;

  const eaters = boardMatesOfTribes([race], state.board, deps.cards);
  if (eaters === 0 || state.shop.length === 0) return null;

  const perCard =
    state.shop.reduce((sum, m) => sum + (m.attack ?? 0) + (m.health ?? 0), 0) / state.shop.length;
  const times = rules.doubleStatsWords.some((w) => new RegExp(w, 'i').test(effectText)) ? 2 : 1;
  // Съесть можно только то, что в витрине есть: едоков может быть больше карт.
  const meals = Math.min(eaters, state.shop.length);
  return { eaters, stats: meals * perCard * times };
}

/**
 * Текст эффекта активации — или `null`, если у миньона её нет.
 *
 * Одна функция на двух читателей: правило активаций (что нажать сейчас)
 * и слагаемое активации в ценности тела (`activationBoardStats`). Второе
 * определение того же разбора рядом — ровно тот способ, которым правила
 * расходятся молча.
 */
function activateEffectText(minion: Minion, cards: CardIndex): string | null {
  if ((minion.tags['HAS_ACTIVATE_POWER'] ?? 0) <= 0) return null;
  const text = cards.info(minion.cardId)?.text ?? '';
  return /activate \([^)]*\):([\s\S]*)$/i.exec(text)?.[1] ?? null;
}

/** Сумма прибавки статов из текста активации: «+{0}/+{1}» или «+2/+2». */
function activationStats(minion: Minion, effectText: string): number {
  let stats = 0;
  for (const m of effectText.matchAll(/\+(?:\{(\d)\}|(\d+))/g)) {
    const placeholder = m[1];
    const literal = m[2];
    if (placeholder !== undefined) stats += minion.scriptData[Number(placeholder)] ?? 0;
    else if (literal !== undefined) stats += Number(literal);
  }
  return stats;
}

/**
 * Сколько СТАТОВ кладёт на НАШ борд одно нажатие активации этого миньона.
 *
 * Зачем слагаемое. Наша шкала меряет ТЕЛА (тир, статы, ключевые слова),
 * а повторяемая способность за золото не входила в неё ни одним числом.
 * На part44 (ход 11) это вышло наружу: Suspicious Prisonguard 3/3 тира 1
 * («Activate (1): Give another minion +3/+3») стоил 5.0 и уходил в жертву
 * первым, а отработавший клич Oozeling Gladiator 2/2 тира 2 — 6.0
 * и оставался, потому что тир у него выше. Игрок продал ровно наоборот.
 *
 * **Почему это ЧИСЛО, а не запрет «носителя активации не продавать».**
 * Запрет был написан первым и ЗАМЕРЕН на корпусе: 469 точек решения
 * 41 партии, жертва менялась в 18, и в худших случаях он предлагал
 * продать Kalecgos 190/159 (194.0), лишь бы сберечь Hired Mount 40/52
 * (60.5) — разница 133.5 очка. Запрет не масштабируется: «+3/+3 за
 * золотой» решает на пятом ходу и не значит ничего на борде из
 * стопятидесятых. Число масштабируется само.
 *
 * **Считается только то, что читается ТОЧНО и достаётся НАШЕМУ борду:**
 *
 *  - «Give another minion +{0}/+{1}» — прибавка в наших же единицах;
 *  - «Set another minion's stats to {1}/{2}» — РАЗНОСТЬЮ с лучшей целью
 *    (part40), и она сама убывает по мере роста борда;
 *  - витринные усиления («all minions in the Tavern +{1}/+{2}», Deft
 *    Deserter) НЕ считаются: статы достаются витрине, а не нам, — тот же
 *    признак, что у заклинаний с part43;
 *  - «Get/Discover/Summon …» и поглощение витрины НЕ считаются: там
 *    у нас курс, а не число («принесёт миньона» у Fruit Vendor — это
 *    вообще заклинания-бананы), и слагаемое из курса раздуло бы ценность
 *    ровно там, где мы читаем хуже всего;
 *  - эффекты со словом «destroy» (Dead Bellringer: «destroy it to gain
 *    +{1}/+{2}») НЕ считаются: прибавка там оплачена своим же миньоном,
 *    а цену мы не читаем.
 *
 * Цена нажатия в золоте здесь НЕ вычитается, и это осознанно: слагаемое
 * отвечает на вопрос «сколько стоит ЭТО ТЕЛО», а не «нажать ли сейчас» —
 * на второй отвечает `activationRules`, и там золото вычитается. Оценка
 * от этого ВЕРХНЯЯ на цену золота и НИЖНЯЯ на число будущих нажатий.
 *
 * Класс назван: в пуле 395 миньонов активация у 17, точно читаемых
 * эффектов — три (Suspicious Prisonguard, Tyrael, Dead Bellringer, причём
 * последний отсеивается словом «destroy»).
 */
function activationBoardStats(
  minion: Minion,
  state: GameState,
  cards: CardIndex,
  rules: TavernRules,
): number {
  const effectText = activateEffectText(minion, cards);
  if (effectText === null) return 0;
  if (/\bdestroy\b/i.test(effectText)) return 0;
  if (rules.buffsShopWords.some((w) => new RegExp(w, 'i').test(effectText))) return 0;

  const others = state.board.filter((m) => m.entityId !== minion.entityId);
  const setStats = setStatsOf(minion, effectText, rules);
  if (setStats !== null) {
    if (others.length === 0) return 0;
    const best = others.reduce((a, b) =>
      setStats.total - ((b.attack ?? 0) + (b.health ?? 0)) >
      setStats.total - ((a.attack ?? 0) + (a.health ?? 0))
        ? b
        : a,
    );
    return Math.max(0, setStats.total - ((best.attack ?? 0) + (best.health ?? 0)));
  }

  const stats = activationStats(minion, effectText);
  // «Give ANOTHER minion» — цель на борде, и без неё прибавке некуда лечь.
  if (stats > 0 && /\banother\b/i.test(effectText) && others.length === 0) return 0;
  return stats;
}

/**
 * Абсолютные статы «задать статы» — или `null`, если текст не про это.
 *
 * Числа читаются так же, как везде: плейсхолдер `{N}` — индекс
 * в `TAG_SCRIPT_DATA_NUM` САМОГО миньона, литерал — числом (part40, Тираэль:
 * `scriptData = [1, 50, 50]`, то есть цена 1 и статы 50/50).
 */
export function setStatsOf(
  minion: Minion,
  effectText: string,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): { readonly attack: number; readonly health: number; readonly total: number } | null {
  for (const word of rules.setStatsWords) {
    const m = new RegExp(word, 'i').exec(effectText);
    if (m === null) continue;
    const read = (placeholder: string | undefined, literal: string | undefined): number | null => {
      if (placeholder !== undefined) return minion.scriptData[Number(placeholder)] ?? null;
      if (literal !== undefined) return Number(literal);
      return null;
    };
    const attack = read(m[1], m[2]);
    const health = read(m[3], m[4]);
    // Тег ещё не пришёл — числа нет, и выдумывать его нельзя: «неизвестно»
    // честнее нуля (тот же довод, что у счётчиков globalInfo).
    if (attack === null || health === null) return null;
    return { attack, health, total: attack + health };
  }
  return null;
}

/**
 * Правило активаций миньонов.
 *
 * «Activate (N): …» — способность своего миньона на борде за золото.
 * Фактура part14 (Suspicious Prisonguard): активируемость — тег
 * `HAS_ACTIVATE_POWER` на миньоне; цена — живой тег
 * `INTERACTABLE_OBJECT_COST` (сходится с плейсхолдером «Activate ({2})» →
 * `TAG_SCRIPT_DATA_NUM_3`); применение — блок `BlockType=PLAY` на сущности,
 * СТОЯЩЕЙ в `PLAY`. Игрок указал, что активации не советовались вовсе —
 * прежде они были отложены с фактурой part8.
 *
 * Эффект читается из текста тем же разбором, что у заклинаний: бафф-статы
 * («Give another minion +{0}/+{1}», плейсхолдеры — теги NUM самого миньона),
 * получение миньона («Get a random Murloc») и поглощение витрины
 * (`consumeGain`, part24). Про остальное — кражи, сложные симбиозы — совет
 * честно не берётся судить, как и с силами героя.
 */
type StatGain = { readonly entityId: number; readonly attack: number; readonly health: number };

/**
 * Что даст своему борду RALLY миньона, если он атакует прямо сейчас.
 *
 * Читаются только формы с фактурой: «Give your other minions +{0}/+{1}»
 * (Wolf Pup, part56 — в логе +4/+1 шести соседям), «Give your minions»
 * и «Gain +{0} Attack» (Glim Guardian). Прочее — пустой список: ралли,
 * которое мы не читаем, просто не добавляет очков.
 */
function rallyGains(attacker: Minion, board: readonly Minion[], cards: CardIndex): StatGain[] {
  const text = cards.info(attacker.cardId)?.text ?? '';
  const clause = /\brally:\s*(?:<\/b>)?\s*([\s\S]*)$/i.exec(text)?.[1];
  if (clause === undefined) return [];
  const read = (ph: string | undefined, lit: string | undefined): number =>
    ph !== undefined ? (attacker.scriptData[Number(ph)] ?? 0) : Number(lit ?? 0);
  const pair = /\+(?:\{(\d)\}|(\d+))\s*\/\s*\+(?:\{(\d)\}|(\d+))/.exec(clause);
  const single = /\+(?:\{(\d)\}|(\d+))\s+(attack|health)\b/i.exec(clause);
  let attack = 0;
  let health = 0;
  if (pair !== null) {
    attack = read(pair[1], pair[2]);
    health = read(pair[3], pair[4]);
  } else if (single !== null) {
    const value = read(single[1], single[2]);
    if (single[3]?.toLowerCase() === 'attack') attack = value;
    else health = value;
  } else {
    return [];
  }
  const whom = /^\s*give\s+your\s+other\s+minions\b/i.test(clause)
    ? board.filter((m) => m.entityId !== attacker.entityId)
    : /^\s*give\s+your\s+minions\b/i.test(clause)
      ? board
      : /^\s*gain\b/i.test(clause)
        ? [attacker]
        : [];
  return whom.map((m) => ({ entityId: m.entityId, attack, health }));
}

/**
 * Активация-приманка Lurking Lionfish (part56, `rules.fishbaitWords`).
 *
 * Бьёт САМЫЙ ЛЕВЫЙ свой зверь, и расстановку в таверне игрок меняет
 * свободно — поэтому атакующим берётся тот зверь, чей удар даёт больше:
 * хрип приманки (+5/+5 убийце) плюс его собственное Rally. Игрок так и сделал:
 * купленного Wolf Pup поставил левее всех. Если лучший не стоит левым,
 * совет говорит это словами.
 *
 * Карта витрины, которую заменит приманка, — самая мелкая: её и называет
 * совет целью.
 */
function fishbaitOf(
  effectText: string,
  state: GameState,
  cards: CardIndex,
  rules: TavernRules,
): { gains: StatGain[]; total: number; wide: boolean; words: string; replaced: Minion | null } | null {
  let found: RegExpExecArray | null = null;
  for (const w of rules.fishbaitWords) {
    found = new RegExp(w, 'i').exec(effectText);
    if (found !== null) break;
  }
  if (found === null) return null;
  const golden = found[1] !== undefined;
  const bait = rules.fishbaitBuff * (golden ? 2 : 1);
  const tribeWord = found[2] ?? '';
  const race =
    Object.entries(rules.tribeTextWords).find(([, w]) => new RegExp(`^(?:${w})$`, 'i').test(tribeWord))?.[0] ??
    null;
  if (race === null) return null;
  const tribe = state.board.filter((m) => {
    const races = racesOf(m, cards);
    return races.includes(race) || races.includes('ALL');
  });
  if (tribe.length === 0) return null;

  const sum = (list: readonly StatGain[]): number => list.reduce((s, g) => s + g.attack + g.health, 0);
  const options = tribe.map((attacker) => {
    // Приманка 0/1 (золотая 0/2): убить её нечем — хрипа нет, ралли всё равно есть.
    const kills = (attacker.attack ?? 0) >= (golden ? 2 : 1);
    const gains = [
      ...(kills ? [{ entityId: attacker.entityId, attack: bait, health: bait }] : []),
      ...rallyGains(attacker, state.board, cards),
    ];
    return { attacker, gains, total: sum(gains) };
  });
  const best = options.reduce((a, b) => (b.total > a.total ? b : a));
  if (best.total <= 0) return null;

  const name = cards.info(best.attacker.cardId)?.name ?? best.attacker.cardId;
  const leftmost = tribe[0]?.entityId === best.attacker.entityId;
  const rally = best.gains.filter((g) => g.entityId !== best.attacker.entityId).length;
  const replaced =
    state.shop.length === 0
      ? null
      : state.shop.reduce((a, b) =>
          (b.attack ?? 0) + (b.health ?? 0) < (a.attack ?? 0) + (a.health ?? 0) ? b : a,
        );
  return {
    gains: best.gains,
    total: best.total,
    wide: rally > 1,
    replaced,
    words:
      `${name} бьёт приманку — +${String(best.total)} статов` +
      (rally > 0 ? ` (с его ралли на ${String(rally)} соседей)` : '') +
      (leftmost ? '' : `; ${name} поставить левее всех зверей`),
  };
}

export function activationRules(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation[] {
  return state.board.flatMap((minion) => {
    if ((minion.tags['HAS_ACTIVATE_POWER'] ?? 0) <= 0) return [];
    if (state.activatedEntityIds.includes(minion.entityId)) return [];
    if ((minion.tags['LITERALLY_UNPLAYABLE'] ?? 0) > 0) return [];
    const cost = minion.tags['INTERACTABLE_OBJECT_COST'] ?? 0;
    if (cost > state.gold) return [];

    const info = deps.cards.info(minion.cardId);
    const effectText = activateEffectText(minion, deps.cards);
    if (effectText === null) return [];

    // Тот же разбор, что у заклинаний: литералы и плейсхолдеры-индексы
    // в теги NUM — только теги здесь живут на самом миньоне.
    const stats = activationStats(minion, effectText);
    const givesMinion = /\b(?:get|summon|discover)\b/i.test(effectText);
    /**
     * «…Then destroy it…» — указанный миньон не получатель прибавки,
     * а РАСХОДНИК (part50, «Мертвый звонарь» `BG36_511`: «Give a different
     * friendly Undead Reborn. Then destroy it to gain +{1}/+{2}»).
     *
     * Общее правило «цель баффа — крупнейший свой» тут даёт совет, который
     * при буквальном исполнении убивает главную карту борда: на ходу 31
     * part50 план предлагал указать на Drustfallen Butcher 2636/2401.
     * Лог показывает, что происходит на самом деле: цель уходит в GRAVEYARD
     * и возвращается БАЗОВОЙ копией (Мумификатор с накопленными статами
     * вернулся с ATK=5), а `+8/+8` получает сам звонарь (111/44 → 119/52).
     */
    const destroysTarget = /\bdestroy\s+it\b/i.test(effectText);

    // «Задать статы» — не прибавка, и числа тут АБСОЛЮТНЫЕ (part40, Тираэль:
    // «Set another minion's stats to {1}/{2}» = 50/50 за 1 золото). Цель
    // выбирается по наибольшей ПРИБАВКЕ, потому что «задать» умеет
    // и уменьшить; неположительная прибавка гасит совет.
    const setStats = setStatsOf(minion, effectText, rules);
    const setBest =
      setStats === null
        ? null
        : state.board
            .filter((m) => m.entityId !== minion.entityId)
            .map((m) => ({ minion: m, gain: setStats.total - ((m.attack ?? 0) + (m.health ?? 0)) }))
            .reduce<{ minion: Minion; gain: number } | null>(
              (a, b) => (a === null || b.gain > a.gain ? b : a),
              null,
            );

    const name = info?.name ?? minion.cardId;
    let score = 0;
    let what = '';
    // «Activate ({0}): Gain {1} Gold next turn» — Private Investigator
    // `BG36_509` (part40, part54, part55: scriptData [1, 2]). Золото
    // отложенное (D012) и считается тем же курсом, что у заклинаний.
    const goldNext = /\bgain\s+(?:\{(\d)\}|(\d+))\s+gold\s+next\s+turn\b/i.exec(effectText);
    const goldNextTurn =
      goldNext === null
        ? 0
        : goldNext[1] !== undefined
          ? (minion.scriptData[Number(goldNext[1])] ?? 0)
          : Number(goldNext[2]);

    // Поглощение витрины: сколько своих едят и по сколько статов достаётся.
    // Оба числа читаемы — племя из текста, статы из витрины.
    const consumed = consumeGain(effectText, state, deps, rules);
    // Приманка Lurking Lionfish: прибавка читается бортом и расстановкой (part56).
    const bait = fishbaitOf(effectText, state, deps.cards, rules);

    if (bait !== null) {
      score = bait.total * rules.value.perStatPoint - cost * rules.goldPointValue;
      what = bait.words;
    } else if (consumed !== null) {
      score = consumed.stats * rules.value.perStatPoint - cost * rules.goldPointValue;
      what =
        `${String(consumed.eaters)} своих съедят витрину — ` +
        `около +${String(Math.round(consumed.stats))} статов всего`;
    } else if (setStats !== null && setBest !== null && setBest.gain > 0) {
      score = setBest.gain * rules.value.perStatPoint - cost * rules.goldPointValue;
      what =
        `сделает ${deps.cards.info(setBest.minion.cardId)?.name ?? setBest.minion.cardId} ` +
        `${String(setStats.attack)}/${String(setStats.health)} — ` +
        `+${String(setBest.gain)} статов`;
    } else if (stats > 0 && destroysTarget) {
      // «Then destroy it» — прибавка достаётся САМОМУ активирующему, а цель
      // получает перерождение и уничтожается (part50, «Мертвый звонарь»
      // `BG36_511`). Наш борд от нажатия всё равно растёт на те же статы,
      // поэтому очки прежние; врала не цифра, а ЦЕЛЬ и СЛОВА.
      score = stats * rules.value.perStatPoint - cost * rules.goldPointValue;
      what =
        `+${String(stats)} статов САМОМУ ${name}; ` +
        `цель получит перерождение и будет уничтожена — вернётся базовой копией`;
    } else if (stats > 0) {
      score = stats * rules.value.perStatPoint - cost * rules.goldPointValue;
      what = `+${String(stats)} статов`;
    } else if (goldNextTurn > 0) {
      score = (goldNextTurn - cost) * rules.goldPointValue;
      what = `+${String(goldNextTurn)} золота на следующий ход`;
    } else if (givesMinion) {
      // Приносимое тело оценивается как средний миньон текущего тира.
      score = rules.value.perTechLevel * state.techLevel - cost * rules.goldPointValue;
      what = 'принесёт миньона';
    }
    // «Activate: Discover a Tavern spell» (Clever Castaway) при плательщике
    // за Discover кормит своих (D232).
    const discovers = discoverCountOf(effectText, 'lead', rules);
    const discoverPay = discovers > 0 ? discoverPayoffOf(state.board, deps.cards, rules) : null;
    if (discoverPay !== null) {
      score += discoverPay.points * discovers;
      what += `${what === '' ? '' : '; '}${discoverPayoffNote(discoverPay, discovers)}`;
    }
    if (score <= 0) return [];

    // Цель баффа — крупнейший свой, кроме самого активирующего:
    // «Give another minion…». У «задать статы» цель уже выбрана прибавкой,
    // и она ОБРАТНАЯ (наименьший свой получает больше всех) — своим полем,
    // а не общим правилом «крупнейший».
    const others = state.board.filter((m) => m.entityId !== minion.entityId);

    // Племя цели, если текст его называет: указать на миньона чужого племени
    // игра не даст вовсе («a different friendly Undead»). Пустой отбор
    // возвращает прежний пул — правило сужает выбор, а не отменяет совет.
    const namedRace =
      Object.entries(rules.tribeTextWords).find(([, word]) =>
        new RegExp(`\\b(?:${word})\\b`, 'i').test(effectText),
      )?.[0] ?? null;
    const sameRace =
      namedRace === null
        ? others
        : others.filter((m) => racesOf(m, deps.cards).includes(namedRace));
    const pool = sameRace.length > 0 ? sameRace : others;

    const size = (m: Minion): number => (m.attack ?? 0) + (m.health ?? 0);
    const target =
      bait !== null
        ? // У приманки цель — карта ВИТРИНЫ, которую она заменит.
          bait.replaced
        : setBest !== null && setBest.gain > 0
        ? setBest.minion
        : destroysTarget && pool.length > 0
          ? // Расходник — тот, кого не жаль обнулить до базовой копии.
            // В part50 игрок одиннадцать раз указывал на мелкого Мумификатора
            // и ни разу на крупное тело.
            pool.reduce((a, b) => (size(b) < size(a) ? b : a))
          : stats > 0 && pool.length > 0
            ? pool.reduce((a, b) => (size(b) > size(a) ? b : a))
            : null;

    return [
      {
        action: 'activate' as const,
        minion,
        score,
        cost,
        requiresSlot: false,
        sellFirst: null,
        targetMinion: target,
        ...(goldNextTurn > 0 ? { grantsGoldNextTurn: goldNextTurn } : {}),
        // Ралли атакующего бьёт соседей — покупки хода идут раньше (D210).
        ...(bait !== null ? { boardGains: bait.gains, buffsWholeBoard: bait.wide } : {}),
        reason: `активация ${name} за ${String(cost)}: ${what}`,
      },
    ];
  });
}

/**
 * Эффект заклинания, восстановленный из текста карты и тегов сущности.
 *
 * Плейсхолдеры `{0}`/`{1}` в тексте снапшота — это индексы значений
 * `TAG_SCRIPT_DATA_NUM_1..2` на сущности (part10: у «Buy the Holy Light»
 * текст «+{0} Attack», а 10 лежит в NUM_1; у Тавматургии «+{1}/+{1}»
 * и единица в NUM_2). Литеральные числа встречаются реже («+1/+1»).
 * Что не разобралось — честный `null`: совет не берётся судить.
 */
export interface SpellEffect {
  /** Золото, которое даст розыгрыш: «Gain 1 Gold» у монетки таверны. */
  readonly gold: number;
  /**
   * Золото, которое придёт НЕ в этот ход: «Gain 2 Gold next turn»
   * (Careful Investment, part30), «Gain 4 Gold in two turns» (ветвь Grace
   * Farsail).
   *
   * Отдельно от `gold` по той же причине, что `maxGold`: это разные
   * величины. `gold` доезжает до следующего шага плана как живое
   * (`grantsGold`), а отложенное золото в этот ход потратить нельзя —
   * смешение делало дар за 3 «по карману» при двух золотых (скриншот
   * игрока: «предлагает сделать ход, на который у меня нет денег»).
   */
  readonly goldNextTurn: number;
  /**
   * Статы ложатся на МИНЬОНОВ ВИТРИНЫ, а не на наш борд: «Give minions
   * in the Tavern +{0}/+{1}» (Them Apples, part30). Лог: блок PLAY
   * с `Target=0`, энчанты — на сущностях `player=10`. Цель у такого
   * заклинания не называется, а статы доезжают до нас только через
   * покупку усиленного миньона.
   */
  readonly buffsShop: boolean;
  /**
   * Витринный бафф держится ВСЮ ПАРТИЮ («this game»), а не до обновления.
   *
   * Слова из текста, и цена у них разная на порядок: Them Apples платит
   * покупками этого хода — усиленные миньоны уходят с первым обновлением
   * витрины, — а Eonar's Favor и Staff of Enrichment усиливают каждую
   * будущую покупку до конца партии.
   */
  readonly buffsShopAllGame: boolean;
  /**
   * Племя, названное в витринном баффе; `null` — все миньоны витрины
   * или тип, который выбираем МЫ.
   *
   * Нужно затем же, зачем «боевой эффект «вашим X» пуст без своих того
   * племени» (part14): «Give Elementals in the Tavern +2/+2 this game»
   * на борде зверей не стоит ничего, и платить за него золото не за что.
   */
  readonly shopBuffRace: string | null;
  /**
   * Тип витринного баффа выбираем мы сами: «minions of its type».
   *
   * Совет обязан назвать, какой именно, — иначе игра просит выбор,
   * а помощник молчит (part37, голое «ОБНОВИТЬ»).
   */
  readonly shopBuffOwnType: boolean;
  /** Сумма статов усиления: «+{0} Attack», «+X/+Y». */
  readonly stats: number;
  /**
   * Та часть `stats`, которая ВЫВЕТРИТСЯ: «+2 Attack until next turn»
   * (Mini-Trident и остальные четыре временных чародейских токена пула).
   *
   * Считается по предложению, где стоят сами статы, а не по всему тексту:
   * у Undersea Mount («Give a minion +{0}/+{1}. If it's a Naga, also give
   * it Windfury until next turn») временна только вихревая часть.
   *
   * Нужно выбору цели: временное усиление имеет смысл класть на носителя,
   * который делает его постоянным (Lava Lurker, part21).
   */
  readonly temporaryStats: number;
  /** Даёт ли божественный щит. */
  readonly divineShield: boolean;
  /**
   * Заклинание уничтожает СВОЕГО миньона — «Destroy a friendly …».
   *
   * Это переворачивает смысл цели: у баффа цель — кого усилить, здесь —
   * кем пожертвовать. «Разделка туши» (part13, ход 21) советовалась
   * «на» крупнейшего своего — то есть предлагала уничтожить главную карту
   * борда, к тому же не проходящую по племени.
   */
  readonly destroysFriendly: boolean;
  /** Племя жертвы — ключ `races` снапшота; `null` — любое. */
  readonly destroyRace: string | null;
  /**
   * Замена: уничтоженному взамен приходит новый миньон («…to get a random
   * Undead»). Заклинание наклейки Тюремщика (part14): ни статов, ни золота
   * в тексте нет, и прежний разбор возвращал null — совет молчал всю партию,
   * хотя бесплатная замена слабейшей нежити на случайную почти всегда апгрейд.
   */
  readonly transforms: boolean;
  /**
   * Даёт провокацию («…and Taunt»). Провокация зовёт удары на носителя,
   * и выбор цели обязан это учитывать: движок с постоянным эффектом
   * в приоритет ударов не подставляется (part15, ход 19).
   */
  readonly grantsTaunt: boolean;
  /**
   * Даёт перерождение или вихрь.
   *
   * Читаются рядом с провокацией и щитом: у модального «Choose One» именно
   * эти слова и отличают ветви друг от друга, а в счёт они не входили вовсе
   * (part43). Веса — те же, что у ключевых слов миньона.
   */
  readonly grantsReborn: boolean;
  readonly grantsWindfury: boolean;
  /**
   * Племя, названное в тексте как ЦЕЛЬ: «Give a Beast +{0}/+{1} and Reborn».
   *
   * `null` — цель любая своя. Нужно выбору цели: усиление, которое ляжет
   * только на зверя, нельзя предлагать на крупнейшего дракона, а на борде
   * без зверей его нельзя предлагать вовсе.
   */
  readonly targetRace: string | null;
  /**
   * Цель НЕ выбирается: игра распределяет эффект сама («of each type»,
   * «random», «left-most»). Совет с «→ на кого-то» показывал бы выбор,
   * которого у игрока нет (part15, ход 19: Misplaced Tea Set).
   */
  readonly untargeted: boolean;
  /**
   * Усиление получает КАЖДЫЙ свой миньон (`boardWideBuffWords`, part51):
   * `stats` здесь — на одно тело, а на борд это число надо умножить.
   *
   * Умножение живёт не в разборе, а в `effectOnBoard`: разбор кэшируется
   * по карте и борда не знает. Отдельным полем, а не выводом из
   * `untargeted`, потому что безадресные формы раздают РАЗНОМУ числу тел
   * («random» — одному, «of each type» — по племенам).
   */
  readonly boardWide: boolean;
  /**
   * Сколько своих получает усиление, когда число названо фразой («Give four
   * friendly minions», `boardCountBuffWords`, part55). `null` — не названо.
   * Ставится вместе с `boardWide`: множитель тот же, только с потолком.
   */
  readonly boardCount: number | null;
  /**
   * Цель — СВОЙ миньон по выбору игрока (`targetsFriendlyWords`, D219).
   *
   * Нужен ровно удвоителю заклинаний по своим (Balinda Stonehearth): лог
   * повторяет такие заклинания, а безадресные — нет (Shiny Ring и Hostile
   * Bounty под Balinda дают по одному блоку POWER). Признак положительный
   * и не выводится из `untargeted`: см. таблицу правил.
   */
  readonly targetsFriendly: boolean;
  /**
   * Заклинание ДАЁТ МИНЬОНА — то же, что покупка, только дешевле трёх
   * (`givesMinionWords`). «Enchanted Lasso» за 2: «Steal a random minion
   * from the Tavern» (part17, ход 1). Ни статов, ни золота в тексте нет,
   * и прежний разбор возвращал null — заклинание было невидимо целиком.
   */
  readonly givesMinion: boolean;
  /**
   * Карта, которую заклинание обещает ПО ИМЕНИ: «Get 3 **Pointy Arrows**».
   * `null` — имени в тексте нет («Get 3 random Spellcraft spells»), и тогда
   * ценность не считается вовсе: что придёт, мы не знаем.
   */
  readonly givesCardId: string | null;
  /**
   * Сколько КАРТ обещает заклинание: «Get 3 Pointy Arrows» (Weapons Forge
   * `BG36_884`, part52), «Get 3 random Spellcraft spells» (Spitescale
   * Special `BG28_606`).
   *
   * Ни статов, ни золота, ни миньона в таком тексте нет, и разбор возвращал
   * `null` — заклинание было невидимо целиком: ни покупки, ни розыгрыша
   * из руки. На part52 игрок купил Кузницу дважды (ходы 15 и 17), и три
   * её стрелы дали Ancestral Automaton +33/+21; советник обе покупки
   * пропустил молча, как «Gain 2 free Refreshes» до part23.
   *
   * Счёт читается тем же шаблоном, что у кличевого генератора
   * (`battlecryGetCountWords`, D093: пишется и словом, и цифрой). Формы
   * «Get a …» без счёта сюда не попадают: там счёт неизвестен, а «Repeat
   * at the start of each turn» (Timewarped Ring) требует горизонта.
   *
   * Ценность считают ПРАВИЛА, а не разбор: числа обещанной карты зависят
   * от живого счётчика усиления заклинаний таверны, который знает только
   * состояние. Плоского курса тут нет намеренно — корпусный прогон
   * показал, почему: три стрелы по `heroPowerSpellValue` стоили 12 очков
   * и на part36 (ход 11) вытеснили из плана тело, хотя при нулевом
   * счётчике стрела даёт 4 стата, то есть ровно цену покупки.
   */
  readonly givesCards: number;
  /**
   * ПРЕДЕЛ золота, поднятый навсегда: «Increase your maximum Gold by {0}».
   *
   * Отдельно от `gold` намеренно — это разные величины. Разовая монета
   * тратится в тот же ход, а поднятый предел приносит по золотому КАЖДЫЙ
   * оставшийся ход, и потолка «десять» у него нет: в part27 тег RESOURCES
   * доходил до 19. Сложить их в одно поле значило бы приравнять «+1 золото
   * сейчас» к «+1 золото до конца партии» (part28, ход 13).
   */
  readonly maxGold: number;
  /**
   * Ветви модального заклинания «Choose One», в порядке снапшота.
   *
   * Пусто у обычного заклинания. У модального остальные поля эффекта —
   * это поля ВЫБРАННОЙ ветви (`chosen`), а не суммы обеих: суммировать
   * их было тихо неверно («+{0}/+{1}; or +{2}/+{3}» у Alliance Flag
   * складывалось в +8 статов вместо +4).
   */
  readonly branches: readonly SpellBranch[];
  /**
   * Индекс выбранной ветви, или `null` — ветви равны по нашей шкале
   * и разделить их нечем. Тогда эффект взят от первой (они равны),
   * а совет честно называет обе.
   */
  readonly chosen: number | null;
  /**
   * Разобранные ветви — только когда выбрать между ними можно лишь ПО
   * БОРДУ: одна бьёт весь борд, другая нет (Forest's Bounty: «Give
   * a minion +{0}/+{1} twice; or Give your minions +{2}/+{3}», part51).
   * Разбор борда не знает, поэтому `chosen` тут `null`, а выбор делает
   * `effectOnBoard` на состоянии. В остальных случаях пусто.
   */
  readonly branchEffects: readonly SpellEffect[];
}

/** Ветвь «Choose One» — отдельная карта снапшота (`…t` и `…t2`). */
export interface SpellBranch {
  readonly cardId: string;
  readonly name: string;
  /**
   * Короткая подпись действия: «+3/+1» у Allied Mace, «+1/+1 и перерождение»
   * у Sprightly Sprucing. Пусто, если сказать нечего.
   *
   * Ключевые слова стоят в подписи не для красоты: игра спрашивает
   * по-русски и словами («Повысить характеристики и дать «Перерождение»»),
   * а мы отвечали одними статами — по подписи «+1/+1» игрок не мог понять,
   * какую из двух кнопок мы советуем (part43, ход 15).
   */
  readonly label: string;
}

/** Ключевое слово ветви — словом, тем же, каким помечен миньон на экране. */
const BRANCH_KEYWORD_WORDS: readonly (readonly [keyof SpellEffect, string])[] = [
  ['divineShield', 'щит'],
  ['grantsTaunt', 'провокация'],
  ['grantsReborn', 'перерождение'],
  ['grantsWindfury', 'вихрь'],
];

/**
 * Подпись ветви: статы и ключевые слова — то, чем ветви и различаются.
 *
 * Числа берутся от ТОЙ ЖЕ сущности, что и оценка (`branchScriptData`),
 * иначе подпись назовёт одно, а счёт посчитает другое.
 */
function branchLabelOf(
  text: string,
  scriptData: readonly (number | null)[],
  effect: SpellEffect | null,
): string {
  const pair = statPair(text, scriptData);
  // Половинчатое усиление («+{0} Attack», «+{1} Health») подписывается тем же
  // числом: у ветвей скарабея вся разница как раз в нём.
  const single = /\+(?:\{(\d)\}|(\d+))\s+(attack|health)\b/i.exec(text);
  const stats =
    pair !== null
      ? `+${String(pair.attack)}/+${String(pair.health)}`
      : single === null
        ? ''
        : `+${String(placeholderValue(single[1], single[2], scriptData))} ${
            (single[3] ?? '').toLowerCase() === 'health' ? 'хп' : 'атк'
          }`;
  const words =
    effect === null
      ? []
      : BRANCH_KEYWORD_WORDS.filter(([key]) => effect[key] === true).map(([, word]) => word);
  return [stats, ...words].filter((x) => x !== '').join(' и ');
}

/**
 * Пара «+X/+Y» из текста: атака и здоровье по отдельности.
 *
 * Сумма статов для оценки и так считается, а раздельные числа нужны двум
 * вещам: подписать ветвь «Choose One» словами игрока («+3/+1») и разделить
 * ветви с одинаковой суммой (`buffSplitPreference`). Плейсхолдер — индекс
 * в теги сущности, как везде.
 */
function statPair(
  text: string,
  scriptData: readonly (number | null)[],
): { readonly attack: number; readonly health: number } | null {
  const m = /\+(?:\{(\d)\}|(\d+))\s*\/\s*\+(?:\{(\d)\}|(\d+))/.exec(text);
  if (m === null) return null;
  return {
    attack: placeholderValue(m[1], m[2], scriptData),
    health: placeholderValue(m[3], m[4], scriptData),
  };
}

/**
 * Число из текста карты: либо литерал, либо ПЛЕЙСХОЛДЕР `{N}` — индекс
 * в теги сущности (`TAG_SCRIPT_DATA_NUM_1..`).
 *
 * Соглашение записано в CLAUDE.md под «не переоткрывать», и живёт оно одной
 * функцией не из любви к общему коду: копии этого разбора уже успели разойтись
 * значением по умолчанию при отсутствующем теге, а «+{0}» с выдуманным числом
 * даёт не падение, а тихо неверную оценку.
 */
function placeholderValue(
  placeholder: string | undefined,
  literal: string | undefined,
  scriptData: readonly (number | null)[],
): number {
  return placeholder === undefined ? Number(literal ?? 0) : (scriptData[Number(placeholder)] ?? 0);
}

/**
 * Очки ветви — только чтобы сравнить ветви между собой.
 *
 * Настоящая ценность заклинания считается в `spellRules`/`shopSpellRules`
 * с ценой и состоянием; здесь нужен один скаляр на ветвь, и он собран
 * из тех же весов. «Даёт миньона» оценивается ценой покупки: точную
 * ценность (среднее по витрине) отсюда не видно — витрины у разбора нет.
 */
/**
 * Ключевые слова, которые ДАЁТ заклинание, — одним числом.
 *
 * Одной функцией, потому что мест три (ветвь, заклинание руки, заклинание
 * витрины), а вопрос один; разъехались бы они молча — как разъезжались
 * списки партий до `CURRENT_BUILD_PARTS`. Веса те же, что у ключевых слов
 * миньона: слово на теле стоит одинаково, кто бы его ни принёс.
 *
 * «До следующего хода» тут не различается — ровно как не различалось
 * у провокации и щита до part43; это записанный остаток долга, а не
 * решение (временных слов в пуле три: Glowing Crown, Angler's Lure,
 * Reinvigoration).
 */
function grantedKeywordScore(effect: SpellEffect, rules: TavernRules): number {
  return (
    (effect.divineShield ? rules.value.divineShield : 0) +
    (effect.grantsTaunt ? rules.value.taunt : 0) +
    (effect.grantsReborn ? rules.value.reborn : 0) +
    (effect.grantsWindfury ? rules.value.windfury : 0)
  );
}

function branchScore(effect: SpellEffect, rules: TavernRules): number {
  return (
    (effect.transforms ? rules.value.transform : 0) +
    effect.stats * rules.value.perStatPoint +
    grantedKeywordScore(effect, rules) +
    // Отложенное золото ветви считается тем же курсом: для СРАВНЕНИЯ
    // ветвей между собой ход задержки почти ничего не меняет (Grace
    // Farsail: «Gain 2 Gold next turn; or Gain 4 Gold in two turns»),
    // а нулём оно делало бы ветвь невидимой.
    (effect.gold + effect.goldNextTurn) * rules.goldPointValue +
    (effect.givesMinion ? rules.minionCost * rules.goldPointValue : 0)
  );
}

/**
 * Усиление на НАШЕМ борде: сколько тел его получат и какую ветвь брать.
 *
 * Разбор эффекта (`spellEffect`) кэшируется по карте и борда не знает,
 * а у усиления «Give your minions +X/+Y» половина ответа именно в борде:
 * Shiny Ring при шести своих — это +12 статов, а не +2 (part51, ход 11),
 * Time Management при семи — +112, а не +16 (ход 25). Здесь `stats`
 * умножается на число своих миньонов, и только здесь: мест, где считается
 * усиление своего борда, три (покупка заклинания витрины, розыгрыш
 * из руки, вариант модального выбора), и множитель, вписанный в каждое
 * отдельно, разъехался бы молча — урок общих таблиц.
 *
 * Тел не больше размера борда: в склеенных сегментах part41 борд читается
 * длиннее семи, и множитель на артефакте склейки был бы враньём сверху.
 *
 * Модальный выбор, отложенный разбором (`branchEffects`: одна ветвь бьёт
 * весь борд, другая нет), делается тут же той же шкалой, что у
 * `chooseOneEffect`, но со статами на борд. Равенство оставляет `chosen:
 * null` — совет назовёт обе ветви, как и прежде.
 *
 * Оценка остаётся НИЖНЕЙ в одном месте, и это названо: план может продать
 * одного из усиленных позже в том же ходу, и тогда бафф на нём пропадёт —
 * шаги плана считаются по борду своего момента, как у всех правил.
 *
 * **Второй множитель — ПОВТОР заклинания по своему миньону** (D219, part53).
 * Balinda Stonehearth на своём борде («Your spells that target friendly
 * minions cast twice») повторяет направленное заклинание целиком: в логе
 * один блок PLAY и два блока POWER, цель Forest's Bounty получала
 * 2 каста × 2 раза × 9/9 = 72 стата. Советник же сравнивал ветви без
 * повтора — 36 против 60 — и звал «всем», тогда как игрок пять раз из пяти
 * брал цель. Множитель ложится ТОЛЬКО на статы и ТОЛЬКО у заклинаний
 * с положительным признаком цели: ключевое слово второй раз не даётся,
 * безадресные заклинания лог не повторяет (Shiny Ring — один блок),
 * а золото, «даёт миньона» и слушатели каста — отдельный долг. Две Balinda
 * дают максимум, а не произведение: фактуры на сложение нет. `cards`
 * необязателен только ради прежних вызовов в тестах: без него повтор
 * не читается.
 */
export function effectOnBoard(
  effect: SpellEffect,
  board: readonly Minion[],
  rules: TavernRules = DEFAULT_TAVERN_RULES,
  cards?: CardIndex,
): {
  readonly effect: SpellEffect;
  readonly bodies: number;
  readonly wide: boolean;
  readonly casts: number;
} {
  const bodiesOf = (e: SpellEffect): number =>
    e.boardWide
      ? Math.max(1, Math.min(board.length, rules.boardSize, e.boardCount ?? rules.boardSize))
      : 1;
  const repeat = cards === undefined ? 1 : friendlyCastMultiplier(board, cards, rules);
  // Положительный признак цели И отрицательный вместе: «Give a friendly
  // minion of each type» (Misplaced Tea Set) начинается как направленное,
  // но цель раздаёт игра, и такое `untargeted` отсекает (part15).
  const castsOf = (e: SpellEffect): number =>
    repeat > 1 &&
    e.targetsFriendly &&
    !e.untargeted &&
    !e.boardWide &&
    !e.buffsShop &&
    !e.destroysFriendly
      ? repeat
      : 1;

  let picked = effect;
  if (effect.chosen === null && effect.branchEffects.length > 1) {
    const scores = effect.branchEffects.map(
      (e) =>
        branchScore(e, rules) +
        (bodiesOf(e) * castsOf(e) - 1) * e.stats * rules.value.perStatPoint,
    );
    const best = Math.max(...scores);
    const leaders = scores.flatMap((s, i) => (s === best ? [i] : []));
    const only = leaders.length === 1 ? leaders[0] : undefined;
    const branch = only === undefined ? undefined : effect.branchEffects[only];
    if (only !== undefined && branch !== undefined) {
      picked = {
        ...branch,
        branches: effect.branches,
        chosen: only,
        branchEffects: effect.branchEffects,
      };
    }
  }

  const bodies = bodiesOf(picked);
  const casts = castsOf(picked);
  const wide = picked.boardWide;
  const factor = bodies * casts;
  if (factor === 1) return { effect: picked, bodies, wide, casts };
  return {
    wide,
    // `boardWide` и `targetsFriendly` снимаются с умноженного эффекта:
    // второй вызов на нём не должен умножить ещё раз.
    effect: {
      ...picked,
      stats: picked.stats * factor,
      temporaryStats: picked.temporaryStats * factor,
      boardWide: false,
      targetsFriendly: casts > 1 ? false : picked.targetsFriendly,
    },
    bodies,
    casts,
  };
}

/**
 * Во сколько раз свой борд повторяет заклинание по своему миньону (D219).
 *
 * Множитель — слово из текста миньона на борде: «twice» — 2, «three
 * times» — 3. Из нескольких удвоителей берётся больший.
 */
export function friendlyCastMultiplier(
  board: readonly Minion[],
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): number {
  let best = 1;
  for (const m of board) {
    const word = firstMatch(rules.friendlyTargetCastWords, cards.info(m.cardId)?.text ?? '');
    if (word === null) continue;
    best = Math.max(best, /three/i.test(word) ? 3 : 2);
  }
  return best;
}

/** Приписка к совету, когда заклинание повторит свой миньон. */
function castsNote(casts: number): string {
  if (casts <= 1) return '';
  return casts === 2
    ? ' (сработает дважды: удвоитель заклинаний по своим на борде)'
    : ` (сработает ${String(casts)} раза: удвоитель заклинаний по своим на борде)`;
}

/** Приписка к «+N статов», когда их получает весь борд. */
function bodiesNote(bodies: number): string {
  return bodies > 1 ? `: весь борд, тел ${String(bodies)}` : '';
}

/**
 * Модальное заклинание «Choose One»: какую ветвь советовать.
 *
 * Ветви лежат в снапшоте отдельными картами с теми же плейсхолдерами:
 * `BG31_880` («Choose One — Give a minion +{0}/+{1}; or +{2}/+{3}») — это
 * `BG31_880t` (Allied Mace, «+{0}/+{1}») и `BG31_880t2` (Allied Buckler,
 * «+{2}/+{3}»). Соглашение проверено на всех пяти модальных заклинаниях
 * пула; порядок ветвей в тексте родителя с порядком карт не совпадает
 * (у Boundless Potential наоборот), поэтому читается текст каждой ветви,
 * а не позиция.
 *
 * Случай part19 (ход 7): совет «РАЗЫГРАТЬ Alliance Flag → на Wrath Weaver»
 * молчал о том, какой из двух эффектов брать, — игрок остался с выбором
 * один на один, на что и указал. Заодно чинится тихий просчёт: сумма
 * статов родителя складывала ОБЕ ветви (+3/+1 и +1/+3 = +8 статов вместо
 * реальных +4).
 *
 * Выбор: сперва по нашей же шкале; при равенстве — по разделению статов
 * (`buffSplitPreference`, замер `npm run spike:buff`); если и это не
 * разделяет — `chosen: null`, и совет честно называет обе ветви.
 */
function chooseOneEffect(
  cardId: string,
  scriptData: readonly (number | null)[],
  cards: CardIndex,
  rules: TavernRules,
): SpellEffect | null {
  const all = ['t', 't2']
    .map((suffix) => cards.info(cardId + suffix))
    .flatMap((info) => {
      if (info === null) return [];
      const pair = statPair(info.text ?? '', scriptData);
      return [
        {
          effect: spellEffect(info.id, scriptData, cards, rules),
          pair,
          branch: {
            cardId: info.id,
            name: info.name,
            label: pair === null ? '' : `+${String(pair.attack)}/+${String(pair.health)}`,
          },
        },
      ];
    });

  const branches = all.map((p) => p.branch);
  const parsed = all.flatMap((p) => (p.effect === null ? [] : [{ ...p, effect: p.effect }]));
  const first = parsed[0];
  if (first === undefined) return null;

  // Одну из ветвей разобрать не вышло — сравнивать не с чем. «Не берёмся
  // судить» здесь честнее, чем «берите ту, которую поняли»: у Boundless
  // Potential это «Discover a minion of your Tier» против «a Tavern spell
  // of your Tier», и неоценённая ветвь не значит худшую. Очки при этом
  // берутся от разобранной — иначе заклинание пропало бы из советов вовсе.
  if (parsed.length < all.length) {
    return { ...first.effect, branches, chosen: branches.length === 1 ? 0 : null };
  }
  // Одна ветвь бьёт весь борд, другая нет (Forest's Bounty, part51): кто
  // из них больше, решает число своих миньонов, а его разбор не знает —
  // кэш ключуется картой. Выбор откладывается до `effectOnBoard`.
  if (parsed.some((p) => p.effect.boardWide) && !parsed.every((p) => p.effect.boardWide)) {
    return {
      ...first.effect,
      branches,
      chosen: null,
      branchEffects: parsed.map((p) => p.effect),
    };
  }
  const scores = parsed.map((p) => branchScore(p.effect, rules));
  const bestScore = Math.max(...scores);
  const leaders = scores.flatMap((s, i) => (s === bestScore ? [i] : []));

  if (leaders.length === 1) {
    const only = leaders[0] ?? 0;
    return { ...(parsed[only]?.effect ?? first.effect), branches, chosen: only };
  }

  // Ветви равны по шкале: разделить их может только разделение статов —
  // одна и та же сумма, розданная по-разному (+3/+1 против +1/+3).
  const preference = rules.buffSplitPreference;
  if (preference !== null) {
    const split = leaders.flatMap((i) => {
      const pair = parsed[i]?.pair;
      return pair === undefined || pair === null ? [] : [{ i, pair }];
    });
    if (split.length === leaders.length && split.length > 1) {
      const key = (p: { attack: number; health: number }): number =>
        preference === 'attack' ? p.attack : p.health;
      const best = split.reduce((a, b) => (key(b.pair) > key(a.pair) ? b : a));
      const worst = split.reduce((a, b) => (key(b.pair) < key(a.pair) ? b : a));
      if (key(best.pair) > key(worst.pair)) {
        return { ...(parsed[best.i]?.effect ?? first.effect), branches, chosen: best.i };
      }
    }
  }

  // Разделить нечем. Эффект берётся от первой ветви — они равны, и это
  // всё равно честнее суммы обеих, — а совет называет обе.
  return { ...first.effect, branches, chosen: null };
}

/**
 * Сколько ходов таверны у нас ещё впереди — таблицей замера по датасету.
 *
 * Нужно всему, что отдаёт не разово, а КАЖДЫЙ ход: пределу золота (part28),
 * а дальше и любой такой экономике. Первый ход таверны — индекс 0; за концом
 * таблицы остаётся её последнее значение, то есть ноль.
 *
 * Оговорки — у самой таблицы (`rules.remainingTavernTurns`): это среднее
 * по нашим 25 партиям, без поправки на здоровье. Число заведомо грубое,
 * и совет обязан называть его вслух, чтобы игрок мог возразить.
 */
/**
 * Цена ЗАМКА на добытом миньоне — «Lock it in your hand for N turn»
 * (`rules.lockInHandWords`, D242; part56, ход 7, Search Through Time).
 *
 * Тело пропускает N ближайших боёв из тех, что ему осталось сыграть: боёв
 * впереди — этот плюс `remainingTurns`, и доля пропущенных снимается с его
 * ценности. Оценка НИЖНЯЯ: таблица мерит, сколько ходов живёт ИГРОК,
 * а тело раннего тира уходит с борда раньше, и замок стоит ему большей
 * доли жизни. Выдумывать срок жизни тела мы не стали — его нет в замерах.
 *
 * `null` — замка в тексте нет.
 */
function lockedHandLoss(
  text: string,
  scriptData: readonly (number | null)[],
  average: number,
  state: GameState,
  rules: TavernRules,
): { readonly loss: number; readonly note: string } | null {
  for (const w of rules.lockInHandWords) {
    const m = new RegExp(w, 'i').exec(text);
    if (m === null) continue;
    const turns = m[1] !== undefined ? (scriptData[Number(m[1])] ?? 0) : Number(m[2] ?? 0);
    if (turns <= 0) return null;
    const fights = 1 + remainingTurns(state, rules);
    const loss = Math.max(0, average) * Math.min(1, turns / fights);
    return {
      loss,
      note: `замок в руке на ${String(turns)} ход — ближайший бой без него (−${loss.toFixed(1)})`,
    };
  }
  return null;
}

export function remainingTurns(
  state: GameState,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): number {
  const table = rules.remainingTavernTurns;
  if (table.length === 0) return 0;
  const turn = tavernTurnOf(state.turn);
  if (turn < 1) return table[0] ?? 0;
  return table[Math.min(turn, table.length) - 1] ?? 0;
}

/**
 * Сколько миньонов мы ещё КУПИМ до конца партии — той же таблицей замера.
 *
 * Второй такой горизонт после `remainingTurns`, и по той же причине:
 * витринный бафф «this game» платит не разом, а каждой будущей покупкой.
 */
function remainingBuys(state: GameState, rules: TavernRules): number {
  const table = rules.remainingTavernBuys;
  if (table.length === 0) return 0;
  const turn = tavernTurnOf(state.turn);
  if (turn < 1) return table[0] ?? 0;
  return table[Math.min(turn, table.length) - 1] ?? 0;
}

/**
 * Сколько стоит УСИЛЕНИЕ ВИТРИНЫ — одной функцией на оба места, где оно
 * встречается (заклинание в руке и заклинание витрины).
 *
 * Одной, потому что формула тут одна, а мест два, и разъехались бы они
 * молча: до part43 в руке число покупок считалось делением золота на тройку,
 * а в витрине — живыми ценами (`bodiesAffordable`), хотя вопрос у них общий.
 *
 * ## Из чего складывается число
 *
 * Статы витринного баффа доезжают до нас ТОЛЬКО купленными телами, поэтому
 * цена — это статы, помноженные на число таких тел, и весь вопрос в том,
 * сколько их будет.
 *
 * - Бафф до обновления (Them Apples): только покупки ЭТОГО хода — усиленные
 *   миньоны уйдут со свежей витриной, не побывав нашими (part30).
 * - Бафф «this game» (Eonar's Favor, Staff of Enrichment, Align the
 *   Elements): каждая будущая покупка до конца партии. Число покупок —
 *   замеренная таблица `remainingTavernBuys`, но не больше числа МЕСТ
 *   на борде: статы живут на телах, а тел больше семи не бывает. Оценка
 *   от этого НИЖНЯЯ — тело, купленное и проданное по дороге, успевает
 *   повоевать, — и так она и подписана.
 * - Названное племя («Give Elementals in the Tavern») и выбираемый нами тип
 *   («minions of its type») сужают счёт до своих: доля считается по СОСТАВУ
 *   НАШЕГО БОРДА — это читаемый факт, а не коэффициент. На борде без своих
 *   такого племени ветка молчит вовсе, как боевой эффект «вашим X» без своих
 *   того племени (part14).
 */
function shopBuffValue(
  effect: SpellEffect,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
  cost: number,
): { readonly score: number; readonly reason: string; readonly pick: string | null } | null {
  if (effect.stats <= 0) return null;
  const cards = deps.cards;
  const buysNow = Math.min(state.shop.length, bodiesAffordable(state, state.gold - cost, rules));

  // Чьи тела считаем: у баффа с названным племенем — только своих этого
  // племени, у баффа «своего типа» — самое многочисленное своё племя
  // (его мы и выберем), у общего — всех.
  const counts = new Map<string, number>();
  for (const m of state.board) {
    for (const race of racesOf(m, cards)) {
      if (race === RACE_ALL) continue;
      counts.set(race, (counts.get(race) ?? 0) + 1);
    }
  }
  const own =
    effect.shopBuffOwnType && counts.size > 0
      ? [...counts.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0]
      : null;
  const race = effect.shopBuffRace ?? own;
  const mates =
    race === null
      ? state.board.length
      : state.board.filter((m) => {
          const theirs = racesOf(m, cards);
          return theirs.includes(race) || theirs.includes(RACE_ALL);
        }).length;
  // Своих такого племени нет — усиливать в витрине будет некого из тех,
  // кого мы покупаем, и платить за это золото не за что.
  if (race !== null && mates === 0) return null;
  const share = race === null ? 1 : mates / Math.max(1, state.board.length);

  // Доля своих множит ОБА срока, а не только «на партию»: у баффа
  // с названным племенем усиление достаётся лишь покупкам этого племени,
  // когда бы они ни случились.
  const bodies =
    (effect.buffsShopAllGame
      ? Math.min(remainingBuys(state, rules), rules.boardSize)
      : buysNow) * share;
  const score = effect.stats * bodies * rules.value.perStatPoint - cost * rules.goldPointValue;
  if (score <= 0) return null;

  const plus = `+${String(effect.stats)} статов`;
  const reason = effect.buffsShopAllGame
    ? `усиление витрины до конца партии (${plus} каждому${
        race === null ? '' : ` из племени ${race}`
      }), тел под него ещё ${bodies.toFixed(1)} — по местам на борде, оценка нижняя`
    : `усиление витрины (${plus} каждому), до боя доедет купленными: ` +
      `покупок на это золото ${String(buysNow)}`;
  // Тип выбираем мы — совет обязан назвать какой: игра просит выбрать
  // миньона сразу после покупки, и молчание тут возвращает выбор игроку.
  return { score, reason, pick: effect.shopBuffOwnType ? race : null };
}

/**
 * Племя, которое текст обещает миньоном: «Get a random Quilboar».
 *
 * Слова «minion» в таком тексте нет вовсе — его заменяет племя, ровно как
 * «Discover a Buddy» у E.T.C. (part12) и «Discover a Naga» у Короля наг.
 * Шаблон строится из той же таблицы `tribeTextWords`, что и везде, и живёт
 * ЗДЕСЬ, а не в общем `givesMinionWords`: общая таблица кормит правила
 * покупки и заморозки, и расширять её значит перемерять их все.
 */
function tribeMinionRace(text: string, rules: TavernRules): string | null {
  for (const [race, pattern] of Object.entries(rules.tribeTextWords)) {
    if (new RegExp(`\\b(?:discover|get|add)s?\\b[^.]*\\b(?:${pattern})\\b`, 'i').test(text)) {
      return race;
    }
  }
  return null;
}

/** Ценность одной ветви «Choose One» — на нашем состоянии, а не по шаблону. */
interface BranchValue {
  /**
   * Очки ветви; `null` — «знаем, ЧТО она делает, но в очки не переводим».
   *
   * Третье состояние понадобилось самоцветам (part48): ветвь «каждый будущий
   * самоцвет +1 до конца партии» стоит ровно столько, сколько самоцветов мы
   * ещё сыграем, а этого числа у нас нет. Прежде такая ветвь была
   * неотличима от нечитаемой и печаталась как «оценить не берёмся» — игрок
   * видел два одинаковых прочерка там, где про одну из ветвей мы знаем всё,
   * кроме множителя.
   *
   * Для РАНЖИРОВАНИЯ это по-прежнему «не оценили»: ветвь без очков выбор
   * не выигрывает и не проигрывает, и совет называет обе (part28).
   */
  readonly score: number | null;
  readonly note: string;
  /**
   * Короткая подпись ветви, если она зависит от СОСТОЯНИЯ.
   *
   * Обычную подпись («+3/+1», «щит») собирает `branchLabelOf` из одного
   * текста карты, и состояния ей не нужно. У самоцветов нужно: размер
   * самоцвета живёт в теге игрока и за партию растёт. Подпись важнее
   * причины — в оверлее видна строка ДЕЙСТВИЯ, а `reason` не показывается
   * вовсе (доктрина part12 и part37).
   */
  readonly label?: string;
}

/**
 * Размер ОДНОГО кровавого самоцвета сейчас — базовые +1/+1 плюс надбавка.
 *
 * Базу проверяет лог: у игрока без надбавок сущность самоцвета создаётся
 * с `TAG_SCRIPT_DATA_NUM_1=1` и `_2=1` (part48, 13:12:19). Надбавку игра
 * держит на сущности игрока (`BACON_BLOODGEMBUFFATKVALUE`), и в той же
 * партии у соперника она доходит до восьми — то есть считать самоцвет
 * вечными «+1/+1» значило бы ошибаться в разы.
 */
function bloodGemStats(state: GameState): { readonly attack: number; readonly health: number } {
  return {
    attack: 1 + (state.globalInfo.bloodGemAttackBuff ?? 0),
    health: 1 + (state.globalInfo.bloodGemHealthBuff ?? 0),
  };
}

/**
 * Ветвь про кровавые самоцветы: обещание САМОЦВЕТОВ или усиление БУДУЩИХ.
 *
 * Пород две, и до part48 они были неразличимы — обе печатались как «оценить
 * не берёмся», хотя знаем мы про них разное.
 *
 * ОБЕЩАНИЕ («Get {0} Blood Gems») считается точно: число из плейсхолдера,
 * размер самоцвета из состояния, племени у цели нет (проверено фикстурами:
 * самоцветы ложились на зверя, пирата и наг — «Give a minion» буквально).
 * Оценка ВЕРХНЯЯ ровно в одном: карты надо ещё разыграть, а на это нужны
 * действия хода — но самоцвет бесплатен, и ход обычно их вмещает.
 *
 * УСИЛЕНИЕ («Your Blood Gems give an extra +1 Attack this game», в том
 * числе обещанное картой — «Get a Gem Day») очков не получает: его цена
 * равна прибавке, умноженной на число самоцветов до конца партии, а такого
 * замера у нас нет. По датасету самоцветов за партию бывает от двух
 * до тридцати трёх (18 записей из 57), и середины у этого разброса нет —
 * он про то, собрал ли игрок квилбоаров, а не про ход. Выдумать множитель
 * значило бы подменить ответ: ветвь получает СЛОВА и остаётся вне
 * ранжирования (part28).
 */
function bloodGemBranch(
  text: string,
  scriptData: readonly (number | null)[],
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): BranchValue | null {
  for (const word of rules.bloodGemGetWords) {
    const m = new RegExp(word, 'i').exec(text);
    if (m === null) continue;
    const count = placeholderValue(m[1], m[2], scriptData);
    if (count <= 0) continue;
    const gem = bloodGemStats(state);
    const stats = count * (gem.attack + gem.health);
    return {
      score: stats * rules.value.perStatPoint,
      label: `+${String(stats)} статов сейчас`,
      note:
        `${String(count)} самоцвета по +${String(gem.attack)}/+${String(gem.health)} — ` +
        `+${String(stats)} статов своим`,
    };
  }

  // Усиление будущих самоцветов — своим текстом или ОБЕЩАННОЙ КАРТОЙ:
  // «Get a Gem Day» не говорит про самоцветы ни слова, а вся ветвь именно
  // про них. Карта ищется по имени, как награда силы героя в part34.
  const named = /\bget\s+an?\s+([^.<]+?)\s*\./i.exec(text)?.[1] ?? null;
  const promised = named === null ? [] : deps.cards.byName(named);
  const upgradeText = [text, ...promised.map((c) => c.text ?? '')].find((t) =>
    rules.bloodGemUpgradeWords.some((w) => new RegExp(w, 'i').test(t)),
  );
  if (upgradeText === undefined) return null;
  const amount = bloodGemUpgradeAmount(upgradeText, scriptData, rules);
  const gem = bloodGemStats(state);
  return {
    score: null,
    label: `${amount} каждому будущему самоцвету`,
    note:
      (named === null ? '' : `«${named}»: `) +
      `каждый будущий самоцвет крупнее на ${amount} (сейчас +${String(gem.attack)}/+${String(gem.health)}) ` +
      `до конца партии — сколько их будет, советник не считает`,
  };
}

/** На сколько усиление растит самоцвет: «+{0}/+{1}» или «+1 Attack». */
function bloodGemUpgradeAmount(
  text: string,
  scriptData: readonly (number | null)[],
  rules: TavernRules,
): string {
  const head = rules.bloodGemUpgradeWords
    .map((w) => new RegExp(w, 'i').exec(text))
    .find((m) => m !== null);
  const tail = head === null || head === undefined ? text : text.slice(head.index);
  const pair = statPair(tail, scriptData);
  if (pair !== null) return `+${String(pair.attack)}/+${String(pair.health)}`;
  const single = /\+(?:\{(\d)\}|(\d+))\s+(attack|health)/i.exec(tail);
  if (single === null) return 'величину из текста карты';
  const value = placeholderValue(single[1], single[2], scriptData);
  return `+${String(value)} ${single[3]?.toLowerCase() === 'attack' ? 'к атаке' : 'к здоровью'}`;
}

/**
 * Что ветвь стоит НА НАШЕМ СОСТОЯНИИ.
 *
 * Отличие от `branchScore` принципиальное, а не стилистическое: тот считает
 * скаляр из одних весов, потому что зовут его из `spellEffect`, у которого
 * состояния нет и кэш ключуется одной картой. Ветви модального МИНЬОНА так
 * не рассудить — весь вопрос в борде и ходе: «случайный квилбоар» на борде
 * квилбоаров стоит 18.8, а по всему пулу тиров 1–4 — 11.6, и предел золота
 * на третьем ходу таверны стоит вдвое дороже, чем на десятом.
 *
 * Возвращается `null`, если ветвь оценить не берёмся, — и тогда выбор
 * честно возвращается игроку целиком (обе ветви названы, ни одна
 * не рекомендована). Молчание про одну ветвь не значит, что она хуже.
 */
function branchValue(
  cardId: string,
  scriptData: readonly (number | null)[],
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): BranchValue | null {
  const text = deps.cards.info(cardId)?.text ?? '';
  if (text === '') return null;
  const effect = spellEffect(cardId, scriptData, deps.cards, rules);

  // КРОВАВЫЕ САМОЦВЕТЫ — до part48 обе ветви такой карты печатались как
  // «оценить не берёмся», и жалоба игрока была ровно про это: «не показало
  // лучший вариант при розыгрыше карты» (Кратерный старатель, ход 7).
  const gems = bloodGemBranch(text, scriptData, state, deps, rules);
  if (gems !== null) return gems;

  // ПРЕДЕЛ ЗОЛОТА — не монета в руке, а по золотому каждый оставшийся ход.
  if (effect !== null && effect.maxGold > 0) {
    const turns = remainingTurns(state, rules);
    return {
      score: effect.maxGold * turns * rules.goldPointValue,
      note:
        `+${String(effect.maxGold)} к пределу золота — ` +
        `по золотому ещё ${turns.toFixed(1)} ходов таверны`,
    };
  }

  // МИНЬОН НАЗВАННОГО ПЛЕМЕНИ — ожиданием по пулу ЭТОГО племени, той же
  // шкалой и на том же борде, что всё остальное. На полном борде карта
  // приходит в руку, и место ей освобождает продажа слабейшего: считать
  // её там полной ценностью значило бы обещать слот, которого нет.
  const race = tribeMinionRace(text, rules);
  if (race !== null) {
    const average = averagePoolValue(shopTiers(state.techLevel), state, deps, rules, race);
    if (average !== null) {
      const victim =
        state.board.length >= rules.boardSize ? weakestOwn(state, deps, rules) : null;
      const victimName =
        victim === null
          ? ''
          : `, борд полон — место через продажу ${
              deps.cards.info(victim.minion.cardId)?.name ?? victim.minion.cardId
            } (${victim.value.toFixed(1)})`;
      return {
        score: average - (victim?.value ?? 0),
        note: `случайный из пула — в среднем ${average.toFixed(1)}${victimName}`,
      };
    }
  }

  // МИНЬОН без племени — общей веткой «даёт миньона»; на полном борде
  // жертва вычитается, как у племенной ветви выше (part31).
  if (effect !== null && effect.givesMinion) {
    const tiered = namedTierPool(text, state, deps, rules);
    const { score, average } = givesMinionValue(
      state,
      deps,
      rules,
      rules.minionCost,
      false,
      tiered ?? undefined,
    );
    const victim = handMinionVictim(state, deps, rules);
    return {
      score: score - (victim?.value ?? 0),
      note:
        `даёт миньона — ${minionSourceNote(tiered, average)}` +
        (victim === null ? '' : `, ${victim.note}`),
    };
  }

  // БЕСПЛАТНЫЕ ОБНОВЛЕНИЯ — по ЖИВОЙ цене кнопки, как у Leaf Through
  // the Pages (part23): при уже бесплатных обновлениях дарить нечего.
  const refresh = firstMatch(rules.freeRefreshWords, text);
  if (refresh !== null && refresh !== '') {
    const price = rerollCostOf(state, rules);
    return {
      score: Number(refresh) * price * rules.goldPointValue,
      note: `${refresh} бесплатных обновлений по цене ${String(price)}`,
    };
  }

  // Статы, щит, золото — тем же скаляром, что у ветвей заклинаний.
  if (effect !== null) {
    const pair = statPair(text, scriptData);
    return {
      score: branchScore(effect, rules),
      note:
        pair === null
          ? `эффект на ${branchScore(effect, rules).toFixed(1)}`
          : `+${String(pair.attack)}/+${String(pair.health)}`,
    };
  }
  return null;
}

/**
 * Какую ветвь «Choose One» брать у МИНЬОНА — и что об этом сказать.
 *
 * Случай part28 (ход 13): Snare Trapper 4/4 («Choose One — Get a random
 * Quilboar; or Increase your maximum Gold by {0}») советовался к розыгрышу
 * молча, и игрок остался с выбором один на один — ровно та же жалоба, что
 * на Alliance Flag в part19, только у заклинания ветвь уже называлась,
 * а у миньона — нет.
 *
 * Экран выбора поймать нельзя, и это не недоделка: ветви создаются
 * сущностями в SETASIDE с тегом `PARENT_CARD` ещё при появлении карты
 * в витрине, а не при розыгрыше (part28: 23:19:38 против 23:20:31),
 * и `openChoice` тут не заполняется вовсе — канал выборов молчит. Значит
 * называть ветвь надо ЗАРАНЕЕ, в самом совете «разыграть», — что и делает
 * поле `spellBranches`, уже понятное оверлею.
 *
 * Очки миньона правка НЕ трогает: ценность ветви в них не входит, порядок
 * покупок прежний, сверки не устаревают. Это осознанная граница — модальных
 * миньонов в пуле семь, и вносить их эффекты в ценность надо вместе
 * с перезамером, а не заодно.
 */
export function modalBranchAdvice(
  minion: Minion,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): {
  readonly branches: readonly SpellBranch[];
  readonly note: string;
  /** Кому достанется эффект советуемой ветви; `null` — цели нет или ветви равны. */
  readonly target: Minion | null;
} | null {
  const info = deps.cards.info(minion.cardId);
  if (!(info?.mechanics.includes('CHOOSE_ONE') ?? false)) return null;

  const all = ['t', 't2']
    .map((suffix) => deps.cards.info(minion.cardId + suffix))
    .flatMap((branch) => {
      if (branch === null) return [];
      // Числа ветви — С ЕЁ СОБСТВЕННОЙ сущности, если игра их прислала:
      // нумерация плейсхолдеров у ветви бывает своя, и подстановка
      // родительских тегов давала «+1 к атаке» там, где карта даёт +4
      // (part43). Соглашение part19 («как у родителя») остаётся запасным
      // путём — у части копий сущностей ветвей не бывает.
      const scriptData = minion.branchScriptData?.[branch.id] ?? minion.scriptData;
      const effect = spellEffect(branch.id, scriptData, deps.cards, rules);
      const value = branchValue(branch.id, scriptData, state, deps, rules);
      return [
        {
          value,
          effect,
          branch: {
            cardId: branch.id,
            name: branch.name,
            // Подпись от оценки — там, где она зависит от состояния
            // (самоцветы, part48); иначе обычная, из одного текста карты.
            label: value?.label ?? branchLabelOf(branch.text ?? '', scriptData, effect),
          },
        },
      ];
    });
  if (all.length < 2) return null;

  const branches = all.map((b) => b.branch);
  // В ранжирование идут ветви С ОЧКАМИ. Ветвь, про которую мы знаем только
  // словами («каждый будущий самоцвет крупнее», part48), в сравнение
  // не входит, но её слова печатаются наравне с остальными — знание без
  // числа лучше прочерка, а число без замера хуже обоих.
  const judged = all.flatMap((b) =>
    b.value === null || b.value.score === null
      ? []
      : [{ ...b, value: { score: b.value.score, note: b.value.note } }],
  );

  // Одну из ветвей оценить не вышло — сравнивать не с чем, и «берите ту,
  // которую поняли» здесь было бы враньём: неоценённая ветвь не значит
  // худшая. Тот же ответ, что у модальных заклинаний (part19).
  if (judged.length < all.length) {
    const listed = all
      .map((b) => `${b.branch.name} — ${b.value?.note ?? 'оценить не берёмся'}`)
      .join('; ');
    return { branches, note: `ветви: ${listed}`, target: null };
  }

  const best = judged.reduce((a, b) => (b.value.score > a.value.score ? b : a));
  const worst = judged.reduce((a, b) => (b.value.score < a.value.score ? b : a));
  const note = judged
    .map((b) => `${b.branch.name} ${b.value.score.toFixed(1)} (${b.value.note})`)
    .join(' против ');

  // Равные ветви не разделяются выдуманным доводом: совет называет обе,
  // как у «+3/+1 против +1/+3» (замер `npm run spike:buff` разницы не нашёл).
  // Цели у равных ветвей тоже нет: их две, и назвать одну — выдать выбор
  // за сделанный.
  if (best.value.score === worst.value.score) return { branches, note, target: null };

  // Ветвь, которая усиливает СВОЕГО миньона, обязана назвать кого именно —
  // ровно как заклинание-усиление с part12: игра спрашивает «на кого»,
  // и молчание тут возвращает выбор игроку («не подсказывает какой и на
  // кого», part43). Цель ищется тем же правилом, что у заклинаний, — вместе
  // с фильтрами кандидата в продажу, движка и племени, названного в тексте.
  const aimed =
    best.effect === null || best.effect.untargeted || best.effect.stats <= 0
      ? null
      : spellTargetOn(best.effect, state, deps, rules, best.branch.cardId);
  return { branches: [best.branch], note, target: aimed?.target ?? null };
}

/**
 * Временно ли усиление, стоящее в тексте на позиции `index`.
 *
 * Смотрится ПРЕДЛОЖЕНИЕ, в котором стоят статы, а не весь текст: у Undersea
 * Mount «Give a minion +{0}/+{1}. If it's a Naga, also give it Windfury
 * until next turn» статы постоянны, а временна вихревая половина. Поиск
 * по всему тексту пометил бы временными и статы — тихо и неверно.
 */
function isTemporaryClause(text: string, index: number, rules: TavernRules): boolean {
  const rest = text.slice(index);
  const stop = rest.search(/[.;]/);
  const clause = stop === -1 ? rest : rest.slice(0, stop);
  return rules.temporaryBuffWords.some((w) => new RegExp(w, 'i').test(clause));
}

/**
 * Чародейское ли это заклинание.
 *
 * Слова «Spellcraft» в тексте самого токена нет — оно стоит у миньона,
 * который его выдаёт. Зато держится соглашение идентификаторов, то же,
 * что у ветвей «Choose One» (part19): токен чародейства — это `<id миньона>t`
 * (Mini-Myrmidon `BG23_000` → Mini-Trident `BG23_000t`, золотой
 * `BG23_000_Gt`). Проверено на ВСЕХ 22 чародеях пула — у каждого есть
 * свой токен, и других карт с таким id нет.
 */
function isSpellcraftSpell(cardId: string | null, cards: CardIndex): boolean {
  if (cardId === null || !cardId.endsWith('t')) return false;
  const source = cards.info(cardId.slice(0, -1));
  return source?.mechanics.includes('BACON_SPELLCRAFT_ID') ?? false;
}

/**
 * «Магнит заклинаний» — миньон, чей текст говорит о заклинании, применённом
 * К НЕМУ САМОМУ, и сколько СТАТОВ даст сверх усиления попадание именно в него.
 *
 * Случай part21 (ход 9): план советовал купить Lava Lurker («The first
 * Spellcraft spell played from hand on this each turn is permanent»)
 * и тут же играл Mini-Trident мимо него — в крупнейшее тело борда. Цель
 * выбиралась по размеру, и обе стороны дела советник не видел вовсе:
 * ни того, что трезубец ВЫВЕТРИТСЯ («+2 Attack until next turn»),
 * ни того, что на скрытне он останется навсегда.
 *
 * Считается только то, что читается числами:
 *
 * - ХРАНИТЕЛЬ («…is permanent») превращает временную часть усиления
 *   в постоянную — выгода равна `temporaryStats`. Требуется, чтобы
 *   заклинание было чародейским (так написано в тексте) и чтобы дневной
 *   счётчик («({0} left!)» — живой тег сущности) не был исчерпан;
 * - РАСТУЩИЙ («…gain +{0} Health») получает свои статы с любого заклинания.
 *
 * Остальные пять магнитов пула (копия заклинания, кровавый камень соседям,
 * усиление витрины, миньона в руке, чужое заклинание) числом не мерятся —
 * у них выгода `0`, и цель выбирается как прежде, по телу. Это честнее
 * выдуманного веса: «не берёмся судить» здесь то же, что у сложных активаций.
 */
export function spellMagnetGain(
  target: Minion,
  effect: SpellEffect,
  spellCardId: string | null,
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): {
  readonly gain: number;
  readonly note: string;
  /** Выгода взята у ХРАНИТЕЛЯ, и его дневной заряд на этом тратится. */
  readonly spendsCharge?: boolean;
} | null {
  // Текст справочник уже нормализовал: приклеенный золотой вариант отрезан
  // при загрузке снапшота (`normalizeCardText`, part17).
  const text = cards.info(target.cardId)?.text ?? '';
  if (text === '') return null;
  if (!rules.spellMagnetWords.some((w) => new RegExp(w, 'i').test(text))) return null;

  if (rules.spellMagnetPermanentWords.some((w) => new RegExp(w, 'i').test(text))) {
    // Счётчик оставшихся на этот ход — тот же плейсхолдер «({0} left!)».
    // Тега нет — считаем, что заряд есть: отсутствие тега не значит ноль.
    const left = target.scriptData[0] ?? 1;
    if (!isSpellcraftSpell(spellCardId, cards) || effect.temporaryStats <= 0 || left <= 0) {
      return { gain: 0, note: '' };
    }
    return {
      gain: effect.temporaryStats,
      note: `усиление на нём останется навсегда (+${String(effect.temporaryStats)} статов)`,
      spendsCharge: true,
    };
  }

  if (rules.spellMagnetGainWords.some((w) => new RegExp(w, 'i').test(text))) {
    const m = /\bgain\s+\+(?:\{(\d)\}|(\d+))(?:\s*\/\s*\+(?:\{(\d)\}|(\d+)))?/i.exec(text);
    if (m === null) return { gain: 0, note: '' };
    const gain =
      placeholderValue(m[1], m[2], target.scriptData) +
      placeholderValue(m[3], m[4], target.scriptData);
    return gain <= 0
      ? { gain: 0, note: '' }
      : { gain, note: `растёт от заклинаний (+${String(gain)} статов)` };
  }

  return { gain: 0, note: '' };
}

/** Число тел словом — для `boardCountBuffWords` («Give four friendly minions»). */
const BODY_COUNT_WORDS: Readonly<Record<string, number>> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
};

/**
 * Разбор заклинания — с кэшем, потому что спрашивают его на КАЖДОГО
 * кандидата, а ответ зависит только от карты и её тегов.
 *
 * Слагаемое магнита в `minionValue` перебирает все заклинания руки, и при
 * усреднении по пулу тиров 1..6 это 382 кандидата × заклинания руки разборов
 * подряд, по два десятка регулярок каждый, — на один промах `averagePoolValue`.
 * План строит до четырёх цепочек по восемь шагов, и каждый шаг зовёт
 * заморозку и дар. Тот же приём и та же причина, что у `memoByCard`
 * для текстов карт; ключ — карта плюс её живые теги, потому что от них
 * зависят числа плейсхолдеров. Результат неизменяемый (все поля `readonly`),
 * поэтому общий объект безопасен.
 */
export function spellEffect(
  cardId: string,
  scriptData: readonly (number | null)[],
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): SpellEffect | null {
  return memoByCard(
    SPELL_EFFECT_CACHE,
    `${cardId}|${scriptData.join('.')}`,
    cards,
    rules,
    () => computeSpellEffect(cardId, scriptData, cards, rules),
  );
}

const SPELL_EFFECT_CACHE = new WeakMap<
  TavernRules,
  WeakMap<CardIndex, Map<string, SpellEffect | null>>
>();

function computeSpellEffect(
  cardId: string,
  scriptData: readonly (number | null)[],
  cards: CardIndex,
  rules: TavernRules,
): SpellEffect | null {
  const info = cards.info(cardId);
  const text = info?.text ?? '';
  if (text === '') return null;

  // Модальное заклинание разбирается по ветвям, а не по склеенному тексту
  // родителя. Рекурсии тут нет: у самих ветвей механики CHOOSE_ONE нет.
  if (info?.mechanics.includes('CHOOSE_ONE') === true) {
    const modal = chooseOneEffect(cardId, scriptData, cards, rules);
    if (modal !== null) return modal;
  }

  // Кровавые самоцветы не оцениваются (граница part28), и молчать надо
  // ЗДЕСЬ, а не полагаться на нули: у Gem Day (part30) ветвей-карт
  // в снапшоте нет, и текст родителя складывал обе ветви в «+2 статов»
  // разового баффа — тихо неверное число вместо честного «не берёмся».
  // Проверка стоит ПОСЛЕ разбора ветвей: модальному миньону с одной
  // самоцветной ветвью вторая обязана остаться видимой.
  if (rules.bloodGemWords.some((w) => new RegExp(w, 'i').test(text))) return null;

  // «At the start of your next turn, give your minions +{0}/+{1} twice» —
  // ветвь Do It Later (Time Management, part51). Статы придут только
  // к СЛЕДУЮЩЕМУ бою, а горизонта «статы завтра против статов сегодня»
  // у шкалы нет; прочитанные как сегодняшние, они уравнивали ветви, которые
  // на деле не равны ни в какую сторону. Неоценённая ветвь — честное
  // «не берёмся» (part28, part48): совет назовёт обе.
  if (/^(?:\[x\])?\s*at\s+the\s+start\s+of\s+your\s+next\s+turn\b/i.test(text)) return null;

  // «Gain 2 Gold next turn» / «Gain 4 Gold in two turns» — золото
  // ОТЛОЖЕННОЕ, и складывать его с живым нельзя (part30, ход 9).
  // «If you win your next combat, gain 3 Gold» (Overconfidence, part55,
  // ход 21) — тоже отложенное: прочитанное как живое, оно оплачивало в плане
  // подъём, на который золота не было (D231). Признак тот же, что у награды
  // силы после боя (`delayedRewardWords`, D217).
  //
  // «Gain 1 Mana Crystal this turn only» — золото ЭТОГО хода: в BG золото
  // и есть мана. Так написана `SW_COIN2`, монета силы Рафаама, которую игра
  // показывает «Золотой монеткой» (тег `OVERRIDECARDNAME` подменяет только
  // имя: у миньонов part11 и part26 он тоже есть). Розыгрыш в part52
  // (00:39:35) снял `RESOURCES_USED` с 6 до 5.
  const gold =
    /gain\s+(\d+)\s+(?:gold|mana\s+crystals?(?=\s+this\s+turn\s+only))(\s+next\s+turn|\s+in\s+two\s+turns)?/i.exec(
      text,
    );
  const afterCombat = rules.delayedRewardWords.some((w) => new RegExp(w, 'i').test(text));
  const deferredGold = gold?.[2] !== undefined || (gold !== null && afterCombat);

  // Числа усиления: литерал или плейсхолдер-индекс в теги сущности.
  // Заодно считается, сколько из них выветрится: пометка временности
  // относится к СВОЕМУ предложению, а не ко всему тексту карты.
  let stats = 0;
  let temporaryStats = 0;
  for (const m of text.matchAll(/\+(?:\{(\d)\}|(\d+))/g)) {
    const placeholder = m[1];
    const literal = m[2];
    const value =
      placeholder !== undefined
        ? (scriptData[Number(placeholder)] ?? 0)
        : literal !== undefined
          ? Number(literal)
          : 0;
    stats += value;
    if (isTemporaryClause(text, m.index, rules)) temporaryStats += value;
  }
  // «Give your minions +{0}/+{1} twice» (Azerite Empowerment), «Give
  // a minion +{0}/+{1} twice» (ветвь All For One): усиление ложится ДВАЖДЫ
  // сразу же, и число в тексте — половина настоящего. Считалось один раз,
  // и ветви Forest's Bounty сравнивались на заниженной первой (part51).
  // «Twice» без плюса рядом («Your Battlecries trigger twice») сюда
  // не попадает: удвоение механики — отдельная история (part22).
  if (/\+(?:\{\d\}|\d+)(?:\s*\/\s*\+(?:\{\d\}|\d+))?\s+twice\b/i.test(text)) {
    stats *= 2;
    temporaryStats *= 2;
  }
  const shield = /divine shield/i.test(text);

  // «Destroy a friendly Undead» — слово после «friendly» сверяется с той же
  // таблицей слов племён, что у тринкетов; не совпало ни с чем — жертва любая.
  const destroy = /destroys? a friendly(?:\s+([a-z]+))?/i.exec(text);
  let destroyRace: string | null = null;
  if (destroy !== null && destroy[1] !== undefined) {
    for (const [race, pattern] of Object.entries(rules.tribeTextWords)) {
      if (new RegExp(`^(?:${pattern})$`, 'i').test(destroy[1])) {
        destroyRace = race;
        break;
      }
    }
  }

  // Замена: за уничтожением следует получение — «…to get a random Undead»
  // (заклинание наклейки Тюремщика, part14).
  const transforms = destroy !== null && /to (?:get|summon|discover)/i.test(text);

  const grantsTaunt = /\btaunt\b/i.test(text);
  // Перерождение и вихрь читаются так же, как провокация и щит, и по той же
  // причине: они и есть весь смысл выбора у «Choose One». У Sprightly Scarab
  // ветви различаются словами («+1/+1 и Reborn» против «+4 к атаке
  // и Windfury»), а сравнивались одними статами — то есть половина карты
  // в счёт не входила (part43, ход 15). Веса те же, что у ключевых слов
  // миньона; 41 заклинание пула даёт хотя бы одно такое слово.
  const grantsReborn = /\breborn\b/i.test(text);
  const grantsWindfury = /\bwindfury\b/i.test(text);

  // Племя ЦЕЛИ — «Give a Beast …», «Give a friendly Elemental …».
  const targetRace = targetRaceOf(text, rules);

  // Статы ложатся на витрину, а не на наш борд, — Them Apples (part30).
  const buffsShop = rules.buffsShopWords.some((w) => new RegExp(w, 'i').test(text));
  // Держится ли бафф всю партию и кому достаётся — читается там же, в тексте.
  // Племя ищется в части ДО «in the Tavern»: «Give Elementals in the Tavern»
  // говорит про элементалей витрины, а «this game» в хвосте — про срок.
  const buffsShopAllGame =
    buffsShop && rules.buffsShopAllGameWords.some((w) => new RegExp(w, 'i').test(text));
  const shopBuffOwnType =
    buffsShop && rules.shopBuffOwnTypeWords.some((w) => new RegExp(w, 'i').test(text));
  const shopBuffRace = buffsShop && !shopBuffOwnType ? shopBuffRaceOf(text, rules) : null;

  // «Цель не выбирается» имеет смысл только у усилений: у замены выбор
  // жертвы и так наш, у золота цели нет вовсе. Витринный бафф раздаёт
  // игра — цели у него нет по построению.
  const untargeted =
    buffsShop ||
    (destroy === null && rules.untargetedSpellWords.some((w) => new RegExp(w, 'i').test(text)));
  // Весь борд — только простая форма (part51); уточнение, условная вторая
  // половина и отложенность выводят карту из неё.
  const excluded = rules.boardWideBuffExcludeWords.some((w) => new RegExp(w, 'i').test(text));
  // Число тел, названное фразой («Give four friendly minions», part55): до
  // этого Bounty считались усилением ОДНОГО тела — +4 статов вместо +16.
  const countWord =
    buffsShop || stats <= 0 || excluded ? null : firstMatch(rules.boardCountBuffWords, text);
  const counted =
    countWord === null ? NaN : (BODY_COUNT_WORDS[countWord.toLowerCase()] ?? Number(countWord));
  const boardCount = Number.isFinite(counted) && counted > 0 ? counted : null;
  const boardWide =
    !buffsShop &&
    stats > 0 &&
    !excluded &&
    (boardCount !== null || rules.boardWideBuffWords.some((w) => new RegExp(w, 'i').test(text)));

  // «Даёт миньона» — та же таблица шаблонов, что у силы героя: факт записан
  // в тексте, а не в том, кто его произносит. Замена («…destroy … to get
  // a random Undead») сюда не относится — у неё своя ветка с жертвой.
  const givesMinion =
    !transforms && rules.givesMinionWords.some((w) => new RegExp(w, 'i').test(text));

  // ПРЕДЕЛ золота: «Increase your maximum Gold by {0}» — ветвь Collect
  // the Bounty (part28) и заклинания витрины Strike Oil. Число читается
  // так же, как везде: плейсхолдер — индекс в теги, литерал — сам собой.
  const maxGoldHit = firstMatchAll(rules.maxGoldWords, text);
  const maxGold =
    maxGoldHit === null ? 0 : placeholderValue(maxGoldHit[1], maxGoldHit[2], scriptData);

  // «Get 3 Pointy Arrows» — обещанные КАРТЫ, счёт словом или цифрой
  // (`battlecryGetCountWords`, D093). Число само по себе ничего не решает:
  // у «даёт миньона» своя ветка и своя, более точная цена, поэтому счёт
  // читается только там, где иначе разбор молчит. Без ИМЕНИ карты счёт
  // тоже бесполезен — цена считается по её числам.
  const givesCardId = givesMinion ? null : promisedCardId(text, cards);
  const givesCards = givesCardId === null ? 0 : promisedCardCount(text, rules);

  // Цель по выбору — первое предложение без тегов разметки («<b>Choose
  // One</b> - Give a minion…»): дальше по тексту «a minion» встречается
  // и в чужих ролях («…get a minion of the same type»).
  const firstClause = text.replace(/<[^>]*>/g, '').split(/[.;]/)[0] ?? '';
  const tribes = Object.values(rules.tribeTextWords).join('|');
  const targetsFriendly = rules.targetsFriendlyWords.some((w) =>
    new RegExp(w.replace('{tribe}', `(?:${tribes})`), 'i').test(firstClause),
  );

  if (
    gold === null &&
    stats === 0 &&
    !shield &&
    !transforms &&
    !grantsTaunt &&
    !grantsReborn &&
    !grantsWindfury &&
    !givesMinion &&
    givesCards === 0 &&
    maxGold === 0
  ) {
    return null;
  }
  const goldAmount = gold?.[1] === undefined ? 0 : Number(gold[1]);
  return {
    gold: deferredGold ? 0 : goldAmount,
    goldNextTurn: deferredGold ? goldAmount : 0,
    stats,
    temporaryStats,
    divineShield: shield,
    destroysFriendly: destroy !== null,
    destroyRace,
    transforms,
    grantsTaunt,
    grantsReborn,
    grantsWindfury,
    targetRace,
    untargeted,
    boardWide,
    boardCount,
    targetsFriendly,
    givesMinion,
    givesCards,
    givesCardId,
    buffsShop,
    buffsShopAllGame,
    shopBuffRace,
    shopBuffOwnType,
    maxGold,
    branches: [],
    chosen: null,
    branchEffects: [],
  };
}

/**
 * Племя, которому достаётся витринный бафф: «Give **Elementals** in the
 * Tavern +{0}/+{1} this game» (Align the Elements, Nomi).
 *
 * Ищется в части текста ДО «in the Tavern» — там стоит тот, кого усиливают.
 * Дальше по предложению племена тоже встречаются («…from Tier 3 and below»
 * племени не называет, зато соседние предложения бывают про своих), и поиск
 * по всему тексту приписал бы баффу чужое племя — та же ошибка, что
 * складывание ветвей «Choose One» в part19.
 */
/**
 * Племя ЦЕЛИ заклинания: «Give a **Beast** +{0}/+{1} and Reborn».
 *
 * Берётся первое предложение и только после глагола выдачи: в хвосте текста
 * племя стоит в другой роли — «If it's a Naga, also give it Windfury»
 * (Undersea Mount) говорит про условие, а не про то, кому заклинание
 * вообще можно применить.
 */
function targetRaceOf(text: string, rules: TavernRules): string | null {
  const head = text.split(/[.;]/)[0] ?? '';
  for (const [race, pattern] of Object.entries(rules.tribeTextWords)) {
    if (new RegExp(`\\bgives?\\s+(?:a|an|another)\\s+(?:friendly\\s+)?(?:${pattern})\\b`, 'i').test(head)) {
      return race;
    }
  }
  return null;
}

function shopBuffRaceOf(text: string, rules: TavernRules): string | null {
  const at = text.search(/\bin\s+the\s+tavern\b/i);
  const head = at === -1 ? text : text.slice(0, at);
  for (const [race, pattern] of Object.entries(rules.tribeTextWords)) {
    if (new RegExp(`\\b(?:${pattern})\\b`, 'i').test(head)) return race;
  }
  return null;
}

/**
 * Есть ли в тексте триггер, который срабатывает В БОЮ.
 *
 * Голова триггера («After…», «Whenever…», «At the start/end of…») ищется
 * шаблонами `engineTextWords`, и на той же позиции проверяется, не тавернная
 * ли это голова (`tavernTriggerWords`): «After you play an Elemental»
 * срабатывает только в таверне, «After a friendly Rally minion attacks» —
 * только в бою. Одной боевой головы достаточно.
 */
function hasCombatTrigger(text: string, rules: TavernRules): boolean {
  for (const word of rules.engineTextWords) {
    const head = new RegExp(word, 'gi');
    let hit: RegExpExecArray | null;
    while ((hit = head.exec(text)) !== null) {
      const at = hit.index;
      const tavern = rules.tavernTriggerWords.some((t) => {
        const re = new RegExp(t, 'iy');
        re.lastIndex = at;
        return re.test(text);
      });
      if (!tavern) return true;
      if (hit[0].length === 0) head.lastIndex += 1;
    }
  }
  return false;
}

/**
 * Миньон-«движок»: его ценность — постоянный эффект из текста (аура,
 * «After/Whenever/At the start…»), а не размен телом. Признаки — механика
 * AURA в снапшоте и слова из `engineTextWords`.
 *
 * Триггер О СЕБЕ движком не считается: «After this attacks and kills
 * a minion…» (Wildfire Elemental) — описание собственного размена, а не
 * эффекта, который надо беречь от ударов. Прежнее правило зачисляло такого
 * бойца в движки словом «After» и уводило провокацию на токен (part17,
 * ход 11).
 *
 * ТАВЕРННЫЙ триггер движком не считается тоже (part27, ход 7): «After you
 * play an Elemental, gain +{1} Health» (Molten Rock) в бою не срабатывает,
 * и провокации на нём терять нечего — а прежнее правило уводило её с самого
 * крупного тела на отработавший генератор 3/3, которого игрок собирался
 * продать. Аура остаётся движком без разбора: «Your minions have +1 Attack»
 * живёт в бою и требует носителя живым.
 */
export function isEffectEngine(
  m: Minion,
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): boolean {
  const info = cards.info(m.cardId);
  if (info?.mechanics.includes('AURA') ?? false) return true;
  const text = info?.text ?? '';
  if (text === '') return false;
  if (rules.selfTriggerWords.some((w) => new RegExp(w, 'i').test(text))) return false;
  return hasCombatTrigger(text, rules);
}

/**
 * В кого целить заклинание с целью на своём борде.
 *
 * Бафф идёт на крупнейшего своего — усиление достаётся тому, кто дольше
 * живёт в бою (точечный выбор правила не судят, сказано в docs). Заклинание
 * с «Destroy a friendly …» целится наоборот: жертва — НАИМЕНЬШИЙ свой
 * подходящего племени. `null` — целить не в кого, и советовать такое
 * заклинание нельзя вовсе: у «Разделки туши» без нежити на борде нет
 * ни жертвы, ни выгоды.
 *
 * Два уточнения по part15 (ход 19):
 *
 * - у заклинания БЕЗ выбора цели (`untargeted`) цель не называется вовсе —
 *   «Misplaced Tea Set» раздаёт «по миньону каждого племени» сам,
 *   и «→ на Deathstrider» показывал выбор, которого нет;
 * - провокация не вешается на миньона-«движка»: она зовёт удары, а ценность
 *   движка — эффект, и подставлять его — терять эффект. «Slimy Shield»
 *   советовался на Deathstrider — игрок прямо сказал, что не хочет его
 *   в приоритете ударов. Цель — крупнейший из остальных; если весь борд
 *   из движков, выбор честно возвращается к крупнейшему.
 *
 * И третье, по part17 (ход 11): усиление остаётся на миньоне НАВСЕГДА,
 * поэтому оно не вешается на кандидата в продажу — слабейшего своего,
 * которого правила сами назовут жертвой при первой покупке на полный борд.
 * «Fortify» советовался на Water Droplet 3/3 — токен, который игрок,
 * по его словам, и так собирался продать.
 */
/**
 * Кандидаты в продажу — те, на кого не вешают ПОСТОЯННОЕ усиление.
 *
 * Их двое, и оба свои правила уже называют: слабейший свой, которого
 * назовёт покупка на полный борд (part17), и карта, чья ценность
 * РЕАЛИЗУЕТСЯ ПРОДАЖЕЙ — «When you sell this, …» (part18). Копия под тройку
 * исключением не считается: её берут не телом и не продают.
 *
 * Отдельной функцией, а не копией в каждом правиле: спрашивают об этом
 * и цель заклинания (`spellTargetOn`), и цель силы, делающей миньона
 * золотым (part48), — а два определения одного и того же разъехались бы
 * молча, ровно как расходились списки партий до `CURRENT_BUILD_PARTS`.
 */
function sellCandidateIds(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): Set<number> {
  const ids = new Set<number>();
  const victim = weakestOwn(state, deps, rules);
  if (victim !== null) ids.add(victim.minion.entityId);
  for (const m of state.board) {
    const text = deps.cards.info(m.cardId)?.text ?? '';
    if (text === '' || copiesOwned(m, state) > 0) continue;
    if (rules.sellValueWords.some((w) => new RegExp(w, 'i').test(text))) ids.add(m.entityId);
  }
  return ids;
}

function spellTargetOn(
  effect: SpellEffect,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
  spellCardId: string | null = null,
  /** Прибавка только к атаке; `undefined` — решает текст заклинания. */
  attackOnly?: boolean,
): {
  readonly target: Minion | null;
  readonly note: string;
  readonly spendsCharge?: boolean;
} | null {
  const cards = deps.cards;
  if (state.board.length === 0) return null;

  if (effect.destroysFriendly) {
    const eligible = state.board.filter((m) => {
      if (effect.destroyRace === null) return true;
      const races = racesOf(m, cards);
      return races.includes(RACE_ALL) || races.includes(effect.destroyRace);
    });
    if (eligible.length === 0) return null;
    const victim = eligible.reduce((a, b) =>
      (b.attack ?? 0) + (b.health ?? 0) < (a.attack ?? 0) + (a.health ?? 0) ? b : a,
    );
    const name = cards.info(victim.cardId)?.name ?? victim.cardId;
    return {
      target: victim,
      note: effect.transforms
        ? `заменит ${name} — наименьшего своего подходящего — на случайного нового`
        : `в жертву ${name} — наименьший свой подходящий`,
    };
  }

  if (effect.untargeted) {
    return { target: null, note: 'цель не выбирается — заклинание распределяет само' };
  }

  const largest = (list: readonly Minion[]): Minion =>
    list.reduce((a, b) =>
      (b.attack ?? 0) + (b.health ?? 0) > (a.attack ?? 0) + (a.health ?? 0) ? b : a,
    );

  let pool: readonly Minion[] = state.board;
  const notes: string[] = [];

  // ПЛЕМЯ ЦЕЛИ, названное в тексте: «Give a **Beast** +{0}/+{1} and Reborn»
  // (ветвь Sprightly Scarab, part43). Своих такого племени нет — заклинание
  // не делает ничего, и советовать его нечестно: это тот же довод, по
  // которому боевой эффект «вашим X» пуст без своих того племени (part14).
  if (effect.targetRace !== null) {
    const race = effect.targetRace;
    const mates = pool.filter((m) => {
      const theirs = racesOf(m, cards);
      return theirs.includes(race) || theirs.includes(RACE_ALL);
    });
    if (mates.length === 0) return null;
    if (mates.length < pool.length) {
      pool = mates;
      notes.push(`только ${race} — так сказано в тексте`);
    }
  }

  if (effect.grantsTaunt) {
    const bodies = pool.filter((m) => !isEffectEngine(m, cards, rules));
    if (bodies.length > 0 && bodies.length < pool.length) {
      pool = bodies;
      notes.push('провокация зовёт удары, миньоны-эффекты не подставляются');
    }
  }

  // Ветвь-кандидат «вихрь» сужает пул ДО фильтра кандидатов в продажу,
  // и это не мелочь порядка, а весь её смысл. `weakestOwn` считает статами,
  // и на part40 (ход 11) слабейшим своим у него выходит ровно Crackling
  // Cyclone 2/1 — носитель щита и ВИХРЯ, которого замер против фактического
  // борда назвал лучшей целью (43.2 % против 22.5 % у крупнейшего тела).
  // Поставь эту ветвь ПОСЛЕ фильтра — и она не достанет до спорного случая
  // вовсе, а замер тихо ответит не на тот вопрос. Всё остальное — фильтр
  // продажи ниже и выбор магнита — работает как работало: сужение пула
  // ветвью не отменяет ни одной последующей проверки.
  const windfuryPool = pool.filter((m) => m.windfury);
  if (rules.buffTargetPreference === 'windfury' && windfuryPool.length > 0) {
    pool = windfuryPool;
    notes.push('вихрь бьёт дважды');
  }

  // Кандидатов в продажу ДВА, и оба свои правила уже называют.
  //
  // Первый — слабейший свой, которого назовёт покупка на полный борд
  // (part17). Второй — карта, чья ценность РЕАЛИЗУЕТСЯ ПРОДАЖЕЙ: «When
  // you sell this, …» (part18, `sellForGoldRule`); держать её телом —
  // не получить обещанного никогда, это записано у самого правила.
  // На part36 (ход 7) план вешал «Allied Buckler +1/+3» на Sellemental
  // 3/3 — крупнейшего на борде — и через два хода сам же советовал его
  // продать; игрок повесил щит на Tusked Camper и Sellemental продал.
  // Копия под тройку исключением не считается ровно как в `sellForGoldRule`:
  // её берут не телом и не продают.
  const sellCandidates = sellCandidateIds(state, deps, rules);
  if (sellCandidates.size > 0) {
    const keepers = pool.filter((m) => !sellCandidates.has(m.entityId));
    // Борд целиком из кандидатов в продажу возвращает выбор им же:
    // усилить кого-то всё равно надо, и «не берёмся» тут хуже крупнейшего.
    if (keepers.length > 0 && keepers.length < pool.length) {
      pool = keepers;
      notes.push('усиление навсегда — не на кандидата в продажу');
    }
  }

  // Прибавка ТОЛЬКО К АТАКЕ — телу, которое бьёт без ответного урона (D225).
  // part54, ходы 19–25: игрок клал Major Hymn и Pointy Arrow на Warpwing
  // («Immune while attacking»), советник — на крупнейшего. Замер против
  // поля, +10 атаки: на Warpwing лучше на 0.7, 1.5, 0.3 и 0.7 п.п. на ходах
  // таверны 10–13; +10 здоровья разницы не даёт, и здоровье сюда не идёт.
  const attackOnlyBuff =
    attackOnly ??
    (spellCardId !== null &&
      /\+(?:\{\d\}|\d+)\s+attack\b/i.test(cards.info(spellCardId)?.text ?? '') &&
      !/\+(?:\{\d\}|\d+)\s*\/\s*\+/.test(cards.info(spellCardId)?.text ?? ''));
  if (attackOnlyBuff) {
    const immune = pool.filter((m) =>
      rules.immuneAttackerWords.some((w) => new RegExp(w, 'i').test(cards.info(m.cardId)?.text ?? '')),
    );
    if (immune.length > 0 && immune.length < pool.length) {
      pool = immune;
      notes.push('атака — телу, которое бьёт без ответного урона');
    }
  }

  // Магнит заклинаний бьёт размер тела: попадание в него даёт СВЕРХ усиления
  // ещё статы, и они считаются числом, а не мнением (part21, ход 9 — Lava
  // Lurker делает трезубец постоянным, Fleeing Fugitive растёт на +1).
  // Правило «крупнейший» им не соперник: наши же docs говорят, что кому
  // полезнее усиление, правила не судят, — а тут выгода читается.
  const magnets = pool.map((m) => ({
    minion: m,
    gain: spellMagnetGain(m, effect, spellCardId, cards, rules),
  }));
  const bestGain = Math.max(0, ...magnets.map((x) => x.gain?.gain ?? 0));
  let spendsCharge = false;
  if (bestGain > 0) {
    const best = magnets.filter((x) => (x.gain?.gain ?? 0) === bestGain);
    pool = best.map((x) => x.minion);
    const note = best[0]?.gain?.note;
    if (note !== undefined && note !== '') notes.push(note);
    spendsCharge = best[0]?.gain?.spendsCharge ?? false;
  }

  const target = largest(pool);
  const name = cards.info(target.cardId)?.name ?? target.cardId;
  return {
    target,
    note: `цель — ${name}` + (notes.length > 0 ? `: ${notes.join('; ')}` : ''),
    spendsCharge,
  };
}

/**
 * Кого усилит заклинание-бафф — та же цель, что называют советы.
 *
 * Нужно замеру `spike:buff`: он сравнивает «+3/+1 против +1/+3» ровно
 * на том миньоне, которого выберет советник, а не на произвольном.
 *
 * `grantsTaunt` включает фильтр движков — тот самый, которым отличается
 * цель заклинания С ПРОВОКАЦИЕЙ от цели обычного усиления (part15).
 * Замер `spike:taunttarget` без него сравнивал бы с правилом, которого
 * советник не применяет: у него ветвь A — это ровно то, что советник
 * говорит сегодня, и «ровно то» обязано включать все фильтры.
 */
export function buffTarget(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
  grantsTaunt = false,
  attackOnly = false,
): Minion | null {
  const buff: SpellEffect = {
    gold: 0,
    goldNextTurn: 0,
    stats: 4,
    temporaryStats: 0,
    divineShield: false,
    destroysFriendly: false,
    destroyRace: null,
    transforms: false,
    grantsTaunt,
    grantsReborn: false,
    grantsWindfury: false,
    targetRace: null,
    untargeted: false,
    boardWide: false,
    boardCount: null,
    targetsFriendly: true,
    givesMinion: false,
    givesCards: 0,
    givesCardId: null,
    buffsShop: false,
    buffsShopAllGame: false,
    shopBuffRace: null,
    shopBuffOwnType: false,
    maxGold: 0,
    branches: [],
    chosen: null,
    branchEffects: [],
  };
  return spellTargetOn(buff, state, deps, rules, null, attackOnly)?.target ?? null;
}

/**
 * Что сказать о ветвях модального заклинания: поле совета и слова причины.
 *
 * Одно место на руку и на витрину — совет об одном и том же заклинании
 * не имеет права звучать по-разному оттого, где оно лежит.
 */
function branchAdvice(effect: SpellEffect): {
  readonly branches: readonly SpellBranch[];
  readonly note: string;
} {
  const label = (b: SpellBranch): string => (b.label === '' ? b.name : `${b.name} ${b.label}`);
  if (effect.branches.length === 0) return { branches: [], note: '' };

  const chosen = effect.chosen === null ? undefined : effect.branches[effect.chosen];
  if (chosen !== undefined) return { branches: [chosen], note: `ветвь ${label(chosen)}` };

  // «Наша шкала не разделяет» — единственная формулировка, верная в обоих
  // случаях: и когда ветви стоят поровну (Alliance Flag: +3/+1 против
  // +1/+3), и когда одну из них оценить нечем (Boundless Potential:
  // миньон против заклинания таверны). Писать «равны» во втором случае
  // было бы неправдой.
  return {
    branches: effect.branches,
    note: `ветви ${effect.branches.map(label).join(' и ')} наша шкала не разделяет`,
  };
}

/**
 * Правила розыгрыша заклинаний из руки.
 *
 * Бой заклинания не играет, но забытая в руке монетка — потерянное золото,
 * а неразыгранный бафф — потерянные статы ближайшего боя (part10, ход 9:
 * бесплатная Тавматургия +1/+1 лежала в руке при совете «НИЧЕГО»).
 *
 * Два случая, оба читаются из опубликованного текста и тегов:
 *
 * - **экономическое** («Gain N Gold»): советуется, только когда добавка
 *   открывает действие, которое сейчас не по карману, — покупку или подъём.
 *   Иначе монетка честно копится (part10, ход 9: золото 0, монетка молчит);
 * - **усиление** («+X/+Y», «+{0} Attack», щит): советуется, когда по карману;
 *   цель — самый крупный свой миньон, очки — те же веса статов и щита,
 *   что у миньонов. Точечный выбор цели правила не судят — сказано в docs.
 */
export function spellRules(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation[] {
  return state.handSpells.flatMap((spell): Recommendation[] => {
    if (spell.unplayable) return [];

    // Обновление витрины с ценой — «Мозаика Стылой Межи» (part35): ни статов,
    // ни золота, ни миньона в тексте, и разбор эффекта вернул бы `null`.
    const discount = discountRefreshRule(spell, state, deps, rules);
    if (discount !== null) return [discount];

    const effect = spellEffect(spell.cardId, spell.scriptData, deps.cards, rules);
    if (effect === null) return [];
    const name = deps.cards.info(spell.cardId)?.name ?? spell.cardId;

    if (effect.gold > 0) {
      // Не по карману — не советуем, как и во всех остальных правилах.
      // Ветка усиления тремя строками ниже это проверяет, экономическая
      // не проверяла: «разыграть монетку за 3» при двух золотых — совет,
      // который нельзя выполнить. В плане такой шаг отсеивается позже
      // (`planSteps` сверяет цену с золотом), а в СПИСКЕ советов он
      // оставался. Живой карты с такой ценой в фикстурах не встречалось —
      // это защита инварианта, а не починка виденного промаха.
      if (spell.cost > state.gold) return [];
      const net = effect.gold - spell.cost;
      if (net <= 0) return [];
      const richer = { ...state, gold: state.gold + net };

      // Покупка, которая откроется: сейчас золота не хватает, с монеткой — да.
      if (state.gold < rules.minionCost && richer.gold >= rules.minionCost) {
        const unlocked = buyRules(richer, deps, rules);
        const best = unlocked.reduce(
          (a: Recommendation | null, b) => (a === null || b.score > a.score ? b : a),
          null,
        );
        if (best?.minion != null) {
          const bestName = deps.cards.info(best.minion.cardId)?.name ?? best.minion.cardId;
          return [
            {
              action: 'play' as const,
              minion: null,
              spellCardId: spell.cardId,
              score: best.score,
              cost: spell.cost,
              // Валовыми: цену `applyRecommendation` вычтет само.
              grantsGold: effect.gold,
              requiresSlot: false,
              sellFirst: null,
              reason:
                `${name} даёт ${String(net)} золота — откроется покупка ` +
                `${bestName} (${best.score.toFixed(1)})`,
            },
          ];
        }
      }

      // Заклинание витрины, которое откроется (D233). part55, ход 9: сила
      // за 1 и подъём за 5 оставляют золотой, а Search Through Time стоит 2 —
      // без этой ветки монетка молчала, золотой сгорал, и развилка меняла
      // подъём на цепочку покупок, хотя игрок поднялся и купил всё.
      const spellUnlocked = shopSpellRules(richer, deps, rules)
        .filter((rec) => rec.cost > state.gold && rec.cost <= richer.gold && rec.score > 0)
        .reduce((a: Recommendation | null, b) => (a === null || b.score > a.score ? b : a), null);
      if (spellUnlocked?.spellCardId != null) {
        const spellName = deps.cards.info(spellUnlocked.spellCardId)?.name ?? spellUnlocked.spellCardId;
        return [
          {
            action: 'play' as const,
            minion: null,
            spellCardId: spell.cardId,
            score: spellUnlocked.score,
            cost: spell.cost,
            // Валовыми: цену `applyRecommendation` вычтет само.
            grantsGold: effect.gold,
            requiresSlot: false,
            sellFirst: null,
            reason:
              `${name} даёт ${String(net)} золота — откроется покупка ` +
              `${spellName} (${spellUnlocked.score.toFixed(1)})`,
          },
        ];
      }

      // Подъём таверны, до которого не хватает ровно этой добавки.
      const upgrade = state.tavernUpgradeCost;
      if (upgrade !== null && state.gold < upgrade && richer.gold >= upgrade) {
        const levelled = levelUpRule(
          richer,
          rules,
          buyRules(richer, deps, rules),
          copiesForTriple(richer, deps.cards, rules),
        );
        if (levelled !== null && levelled.score > 0) {
          return [
            {
              action: 'play' as const,
              minion: null,
              spellCardId: spell.cardId,
              score: levelled.score,
              cost: spell.cost,
              // Валовыми: цену `applyRecommendation` вычтет само.
              grantsGold: effect.gold,
              requiresSlot: false,
              sellFirst: null,
              reason: `${name} даёт ${String(net)} золота — откроется подъём таверны`,
            },
          ];
        }
      }

      // Ничего не открывается — монетка честно копится.
      return [];
    }

    // Бафф ПО ВИТРИНЕ (Them Apples, part30): статы ложатся на миньонов
    // магазина, и до нас доезжают только те, кого мы купим. Цели нет
    // по построению: игра раздаёт сама (в логе блок PLAY с Target=0).
    if (effect.buffsShop) {
      if (spell.cost > state.gold) return [];
      const buff = shopBuffValue(effect, state, deps, rules, spell.cost);
      if (buff === null) return [];
      return [
        {
          action: 'play' as const,
          minion: null,
          spellCardId: spell.cardId,
          shopBuffPick: buff.pick,
          score: buff.score,
          cost: spell.cost,
          requiresSlot: false,
          sellFirst: null,
          reason: `${name} — ${buff.reason}`,
        },
      ];
    }

    // «Get 3 Pointy Arrows» из РУКИ — та же карта и та же цена, что
    // в витрине (part52: куплена на ходу 15, разыграна там же, и ещё раз
    // на ходу 17). Без этой ветки совет молчал и про покупку, и про
    // розыгрыш — карта была невидима целиком.
    if (effect.givesCards > 0 && spell.cost <= state.gold) {
      const promised = promisedCardsValue(effect, state, deps, rules, spell.cost);
      if (promised !== null) {
        return [
          {
            action: 'play' as const,
            minion: null,
            spellCardId: spell.cardId,
            score: promised.score,
            cost: spell.cost,
            requiresSlot: false,
            sellFirst: null,
            reason: `${name} — ${promised.reason}`,
          },
        ];
      }
    }

    // Discover из руки при плательщике за Discover (D232): награда за тройку
    // «Discover a minion from Tier N» статов не даёт, а Hooktusk кормит ею
    // своих (part55, 17:15:31 — триггер сразу за выбором награды).
    const discovers = discoverCountOf(deps.cards.info(spell.cardId)?.text ?? '', 'lead', rules);
    if (discovers > 0 && effect.stats <= 0 && spell.cost <= state.gold) {
      const pay = discoverPayoffOf(state.board, deps.cards, rules);
      const fedScore = (pay?.points ?? 0) * discovers - spell.cost * rules.goldPointValue;
      if (pay === null || fedScore <= 0) return [];
      return [
        {
          action: 'play' as const,
          minion: null,
          spellCardId: spell.cardId,
          score: fedScore,
          cost: spell.cost,
          requiresSlot: false,
          sellFirst: null,
          reason: `${name} — ${discoverPayoffNote(pay, discovers)}`,
        },
      ];
    }

    // Усиление или замена: бесплатная ценность перед боем.
    if (spell.cost > state.gold || state.board.length === 0) return [];
    // Статы на весь борд и ветвь по борду — одной функцией на все места (part51).
    const onBoard = effectOnBoard(effect, state.board, rules, deps.cards);
    const boosted = onBoard.effect;
    const score =
      (boosted.transforms
        ? rules.value.transform
        : boosted.stats * rules.value.perStatPoint + grantedKeywordScore(boosted, rules)) -
      spell.cost * rules.goldPointValue;
    if (score <= 0) return [];

    const aimed = spellTargetOn(boosted, state, deps, rules, spell.cardId);
    if (aimed === null) return [];
    const branch = branchAdvice(boosted);

    return [
      {
        action: 'play' as const,
        minion: null,
        spellCardId: spell.cardId,
        spendsMagnetCharge: aimed.spendsCharge ?? false,
        targetMinion: aimed.target,
        spellBranches: branch.branches,
        buffsWholeBoard: onBoard.wide,
        score,
        cost: spell.cost,
        requiresSlot: false,
        sellFirst: null,
        reason:
          `${name} — ${boosted.transforms ? 'замена' : 'усиление перед боем'}` +
          (boosted.stats > 0
            ? ` (+${String(boosted.stats)} статов${bodiesNote(onBoard.bodies)})${castsNote(onBoard.casts)}`
            : '') +
          (boosted.divineShield ? ' и щит' : '') +
          (branch.note === '' ? '' : `, ${branch.note}`) +
          `, ${aimed.note}`,
      },
    ];
  });
}

/** Как назвать механику наполнения витрины в причине совета. */
const REFRESH_MECHANIC_LABEL: Readonly<Record<string, string>> = {
  BATTLECRY: 'кличевыми',
  DEATHRATTLE: 'с хрипом',
  BACON_RALLY: 'с ралли',
  BACON_SPELLCRAFT_ID: 'с чародейством',
};

/**
 * Заклинание руки, которое ОБНОВЛЯЕТ витрину и назначает ей цену —
 * «Refresh the Tavern with Battlecry minions. They cost (1)», чародейское
 * заклинание тринкета «Мозаика Стылой Межи» (part35, приходит в руку
 * каждый ход бесплатно).
 *
 * Прежде оно было невидимо целиком: ни статов, ни золота, ни миньона
 * в тексте — `spellEffect` возвращал `null`, — и на скриншоте хода 19
 * (золото 2/10 после подъёма, витрина по три) совет был «ОБНОВИТЬ за 1»
 * и «НИЧЕГО», тогда как игрок разыграл заклинание и купил двоих по одному.
 *
 * Ценность считается ТЕЛАМИ, без нового веса: сколько тел даёт остаток
 * золота по новой цене (не больше размера витрины тира) при ожидании
 * по пулу названной механики тиров 1..своего — минус то, что витрина
 * по карману прямо сейчас (лучшие по ценности, пока хватает золота).
 * Второе слагаемое и делает совет честным против покупки: при десяти
 * золотых и двух драконах в витрине за 30 очков заклинание в списке
 * молчит, а в плане встаёт ПОСЛЕ этих покупок — на остаток в четыре
 * золота это четыре тела вместо одного. Ожидание — среднее по пулу,
 * а не лучшее-из-N (оценка нижняя, как у «Get a random X»). Механика
 * читается таблицей `mechanicTextWords`; без неё пул не фильтруется.
 *
 * Что заклинание принесёт на деле, решает игра, поэтому план после него
 * обрывается, как после обновления кнопкой (`refreshesShop`).
 */
export function discountRefreshRule(
  spell: HandSpell,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const info = deps.cards.info(spell.cardId);
  const text = info?.text ?? '';
  if (text === '') return null;
  const hit = firstMatchAll(rules.discountRefreshWords, text);
  if (hit === null) return null;
  const price = Number(hit[1]);
  if (!Number.isFinite(price)) return null;

  const goldCost = spell.cost;
  if (goldCost > state.gold) return null;
  const goldAfter = state.gold - goldCost;

  // Механика наполнения — слово внутри того же предложения («with
  // Battlecry minions»), той же таблицей, что синергии по тексту.
  let mechanic: string | null = null;
  for (const [mech, pattern] of Object.entries(rules.mechanicTextWords)) {
    if (new RegExp(`\\b(?:${pattern})\\b`, 'i').test(hit[0])) {
      mechanic = mech;
      break;
    }
  }

  const shopSize = rules.shopSizeByTier[state.techLevel] ?? state.shop.length;
  const bodiesAfter = Math.min(shopSize, price <= 0 ? shopSize : Math.floor(goldAfter / price));
  if (bodiesAfter <= 0) return null;
  const expected = averagePoolValue(shopTiers(state.techLevel), state, deps, rules, null, mechanic);
  if (expected === null) return null;

  // Что теряем: покупки нынешней витрины по карману — лучшие по ценности,
  // пока хватает золота, по живой цене каждого.
  const offers = state.shop
    .map((m) => ({ cost: buyCostOf(m, rules), value: minionValue(m, state, deps, rules).total }))
    .sort((a, b) => b.value - a.value);
  let left = state.gold;
  let lost = 0;
  let bodiesNow = 0;
  for (const offer of offers) {
    if (offer.cost > left) continue;
    left -= offer.cost;
    lost += offer.value;
    bodiesNow += 1;
  }

  const score = bodiesAfter * expected - lost - goldCost * rules.goldPointValue;
  if (score <= 0) return null;

  const name = info?.name ?? spell.cardId;
  const filling = mechanic === null ? '' : `${REFRESH_MECHANIC_LABEL[mechanic] ?? mechanic} `;
  return {
    action: 'play',
    minion: null,
    spellCardId: spell.cardId,
    score,
    cost: goldCost,
    requiresSlot: false,
    sellFirst: null,
    refreshesShop: true,
    refreshSpend: bodiesAfter * price,
    reason:
      `${name} — обновление витрины ${filling}по ${String(price)}: ` +
      `на ${String(goldAfter)} золота покупок ${String(bodiesAfter)} ` +
      `(тело по пулу ≈ ${expected.toFixed(1)}) против ${String(bodiesNow)} по карману сейчас`,
  };
}

/**
 * Вернётся ли здоровье, которым платят за покупку.
 *
 * «After your hero takes damage, rewind it» — текст четырёх карт пула
 * (Soul Rewinder тира 2, Ashen Corruptor тира 5, Timewarped Rewinder тира 3,
 * Timewarped Archimonde тира 5), и лог подтверждает, что триггер срабатывает
 * именно на трату здоровья, а не только на урон боя: part29, 01:14:09 —
 * блок покупки, `META_DATA - Meta=SPEND_HEALTH Data=3`, броня героя 14 → 11,
 * следом BLOCK_START TRIGGER на `BG26_174` и броня обратно 14.
 *
 * Возвращает ли перемотчик здоровье БЕСКОНЕЧНОЕ число раз, текст не говорит
 * и ограничения не называет; в part29 он отработал на обеих покупках
 * и на уроне боёв, вырастая с 4/1 до 25/34. Считаем по тексту: пока такой
 * миньон на борде, цена в здоровье равна нулю.
 */
function healthPriceIsFree(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): boolean {
  return state.board.some((m) => {
    const text = deps.cards.info(m.cardId)?.text ?? '';
    return text !== '' && rules.healthRewindWords.some((w) => new RegExp(w, 'i').test(text));
  });
}

/**
 * Правила покупки заклинаний из витрины.
 *
 * У заклинания витрины, в отличие от миньона, цена в логе есть — тег COST
 * (part11: монетка у бармена за 1). Оцениваются те же два случая, что
 * у заклинаний руки: золото и усиление; про остальное совет молчит.
 * Золотое заклинание с чистой прибылью — покупка без раздумий; в ноль
 * (монетка за 1 даёт 1) — маленький банк на будущее, советуется последним.
 */
export function shopSpellRules(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation[] {
  return state.shopSpells.flatMap((spell) => {
    if (spell.unplayable) return [];

    // Цена бывает НЕ в золоте: тег `BACON_COSTS_HEALTH_TO_BUY` на карте
    // витрины значит, что игра спишет `COST` со здоровья героя, а не
    // с монет (part29, ход 9: Hasty Excavation «Gain 1 Gold» за 3
    // здоровья при нулевом золоте). Прежде такое заклинание сравнивалось
    // с золотом и было невидимо целиком — вдвойне: и «не по карману»,
    // и «даёт 1 золото, а стоит 3» с отрицательной чистой прибылью.
    //
    // Здоровье в очки мы не переводим и переводить не станем: курса
    // «здоровье → золото» у нас нет, и выдумать его значило бы вписать
    // в правила мнение. Поэтому ветка живёт ровно там, где курс НЕ НУЖЕН,
    // — когда здоровье возвращается само. «After your hero takes damage,
    // rewind it» — читаемый текст четырёх карт пула, и лог подтверждает,
    // что покупка за здоровье этот триггер запускает: part29, 01:14:09 —
    // `META_DATA - Meta=SPEND_HEALTH Data=3`, броня 14 → 11, следом
    // триггер Soul Rewinder и броня обратно 14. Ровно на это игрок
    // и указал: «купить карту за здоровье, которая будет для меня
    // бесплатна с учётом существа, который отменяет урон по мне».
    //
    // Без такого миньона совет молчит — честнее выдуманного курса.
    if (spell.costsHealth && !healthPriceIsFree(state, deps, rules)) return [];
    const goldCost = spell.costsHealth ? 0 : spell.cost;
    if (goldCost > state.gold) return [];
    // Цена словами: «за 2» — золото, «за 3 здоровья» — здоровье. Число
    // одно и то же (тег `COST`), различает их только флаг, и совет обязан
    // говорить, чем платит игрок.
    const price = spell.costsHealth
      ? `${String(spell.cost)} здоровья (их вернёт «перемотка»)`
      : String(spell.cost);
    const info = deps.cards.info(spell.cardId);
    const name = info?.name ?? spell.cardId;

    // Бесплатные обновления — экономика с живой ценой: обновление стоит
    // ровно столько, сколько написано на кнопке, и нулевая цена значит,
    // что дарить нечего. Своей шкалы у ветки нет: сэкономленное золото
    // переводится в очки тем же курсом, что везде.
    const refresh = firstMatch(rules.freeRefreshWords, info?.text ?? '');
    if (refresh !== null) {
      // Цена обновления читается с кнопки и бывает нулевой; неизвестной она
      // быть не может — в таверне кнопка есть всегда, а `null` тут значит
      // «мы её ещё не видели», и выдумывать цену вместо неё нельзя.
      const perRefresh = state.rerollCost;
      const count = Number(refresh);
      if (perRefresh === null || !Number.isFinite(count)) return [];
      const netGold = count * perRefresh - goldCost;
      if (netGold <= 0) return [];
      return [
        {
          action: 'buy' as const,
          minion: null,
          spellCardId: spell.cardId,
          score: netGold * rules.goldPointValue,
          cost: goldCost,
          requiresSlot: false,
          sellFirst: null,
          reason:
            `${name} за ${price} — ${String(count)} обновлений по ` +
            `${String(perRefresh)}, чистыми ${String(netGold)} золота`,
        },
      ];
    }

    const effect = spellEffect(spell.cardId, spell.scriptData, deps.cards, rules);
    if (effect === null) return [];

    if (effect.gold > 0) {
      const net = effect.gold - goldCost;
      if (net < 0) return [];
      const score = net > 0 ? net * rules.goldPointValue : 0.5;
      return [
        {
          action: 'buy' as const,
          minion: null,
          spellCardId: spell.cardId,
          score,
          cost: goldCost,
          grantsGold: effect.gold,
          requiresSlot: false,
          sellFirst: null,
          reason:
            net > 0
              ? `${name} за ${price} даёт ${String(effect.gold)} золота — чистая прибыль`
              : `${name} за ${price} — золото про запас, потратится в нужный ход`,
        },
      ];
    }

    // Золото СЛЕДУЮЩЕГО хода — «Gain 2 Gold next turn» (Careful
    // Investment, part30). Покупка выгодна тем же курсом, но `grantsGold`
    // здесь НЕ заполняется намеренно: это золото нельзя потратить в этот
    // ход, а план доносил его до следующего шага как живое — и дар за 3
    // становился «по карману» при двух золотых (скриншот игрока).
    if (effect.goldNextTurn > 0) {
      const net = effect.goldNextTurn - goldCost;
      if (net <= 0) return [];
      return [
        {
          action: 'buy' as const,
          minion: null,
          spellCardId: spell.cardId,
          score: net * rules.goldPointValue,
          cost: goldCost,
          requiresSlot: false,
          sellFirst: null,
          reason:
            `${name} за ${price} даёт ${String(effect.goldNextTurn)} золота ` +
            `СЛЕДУЮЩИМ ходом — чистая прибыль, но покупок этого хода не открывает`,
        },
      ];
    }


    // ПРЕДЕЛ золота — экономика, растянутая на всю оставшуюся партию:
    // «Increase your maximum Gold by 1» (Strike Oil за 2, тир 2). Прежде
    // разбор возвращал по такому тексту `null`, и заклинание было невидимо
    // целиком — тот же класс, что «Gain 2 free Refreshes» до part23.
    //
    // Считается оно как обновления: чистое золото по курсу, только золото
    // тут не разовое, а по одному за каждый оставшийся ход таверны
    // (`remainingTurns`, замер по датасету). Поздним ходом ветка гаснет
    // сама — в конце партии предел поднимать уже некуда.
    if (effect.maxGold > 0) {
      const turns = remainingTurns(state, rules);
      const netGold = effect.maxGold * turns - goldCost;
      if (netGold <= 0) return [];
      return [
        {
          action: 'buy' as const,
          minion: null,
          spellCardId: spell.cardId,
          score: netGold * rules.goldPointValue,
          cost: goldCost,
          requiresSlot: false,
          sellFirst: null,
          reason:
            `${name} за ${price} — предел золота +${String(effect.maxGold)}, ` +
            `по золотому ещё ${turns.toFixed(1)} ходов таверны, чистыми ${netGold.toFixed(1)}`,
        },
      ];
    }
    // Заклинание, дающее миньона, — это покупка дешевле трёх золота, и оно
    // сравнимо с покупками напрямую: та же шкала, что у силы героя (part17,
    // ход 1: Enchanted Lasso за 2 при витрине из двух миньонов). Пустой
    // борд ему не помеха — миньон и есть его наполнение.
    if (effect.givesMinion) {
      const tiered = namedTierPool(info?.text ?? '', state, deps, rules);
      const { score, average, discounted } = givesMinionValue(
        state,
        deps,
        rules,
        goldCost,
        true,
        tiered ?? undefined,
      );
      // Миньон приходит В РУКУ: на полном борде место ему освободит только
      // продажа, и жертва вычитается, как у покупки и у ветви part28
      // (part31, ход 13: A New Sprout 7.1 при слабейшем своём 9.0 — молчит).
      // Превосходство обязано перебивать `sellMargin`, как у покупок.
      // «Discover a Battlecry minion» (Hired Headhunter) при плательщике
      // за Discover кормит своих (D232; part55, 17:15:58 — +56 статов).
      const discovers = discoverCountOf(info?.text ?? '', 'lead', rules);
      const discoverPay = discovers > 0 ? discoverPayoffOf(state.board, deps.cards, rules) : null;
      // Замок в руке (D242): тело пропустит ближайший бой.
      const lock = lockedHandLoss(info?.text ?? '', spell.scriptData, average, state, rules);
      const gained = score + (discoverPay?.points ?? 0) * discovers - (lock?.loss ?? 0);
      const victim = handMinionVictim(state, deps, rules);
      if (victim !== null && gained - victim.value <= rules.sellMargin) return [];
      const cheaper = rules.minionCost - goldCost;
      // Модальное «даёт миньона» (The Road Less Traveled, Boundless
      // Potential) спросит игрока сразу после покупки — ветви называются
      // и здесь, а не только у усилений.
      const branch = branchAdvice(effect);
      return [
        {
          action: 'buy' as const,
          minion: null,
          spellCardId: spell.cardId,
          spellBranches: branch.branches,
          score: gained - (victim?.value ?? 0),
          cost: goldCost,
          requiresSlot: false,
          sellFirst: null,
          reason:
            `${name} за ${price} даёт миньона — ` +
            minionSourceNote(tiered, average) +
            (cheaper < 0
              ? `, и это на ${String(-cheaper)} золота ДОРОЖЕ покупки`
              : discounted && cheaper > 0
                ? `, но на ${String(cheaper)} золота дешевле покупки`
                : ', и это дешёвое тело, а не лучшее') +
            (discoverPay === null ? '' : `; ${discoverPayoffNote(discoverPay, discovers)}`) +
            (lock === null ? '' : `; ${lock.note}`) +
            (victim === null ? '' : `; ${victim.note}`) +
            (branch.note === '' ? '' : `; ${branch.note}`),
        },
      ];
    }

    // Бафф ПО ВИТРИНЕ — как у той же карты в руке: статы доезжают только
    // покупками, цель не называется (Them Apples, part30).
    if (effect.buffsShop) {
      const buff = shopBuffValue(effect, state, deps, rules, goldCost);
      if (buff === null) return [];
      return [
        {
          action: 'buy' as const,
          minion: null,
          spellCardId: spell.cardId,
          shopBuffPick: buff.pick,
          score: buff.score,
          cost: goldCost,
          requiresSlot: false,
          sellFirst: null,
          reason: `${name} за ${price} — ${buff.reason}`,
        },
      ];
    }

    // Заклинание, которое кроме КАРТ не обещает ничего: «Get 3 Pointy
    // Arrows» (Weapons Forge, part52, ходы 15 и 17). Цена — статы
    // обещанной карты, той же шкалой, что у любого усиления.
    // Ветка стоит ПОСЛЕ всех узнанных эффектов: там, где карта уже понята
    // (даёт миньона, золото, статы), счёт карт ничего не уточняет.
    const promised = promisedCardsValue(effect, state, deps, rules, goldCost);
    if (promised !== null) {
      return [
        {
          action: 'buy' as const,
          minion: null,
          spellCardId: spell.cardId,
          score: promised.score,
          cost: goldCost,
          requiresSlot: false,
          sellFirst: null,
          reason: `${name} за ${price} — ${promised.reason}`,
        },
      ];
    }

    if (state.board.length === 0) return [];
    // Статы на весь борд и ветвь по борду — одной функцией на все места (part51).
    const onBoard = effectOnBoard(effect, state.board, rules, deps.cards);
    const boosted = onBoard.effect;
    const score = boosted.transforms
      ? rules.value.transform
      : boosted.stats * rules.value.perStatPoint + grantedKeywordScore(boosted, rules);
    if (score <= 0) return [];
    const aimed = spellTargetOn(boosted, state, deps, rules, spell.cardId);
    if (aimed === null) return [];
    const branch = branchAdvice(boosted);
    return [
      {
        action: 'buy' as const,
        minion: null,
        spellCardId: spell.cardId,
        spendsMagnetCharge: aimed.spendsCharge ?? false,
        targetMinion: aimed.target,
        spellBranches: branch.branches,
        buffsWholeBoard: onBoard.wide,
        score,
        cost: goldCost,
        requiresSlot: false,
        sellFirst: null,
        reason:
          `${name} за ${price} — ${boosted.transforms ? 'замена' : 'усиление'}` +
          (boosted.stats > 0
            ? ` (+${String(boosted.stats)} статов${bodiesNote(onBoard.bodies)})${castsNote(onBoard.casts)}`
            : '') +
          (boosted.divineShield ? ' и щит' : '') +
          (branch.note === '' ? '' : `, ${branch.note}`) +
          `, ${aimed.note}`,
      },
    ];
  });
}

/**
 * Правило тёмного дара.
 *
 * Что это на самом деле — видно в логе (part23, три нажатия): блок PLAY
 * на кнопке `BG36_Button_DarkGift` открывает выбор `ChoiceType=GENERAL`
 * с источником `Battlegrounds Dark Gift [DNT]` и ТРЕМЯ МИНЬОНАМИ
 * в `Entities[0..2]` — то есть дар это не усиление своего миньона, а
 * ДОБЫЧА ЧУЖОГО: раскопка из трёх, у каждого свой дар сверху. Цена
 * читается из тега COST кнопки, заряды (три на партию) — из
 * `TAG_SCRIPT_DATA_NUM_2`, нажатие в этом ходу — из блока PLAY.
 *
 * Ценность считается ТЕЛОМ, которое дар принесёт: тир предложения известен
 * из таблицы `rules.darkGift.tiersByTavernTurn` (прислана игроком из разбора
 * механики), а во что оно обходится нам — той же функцией и на том же борде,
 * что и всё остальное (`averagePoolValue`). Прежний ПЛОСКИЙ вес вёл себя
 * ровно наоборот правде: на втором тире обгонял покупку, на пятом проигрывал
 * ей вдвое, то есть подталкивал жать РАНО, тогда как предложения тем сильнее,
 * чем позже нажать.
 *
 * Оценка НИЖНЯЯ: сам дар и выбор из трёх сверху не считаются вовсе
 * (`rules.darkGift.bonus` = 0), потому что цены у них нет.
 *
 * ## Цена ПРИДЕРЖАННОГО заряда (part31)
 *
 * Зарядов три на партию, а предложение растёт по ходам таверны до
 * десятого — значит нажать заряд СЕЙЧАС значит не нажать его ПОЗЖЕ,
 * когда он принесёт тело тиром выше. Пока правило мерило дар одним
 * телом «сейчас», оно ставило его верхней строкой с первого же хода,
 * где он по карману (part31: с хода 7 в плане, на ходу 13 — 14.4 против
 * покупки 14.0), а игрок все три заряда нажал на 10-м, 11-м и 12-м ходах
 * таверны (ходы 19, 21, 23) — и написал: «как только тёмный дар
 * открывается, его почти сразу рекомендуют; он становится сильнее
 * с каждым ходом».
 *
 * Считается это без нового веса. Ходов таверны впереди — замер
 * (`remainingTurns`, таблица по датасету), зарядов — живой тег кнопки.
 * Если ходов (с нынешним) не больше, чем зарядов, каждому заряду
 * достаётся свой ход и придерживать нечего. Иначе лучшие ходы для
 * зарядов — ПОСЛЕДНИЕ (предложение не убывает), и нажатие сейчас
 * вытесняет самый ранний из них: ход `сейчас + (впереди + 1 − зарядов)`.
 * Цена спешки — разница тел ЭТОГО хода и того: та же функция, тот же
 * борд, тиры по той же таблице (дробный ход — линейно между соседними
 * строками). После десятого хода таблица плоская, и цена сама падает
 * в ноль: держать заряд дальше незачем — ровно там игрок и жал.
 *
 * Здоровье в горизонт не входит (записанная оговорка part28): в
 * проигрываемой партии ходов впереди меньше, чем обещает таблица, и дар
 * стоило бы жать раньше. Поэтому совет печатает и горизонт, и цену
 * словами — чтобы игрок мог возразить числу, а не молчанию.
 *
 * Совет не ворует золото у подъёма таверны, как и обновление витрины.
 */
export function darkGiftRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const cost = state.darkGiftCost;
  if (cost === null || state.darkGiftUsedThisTurn) return null;
  if (cost > state.gold) return null;
  if (state.board.length === 0) return null;

  // Золото дара уступается подъёму только при настоящем отставании от
  // графика. Первая версия блокировала дар всякий раз, когда подъём был
  // «по карману», — а по карману он при нетронутом золоте почти всегда,
  // и на part8 дар не был посоветован ни разу за партию.
  //
  // И только тому подъёму, который правило подъёма вообще разрешает (D230).
  // part55, ход 21: hp 11 при пороге 15 — `levelUpRule` ставит подъёму ноль
  // (`blockedByHp`, D214), а дар молчал, уступая ему золото, и последний
  // заряд пропадал; игрок нажал дар сам.
  const behind =
    targetTier(state.turn, rules) > state.techLevel &&
    effectiveHp(state) >= rules.levellingHpFloor;
  const upgrade = state.tavernUpgradeCost;
  if (behind && upgrade !== null && state.gold >= upgrade && state.gold - cost < upgrade) {
    return null;
  }

  // Тир предложения — по ходу ТАВЕРНЫ; после последней строки таблицы
  // предложение не растёт, поэтому берётся её хвост.
  const tavernTurn = tavernTurnOf(state.turn);
  const tiers = darkGiftTiersAt(tavernTurn, state, rules);

  const body = averagePoolValue(tiers, state, deps, rules);
  if (body === null) return null;

  // Цена придержанного заряда — см. описание правила.
  const ahead = remainingTurns(state, rules);
  const charges = state.darkGiftCharges ?? rules.darkGift.charges;
  const spare = ahead + 1 - charges;
  let holdCost = 0;
  let holdNote = `зарядов ${String(charges)}, впереди ещё ${ahead.toFixed(1)} ходов таверны — придерживать незачем`;
  if (spare > 0) {
    const displaced = tavernTurn + spare;
    const lo = Math.floor(displaced);
    const hi = Math.ceil(displaced);
    const atLo = averagePoolValue(darkGiftTiersAt(lo, state, rules), state, deps, rules);
    const atHi = averagePoolValue(darkGiftTiersAt(hi, state, rules), state, deps, rules);
    const later =
      atLo === null ? atHi : atHi === null ? atLo : atLo + (atHi - atLo) * (displaced - lo);
    if (later !== null) {
      holdCost = Math.max(0, later - body);
      const laterTiers = darkGiftTiersAt(Math.round(displaced), state, rules);
      holdNote =
        holdCost > 0
          ? `но заряд лучше придержать: зарядов ${String(charges)}, впереди ещё ` +
            `${ahead.toFixed(1)} ходов таверны, а на ${String(Math.round(displaced))}-м ходу таверны ` +
            `дар даёт тир ${laterTiers.join(' или ')} (${later.toFixed(1)}) — спешка стоит ${holdCost.toFixed(1)}`
          : `впереди ещё ${ahead.toFixed(1)} ходов таверны, а сильнее предложение уже не станет — жать`;
    }
  }

  // Дар — это Discover (выбор из трёх), и плательщики за Discover получают
  // своё при каждом нажатии (D232; part55, 17:14:40 — триггер Hooktusk
  // сразу за выбором дара). Прибавка от ожидания не зависит: цену спешки
  // она не трогает.
  const discoverPay = discoverPayoffOf(state.board, deps.cards, rules);
  const score = body + rules.darkGift.bonus - holdCost + (discoverPay?.points ?? 0);
  if (score <= 0) return null;

  return {
    action: 'darkGift',
    minion: null,
    score,
    cost,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `тёмный дар за ${String(cost)} — раскопка из трёх миньонов с даром, ` +
      `тир ${tiers.join(' или ')} (${body.toFixed(1)}); ${holdNote}` +
      (discoverPay === null ? '' : `; ${discoverPayoffNote(discoverPay, 1)}`),
  };
}

/**
 * Тиры предложения дара на ходу таверны — строка таблицы игрока, не выше
 * этого хода; до первой строки — первая, после последней — последняя
 * (предложение не растёт). Без таблицы — свой тир таверны.
 */
function darkGiftTiersAt(tavernTurn: number, state: GameState, rules: TavernRules): readonly number[] {
  const table = rules.darkGift.tiersByTavernTurn;
  const rows = Object.keys(table)
    .map(Number)
    .sort((a, b) => a - b);
  const row = rows.findLast((r) => r <= tavernTurn) ?? rows[0];
  return (row === undefined ? undefined : table[row]) ?? [state.techLevel];
}

/**
 * Совет по выбору тринкета.
 *
 * Честная граница возможностей: у тринкета нет ни статов, ни племени в данных —
 * только текст. Из текста извлекаются упомянутые словами племена
 * (таблица `trinketTribeWords`), и варианты ранжируются по числу своих
 * миньонов этих племён. Про эффекты вне племён совет прямо говорит,
 * что оценить их не берётся, — это лучше выдуманного рейтинга.
 */
export function trinketAdvice(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): TrinketAdvice[] {
  const { cards } = deps;
  if (state.trinketOffer.length === 0) return [];
  const stats = bgStatsOf(deps);

  const scored = state.trinketOffer.map((offer) => {
    const info = cards.info(offer.cardId);
    const name = info?.name ?? offer.cardId;
    const text = info?.text ?? '';

    // Племя берётся из двух источников: теги BACON_SUBSET_<RACE> на сущности
    // (надёжнее: у «Разноцветного компаса» племя в тексте — плейсхолдер {0},
    // и текстовый разбор его не видел, part12) и слова текста — для
    // тринкетов без тега.
    const fromText = Object.entries(rules.tribeTextWords)
      .filter(([, word]) => new RegExp(`\\b(?:${word})\\b`, 'i').test(text))
      .map(([race]) => race);
    const tribes = [...new Set([...offer.subsetRaces, ...fromText])];

    const tribeMinions =
      tribes.length === 0
        ? 0
        : state.board.filter((m) => {
            const races = racesOf(m, cards);
            return races.includes(RACE_ALL) || races.some((r) => tribes.includes(r));
          }).length;

    // Сверка с составом партии: свои миньоны племени X обычно доказывают X
    // сами (куплены из витрины), но амальгамы и карты, полученные вне
    // магазина, создают фантомные племена — «Рука-протез» приносит мехов
    // в партию без мехов (part11). Пока состав недонабран, молчание данных
    // не считается отсутствием племени.
    const proven = lobbyRaces(state, cards);
    const unseen =
      proven.size >= rules.lobbyRacesKnownAfter
        ? tribes.filter((t) => !proven.has(t))
        : [];
    const unseenNote =
      unseen.length > 0 ? ` (${unseen.join('/')} в витринах партии не встречалось)` : '';

    // Статистика мест из снапшота Firestone: данные, а не мнение. Особенно
    // ценна там, где прежде было голое «оценить не берёмся».
    const stat = stats?.trinket(offer.cardId) ?? null;
    const statNote =
      stat === null ? '' : `; по статистике место ${stat.averagePlacement.toFixed(2)}`;

    // Цена НАЗЫВАЕТСЯ, но в ранжирование не входит. Она настоящая и внутри
    // одного предложения разная (part32, ход 17: 4, 5, 5 и 2 при золоте 10),
    // так что молчать о ней нельзя: точка решения показывает золото ДО
    // выбора, и план строился на золото, которого после выбора не будет.
    // Веса же у неё нет намеренно — сколько мест стоит золотой на этом
    // ходу, у нас не замерено, а выдуманный коэффициент перевернул бы
    // ранжирование, которое подтверждено игроком (docs/jeefhs.md).
    const costNote =
      offer.cost === null || offer.cost === 0
        ? ''
        : `; ${String(offer.cost)} золота, останется ${String(Math.max(0, state.gold - offer.cost))}`;

    return {
      offer,
      name,
      tribeMinions,
      averagePlacement: stat?.averagePlacement ?? null,
      reason:
        (tribes.length === 0
          ? 'эффект вне племён'
          : tribeMinions === 0
            ? `для племени ${tribes.join('/')}, а своих таких нет${unseenNote}`
            : `упоминает ${tribes.join('/')} — своих ${String(tribeMinions)}${unseenNote}`) +
        (tribes.length === 0 && stat === null ? ' — оценить не берёмся' : statNote) +
        costNote,
    };
  });

  // Ранжирование совмещает статистику и синергию. У вариантов со
  // статистикой считается «эффективное место»: среднее место минус
  // trinketPlacePerTribeMinion за каждого своего миньона племени. Так
  // сильный нейтральный обходит слабый племенной — правило JeefHS,
  // подтверждено игроком (docs/jeefhs.md), — а сильная синергия (4+
  // своих) статистикой не перебивается. Варианты без статистики
  // ранжируются прежним порядком: сначала свои племена — глобальное
  // среднее нашего борда не знает.
  const effectivePlace = (t: { averagePlacement?: number | null; tribeMinions: number }) =>
    t.averagePlacement == null
      ? null
      : t.averagePlacement - t.tribeMinions * rules.trinketPlacePerTribeMinion;
  return scored.sort((a, b) => {
    const ea = effectivePlace(a);
    const eb = effectivePlace(b);
    if (ea !== null && eb !== null && ea !== eb) return ea - eb;
    return (
      b.tribeMinions - a.tribeMinions ||
      (a.averagePlacement ?? 9) - (b.averagePlacement ?? 9)
    );
  });
}

/**
 * Состояние, на котором судятся траты хода при открытом предложении тринкетов.
 *
 * Точка решения стоит ДО выбора: золото в ней ещё целое, а вариант стоит
 * от нуля до шести (D116). Советы и план строились на всём золоте, и в 58
 * точках корпуса из 71 опознанного выбора план тратил больше, чем останется
 * (part55, ход 11: план на 8 при оставшихся 4). Вычитается цена ВЕРХНЕГО
 * варианта своего же совета — из тех, что по карману: дороже золота игра
 * тринкет не отдаст. Предложение в результате закрыто, чтобы цепочка
 * плана не вычла цену второй раз.
 */
export function afterTrinketPick(state: GameState, trinkets: readonly TrinketAdvice[]): GameState {
  if (state.trinketOffer.length === 0) return state;
  const pick = trinkets.find((t) => (t.offer.cost ?? 0) <= state.gold);
  const cost = pick?.offer.cost ?? 0;
  return { ...state, gold: state.gold - cost, trinketOffer: [] };
}

/**
 * Напоминание за ход до предложения тринкетов.
 *
 * Предложения открываются на ходах `trinketOfferTurns` (11 и 17 — 6-й
 * и 9-й ходы таверны, замерено по всем партиям билда 248348), и игра
 * подбирает их под борд — тьюторинг из базы знаний JeefHS, подтверждён
 * игроком (docs/jeefhs.md). Напоминание называет племена, у которых
 * уже есть 2+ своих, — их тринкеты и приедут; без таких — предупреждает,
 * что предложение будет случайным.
 *
 * Амальгамы (`ALL`) в счёт не идут: тьюторингу нужен внятный сигнал
 * борда, а амальгама «своя» для всех племён сразу.
 */
export function trinketForecast(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): string | null {
  if (!rules.trinketOfferTurns.includes(state.turn + 2)) return null;

  const counts = new Map<string, number>();
  for (const m of state.board) {
    for (const race of racesOf(m, deps.cards)) {
      if (race === RACE_ALL) continue;
      counts.set(race, (counts.get(race) ?? 0) + 1);
    }
  }
  const strong = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([race, n]) => `${race} ×${String(n)}`);

  return strong.length > 0
    ? `следующим ходом — выбор тринкета; предложение подбирается под борд, ` +
        `своих 2+: ${strong.join(', ')}`
    : 'следующим ходом — выбор тринкета; предложение подбирается под борд, ' +
        'а племени с 2+ своими нет — держите пару миньонов желаемого племени';
}

/**
 * Герой, чью силу нам предлагают, — по соглашению идентификаторов.
 *
 * Нужно выбору Мастера Нгуена (`BG20_HERO_202`, part26): он меняет силу
 * КАЖДЫЙ ход, и варианты — это силы чужих героев. Своей ценности у силы
 * героя мы не считаем (то же решение, что и с самими героями: статистика
 * и есть её свёртка), зато у героя есть среднее место Firestone.
 *
 * Соглашение: `<id героя>p`, `…p2`, `…p_Alt` (BG25_HERO_103p,
 * BG23_HERO_303p2, BG22_HERO_000p_Alt). Проверка не по регулярке, а по
 * справочнику: совпал ли базовый id с настоящей картой героя. Силы старого
 * образца (`TB_BaconShop_HP_020`) героя в имени не несут — их 100 из 169
 * в пуле, и для них ответ честно остаётся «оценить не берёмся».
 */
function heroOfPower(powerCardId: string, cards: CardIndex): string | null {
  const m = /^(.*_HERO_[A-Za-z0-9]+)p\d*(?:_Alt)?$/.exec(powerCardId);
  const base = m?.[1];
  if (base === undefined) return null;
  return cards.info(base)?.type === 'HERO' ? base : null;
}

/**
 * Ценность силы героя, ПРЕДЛОЖЕННОЙ В ВЫБОРЕ, — тем же текстом и той же
 * шкалой, что и всё остальное.
 *
 * Отличие от `heroPowerRule` одно, но важное: у варианта выбора нет
 * сущности, а значит нет и живого тега `COST`. Цену нажатия карта
 * не несёт, поэтому скидка «дешевле покупки» не начисляется вовсе
 * (`cost = minionCost` обнуляет разницу) — оценка нижняя и честная.
 */
function heroPowerChoiceValue(
  cardId: string,
  scriptData: readonly (number | null)[],
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): { readonly score: number; readonly note: string } | null {
  const text = deps.cards.info(cardId)?.text ?? '';
  if (text === '') return null;

  // «Discover a Naga» (King of Naga) — миньона обещает ПЛЕМЯ, а слова
  // «minion» в тексте нет вовсе; тот же случай, что «Discover a Buddy»
  // у E.T.C. (part12). Шаблон строится из той же таблицы слов племён,
  // что и везде, и живёт ЗДЕСЬ, а не в общем `givesMinionWords`: общая
  // таблица кормит правила покупки и заморозки, и расширять её значит
  // перемерять их все. Тот же разбор судит ветви модальных миньонов
  // (part28), поэтому и вынесен в `tribeMinionRace`.
  const givesTribeMinion = tribeMinionRace(text, rules) !== null;

  // ЗАМЕНА идёт раньше «даёт миньона», и это не тонкость: «Destroy
  // a friendly Undead to get a random Undead» (Rune of Damnation) даёт
  // миньона ВЗАМЕН своего, а не сверх борда. Прочитанное как «даёт
  // миньона», оно стоило бы целой покупки (7.6 очка вместо 3.0).
  // Разбор текста один на обе ветки: и на замену, и на разовый эффект ниже.
  const effect = spellEffect(cardId, scriptData, deps.cards, rules);
  if (effect !== null && effect.transforms) {
    return {
      score: rules.value.transform,
      note: 'меняет своего миньона на нового',
    };
  }

  if (givesTribeMinion || rules.givesMinionWords.some((w) => new RegExp(w, 'i').test(text))) {
    const tiered = namedTierPool(text, state, deps, rules);
    const { score, average } = givesMinionValue(
      state,
      deps,
      rules,
      rules.minionCost,
      false,
      tiered ?? undefined,
    );
    return { score, note: `даёт миньона — ${minionSourceNote(tiered, average)}` };
  }
  if (rules.heroPowerRefreshWords.some((w) => new RegExp(w, 'i').test(text))) {
    return { score: rules.freeHeroPowerValue, note: 'обновляет витрину' };
  }
  if (rules.heroPowerSpellWords.some((w) => new RegExp(w, 'i').test(text))) {
    return { score: rules.heroPowerSpellValue, note: 'даёт заклинание таверны' };
  }

  // Разовый эффект читается только у силы, которая ПРЯМО СЕЙЧАС что-то
  // делает со своим миньоном, и только если в тексте нет триггера. Иначе
  // числа выходят тихо неверными: у «Tavern Lighting» («Your Tavern spells
  // give an extra +{1}/+{1}. At the start of every 3 turns, improve this»)
  // разбор находил +2 статов и оценивал вечную прибавку ко ВСЕМ будущим
  // заклинаниям в одно очко. Молчание тут честнее числа.
  const targetsMinion = /\b(?:a|your) minion\b|\bfriendly\b/i.test(text);
  const hasTrigger = rules.engineTextWords.some((w) => new RegExp(w, 'i').test(text));
  if (!targetsMinion || hasTrigger) return null;

  // Замена сюда не доходит — она названа выше и вернула свой ответ.
  if (effect === null) return null;
  const score =
    effect.stats * rules.value.perStatPoint +
    (effect.divineShield ? rules.value.divineShield : 0) +
    effect.gold * rules.goldPointValue;
  if (score <= 0) return null;
  const parts = [
    effect.stats > 0 ? `+${String(effect.stats)} статов` : '',
    effect.divineShield ? 'щит' : '',
    effect.gold > 0 ? `${String(effect.gold)} золота` : '',
  ].filter((p) => p !== '');
  return { score, note: parts.join(', ') };
}

/**
 * Совет по ставке на чужой бой — фактами, а не выдуманным весом.
 *
 * Спрашивают о будущем чужого боя, а знаем мы про игроков ровно то, что
 * лог говорит открыто: тир таверны, здоровье с бронёй, место в таблице
 * и то, как давно мы видели их борд. Порядок — по ТИРУ, при равенстве
 * по здоровью: тир говорит о силе доступных миньонов, то есть о самом
 * бое, а здоровье — о прошлых боях.
 *
 * Симулятор здесь НЕ применяется намеренно. Борд чужого игрока виден
 * только в бою с ним, и к моменту ставки картинке 5–17 ходов; сверять
 * по ней уже записано как ошибка (docs/position.md), и «точный процент»
 * от неё был бы числом без содержания.
 */
function wagerAdvice(
  options: readonly ChoiceOption[],
  state: GameState,
  deps: TavernAdvisorDeps,
): ChoiceAdvice[] {
  const judged = options.map((option) => {
    const name = deps.cards.info(option.cardId)?.name ?? option.cardId;
    // Игрок ищется по БАЗОВОЙ карте героя: варианты ставки приходят базовыми
    // (part26: `BG27_HERO_801`, `TB_BaconShop_HERO_33`), а в таблице лобби
    // тот же игрок стоит со своим скином — в тех же партиях их полно
    // (`TB_BaconShop_HERO_58_SKIN_E`, `BG20_HERO_282_SKIN_C4`). Сырое
    // сравнение на скине не совпадает, и половина ставки молча уходила
    // в «оценить не берёмся» — то есть ранжирование по тиру и здоровью
    // выключалось там, где данные для него есть.
    const wanted = baseHeroCardId(option.cardId);
    const player = Object.values(state.lobby).find(
      (p) => baseHeroCardId(p.heroCardId) === wanted,
    );
    if (player === undefined) {
      return { option, name, value: null, score: null, reason: 'оценить не берёмся' };
    }

    const hp = (player.health ?? 0) - player.damage + player.armor;
    const seenTurn = state.lastSeenBoardTurns[player.playerId];
    const board =
      seenTurn === undefined
        ? 'борда его мы не видели'
        : `борд видели ${String(state.turn - seenTurn)} ходов назад`;
    const tier = player.techLevel ?? 0;
    return {
      option,
      name,
      value: null,
      // Ключ сортировки, а не очки: тир главнее, здоровье разводит равных.
      score: tier * 100 + hp,
      reason:
        `тир ${String(tier)}, hp ${String(hp)}, место ${String(player.place ?? '?')} — ${board}`,
    };
  });

  const sorted = [...judged].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  const top = sorted[0];
  const next = sorted[1];
  if (top?.score != null && next?.score != null && top.score !== next.score) {
    const why = Math.floor(top.score / 100) > Math.floor(next.score / 100) ? 'тиру' : 'здоровью';
    return [{ ...top, reason: `${top.reason}; впереди по ${why}` }, ...sorted.slice(1)];
  }
  return sorted;
}

/** Один вариант открытого выбора «возьмите одно из» с оценкой. */
export interface ChoiceAdvice {
  readonly option: ChoiceOption;
  readonly name: string;
  /** Оценка той же функцией, что у витрины. `null` у не-миньонов. */
  readonly value: ValueBreakdown | null;
  /**
   * Ключ ранжирования ВНУТРИ одного выбора — сравнивать между выборами
   * его нельзя. У миньонов это `value.total`, у заклинаний — оценка
   * эффекта из текста, у выбора сил героя (part26) — среднее место
   * со знаком минус (меньше место — выше строка), у «Дружеской ставки» —
   * упакованная пара «тир, здоровье». `null` — оценить не взялись.
   *
   * Шкалы разные намеренно: ранжируется та, что есть у ВСЕХ вариантов
   * одного выбора, и смешивать их запрещено (part26).
   */
  readonly score: number | null;
  readonly reason: string;
}

/**
 * Совет по открытому выбору: награда за тройку, раскопка карт, сокровища.
 *
 * Варианты-миньоны оцениваются той же функцией, что и витрина, — тир, статы,
 * племя, копии. Именно здесь копии решают: выбор, собирающий тройку, стоит
 * выше любых статов. Варианты-заклинания оцениваются эффектом из текста
 * (усиление, щит, золото) — так выбор сокровищ part10 («+{0} Attack and
 * Divine Shield» против бананов) получает рекомендацию, а не молчание.
 * Что не разобралось, честно помечено «оценить не берёмся».
 *
 * Тринкеты сюда не попадают: их выбор идёт отдельным полем `trinkets`
 * со своим ранжированием по племенам из текста.
 */
export function choiceAdvice(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): ChoiceAdvice[] {
  const choice = state.openChoice;
  if (choice === null || choice.options.length === 0) return [];

  // Ставка на ЧУЖОЙ БОЙ: «Дружеская ставка» (`TB_BaconShop_HP_081`,
  // part26) предлагает угадать, кто из двух игроков выиграет свой следующий
  // бой, и варианты приходят картами ГЕРОЕВ, а не миньонов. Выбор героя
  // в начале партии сюда не попадает — он живёт отдельным полем
  // (`heroChoice`, канал `ChoiceType=MULLIGAN`), но источник проверяется
  // всё равно: ставку делает сила героя.
  if (
    deps.cards.info(choice.sourceCardId ?? '')?.type === 'HERO_POWER' &&
    choice.options.every((o) => deps.cards.info(o.cardId)?.type === 'HERO')
  ) {
    return wagerAdvice(choice.options, state, deps);
  }

  // Выбор из СИЛ ГЕРОЯ — отдельный случай: так меняет силу Мастер Нгуен,
  // каждый ход (part26). Шкал тут две, и смешивать их нельзя — это тот же
  // урок, что с планкой заморозки (part23): сравнивать можно только числа
  // одной начинки.
  //
  //  * ОЧКИ — эффект силы, прочитанный из текста на нашем состоянии
  //    (даёт миньона, обновляет витрину, даёт заклинание, усиление). Это
  //    наша обычная шкала, и она знает про борд и тир;
  //  * МЕСТО — среднее место героя, чью силу предлагают (Firestone).
  //    Число чужое и про ЦЕЛУЮ партию этого героя, а Нгуену сила достаётся
  //    на один ход, — поэтому оно всегда подписано «по статистике» и
  //    в очки не переводится.
  //
  // Ранжируем по той шкале, которая есть у ВСЕХ вариантов; когда общей нет,
  // порядок не выдумывается — каждый вариант говорит, что про него известно.
  if (choice.options.every((o) => deps.cards.info(o.cardId)?.type === 'HERO_POWER')) {
    const stats = bgStatsOf(deps);
    const judged = choice.options.map((option) => {
      const info = deps.cards.info(option.cardId);
      const name = info?.name ?? option.cardId;
      const points = heroPowerChoiceValue(
        option.cardId,
        option.scriptData ?? [],
        state,
        deps,
        rules,
      );
      const heroId = heroOfPower(option.cardId, deps.cards);
      const stat = heroId === null ? null : (stats?.hero(heroId) ?? null);
      const heroName = heroId === null ? null : (deps.cards.info(heroId)?.name ?? heroId);
      return { option, name, points, stat, heroName };
    });

    const allPoints = judged.every((j) => j.points !== null);
    const allStats = judged.every((j) => j.stat !== null);
    return judged
      .map((j) => {
        const parts = [
          j.points === null ? '' : `${j.points.note} — ${j.points.score.toFixed(1)} очка`,
          j.stat === null
            ? ''
            : `по статистике героя (${j.heroName ?? ''}) среднее место ${j.stat.averagePosition.toFixed(2)}`,
        ].filter((p) => p !== '');
        // Очки проставляются, только когда шкала общая: они и есть заявка
        // на порядок. Разные шкалы — заявки нет, но известное всё равно
        // стоит выше неизвестного (сортировка ниже стабильна).
        const score = allPoints
          ? (j.points?.score ?? null)
          : allStats
            ? // Место тем лучше, чем меньше: в очки не переводим, только
              // разворачиваем для сортировки.
              -(j.stat?.averagePosition ?? 0)
            : null;
        return {
          option: j.option,
          name: j.name,
          value: null,
          score,
          known: parts.length > 0,
          reason: parts.length === 0 ? 'оценить не берёмся' : parts.join('; '),
        };
      })
      .sort((a, b) =>
        a.score !== null && b.score !== null
          ? b.score - a.score
          : Number(b.known) - Number(a.known),
      )
      .map((j) => ({ option: j.option, name: j.name, value: j.value, score: j.score, reason: j.reason }));
  }

  const scored = choice.options.map((option) => {
    const info = deps.cards.info(option.cardId);
    const name = info?.name ?? option.cardId;

    if (info === null || info.type !== 'MINION') {
      // Заклинание: оценка эффекта из текста и тегов варианта.
      const parsed =
        info !== null && (info.type?.includes('SPELL') ?? false)
          ? spellEffect(option.cardId, option.scriptData ?? [], deps.cards, rules)
          : null;
      // Статы на весь борд — той же функцией, что у покупки и розыгрыша (part51).
      const onBoard =
        parsed === null ? null : effectOnBoard(parsed, state.board, rules, deps.cards);
      const effect = onBoard?.effect ?? null;
      if (effect === null || (effect.stats === 0 && !effect.divineShield && effect.gold === 0)) {
        return { option, name, value: null, score: null, reason: 'оценить не берёмся' };
      }
      const score =
        effect.stats * rules.value.perStatPoint +
        (effect.divineShield ? rules.value.divineShield : 0) +
        effect.gold * rules.goldPointValue;
      const parts = [
        effect.stats > 0
          ? `+${String(effect.stats)} статов${bodiesNote(onBoard?.bodies ?? 1)}`
          : '',
        effect.divineShield ? 'щит' : '',
        effect.gold > 0 ? `${String(effect.gold)} золота` : '',
      ].filter((p) => p !== '');
      return {
        option,
        name,
        value: null,
        score,
        reason: `заклинание: ${parts.join(', ')} — очки ${score.toFixed(1)}`,
      };
    }

    // Псевдо-миньон из справочника, поверх которого кладутся статы и тир
    // СУЩНОСТИ варианта (D199): тёмный дар меняет их до экрана выбора
    // (part52 — Jailer 15/17 против 3/5 снапшота, part55 — Extortionist
    // 28/28 против 7/7). Ключевые слова по-прежнему не ставятся —
    // тир, статы, племя и копии дают основную часть различий.
    const card = minionFromCard(info, option.entityId, false);
    const health = option.health ?? card.health;
    const candidate: Minion = {
      ...card,
      attack: option.attack ?? card.attack,
      health,
      maxHealth: health,
      techLevel: option.techLevel ?? card.techLevel,
    };
    const value = minionValue(candidate, state, deps, rules);

    const notes: string[] = [];
    if (value.completesTriple) notes.push('собирает тройку');
    else if (value.tripleBet) notes.push('вторая копия');
    if (value.tribeMates > 0) notes.push(`своих по племени ${String(value.tribeMates)}`);
    if (value.textTribeMates > 0) {
      notes.push(`племя из текста: своих ${String(value.textTribeMates)}`);
    }
    if (value.doubler > 0) notes.push('свой удвоитель на борде — триггер принесёт вдвое');
    if (info.magnetic) notes.push('магнитный');

    return {
      option,
      name,
      value,
      score: value.total,
      reason:
        `тир ${candidate.techLevel === null ? '?' : String(candidate.techLevel)}, ` +
        `ценность ${value.total.toFixed(1)}` +
        (notes.length > 0 ? ` — ${notes.join(', ')}` : ''),
    };
  });

  // По убыванию очков; неоценённое — в конце в исходном порядке.
  return scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/** Шаг плана розыгрыша. */
export interface PlanStep {
  readonly minion: Minion;
  /** К кому примагнитить; `null` — поставить в свободный слот. */
  readonly magnetizeTo: Minion | null;
  /** Кого продать ради места. Не больше одного такого шага на план. */
  readonly sellFirst: Minion | null;
  readonly score: number;
}

/**
 * План розыгрыша, когда разыграть стоит несколько карт за ход.
 *
 * Отдельные советы «разыграть X» этого не выражают: игрок читает верхнюю
 * строку и ставит одну карту, хотя мог разыграть больше (part9, ход 25 —
 * на борде одно место, а в руке Glambot, Kangor's Apprentice и магнитный
 * Accord-o-Tron). План раскладывает розыгрыши по слотам сам: обычные миньоны
 * по убыванию ценности занимают свободные места, магнитные примагничиваются
 * и мест не тратят. Порядок в плане — сначала тела, потом магниты: свежий
 * мех тоже кандидат в носители.
 */
export function playPlan(
  state: GameState,
  deps: TavernAdvisorDeps,
  plays: readonly Recommendation[],
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): PlanStep[] {
  const candidates = [...plays]
    .filter((r) => r.action === 'play' && r.minion !== null)
    .sort((a, b) => b.score - a.score);
  if (candidates.length < 2) return [];

  let slots = Math.max(0, rules.boardSize - state.board.length);
  const boardAfter: Minion[] = [...state.board];
  const bodies: PlanStep[] = [];
  const magnets: { rec: Recommendation; minion: Minion }[] = [];
  // Розыгрыш через продажу в плане один: жертву каждый совет считал против
  // исходного борда, и второй такой шаг продавал бы того же миньона дважды.
  let displaced = false;

  for (const rec of candidates) {
    const minion = rec.minion;
    if (minion === null) continue;
    if (isMagnetic(minion, deps.cards)) {
      magnets.push({ rec, minion });
      continue;
    }
    if (slots > 0) {
      slots -= 1;
      boardAfter.push(minion);
      bodies.push({ minion, magnetizeTo: null, sellFirst: null, score: rec.score });
      continue;
    }
    if (rec.sellFirst !== null && !displaced) {
      displaced = true;
      boardAfter.push(minion);
      bodies.push({ minion, magnetizeTo: null, sellFirst: rec.sellFirst, score: rec.score });
    }
  }

  // Магниты после тел: только что разыгранный мех — тоже кандидат в носители.
  const magnetSteps: PlanStep[] = [];
  const poison = poisonAmongSeen(state);
  for (const { rec, minion } of magnets) {
    const host = magnetizeTarget(
      minion,
      boardAfter.filter((m) => m.entityId !== minion.entityId),
      deps.cards,
      poison,
      claimsMagnetDoubler(minion, state, deps.cards),
    );
    if (host !== null) {
      magnetSteps.push({ minion, magnetizeTo: host, sellFirst: null, score: rec.score });
      // Удвоение потрачено ЭТИМ шагом: следующий модуль обязан считать
      // носителя обычным, иначе цепочка обещала бы удвоение дважды. Тот же
      // приём, что в плане трат (`withMagnetDoublingSpent`), — здесь он
      // на месте, потому что `boardAfter` изменяемый.
      const spent = withMagnetDoublingSpent(boardAfter, host);
      if (spent !== boardAfter) boardAfter.splice(0, boardAfter.length, ...spent);
    } else if (slots > 0) {
      slots -= 1;
      boardAfter.push(minion);
      magnetSteps.push({ minion, magnetizeTo: null, sellFirst: null, score: rec.score });
    }
  }

  const steps = [...bodies, ...magnetSteps];
  return steps.length >= 2 ? steps : [];
}

/**
 * Совет по таверне целиком.
 *
 * Возвращает `null` вне фазы таверны: советовать покупки во время боя
 * бессмысленно, а притворяться, что состояние подходит, — вредно.
 */
export function adviseTavern(
  input: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): TavernAdvice | null {
  if (input.phase !== 'tavern') return null;
  // Тринкеты судятся на открытом предложении, всё остальное — на золоте,
  // которое останется после выбора (`afterTrinketPick`).
  const trinkets = trinketAdvice(input, deps, rules);
  const state = afterTrinketPick(input, trinkets);

  // До выбора героя советовать нечего, КРОМЕ самого выбора героя: он идёт
  // тем же каналом выборов, и его ранжирует статистика мест.
  if (state.hero === null) {
    if (state.heroChoice === null) return null;
    return {
      recommendations: [],
      gold: state.gold,
      targetTier: targetTier(state.turn, rules),
      shopValues: [],
      trinkets: [],
      choice: [],
      playPlan: [],
      heroChoice: heroChoiceAdvice(state, deps),
      trinketForecast: null,
    };
  }

  const buys = buyRules(state, deps, rules);
  const plays = playRules(state, deps, rules);
  const recommendations: Recommendation[] = [
    ...buys,
    ...plays,
    ...spellRules(state, deps, rules),
    ...shopSpellRules(state, deps, rules),
    levelUpRule(state, rules, buys, copiesForTriple(state, deps.cards, rules)),
    heroPowerRule(state, deps, rules),
    freeHeroPowerRule(state, deps, rules),
    heroPowerKeywordRule(state, deps, rules),
    heroPowerStatsRule(state, deps, rules),
    heroPowerShareAttackRule(state, deps, rules),
    heroPowerGoldenRule(state, deps, rules),
    heroPowerDigRule(state, deps, rules),
    heroPowerSpellRule(state, deps, rules),
    heroPowerGoldRule(state, deps, rules),
    heroPowerShotRule(state, deps, rules),
    heroPowerUpgradeRule(state, deps, rules),
    ...activationRules(state, deps, rules),
    darkGiftRule(state, deps, rules),
    spinRule(state, deps, rules, buys),
    sellRule(state, deps, rules),
    sellForGoldRule(state, deps, rules),
    rerollRule(state, deps, rules),
    freezeRule(state, deps, rules),
    {
      action: 'pass',
      minion: null,
      score: 0,
      cost: 0,
      requiresSlot: false,
      sellFirst: null,
      reason: 'ничего не делать и оставить золото',
    },
  ].filter((r): r is Recommendation => r !== null);

  const sorted = recommendations.sort((a, b) => b.score - a.score);

  // «Делать нечего, а золото есть»: когда лучший совет — «ничего», а на
  // обновление витрины хватает, обновление и есть ход — поиск лучшего.
  // Случай part11: борд полон и силён, все покупки отсеяны, 5 золота,
  // совет «НИЧЕГО» — игрок справедливо заметил, что мог обновляться.
  const idleRerollCost = rerollCostOf(state, rules);
  // Найденное не на что купить — обновление только под названную цель
  // заморозки, как в `rerollRule` (part27, ход 19).
  const idleCannotBuy = state.gold - idleRerollCost < rules.cheapestShopPrice;
  const idleGoal = idleCannotBuy ? rerollFreezeGoal(state, deps, rules) : null;
  if (
    sorted[0]?.action === 'pass' &&
    state.gold >= idleRerollCost &&
    // «Делать нечего» с золотом на покупку — повод искать; с золотом
    // на один реролл в ранней партии — нет (part18, ход 7).
    paidRerollIsUseful(state, rules) &&
    (!idleCannotBuy || idleGoal !== null) &&
    state.shop.some((m) => !m.frozen)
  ) {
    const idlePrice =
      idleRerollCost === 0 ? 'обновление бесплатно' : `обновление стоит ${String(idleRerollCost)}`;
    sorted.unshift({
      action: 'reroll',
      minion: null,
      score: 0.5,
      cost: idleRerollCost,
      requiresSlot: false,
      sellFirst: null,
      searchGoal: idleGoal?.what ?? null,
      reason:
        idleGoal !== null
          ? `золота ${String(state.gold)} — купить нечего и после обновления, но ${idlePrice}: ` +
            `искать под заморозку ${idleGoal.what} — ${idleGoal.why}`
          : idleRerollCost === 0
            ? 'покупать нечего и некуда, а обновление бесплатно — искать лучшее'
            : `покупать нечего и некуда, а золота ${String(state.gold)} — ` +
              'обновление витрины в поиске лучшего',
    });
  }

  return {
    recommendations: sorted,
    gold: state.gold,
    targetTier: targetTier(state.turn, rules),
    shopValues: state.shop.map((minion) => ({
      minion,
      value: minionValue(minion, state, deps, rules),
    })),
    trinkets,
    choice: choiceAdvice(state, deps, rules),
    playPlan: playPlan(state, deps, plays, rules),
    heroChoice: heroChoiceAdvice(state, deps),
    trinketForecast: trinketForecast(state, deps, rules),
  };
}
