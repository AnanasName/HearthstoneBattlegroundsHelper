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
  readonly total: number;
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

/** Ценность миньона: во что складываются веса из таблицы правил. */
export function minionValue(
  candidate: Minion,
  state: GameState,
  { cards }: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): ValueBreakdown {
  const w = rules.value;
  const info = cards.info(candidate.cardId);

  const tech = (candidate.techLevel ?? info?.techLevel ?? 1) * w.perTechLevel;
  const stats = ((candidate.attack ?? 0) + (candidate.health ?? 0)) * w.perStatPoint;

  const mates = tribeMates(candidate, state.board, cards);
  const tribe = mates * w.perTribeMate;

  // Веса и капы слов — в `keywordValue` (щит не дороже тела, part7).
  // Яд и токсин — одно слово с одним весом, дважды не считаются.
  const keywords = BINARY_KEYWORDS.filter(([, field]) => candidate[field])
    .filter(([, field]) => field !== 'venomous' || !candidate.poisonous)
    .reduce(
      (sum, [, field]) =>
        sum + keywordValue(field, candidate.attack ?? 0, candidate.health ?? 0, rules),
      0,
    );

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
    heroPowerPlay,
    heroPowerBuy,
    heroPowerBuyLeft,
    heroPowerBuyReward: heroPowerBuyRewardName,
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
      heroPowerPlay +
      heroPowerBuy,
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
 * Порядок предпочтений: пригодные по племени → кому дар не пропадёт →
 * при яде со щитом → самый крупный. Каждый следующий фильтр отступает,
 * если оставляет пусто: статы складываются всегда, и совсем без носителя
 * магнит остаётся телом.
 */
export function magnetizeTarget(
  magnet: Minion,
  board: readonly Minion[],
  cards: CardIndex,
  poisonThreat = false,
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

  const grants = BINARY_KEYWORD_FLAGS.filter(([mech]) =>
    magnetInfo?.mechanics.includes(mech) ?? false,
  );
  let pool = eligible;
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
  return value.total - value.copies - value.heroPowerPlay - value.heroPowerBuy;
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
  const victim = full ? weakestOwn(state, deps, rules) : null;
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

      // Магнитному миньону носитель называется всегда, а не только на полном
      // борде: игрок решает «телом или примагнитить», и совет без носителя
      // перекладывал половину решения на него (part13, ход 15). На полном
      // борде носитель ещё и освобождает от продажи: слот магниту не нужен.
      const host = isMagnetic(minion, deps.cards)
        ? magnetizeTarget(minion, state.board, deps.cards, poisonAmongSeen(state))
        : null;

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

      // Золотой продажи хватает только тому, кто продажу и делает: у прочих
      // веток бюджет остаётся прежним, и «по карману» решается остатком.
      if (cost > state.gold && sellFirst === null) return [];

      // Пометка про копии не дублирует ветку тройки на полном борде выше.
      if (value.completesTriple && !notes.some((n) => n.includes('тройку'))) {
        notes.unshift('собирает тройку');
      } else if (value.tripleBet && !notes.some((n) => n.includes('тройку'))) {
        notes.unshift('вторая копия');
      }
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
          score: value.total,
          cost,
          requiresSlot,
          sellFirst,
          magnetizeTo: host,
          ...(value.heroPowerBuyLeft === null ? {} : { heroPowerBuyLeft: value.heroPowerBuyLeft }),
          // Пол — ЕДИНИЦА, и это не подобранное число, а край наблюдений.
          // В логе part40 цена силы принимает ровно три значения: 3 (десять
          // раз), 2 (десять) и 1 (дважды); НУЛЯ нет ни разу. Считать ниже
          // виденного значило бы гадать — и гадать в сторону, где наше же
          // правило силы уходит в молчание (`cost <= 0` возвращает null),
          // то есть правка создала бы новую тихую дыру вместо совета.
          // Появится фикстура с нулём — пол снимется вместе с ней.
          ...(powerDiscount !== null &&
          powerCost !== null &&
          (deps.cards.info(minion.cardId)?.races ?? []).includes(powerDiscount.race)
            ? { heroPowerCostAfter: Math.max(1, powerCost - powerDiscount.amount) }
            : {}),
          reason:
            `${name} ${String(minion.attack ?? '?')}/${String(minion.health ?? '?')} ` +
            `тир ${tier === null ? '?' : String(tier)}, ценность ${value.total.toFixed(1)}` +
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
  const victim = full ? weakestOwn(state, deps, rules) : null;

  return state.hand.flatMap((minion) => {
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
      ? magnetizeTarget(minion, state.board, deps.cards, poisonAmongSeen(state))
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
        score: playValue,
        cost: 0,
        requiresSlot: full && host === null,
        sellFirst: full && host === null ? (victim?.minion ?? null) : null,
        magnetizeTo: host,
        spellBranches: modal?.branches,
        reason:
          `${name} ${String(minion.attack ?? '?')}/${String(minion.health ?? '?')} из руки, ` +
          `ценность ${playValue.toFixed(1)}` +
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
  if (state.board.length >= rules.boardSize) return null;

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
  const numbers: Readonly<Record<string, number>> = { two: 2, three: 3, four: 4 };

  /**
   * Сколько карт обещает клич. Счёт написан либо словом, либо цифрой,
   * и оба чтения обязательны: пропущенная цифра роняет счёт на единицу,
   * а с ним и всё правило (part38 — см. `battlecryGetCountWords`).
   */
  const promisedCards = (text: string): number => {
    for (const word of rules.battlecryGetCountWords) {
      const raw = new RegExp(word, 'i').exec(text)?.[1]?.toLowerCase();
      if (raw === undefined) continue;
      const count = numbers[raw] ?? Number(raw);
      if (Number.isFinite(count) && count > 0) return count;
    }
    return 1;
  };

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
    if (cost > state.gold) continue;
    // Копию не прокручивают: продажа ломает будущую тройку.
    if (copiesOwned(minion, state) > 0) continue;

    const text = deps.cards.info(minion.cardId)?.text ?? '';
    if (text === '') continue;
    const kind = spinKindOf(text, rules);
    if (kind === null) continue;
    // Батлкрайного генератора, который сам — лучшая покупка, не прокручивают.
    if (kind === 'battlecry' && bestBuy?.minion?.entityId === minion.entityId) continue;

    const net = cost - rules.sellGold;
    let base: number;
    let note: string;
    if (kind === 'battlecry') {
      const count = promisedCards(text);
      base = count * rules.heroPowerSpellValue - net * rules.goldPointValue;
      note = `клич даст ${String(count)} карт.`;
    } else {
      const spun = sellSpinValue(minion, state, deps, rules, true);
      if (spun === null) continue;
      base = spun.score;
      note =
        spun.tier === null
          ? 'продажа даст миньона'
          : `продажа даст миньона тира ${String(spun.tier)}`;
    }
    if (base <= 0) continue;

    // Пока выполнимы и прокрутка, и лучшая покупка, прокрутка идёт первой:
    // начатая с покупки цепочка умирает — золота на генератора не остаётся.
    const rival = bestBuyExcept(minion.entityId);
    const affordBoth = rival?.minion != null && state.gold - net >= buyCostOf(rival.minion, rules);
    const score = affordBoth && rival !== null ? Math.max(base, rival.score + 0.5) : base;
    if (best === null || base > best.base) best = { minion, net, base, score, note };
  }
  if (best === null) return null;

  const name = deps.cards.info(best.minion.cardId)?.name ?? best.minion.cardId;
  const next = bestBuyExcept(best.minion.entityId);
  const followUp =
    next?.minion != null && state.gold - best.net >= buyCostOf(next.minion, rules)
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
    sellFirst: null,
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
  const nextGold = Math.min(2 + tavernTurnOf(state.turn) + 1, 10);
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
    for (let t = tavernTurnOf(state.turn) + 1; t < 12; t++) {
      if (Math.min(2 + t, 10) >= need) return t;
    }
    return tavernTurnOf(state.turn) + 1;
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
    const gold = Math.min(2 + turnAffordingBoth(spent), 10);
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
    const nextTavernTurn = tavernTurnOf(state.turn) + 1;
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
 * Можно ли нажать силу героя ПРЯМО СЕЙЧАС — три запрета одним местом.
 *
 * Запретов три, и каждый читается из лога: сила уже нажата в этом ходу
 * (блок PLAY на её сущности), сила временно неиграбельна
 * (`LITERALLY_UNPLAYABLE`) и сила ещё не открыта (`LOCK_VISUAL` — замок
 * «Unlocks at Tier N», part37).
 *
 * Одной функцией, а не тремя условиями в пяти правилах: два первых запрета
 * и были размножены по пяти местам, и добавление третьего в четыре из пяти
 * прошло бы молча — ровно тот способ, которым разъезжаются списки
 * (`CURRENT_BUILD_PARTS`, docs/journal.md). Прочие условия у правил свои:
 * `heroPowerHasActivate` (пассивную силу не «нажимают»), цена, место
 * на борде.
 */
export function heroPowerReady(hero: {
  readonly heroPowerUsedThisTurn: boolean;
  readonly heroPowerUnplayable: boolean;
  readonly heroPowerLocked: boolean;
}): boolean {
  return !hero.heroPowerUsedThisTurn && !hero.heroPowerUnplayable && !hero.heroPowerLocked;
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

  const cost = hero.heroPowerCost;
  if (cost === null || cost <= 0) return null;
  if (!heroPowerReady(hero)) return null;

  // Найденный миньон приходит в руку, и на полном борде место ему освобождает
  // ПРОДАЖА — та самая, что приносит золотой. Значит «по карману» считается
  // вместе с ней, ровно как у покупки (part36, ход 13). Случай part40 (ход 13):
  // золото 1, борд полон, сила стоит 2 — оверлей сказал «НИЧЕГО», а игрок
  // продал Southsea Busker и нажал силу, получив золотого Aureate Laureate.
  // Прибавка идёт ТОЛЬКО там, где продажа и так подразумевается: `victim`
  // не пуст лишь на полном борде, и продавать «просто ради монеты» правило
  // по-прежнему не предлагает.
  const victim = handMinionVictim(state, deps, rules);
  if (cost > state.gold + (victim === null ? 0 : rules.sellGold)) return null;

  const info = deps.cards.info(hero.heroPowerCardId);
  const text = info?.text ?? '';

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
  const hurried = score - hurry.cost;
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
      (hurry.note === null ? '' : `; ${hurry.note}`) +
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

  const cost = hero.heroPowerCost ?? 0;
  // Бесплатные силы живут в freeHeroPowerRule; здесь — платная экономика.
  if (cost <= 0 || cost > state.gold) return null;

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
      `${info?.name ?? hero.heroPowerCardId} за ${String(cost)} даёт заклинание таверны — ` +
      'оно стоит дороже своей цены, нажать, пока золото не сгорело',
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
    const text = info?.text ?? '';
    const activate = /activate \([^)]*\):([\s\S]*)$/i.exec(text);
    if (activate?.[1] === undefined) return [];
    const effectText = activate[1];

    // Тот же разбор, что у заклинаний: литералы и плейсхолдеры-индексы
    // в теги NUM — только теги здесь живут на самом миньоне.
    let stats = 0;
    for (const m of effectText.matchAll(/\+(?:\{(\d)\}|(\d+))/g)) {
      const placeholder = m[1];
      const literal = m[2];
      if (placeholder !== undefined) stats += minion.scriptData[Number(placeholder)] ?? 0;
      else if (literal !== undefined) stats += Number(literal);
    }
    const givesMinion = /\b(?:get|summon|discover)\b/i.test(effectText);

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

    // Поглощение витрины: сколько своих едят и по сколько статов достаётся.
    // Оба числа читаемы — племя из текста, статы из витрины.
    const consumed = consumeGain(effectText, state, deps, rules);

    if (consumed !== null) {
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
    } else if (stats > 0) {
      score = stats * rules.value.perStatPoint - cost * rules.goldPointValue;
      what = `+${String(stats)} статов`;
    } else if (givesMinion) {
      // Приносимое тело оценивается как средний миньон текущего тира.
      score = rules.value.perTechLevel * state.techLevel - cost * rules.goldPointValue;
      what = 'принесёт миньона';
    }
    if (score <= 0) return [];

    // Цель баффа — крупнейший свой, кроме самого активирующего:
    // «Give another minion…». У «задать статы» цель уже выбрана прибавкой,
    // и она ОБРАТНАЯ (наименьший свой получает больше всех) — своим полем,
    // а не общим правилом «крупнейший».
    const others = state.board.filter((m) => m.entityId !== minion.entityId);
    const target =
      setBest !== null && setBest.gain > 0
        ? setBest.minion
        : stats > 0 && others.length > 0
          ? others.reduce((a, b) =>
              (b.attack ?? 0) + (b.health ?? 0) > (a.attack ?? 0) + (a.health ?? 0) ? b : a,
            )
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
   * Цель НЕ выбирается: игра распределяет эффект сама («of each type»,
   * «random», «left-most»). Совет с «→ на кого-то» показывал бы выбор,
   * которого у игрока нет (part15, ход 19: Misplaced Tea Set).
   */
  readonly untargeted: boolean;
  /**
   * Заклинание ДАЁТ МИНЬОНА — то же, что покупка, только дешевле трёх
   * (`givesMinionWords`). «Enchanted Lasso» за 2: «Steal a random minion
   * from the Tavern» (part17, ход 1). Ни статов, ни золота в тексте нет,
   * и прежний разбор возвращал null — заклинание было невидимо целиком.
   */
  readonly givesMinion: boolean;
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
}

/** Ветвь «Choose One» — отдельная карта снапшота (`…t` и `…t2`). */
export interface SpellBranch {
  readonly cardId: string;
  readonly name: string;
  /** Короткая подпись действия: «+3/+1» у Allied Mace. Пусто, если не статы. */
  readonly label: string;
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
function branchScore(effect: SpellEffect, rules: TavernRules): number {
  return (
    (effect.transforms ? rules.value.transform : 0) +
    effect.stats * rules.value.perStatPoint +
    (effect.divineShield ? rules.value.divineShield : 0) +
    (effect.grantsTaunt ? rules.value.taunt : 0) +
    // Отложенное золото ветви считается тем же курсом: для СРАВНЕНИЯ
    // ветвей между собой ход задержки почти ничего не меняет (Grace
    // Farsail: «Gain 2 Gold next turn; or Gain 4 Gold in two turns»),
    // а нулём оно делало бы ветвь невидимой.
    (effect.gold + effect.goldNextTurn) * rules.goldPointValue +
    (effect.givesMinion ? rules.minionCost * rules.goldPointValue : 0)
  );
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
  readonly score: number;
  readonly note: string;
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
): { readonly branches: readonly SpellBranch[]; readonly note: string } | null {
  const info = deps.cards.info(minion.cardId);
  if (!(info?.mechanics.includes('CHOOSE_ONE') ?? false)) return null;

  const all = ['t', 't2']
    .map((suffix) => deps.cards.info(minion.cardId + suffix))
    .flatMap((branch) => {
      if (branch === null) return [];
      const pair = statPair(branch.text ?? '', minion.scriptData);
      return [
        {
          value: branchValue(branch.id, minion.scriptData, state, deps, rules),
          branch: {
            cardId: branch.id,
            name: branch.name,
            label: pair === null ? '' : `+${String(pair.attack)}/+${String(pair.health)}`,
          },
        },
      ];
    });
  if (all.length < 2) return null;

  const branches = all.map((b) => b.branch);
  const judged = all.flatMap((b) => (b.value === null ? [] : [{ ...b, value: b.value }]));

  // Одну из ветвей оценить не вышло — сравнивать не с чем, и «берите ту,
  // которую поняли» здесь было бы враньём: неоценённая ветвь не значит
  // худшая. Тот же ответ, что у модальных заклинаний (part19).
  if (judged.length < all.length) {
    const listed = all
      .map((b) => `${b.branch.name} — ${b.value?.note ?? 'оценить не берёмся'}`)
      .join('; ');
    return { branches, note: `ветви: ${listed}` };
  }

  const best = judged.reduce((a, b) => (b.value.score > a.value.score ? b : a));
  const worst = judged.reduce((a, b) => (b.value.score < a.value.score ? b : a));
  const note = judged
    .map((b) => `${b.branch.name} ${b.value.score.toFixed(1)} (${b.value.note})`)
    .join(' против ');

  // Равные ветви не разделяются выдуманным доводом: совет называет обе,
  // как у «+3/+1 против +1/+3» (замер `npm run spike:buff` разницы не нашёл).
  if (best.value.score === worst.value.score) return { branches, note };
  return { branches: [best.branch], note };
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

  // «Gain 2 Gold next turn» / «Gain 4 Gold in two turns» — золото
  // ОТЛОЖЕННОЕ, и складывать его с живым нельзя (part30, ход 9).
  const gold = /gain\s+(\d+)\s+gold(\s+next\s+turn|\s+in\s+two\s+turns)?/i.exec(text);
  const deferredGold = gold?.[2] !== undefined;

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

  // Статы ложатся на витрину, а не на наш борд, — Them Apples (part30).
  const buffsShop = rules.buffsShopWords.some((w) => new RegExp(w, 'i').test(text));

  // «Цель не выбирается» имеет смысл только у усилений: у замены выбор
  // жертвы и так наш, у золота цели нет вовсе. Витринный бафф раздаёт
  // игра — цели у него нет по построению.
  const untargeted =
    buffsShop ||
    (destroy === null && rules.untargetedSpellWords.some((w) => new RegExp(w, 'i').test(text)));

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

  if (gold === null && stats === 0 && !shield && !transforms && !grantsTaunt && !givesMinion && maxGold === 0) {
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
    untargeted,
    givesMinion,
    buffsShop,
    maxGold,
    branches: [],
    chosen: null,
  };
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
function spellTargetOn(
  effect: SpellEffect,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
  spellCardId: string | null = null,
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
  const sellCandidates = new Set<number>();
  const victim = weakestOwn(state, deps, rules);
  if (victim !== null) sellCandidates.add(victim.minion.entityId);
  for (const m of state.board) {
    const text = cards.info(m.cardId)?.text ?? '';
    if (text === '' || copiesOwned(m, state) > 0) continue;
    if (rules.sellValueWords.some((w) => new RegExp(w, 'i').test(text))) {
      sellCandidates.add(m.entityId);
    }
  }
  if (sellCandidates.size > 0) {
    const keepers = pool.filter((m) => !sellCandidates.has(m.entityId));
    // Борд целиком из кандидатов в продажу возвращает выбор им же:
    // усилить кого-то всё равно надо, и «не берёмся» тут хуже крупнейшего.
    if (keepers.length > 0 && keepers.length < pool.length) {
      pool = keepers;
      notes.push('усиление навсегда — не на кандидата в продажу');
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
 */
export function buffTarget(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
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
    grantsTaunt: false,
    untargeted: false,
    givesMinion: false,
    buffsShop: false,
    maxGold: 0,
    branches: [],
    chosen: null,
  };
  return spellTargetOn(buff, state, deps, rules)?.target ?? null;
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
    // магазина, и до нас доезжают только те, кого мы купим. Ценность —
    // статы на число покупок, которые остаток золота ещё позволяет;
    // при нуле золота заклинание честно молчит — усиленные миньоны
    // уйдут с обновлением витрины, не побывав нашими. Цели нет
    // по построению: игра раздаёт сама (в логе блок PLAY с Target=0).
    if (effect.buffsShop) {
      if (spell.cost > state.gold) return [];
      const buys = Math.min(
        state.shop.length,
        Math.max(0, Math.floor((state.gold - spell.cost) / rules.minionCost)),
      );
      const score =
        effect.stats * buys * rules.value.perStatPoint - spell.cost * rules.goldPointValue;
      if (score <= 0) return [];
      return [
        {
          action: 'play' as const,
          minion: null,
          spellCardId: spell.cardId,
          score,
          cost: spell.cost,
          requiresSlot: false,
          sellFirst: null,
          reason:
            `${name} — усиление витрины (+${String(effect.stats)} статов каждому), ` +
            `до боя доедет купленными: покупок на это золото ${String(buys)}`,
        },
      ];
    }

    // Усиление или замена: бесплатная ценность перед боем.
    if (spell.cost > state.gold || state.board.length === 0) return [];
    const score =
      (effect.transforms
        ? rules.value.transform
        : effect.stats * rules.value.perStatPoint +
          (effect.divineShield ? rules.value.divineShield : 0) +
          (effect.grantsTaunt ? rules.value.taunt : 0)) -
      spell.cost * rules.goldPointValue;
    if (score <= 0) return [];

    const aimed = spellTargetOn(effect, state, deps, rules, spell.cardId);
    if (aimed === null) return [];
    const branch = branchAdvice(effect);

    return [
      {
        action: 'play' as const,
        minion: null,
        spellCardId: spell.cardId,
        spendsMagnetCharge: aimed.spendsCharge ?? false,
        targetMinion: aimed.target,
        spellBranches: branch.branches,
        score,
        cost: spell.cost,
        requiresSlot: false,
        sellFirst: null,
        reason:
          `${name} — ${effect.transforms ? 'замена' : 'усиление перед боем'}` +
          (effect.stats > 0 ? ` (+${String(effect.stats)} статов)` : '') +
          (effect.divineShield ? ' и щит' : '') +
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
      const victim = handMinionVictim(state, deps, rules);
      if (victim !== null && score - victim.value <= rules.sellMargin) return [];
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
          score: score - (victim?.value ?? 0),
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
            (victim === null ? '' : `; ${victim.note}`) +
            (branch.note === '' ? '' : `; ${branch.note}`),
        },
      ];
    }

    // Бафф ПО ВИТРИНЕ — как у той же карты в руке: статы доезжают только
    // покупками, цель не называется (Them Apples, part30).
    if (effect.buffsShop) {
      const buys = Math.min(
        state.shop.length,
        bodiesAffordable(state, state.gold - goldCost, rules),
      );
      const score =
        effect.stats * buys * rules.value.perStatPoint - goldCost * rules.goldPointValue;
      if (score <= 0) return [];
      return [
        {
          action: 'buy' as const,
          minion: null,
          spellCardId: spell.cardId,
          score,
          cost: goldCost,
          requiresSlot: false,
          sellFirst: null,
          reason:
            `${name} за ${price} — усиление витрины (+${String(effect.stats)} статов ` +
            `каждому), до боя доедет купленными: покупок на остаток ${String(buys)}`,
        },
      ];
    }

    if (state.board.length === 0) return [];
    const score = effect.transforms
      ? rules.value.transform
      : effect.stats * rules.value.perStatPoint +
        (effect.divineShield ? rules.value.divineShield : 0) +
        (effect.grantsTaunt ? rules.value.taunt : 0);
    if (score <= 0) return [];
    const aimed = spellTargetOn(effect, state, deps, rules, spell.cardId);
    if (aimed === null) return [];
    const branch = branchAdvice(effect);
    return [
      {
        action: 'buy' as const,
        minion: null,
        spellCardId: spell.cardId,
        spendsMagnetCharge: aimed.spendsCharge ?? false,
        targetMinion: aimed.target,
        spellBranches: branch.branches,
        score,
        cost: goldCost,
        requiresSlot: false,
        sellFirst: null,
        reason:
          `${name} за ${price} — ${effect.transforms ? 'замена' : 'усиление'}` +
          (effect.stats > 0 ? ` (+${String(effect.stats)} статов)` : '') +
          (effect.divineShield ? ' и щит' : '') +
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
  const behind = targetTier(state.turn, rules) > state.techLevel;
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

  const score = body + rules.darkGift.bonus - holdCost;
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
      `тир ${tiers.join(' или ')} (${body.toFixed(1)}); ${holdNote}`,
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
      const effect =
        info !== null && (info.type?.includes('SPELL') ?? false)
          ? spellEffect(option.cardId, option.scriptData ?? [], deps.cards, rules)
          : null;
      if (effect === null || (effect.stats === 0 && !effect.divineShield && effect.gold === 0)) {
        return { option, name, value: null, score: null, reason: 'оценить не берёмся' };
      }
      const score =
        effect.stats * rules.value.perStatPoint +
        (effect.divineShield ? rules.value.divineShield : 0) +
        effect.gold * rules.goldPointValue;
      const parts = [
        effect.stats > 0 ? `+${String(effect.stats)} статов` : '',
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

    // Псевдо-миньон из справочника: у варианта выбора нет сущности с тегами,
    // есть только карта. Ключевые слова (щит, яд) при этом не видны —
    // тир, статы, племя и копии дают основную часть различий.
    const candidate = minionFromCard(info, option.entityId, false);
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
        `тир ${info.techLevel === null ? '?' : String(info.techLevel)}, ` +
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
    );
    if (host !== null) {
      magnetSteps.push({ minion, magnetizeTo: host, sellFirst: null, score: rec.score });
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
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): TavernAdvice | null {
  if (state.phase !== 'tavern') return null;

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
    heroPowerSpellRule(state, deps, rules),
    heroPowerGoldRule(state, deps, rules),
    heroPowerShotRule(state, deps, rules),
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
    trinkets: trinketAdvice(state, deps, rules),
    choice: choiceAdvice(state, deps, rules),
    playPlan: playPlan(state, deps, plays, rules),
    heroChoice: heroChoiceAdvice(state, deps),
    trinketForecast: trinketForecast(state, deps, rules),
  };
}
