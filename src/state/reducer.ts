import {
  insideBlock,
  readPowerEvents,
  SOURCE_OF_TRUTH,
  type BlockContext,
  type PowerEvent,
} from '../parser/blocks.js';
import { entityIdOf, parseEntityDescriptor } from '../parser/entity.js';
import { readPlayers, type Players } from './players.js';
import {
  BOARD_VISUAL_STATE_COMBAT,
  BOARD_VISUAL_STATE_TAVERN,
  EMPTY_GLOBAL_INFO,
  EMPTY_STATE,
  raceOfSubsetTag,
  type ChoiceOption,
  type Enchantment,
  type GameState,
  type GlobalInfo,
  type LobbyPlayer,
  type Minion,
  type Phase,
  type PlayerAction,
  type PlayerActionType,
} from './types.js';

/**
 * Свёртка потока событий Power.log в состояние партии.
 *
 * Что здесь опирается на подтверждённые факты:
 *
 * - фаза — тег `BOARD_VISUAL_STATE` на `GameEntity`, 1 таверна / 2 бой;
 * - свой игрок — объявление `Player` с ненулевым `GameAccountId`;
 * - свой герой — `HERO_ENTITY` у своего игрока, он же меняется при выборе героя;
 * - свой борд — сущности в `zone=PLAY` под своим контроллером.
 *
 * Чего здесь СОЗНАТЕЛЬНО нет: борда оппонента и содержимого магазина. Различить
 * их можно только по фазе, и это пока гипотеза — см. docs/power-log.md.
 */

const TAG_RE = /^tag=(\w+) value=(-?\w+)$/;
const TAG_CHANGE_RE = /^TAG_CHANGE Entity=(.+?) tag=(\w+) value=(-?\w+)\s*$/;
const FULL_ENTITY_CREATING_RE = /^FULL_ENTITY - Creating ID=(\d+) CardID=(\S*)/;

/**
 * SHOW_ENTITY раскрывает ранее скрытую карту и называет сущность через
 * `Entity=`, а не `ID=`, как FULL_ENTITY. Из 1349 таких строк за партию
 * 1262 идут с голым id, и все несут непустой CardID.
 *
 * Пока разбор искал только форму FULL_ENTITY, теги после SHOW_ENTITY уходили
 * в никуда, а раскрытые карты оставались без cardId — именно поэтому энчанты
 * выглядели безымянными.
 *
 * CHANGE_ENTITY устроен ТАК ЖЕ и разбирается тем же шаблоном: игра сообщает
 * им, что сущность стала ДРУГОЙ КАРТОЙ, — новый id карты в хвосте после
 * `CardID=`, а дескриптор по общему правилу показывает состояние ДО замены
 * (docs/power-log.md, п. 5). За строкой идёт блок тегов новой карты
 * (`CARDTYPE`, `ATK`, `HEALTH`, `PREMIUM`, `CARDRACE`), поэтому строку
 * обязан узнавать не только тот, кому нужен cardId: пока она не узнавалась,
 * `current` оставался на ПРЕЖНЕЙ сущности, и эти теги уходили к ней.
 *
 * По корпусу 45 партий таких строк 252 в канале-источнике, и они делают три
 * разные вещи: слот аксессуара становится взятым тринкетом (по две на партию),
 * миньон соперника превращается в бою, а «Сейф» `BG36_520t` в НАШЕЙ руке
 * открывается ЗОЛОТЫМ миньоном (part46: 16 событий за партию). Последнее
 * и стоило совета: рука числилась вечным «Unplayable», и разыграть открытый
 * сейф советник не предлагал никогда.
 */
const UPDATING_ENTITY_RE = /^(?:SHOW|CHANGE)_ENTITY - Updating Entity=(\d+) CardID=(\S*)/;

/** Кнопка подъёма таверны — по одной на каждый достижимый тир. */
const TECH_UP_BUTTON_RE = /^TB_BaconShopTechUp\d+_Button$/;

/** Кнопка тёмного дара — `CARDTYPE=GAME_MODE_BUTTON`, цена в теге `COST`. */
const DARK_GIFT_BUTTON = 'BG36_Button_DarkGift';

/** Кнопка обновления витрины — её `COST` и есть живая цена реролла. */
const REROLL_BUTTON = 'TB_BaconShop_8p_Reroll_Button';

/** Энчант игрока с запасом бесплатных обновлений (`BACON_FREE_REFRESH_COUNT`). */
const FREE_REFRESH_ENCHANT = 'Bacon_Free_Refresh_Player_Ench';

/**
 * Перетаскиватели покупки и продажи: блок `PLAY` на них несёт карту-цель
 * в `Target=[…]` (part17: 19 покупок миньонов, 9 заклинаний, 44 продажи —
 * все этой формой). Кнопка заморозки держит всю витрину разом.
 */
const DRAG_BUY = 'TB_BaconShop_DragBuy';
const DRAG_BUY_SPELL = 'TB_BaconShop_DragBuy_Spell';
const DRAG_SELL = 'TB_BaconShop_DragSell';
const LOCK_ALL_BUTTON = 'TB_BaconShopLockAll_Button';

/**
 * Тег кнопки покупки со значением — id её товара. Игра тег не именует
 * (в логе он числом), но ставит на каждую кнопку `TB_BaconShop_DragBuy`
 * следом за созданием: `TAG_CHANGE Entity=7345 tag=2442 value=7344`,
 * а на миньоне — `HAS_DRAG_TO_BUY=1`. При обновлении витрины кнопка уходит
 * в `REMOVEDFROMGAME` и тег сбрасывается в 0 (part35, 18:05:10). Через эту
 * связку читается ЖИВАЯ цена покупки — тег `COST` кнопки: 3 обычно, 1 при
 * скидке part4 (там же и `BACON_REDUCE_BUY_COST=2` на миньоне), 1 у всей
 * витрины после «Мозаики Стылой Межи» (part35 — без тега на миньонах).
 */
const DRAG_BUY_TARGET_TAG = '2442';

/**
 * Заголовок открытия выбора: `id=3 Player=AngryMem#2886 TaskList= ChoiceType=GENERAL …`.
 *
 * `TaskList` бывает пуст — на part9 у раскопок он не заполнен, поэтому
 * `\S*`, а не `\d+`.
 */
const CHOICE_HEADER_RE = /^id=(\d+) Player=(.+?) TaskList=\S* ChoiceType=(\w+)/;
/** Вариант выбора: `Entities[0]=[дескриптор]`. */
const CHOICE_OPTION_RE = /^Entities\[\d+\]=/;
/** Заголовок закрытия: `id=3 ChoiceType=GENERAL` в канале SendChoices. */
const SEND_CHOICES_RE = /^id=(\d+) ChoiceType=/;
/** Выбранный вариант в канале SendChoices: `m_chosenEntities[0]=[дескриптор]`. */
const CHOSEN_OPTION_RE = /^m_chosenEntities\[\d+\]=/;

/** Теги-признаки, которые нас интересуют у миньона. */
interface Entity {
  id: number;
  cardId: string;
  zone: string;
  zonePos: number;
  controller: number | null;
  cardType: string | null;
  /** Носитель энчанта — тег `ATTACHED`. Заполнен только у энчантов. */
  attached: number | null;
  tags: Map<string, number>;
}

function numeric(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function flag(e: Entity, tag: string): boolean {
  return (e.tags.get(tag) ?? 0) > 0;
}

/** Зоны, в которых энчант считается снятым и в состояние не идёт. */
const DEAD_ZONES = new Set(['GRAVEYARD', 'REMOVEDFROMGAME', 'SETASIDE']);

function toEnchantment(e: Entity): Enchantment {
  return {
    entityId: e.id,
    cardId: e.cardId,
    // Идентификаторы растут монотонно по времени создания, поэтому сами по себе
    // задают порядок наложения — ровно то, чего симулятор ждёт от timing.
    timing: e.id,
    scriptDataNum1: e.tags.get('TAG_SCRIPT_DATA_NUM_1') ?? null,
    scriptDataNum2: e.tags.get('TAG_SCRIPT_DATA_NUM_2') ?? null,
  };
}

function toMinion(
  e: Entity,
  enchantments: readonly Enchantment[],
  buyCost: number | null = null,
  branchScriptData: Readonly<Record<string, readonly (number | null)[]>> | undefined = undefined,
): Minion {
  const health = e.tags.get('HEALTH') ?? null;
  const damage = e.tags.get('DAMAGE') ?? 0;
  return {
    entityId: e.id,
    cardId: e.cardId,
    zonePos: e.zonePos,
    attack: e.tags.get('ATK') ?? null,
    health: health === null ? null : health - damage,
    buyCost,
    enchantments,
    scriptData: [1, 2, 3, 4, 5, 6].map(
      (i) => e.tags.get(`TAG_SCRIPT_DATA_NUM_${String(i)}`) ?? null,
    ),
    branchScriptData,
    tags: Object.fromEntries(e.tags),
    taunt: flag(e, 'TAUNT'),
    divineShield: flag(e, 'DIVINE_SHIELD'),
    poisonous: flag(e, 'POISONOUS'),
    venomous: flag(e, 'VENOMOUS'),
    reborn: flag(e, 'REBORN'),
    windfury: flag(e, 'WINDFURY'),
    stealth: flag(e, 'STEALTH'),
    // Тег PREMIUM, а не суффикс _G: 25 золотых миньонов эталонной партии
    // такого суффикса не имеют, обратных случаев нет.
    golden: flag(e, 'PREMIUM'),
    frozen: flag(e, 'FROZEN'),
    maxHealth: health,
    techLevel: e.tags.get('TECH_LEVEL') ?? null,
  };
}

export interface Reducer {
  step: (event: PowerEvent) => void;
  snapshot: () => GameState;
}

export function createReducer(players: Players): Reducer {
  const entities = new Map<number, Entity>();

  let phase: Phase = 'tavern';
  let turn = 0;
  let techLevel = 1;
  let techLevelUpTurn: number | null = null;
  let goldTotal = 0;
  let goldSpent = 0;
  /**
   * Временное золото хода — тег `TEMP_RESOURCES` (part34). Его дают «Gain
   * 1 Gold next turn» (Southsea Busker) и «Gain 2 Gold next turn» (Careful
   * Investment, part30), а ещё ПРОДАЖА, пока в этом ходу ничего не потрачено
   * (возврат не может опустить `RESOURCES_USED` ниже нуля — он идёт сюда).
   * Тратится оно ПЕРВЫМ: подъём за 3 при `TEMP_RESOURCES=1` пишет
   * `TEMP_RESOURCES=0` и `RESOURCES_USED=2`. Прежняя формула «RESOURCES минус
   * RESOURCES_USED» такого золота не видела вовсе, и ход после Busker
   * читался на монету беднее, а продажа при нуле потраченного — как
   * ничего не давшая. Границу хода с ненулевым остатком в фикстурах не
   * встретили ни разу — сброс доверен тегам игры.
   */
  let goldTemp = 0;
  /** Сколько временного золота потрачено в этом ходу — чтобы `goldSpent` видел и его. */
  let tempSpent = 0;
  /** Золото, обещанное к следующему ходу, — тег игры, см. `GameState.extraGoldNextTurn`. */
  let extraGoldNextTurn = 0;
  let anomalyCardId: string | null = null;
  let finalPlace: number | null = null;
  let buildNumber: number | null = null;
  let heroEntityId: number | null = null;
  let nextOpponentPlayerId: number | null = null;
  let currentOpponentPlayerId: number | null = null;
  let wonLastCombat: boolean | null = null;
  let lastCombatDamage = 0;
  let altTavern = false;
  let gameType: string | null = null;
  let maxTechLevel: number | null = null;

  /**
   * Счётчики игрока: тег лога → поле GlobalInfo.
   *
   * Только те, для которых в фикстурах нашёлся именованный тег. Остальные
   * счётчики симулятора приходят безымянными числовыми тегами (62 штуки
   * на сущности игрока за партию), сопоставить их не по чему.
   */
  const GLOBAL_INFO_TAGS: Readonly<Record<string, keyof GlobalInfo>> = {
    NUM_RESOURCES_SPENT_THIS_GAME: 'goldSpentThisGame',
    NUM_SPELLS_PLAYED_THIS_GAME: 'spellsCastThisGame',
    NUM_CARDS_PLAYED_THIS_TURN: 'cardsPlayedThisTurn',
    TAVERN_SPELL_ATTACK_INCREASE: 'tavernSpellAttackBuff',
    TAVERN_SPELL_HEALTH_INCREASE: 'tavernSpellHealthBuff',
    BACON_ELEMENTAL_BUFFATKVALUE: 'elementalAttackBuff',
    BACON_ELEMENTAL_BUFFHEALTHVALUE: 'elementalHealthBuff',
    // Надбавка к кровавому самоцвету (part48): та же пара тегов, что
    // у элементалей, и живёт она у игрока до конца партии.
    BACON_BLOODGEMBUFFATKVALUE: 'bloodGemAttackBuff',
    BACON_BLOODGEMBUFFHEALTHVALUE: 'bloodGemHealthBuff',
  };

  const globalInfo: Record<keyof GlobalInfo, number | null> = { ...EMPTY_GLOBAL_INFO };

  /** id сущности героя → `PlayerID` его владельца. */
  const heroOwner = new Map<number, number>();
  /**
   * Герой, только что подставленный в чужой слот, чей `PlayerID` ещё не
   * пришёл. Порядок этих двух строк В ЛОГЕ НЕ ЗАКРЕПЛЁН: в обычном бою
   * `PLAYER_ID` героя идёт раньше `HERO_ENTITY` слота, а в РЕВАНШЕ —
   * строкой позже (part52: 11 боёв обычных, 2 реванша, 00:50:14 и 00:58:00).
   * Поиск владельца только в момент `HERO_ENTITY` промахивался молча,
   * и борд соперника записывался ПРЕДЫДУЩЕМУ игроку.
   */
  let pendingOpponentHeroId: number | null = null;
  /** Последний увиденный борд каждого противника. */
  const lastSeenBoards = new Map<number, Minion[]>();
  /** Ход, на котором этот борд был увиден, — мера устаревания картинки. */
  const lastSeenBoardTurns = new Map<number, number>();
  /** Снят ли уже борд противника в текущем бою. */
  let opponentBoardCaptured = false;
  /**
   * Нажаты ли в этом ходу сила героя и тёмный дар.
   *
   * `EXHAUSTED` на этих сущностях в фикстурах не встречается ни разу;
   * применение видно только блоком `BlockType=PLAY` на самой сущности
   * (part8: 10 нажатий силы — 10 блоков, 3 нажатия дара — 3 блока).
   * Сбрасываются со сменой хода партии.
   */
  let heroPowerUsedThisTurn = false;
  let darkGiftUsedThisTurn = false;
  const activatedEntityIds = new Set<number>();

  /** Признаки «в этом ходу» с нуля — смена хода партии и шов сегментов (D264). */
  const resetTurnFlags = (): void => {
    heroPowerUsedThisTurn = false;
    darkGiftUsedThisTurn = false;
    activatedEntityIds.clear();
    tempSpent = 0;
  };

  /**
   * Журнал своих действий за партию — сырьё фазы 6 («какие действия ведут
   * к победе» не выучить, не записывая действий). Блок PLAY стоит в стеке
   * у многих событий подряд, а действие он значит ОДНО: WeakMap по самому
   * объекту блока делает запись одноразовой — стек держит один объект
   * от открытия до закрытия, и события несут ссылки на него. Значение —
   * номер записи в журнале: направление заморозки видно только внутри
   * блока (снятие ставит витрине `FROZEN value=0`, part60), и запись
   * уточняется уже после того, как сделана.
   */
  const actions: PlayerAction[] = [];
  const journaledBlocks = new WeakMap<BlockContext, number>();

  const journal = (
    block: BlockContext,
    type: PlayerActionType,
    cardId: string | null,
    entityId: number | null,
  ): void => {
    if (journaledBlocks.has(block)) return;
    journaledBlocks.set(block, actions.length);
    actions.push({
      turn,
      type,
      cardId: cardId === '' ? null : cardId,
      entityId,
      // Ветвь берётся из ТОГО ЖЕ блока: поле `SubOption` стоит в строке
      // BLOCK_START рядом с `Target=`, и разбирать карту для этого не надо.
      subOption: block.subOption,
    });
  };

  /** Карта-цель блока покупки или продажи — из `Target=[…]` его строки. */
  const targetOf = (block: BlockContext): { cardId: string | null; entityId: number | null } => {
    const t = block.target;
    if (t === null) return { cardId: null, entityId: null };
    if (t.kind === 'descriptor') {
      return {
        cardId: t.descriptor.cardId === '' ? null : t.descriptor.cardId,
        entityId: t.descriptor.id,
      };
    }
    return { cardId: null, entityId: entityIdOf(t) };
  };

  /** Сущность, к которой относятся идущие следом строки `tag=…`. */
  let current: Entity | null = null;
  /**
   * Текущий блок — `GameEntity` дампа: его теги (TURN, BOARD_VISUAL_STATE…)
   * глобальные, а не сущностные, и адресат у них `{kind: 'game'}`.
   */
  let currentIsGameEntity = false;

  /**
   * Открытый модальный выбор и его сборка.
   *
   * `openChoice` живёт от заголовка `DebugPrintEntityChoices` до `SendChoices`
   * с тем же id; варианты дописываются в него строками `Entities[i]=`.
   * Новый заголовок заменяет прежний выбор целиком — на экране клиента
   * выбор один. Чужие выборы не собираются.
   *
   * `MULLIGAN` — выбор героя в начале партии — собирается тем же каналом,
   * но в ОТДЕЛЬНОЕ поле: это не модальный выбор таверны, и советуется он
   * иначе (статистикой мест, а не ценностью миньона).
   */
  interface OpenChoiceDraft {
    id: number;
    sourceCardId: string | null;
    options: ChoiceOption[];
    mulligan: boolean;
  }
  let openChoice: OpenChoiceDraft | null = null;
  let heroChoice: OpenChoiceDraft | null = null;
  let collectingChoice: OpenChoiceDraft | null = null;

  const stepChoice = (source: string, content: string): void => {
    if (source === 'GameState.SendChoices') {
      // Взятый тринкет — единственный выбор, который журнал не видит блоком
      // PLAY. Признаки те же, что у открытого предложения в снимке: свой
      // тринкет в SETASIDE с `BACON_TRINKET`. Проверка по сущности, а не
      // по заголовку выбора: тем же каналом закрываются раскопки и тройки.
      if (CHOSEN_OPTION_RE.test(content)) {
        const d = parseEntityDescriptor(content);
        const e = d === null ? undefined : entities.get(d.id);
        if (
          e !== undefined &&
          e.cardType === 'BATTLEGROUND_TRINKET' &&
          e.controller === players.selfPlayerId &&
          e.zone === 'SETASIDE' &&
          flag(e, 'BACON_TRINKET')
        ) {
          actions.push({
            turn,
            type: 'trinket',
            cardId: e.cardId === '' ? null : e.cardId,
            entityId: e.id,
            subOption: null,
          });
        }
        return;
      }
      const done = SEND_CHOICES_RE.exec(content);
      if (done?.[1] === undefined) return;
      const id = Number(done[1]);
      if (openChoice !== null && id >= openChoice.id) {
        openChoice = null;
        collectingChoice = null;
      }
      if (heroChoice !== null && id >= heroChoice.id) {
        heroChoice = null;
        collectingChoice = null;
      }
      return;
    }

    const header = CHOICE_HEADER_RE.exec(content);
    if (header !== null) {
      const [, id, player, choiceType] = header;
      const mine = players.selfName === null || player === players.selfName;
      const general = choiceType === 'GENERAL' && mine;
      const mulligan = choiceType === 'MULLIGAN' && mine;
      collectingChoice =
        general || mulligan
          ? { id: Number(id), sourceCardId: null, options: [], mulligan }
          : null;
      if (general) openChoice = collectingChoice;
      if (mulligan) heroChoice = collectingChoice;
      return;
    }

    if (collectingChoice === null) return;

    if (content.startsWith('Source=')) {
      const d = parseEntityDescriptor(content);
      collectingChoice.sourceCardId = d === null || d.cardId === '' ? null : d.cardId;
      return;
    }
    if (CHOICE_OPTION_RE.test(content)) {
      const d = parseEntityDescriptor(content);
      if (d !== null) collectingChoice.options.push({ entityId: d.id, cardId: d.cardId });
    }
  };

  /**
   * Карты, виденные в витрине за партию, — сырьё для состава племён.
   *
   * Копится в step, а не в snapshot: живой путь снимает состояние на каждое
   * чтение, пакетный — однажды в конце, и накопление на снимках молча
   * разошлось бы между ними. Условие членства то же, что у магазина
   * в снимке: чужой миньон в PLAY в фазе таверны. В бою те же признаки
   * носит борд противника, а там бывают токены вне пула — фаза обязательна.
   */
  const seenShopCardIds = new Set<string>();

  /**
   * Племя, которое лог называет САМ, — тег `CARDRACE` на сущности карты.
   *
   * Запасной источник для снапшота, а не замена ему: D071 отверг этот тег
   * для СОСТАВА партии и был прав по своей причине — у двуплеменной карты
   * он показывает одно племя. Замер на part64 (126 карт с тегом): 94 совпали
   * со снапшотом полностью, 6 разошлись — и все шесть ровно того вида, что
   * назвал D071 (Рука-протез MECH/UNDEAD, лог говорит MECHANICAL; Timecap'n
   * Hooktail, Firescale Hoarder, Flaming Enforcer, Gearfin). Оставшиеся 26 —
   * те, где снапшот МОЛЧИТ, и все двадцать шесть оказались ABERRATION.
   *
   * Отсюда и правило слияния (`withLogRaces`): снапшот сильнее всегда, тег
   * говорит только там, где снапшот не знает ничего. Двуплеменные при этом
   * не страдают — у них снапшот не молчит, — а новое племя патча перестаёт
   * быть слепотой в тот же день, когда приходит в игру.
   *
   * Тег СТРОКОВЫЙ, поэтому в `tags` (числовую карту) он не попадает и
   * копится здесь отдельно.
   *
   * ## Только из БЛОКА ТЕГОВ карты, и это не мелочь
   *
   * Ключ здесь — КАРТА, а племя бывает ПРИОБРЕТЁННЫМ: тёмный дар и тринкеты
   * дают его конкретной СУЩНОСТИ, и приходит оно отдельным `TAG_CHANGE`
   * (part51, 17:17:27: `TAG_CHANGE Entity=7940 tag=CARDRACE value=ALL`
   * плюс `MINION_TYPE_MASK=1` на Бранне `BG_LOE_077`, следом энчант
   * `BG36_MidGameEffect_000t22e` с `ATTACHED=7940`). Записать такое
   * по карте значило бы раздать приобретение ВСЕМ копиям — и своим,
   * и чужим, и будущим. Механику подтвердил игрок: в базовом виде Бранн
   * племени не имеет, но получить его даром или тринкетом можно.
   *
   * Поэтому запоминается только то, что пришло вместе с самой картой,
   * — и первое значение не переписывается: `SHOW_ENTITY` раскрывает карту
   * с ТЕКУЩИМИ тегами, то есть у повторного раскрытия приобретённое племя
   * уже в блоке.
   *
   * Само приобретение здесь НЕ читается вовсе — это отдельная фактура
   * (счёт по фикстурам — в журнале), и молчать о ней честнее, чем
   * приписывать её карте.
   */
  const logRaces = new Map<string, string>();
  const noteCardRace = (e: Entity, value: string): void => {
    if (e.cardId === '' || value === '') return;
    if (logRaces.has(e.cardId)) return;
    logRaces.set(e.cardId, value);
  };

  const noteShopMinion = (e: Entity): void => {
    if (phase !== 'tavern' || e.cardId === '') return;
    if (e.cardType !== 'MINION' || e.zone !== 'PLAY') return;
    const self = players.selfPlayerId;
    if (self === null || e.controller === null || e.controller === self) return;
    seenShopCardIds.add(e.cardId);
  };

  const touch = (id: number, cardId?: string, authoritative = false): Entity => {
    const found = entities.get(id);
    if (found !== undefined) {
      // Обычные упоминания лишь дополняют пустой cardId. SHOW_ENTITY — другое
      // дело: это раскрытие карты, оно авторитетнее того, что было известно.
      if (cardId !== undefined && cardId !== '' && (authoritative || found.cardId === '')) {
        found.cardId = cardId;
        noteShopMinion(found);
        noteCounterEnchant(found);
      }
      return found;
    }
    const created: Entity = {
      id,
      cardId: cardId ?? '',
      zone: '',
      zonePos: 0,
      controller: null,
      cardType: null,
      attached: null,
      tags: new Map(),
    };
    entities.set(id, created);
    noteCounterEnchant(created);
    return created;
  };

  /**
   * @param fromCardBlock строка пришла из БЛОКА ТЕГОВ сущности
   * (`FULL_ENTITY`/`SHOW_ENTITY`/`CHANGE_ENTITY`), а не отдельным
   * `TAG_CHANGE`. Различие важно только племени, см. `noteCardRace`.
   */
  const applyToEntity = (e: Entity, tag: string, value: string, fromCardBlock = false): void => {
    const n = numeric(value);

    // Кэш группировки энчантов зависит только от типа, носителя и зоны.
    if (
      tag === 'ZONE' ||
      tag === 'ATTACHED' ||
      tag === 'CARDTYPE' ||
      e.cardType === 'ENCHANTMENT'
    ) {
      enchantmentsCache = null;
    }

    switch (tag) {
      case 'CARDRACE':
        if (fromCardBlock) noteCardRace(e, value);
        return;
      case 'ZONE':
        e.zone = value;
        noteShopMinion(e);
        return;
      case 'ZONE_POSITION':
        if (n !== null) e.zonePos = n;
        return;
      case 'CONTROLLER':
        if (n !== null) e.controller = n;
        noteShopMinion(e);
        return;
      case 'ATTACHED':
        if (n !== null) e.attached = n;
        return;
      case 'CARDTYPE':
        e.cardType = value;
        if (value === 'BATTLEGROUND_ANOMALY' && e.cardId !== '') anomalyCardId = e.cardId;
        noteShopMinion(e);
        return;
      default:
        if (n !== null) e.tags.set(tag, n);
        return;
    }
  };

  /**
   * Кому адресован тег.
   *
   * Привязка обязательна: одни и те же имена тегов приходят на разные сущности
   * с разным смыслом. `TURN` на `GameEntity` — номер хода партии, он дорастает
   * до 24; `TURN` на самом игроке — его собственный счётчик, вдвое меньше.
   * Без разделения побеждало то значение, что пришло последним.
   */
  type Subject =
    | { kind: 'game' }
    | { kind: 'self' }
    | { kind: 'entity'; id: number }
    | { kind: 'other' };

  const applyGlobal = (tag: string, value: string, subject: Subject): void => {
    const n = numeric(value);

    switch (tag) {
      case 'BOARD_VISUAL_STATE':
        if (subject.kind !== 'game') return;
        if (n === BOARD_VISUAL_STATE_TAVERN) phase = 'tavern';
        else if (n === BOARD_VISUAL_STATE_COMBAT) {
          phase = 'combat';
          opponentBoardCaptured = false;
        }
        return;
      case 'TURN':
        if (subject.kind === 'game' && n !== null && n !== turn) {
          turn = n;
          resetTurnFlags();
        }
        return;
      case 'STEP':
        if (subject.kind === 'game' && value === 'FINAL_GAMEOVER') phase = 'gameOver';
        return;
      case 'PLAYER_TECH_LEVEL':
        if (subject.kind === 'self' && n !== null) {
          // Ход подъёма запоминается для правила заморозки: в этот ход
          // свежая витрина будет уже нового тира.
          if (n > techLevel) techLevelUpTurn = turn;
          techLevel = n;
        }
        return;
      case 'RESOURCES':
        if (subject.kind === 'self' && n !== null) goldTotal = n;
        return;
      case 'RESOURCES_USED':
        if (subject.kind === 'self' && n !== null) goldSpent = n;
        return;
      case 'BACON_PLAYER_EXTRA_GOLD_NEXT_TURN':
        if (subject.kind === 'self' && n !== null) extraGoldNextTurn = n;
        return;
      case 'TEMP_RESOURCES':
        if (subject.kind === 'self' && n !== null) {
          if (n < goldTemp) tempSpent += goldTemp - n;
          goldTemp = n;
        }
        return;
      case 'PLAYER_LEADERBOARD_PLACE':
        if (subject.kind === 'entity' && subject.id === heroEntityId) finalPlace = n;
        return;
      case 'HERO_ENTITY':
        // Свой герой. Ветка TAG_CHANGE обрабатывает этот тег отдельно (там
        // есть ещё чужой слот), но в дампе переподключения тег приходит
        // строкой-продолжением блока Player — и до этой ветки не доходил:
        // part1, сегменты 2–4 оставались без героя.
        if (subject.kind === 'self' && n !== null) heroEntityId = n;
        return;
      case 'NEXT_OPPONENT_PLAYER_ID':
        if (subject.kind === 'self' && n !== null) nextOpponentPlayerId = n;
        return;
      case 'PLAYER_ID':
        // У героя каждого участника лобби есть его PlayerID. Это единственный
        // способ понять, кто скрыт за чужим слотом во время боя.
        if (subject.kind === 'entity' && n !== null) {
          heroOwner.set(subject.id, n);
          // Реванш: слот получил героя раньше, чем герой — свой PlayerID.
          if (subject.id === pendingOpponentHeroId) {
            currentOpponentPlayerId = n;
            pendingOpponentHeroId = null;
          }
        }
        return;
      case 'BACON_WON_LAST_COMBAT':
        if (subject.kind === 'self' && n !== null) wonLastCombat = n > 0;
        return;
      case 'DAMAGE_DEALT_TO_HERO_LAST_TURN':
        if (subject.kind === 'self' && n !== null) lastCombatDamage = n;
        return;
      case 'BACON_ALT_TAVERN_IN_PROGRESS':
        // Тег партии, а не игрока: приходит на `GameEntity` блоком TRIGGER
        // «Альтернативной истории» и снимается в ноль на выходе. Читается
        // ради одного — на время альт-таверны игра подменяет пул золота,
        // и рост `RESOURCES_USED` там тратой СВОЕГО золота не является.
        if (subject.kind === 'game' && n !== null) altTavern = n > 0;
        return;
      case 'BACON_MAX_PLAYER_TECH_LEVEL':
        // Тег висит на героях всех участников лобби, а предел тира — свойство
        // героя, не партии. Берём только со своего, иначе чужой герой с иным
        // пределом молча подменит наш. Ноль приходит при сбросе сущности
        // и пределом быть не может.
        if (n === null || n <= 0) return;
        if (subject.kind === 'self' || (subject.kind === 'entity' && subject.id === heroEntityId)) {
          maxTechLevel = n;
        }
        return;
      default: {
        // Счётчики принимаются только от своего игрока: те же имена приходят
        // и на сущность соперника, где значат его показатели.
        if (subject.kind !== 'self' || n === null) return;
        const field = GLOBAL_INFO_TAGS[tag];
        if (field !== undefined) globalInfo[field] = n;
        return;
      }
    }
  };

  const selfPlayerEntityIds = new Set(
    players.decls.filter((d) => d.playerId === players.selfPlayerId).map((d) => d.entityId),
  );

  const subjectOf = (entityRef: string): Subject => {
    if (entityRef === 'GameEntity') return { kind: 'game' };
    if (players.selfName !== null && entityRef === players.selfName) return { kind: 'self' };
    if (/^\d+$/.test(entityRef)) {
      const id = Number(entityRef);
      return selfPlayerEntityIds.has(id) ? { kind: 'self' } : { kind: 'entity', id };
    }
    return { kind: 'other' };
  };

  const isSelf = (entityName: string): boolean =>
    players.selfName !== null && entityName === players.selfName;

  /**
   * Энчанты, сгруппированные по носителю.
   *
   * Результат кэшируется: за партию энчантов больше тысячи, а снимок состояния
   * в живом режиме берётся часто. Без кэша полный проход по всем сущностям
   * на каждый снимок делает работу квадратичной — на прогоне фикстуры это
   * стоило пятикратного замедления.
   */
  let enchantmentsCache: Map<number, Enchantment[]> | null = null;

  const groupEnchantments = (): Map<number, Enchantment[]> => {
    if (enchantmentsCache !== null) return enchantmentsCache;

    const byHost = new Map<number, Enchantment[]>();
    for (const e of entities.values()) {
      if (e.cardType !== 'ENCHANTMENT' || e.attached === null) continue;
      if (DEAD_ZONES.has(e.zone)) continue;
      const list = byHost.get(e.attached) ?? [];
      list.push(toEnchantment(e));
      byHost.set(e.attached, list);
    }
    for (const list of byHost.values()) list.sort((a, b) => a.timing - b.timing);

    enchantmentsCache = byHost;
    return byHost;
  };

  /**
   * Миньоны в зоне.
   *
   * Белый список, а не чёрный: у части сущностей `CARDTYPE` в логе не
   * встречается вовсе, и при фильтрации «всё кроме» на борду оказывалось
   * 455 штук вместо максимум семи.
   */
  const collectMinions = (
    zone: string,
    ownedBySelf: boolean,
    enchantments: Map<number, Enchantment[]>,
    buyCosts: ReadonlyMap<number, number> = new Map(),
    branchData: ReadonlyMap<number, Record<string, (number | null)[]>> = new Map(),
  ): Minion[] => {
    const self = players.selfPlayerId;
    if (self === null) return [];
    return [...entities.values()]
      .filter(
        (e) =>
          e.cardType === 'MINION' &&
          e.zone === zone &&
          (ownedBySelf ? e.controller === self : e.controller !== self),
      )
      .sort((a, b) => a.zonePos - b.zonePos)
      .map((e) =>
        toMinion(e, enchantments.get(e.id) ?? [], buyCosts.get(e.id) ?? null, branchData.get(e.id)),
      );
  };

  /**
   * Плейсхолдеры ВЕТВЕЙ модального «Choose One» — с сущностей самих ветвей.
   *
   * Ветви лежат в снапшоте отдельными картами `<id>t` и `<id>t2` (part19),
   * и до part43 их числа брались из тегов РОДИТЕЛЯ по соглашению «у ветви
   * плейсхолдеры те же». Соглашение держится не всегда, и проверить это
   * можно по самому снапшоту: у Alliance Flag ветви пишут `{0}/{1}`
   * и `{2}/{3}` — родительские индексы, — а у Sprightly Scarab, Fearless
   * Foodie, Sly Infiltrator и Veteran Brigand вторая ветвь ПЕРЕНУМЕРОВАНА
   * на `{0}`. Четыре карты из двенадцати модальных, и на part43 (ход 15)
   * это дало тихо неверное число: «+{0} Attack» второй ветви скарабея
   * читалось как +1 при настоящих +4, и советник называл игроку ту ветвь,
   * которая по его же шкале хуже.
   *
   * Игра числа ветвей пишет сама: сущности создаются с `CREATOR` = id
   * родителя и своими `TAG_SCRIPT_DATA_NUM_*` (part43, 02:00:44 —
   * у `BG27_084t` это 1 и 1, у `BG27_084t2` — 4). Читаем их, а соглашение
   * оставляем запасным путём: у части копий сущностей ветвей может
   * не оказаться вовсе.
   */
  const choiceBranchData = (): Map<number, Record<string, (number | null)[]>> => {
    const byParent = new Map<number, Record<string, (number | null)[]>>();
    for (const e of entities.values()) {
      // Дешёвая проверка первой: сущностей за партию тысячи, а карт ветвей
      // единицы, и суффикс отсеивает почти всё до похода в таблицу.
      if (!e.cardId.endsWith('t') && !e.cardId.endsWith('t2')) continue;
      const creator = e.tags.get('CREATOR') ?? 0;
      if (creator <= 0) continue;
      const parent = entities.get(creator);
      if (parent === undefined || parent.cardId === '') continue;
      if (e.cardId !== `${parent.cardId}t` && e.cardId !== `${parent.cardId}t2`) continue;
      const data = [1, 2, 3, 4].map(
        (i) => e.tags.get(`TAG_SCRIPT_DATA_NUM_${String(i)}`) ?? null,
      );
      byParent.set(creator, { ...byParent.get(creator), [e.cardId]: data });
    }
    return byParent;
  };

  /**
   * Живые цены покупки по миньонам витрины: `COST` кнопки `DragBuy`,
   * привязанной к товару тегом `DRAG_BUY_TARGET_TAG`.
   *
   * Берутся только кнопки в `PLAY`: при обновлении витрины отработавшие
   * уходят в `REMOVEDFROMGAME` с обнулённой привязкой, и без фильтра
   * по зоне старая кнопка могла бы назвать цену новому миньону с тем же
   * id (id не переиспользуются, но фильтр — то самое утверждение, которое
   * лог подтверждает, а не надежда). Кнопка без тега `COST` цены
   * не называет — тогда миньон остаётся с `buyCost: null`.
   */
  const dragBuyCosts = (): Map<number, number> => {
    const self = players.selfPlayerId;
    const costs = new Map<number, number>();
    if (self === null) return costs;
    for (const e of entities.values()) {
      if (e.cardId !== DRAG_BUY || e.controller !== self || e.zone !== 'PLAY') continue;
      const target = e.tags.get(DRAG_BUY_TARGET_TAG) ?? 0;
      const cost = e.tags.get('COST');
      if (target <= 0 || cost === undefined) continue;
      costs.set(target, cost);
    }
    return costs;
  };

  /**
   * Борд противника виден только во время боя, и снимать его надо в НАЧАЛЕ:
   * к моменту выхода в таверну чужие миньоны уже убраны из PLAY, а к концу боя
   * половина из них мертва. Момент ловится по первому блоку `ATTACK` — тогда
   * обе стороны уже расставлены, но размены ещё не начались.
   *
   * Это и есть «последний увиденный борд противника» из ТЗ.
   */
  const rememberOpponentBoard = (): void => {
    if (currentOpponentPlayerId === null || opponentBoardCaptured) return;
    const board = collectMinions('PLAY', false, groupEnchantments());
    if (board.length === 0) return;
    lastSeenBoards.set(currentOpponentPlayerId, board);
    lastSeenBoardTurns.set(currentOpponentPlayerId, turn);
    opponentBoardCaptured = true;
  };

  /** Встречен ли уже CREATE_GAME — следующий будет дампом переподключения. */
  let gameCreated = false;

  const resetEntities = (): void => {
    entities.clear();
    enchantmentsCache = null;
    counterEnchantIds.clear();
    current = null;
    currentIsGameEntity = false;
    openChoice = null;
    heroChoice = null;
    collectingChoice = null;
    pendingOpponentHeroId = null;
    // Состояние хода — тоже с дампа, как у сегмента, прочитанного отдельно.
    // Иначе редьюсер входит в ход шва с ходом, золотом и героем прошлого
    // сегмента, и точка решения этого хода пропадает (D023).
    phase = 'tavern';
    turn = 0;
    goldTotal = 0;
    goldSpent = 0;
    goldTemp = 0;
    extraGoldNextTurn = 0;
    heroEntityId = null;
    nextOpponentPlayerId = null;
    currentOpponentPlayerId = null;
    opponentBoardCaptured = false;
    altTavern = false;
    resetTurnFlags();
  };

  const step = (event: PowerEvent): void => {
    const { content } = event.line;

    // Номер билда — из канала метаданных, одной строкой после CREATE_GAME.
    // По нему приложение узнаёт, не отстал ли снапшот карт от патча.
    if (content.startsWith('BuildNumber=')) {
      const n = Number(content.slice('BuildNumber='.length));
      if (Number.isFinite(n)) buildNumber = n;
      return;
    }

    // Режим партии — тем же каналом метаданных и той же строкой после
    // CREATE_GAME. Читается ради одного: обычная партия Hearthstone
    // складывает наши признаки таверны ЛОЖНО (мана читается золотом,
    // чужие карты — витриной), и без явного режима она попадала в датасет
    // как партия Battlegrounds.
    if (content.startsWith('GameType=')) {
      gameType = content.slice('GameType='.length).trim();
      return;
    }

    // Каналы модальных выборов идут отдельно от DebugPrintPower и не трогают
    // ни `current`, ни стек блоков: их строки вклиниваются между блоками.
    if (event.line.source !== SOURCE_OF_TRUTH) {
      stepChoice(event.line.source, content);
      return;
    }

    // Повторный CREATE_GAME — дамп ПЕРЕПОДКЛЮЧЕНИЯ посреди той же партии
    // (склейка сегментов part1, part35, part41). Дамп перечисляет все живые
    // сущности заново и полностью, а умерших за время разрыва не называет
    // вовсе — их прежние записи оставались в PLAY, и после шва на борду
    // стояло 12–20 миньонов, а в витрине 10–16. Таблица сущностей и всё, что
    // выведено из неё, начинаются с дампа; история партии (борды соперников,
    // журнал, виденные карты) — накопление, и она сохраняется (D264).
    if (content === 'CREATE_GAME') {
      if (gameCreated) resetEntities();
      gameCreated = true;
      return;
    }

    // Первый размен боя — момент, когда оба борда уже расставлены.
    if (phase === 'combat' && !opponentBoardCaptured && insideBlock(event, 'ATTACK')) {
      rememberOpponentBoard();
    }

    // Нажатия силы героя, тёмного дара и активаций миньонов видны только
    // по блокам PLAY на их сущностях — тега-расхода у них нет. Смотрим стек
    // каждого события: блок открылся раньше, чем пришло его содержимое.
    // Тем же проходом ведётся журнал действий: покупка и продажа — блоки
    // на перетаскивателях с картой-целью, кнопки — обновление, подъём,
    // заморозка, розыгрыш — блок на карте, стоявшей в руке.
    for (const block of event.blocks) {
      if (block.blockType !== 'PLAY' || block.entityId === null) continue;
      const pressed = entities.get(block.entityId);
      if (pressed === undefined || pressed.controller !== players.selfPlayerId) continue;
      // Зона нажатой сущности — из дескриптора строки BLOCK_START, а не из
      // таблицы сущностей: внутри блока карта успевает сменить зону, а стек
      // блоков висит на КАЖДОМ его событии. Розыгрыш из руки читал зону так
      // всегда, активация — нет, и разъехалось это молча (part40, ход 17):
      // у Тираэля BLOCK_START стоит с `zone=HAND`, а строкой ниже приходит
      // `ZONE value=PLAY`, после чего все остальные события того же блока
      // видели миньона уже на борде — то есть КАЖДЫЙ разыгранный из руки
      // миньон попадал в «уже активирован в этом ходу» и советоваться
      // к активации в свой же ход не мог. Настоящая активация отличается
      // дескриптором честно: `zone=PLAY` (и у Тираэля в 20:08:59 там же
      // стоит `Target=` — цель, которой ставят статы).
      const zoneAtPress =
        block.entity !== null && block.entity.kind === 'descriptor'
          ? block.entity.descriptor.zone
          : pressed.zone;
      if (pressed.cardType === 'HERO_POWER') {
        heroPowerUsedThisTurn = true;
        journal(block, 'heroPower', pressed.cardId, pressed.id);
      } else if (pressed.cardId === DARK_GIFT_BUTTON) {
        darkGiftUsedThisTurn = true;
        journal(block, 'darkGift', pressed.cardId, pressed.id);
      } else if (pressed.cardType === 'MINION' && zoneAtPress === 'PLAY') {
        // Активация: блок PLAY на миньоне, уже СТОЯВШЕМ на борде В МОМЕНТ
        // НАЖАТИЯ, — розыгрыш из руки отличается зоной сущности (part14,
        // Suspicious Prisonguard), и зону надо брать на открытии блока.
        activatedEntityIds.add(pressed.id);
        journal(block, 'activate', pressed.cardId, pressed.id);
      } else if (pressed.cardId === DRAG_BUY || pressed.cardId === DRAG_BUY_SPELL) {
        const bought = targetOf(block);
        journal(block, 'buy', bought.cardId, bought.entityId);
      } else if (pressed.cardId === DRAG_SELL) {
        const sold = targetOf(block);
        journal(block, 'sell', sold.cardId, sold.entityId);
      } else if (pressed.cardId === REROLL_BUTTON) {
        journal(block, 'roll', null, null);
      } else if (TECH_UP_BUTTON_RE.test(pressed.cardId)) {
        journal(block, 'levelUp', null, null);
      } else if (pressed.cardId === LOCK_ALL_BUTTON) {
        journal(block, 'freeze', null, null);
      } else {
        // Розыгрыш из руки — та же зона на открытии блока, что и у активации.
        if (zoneAtPress === 'HAND') journal(block, 'play', pressed.cardId, pressed.id);
      }
    }

    // Заморозка, оказавшаяся СНЯТИЕМ: витрина оттаивает внутри блока кнопки.
    if (content.includes('tag=FROZEN value=0')) {
      for (const block of event.blocks) {
        const index = journaledBlocks.get(block);
        if (index === undefined) continue;
        const pressed = actions[index];
        if (pressed?.type === 'freeze') actions[index] = { ...pressed, type: 'unfreeze' };
      }
    }

    const descriptorHere = content.includes('[entityName=')
      ? parseEntityDescriptor(content)
      : null;

    // Блоки дампа CREATE_GAME: «GameEntity EntityID=16», «Player EntityID=17
    // PlayerID=6 …» — заголовки с тегами-продолжениями. При обычном старте
    // в них лишь начальные значения, но дамп ПЕРЕПОДКЛЮЧЕНИЯ несёт ими всё
    // состояние партии: TURN, PLAYER_TECH_LEVEL, HERO_ENTITY. Без этой ветки
    // заголовок не подходил ни под один шаблон, current сбрасывался, и теги
    // дампа выбрасывались целиком — part1, сегменты 2–4: помощник после
    // реконнекта не знал ни героя, ни тира, пока их не тронет живое событие.
    const dumpHeader = /^(GameEntity|Player) EntityID=(\d+)/.exec(content);
    if (dumpHeader !== null && dumpHeader[2] !== undefined) {
      current = touch(Number(dumpHeader[2]));
      currentIsGameEntity = dumpHeader[1] === 'GameEntity';
      return;
    }

    if (
      content.startsWith('FULL_ENTITY') ||
      content.startsWith('SHOW_ENTITY') ||
      content.startsWith('CHANGE_ENTITY')
    ) {
      // FULL_ENTITY лишь ОБЪЯВЛЯЕТ карту, а SHOW_ENTITY и CHANGE_ENTITY
      // сообщают, чем она стала, — их слово старше того, что было известно.
      const authoritative = !content.startsWith('FULL_ENTITY');
      currentIsGameEntity = false;

      if (descriptorHere !== null) {
        // У SHOW_ENTITY с дескриптором cardId стоит в хвосте, после `CardID=`,
        // а внутри самого дескриптора он ещё пустой — карта же была скрыта.
        // У CHANGE_ENTITY дескриптор несёт СТАРУЮ карту, и хвост тут не
        // уточнение, а замена.
        const revealed = /\bCardID=(\S+)\s*$/.exec(content)?.[1];
        const e = touch(descriptorHere.id, revealed ?? descriptorHere.cardId, authoritative);
        e.zone = descriptorHere.zone;
        e.zonePos = descriptorHere.zonePos;
        e.controller ??= descriptorHere.player;
        current = e;
        return;
      }

      const shown = UPDATING_ENTITY_RE.exec(content);
      if (shown?.[1] !== undefined) {
        current = touch(Number(shown[1]), shown[2] ?? '', true);
        return;
      }

      const m = FULL_ENTITY_CREATING_RE.exec(content);
      current = m?.[1] === undefined ? null : touch(Number(m[1]), m[2] ?? '');
      return;
    }

    // HIDE_ENTITY несёт смену зоны прямо в строке и начинается не с TAG_CHANGE,
    // поэтому без отдельной ветки все 1221 событие скрытия проваливались мимо
    // разбора, и убранные сущности оставались в PLAY.
    if (content.startsWith('HIDE_ENTITY')) {
      const hidden = descriptorHere;
      const m = /\btag=(\w+) value=(-?\w+)\s*$/.exec(content);
      if (hidden !== null && m?.[1] !== undefined && m[2] !== undefined) {
        applyToEntity(touch(hidden.id, hidden.cardId), m[1], m[2]);
      }
      current = null;
      currentIsGameEntity = false;
      return;
    }

    const tagLine = TAG_RE.exec(content);
    if (tagLine !== null) {
      const [, tag, value] = tagLine;
      if (tag === undefined || value === undefined) return;
      if (current !== null) {
        applyToEntity(current, tag, value, true);
        applyGlobal(
          tag,
          value,
          currentIsGameEntity
            ? { kind: 'game' }
            : selfPlayerEntityIds.has(current.id)
              ? { kind: 'self' }
              : { kind: 'entity', id: current.id },
        );
      }
      return;
    }

    current = null;
    currentIsGameEntity = false;

    const change = TAG_CHANGE_RE.exec(content);
    if (change === null) return;
    const [, entityRef, tag, value] = change;
    if (entityRef === undefined || tag === undefined || value === undefined) return;

    if (tag === 'HERO_ENTITY') {
      if (isSelf(entityRef)) {
        // Свой герой объявляется именно так, и меняется при выборе героя.
        heroEntityId = numeric(value);
      } else {
        // Чужой слот переиспользуется: в таверне там Бармен Боб, на бой
        // подставляется герой очередного противника. Кто именно — видно
        // по тегу PLAYER_ID самого героя, а не по подписи слота: в поздних
        // боях подпись остаётся «Бармен Боб», хотя дерёмся с игроком.
        const heroId = numeric(value);
        const owner = heroOwner.get(heroId ?? -1);
        if (owner !== undefined) currentOpponentPlayerId = owner;
        // Владельца ещё не объявляли — ждём его строку (реванш, part52).
        else pendingOpponentHeroId = heroId;
      }
    }

    let subject: Subject = subjectOf(entityRef);
    if (entityRef.startsWith('[')) {
      const d = parseEntityDescriptor(entityRef);
      if (d !== null) {
        subject = selfPlayerEntityIds.has(d.id)
          ? { kind: 'self' }
          : { kind: 'entity', id: d.id };
        const e = touch(d.id, d.cardId);
        // Зона и позиция из дескриптора НЕ применяются: дескриптор показывает
        // состояние ДО изменения и бывает устаревшим. Наблюдение с эталонной
        // партии — история зон вида
        //   SETASIDE > PLAY > GRAVEYARD > PLAY > REMOVEDFROMGAME > PLAY,
        // где каждый возврат в PLAY приходил именно из дескриптора и воскрешал
        // уже удалённого миньона. Истина только в явных тегах ZONE/ZONE_POSITION.
        e.controller ??= d.player;
        applyToEntity(e, tag, value);
      }
    } else if (/^\d+$/.test(entityRef)) {
      applyToEntity(touch(Number(entityRef)), tag, value);
    }

    applyGlobal(tag, value, subject);
  };

  /**
   * Счётчики, которые игра держит НЕ на сущности игрока, а на его ЭНЧАНТЕ.
   *
   * Именованные счётчики (`GLOBAL_INFO_TAGS`) приходят тегом на самого
   * игрока, и их читает `applyGlobal`. Но два поля, которых ждёт симулятор,
   * устроены иначе: игра заводит отдельную сущность-энчант под контроллером
   * игрока и пишет значение в её `TAG_SCRIPT_DATA_NUM_1` (part50).
   * Именованного тега у них нет вовсе, поэтому и путь другой — скан таблицы
   * сущностей по контроллеру, как у кнопки подъёма ниже.
   *
   * Фильтр по контроллеру обязателен и не косметика: у каждого из восьми
   * игроков лобби свой такой энчант с ЕГО числом. В part50 наш `PlayerID`
   * равен 8 (единственный с ненулевым `GameAccountId`), и на соседней
   * сущности с `player=16` стоит счётчик соперника.
   *
   * Зона `PLAY` — тоже из фактуры: отработавшие копии уходят в
   * `REMOVEDFROMGAME`, и брать их значило бы читать число прошлой партии.
   */
  const PLAYER_ENCHANT_COUNTERS: Readonly<
    Record<string, { readonly num1?: keyof GlobalInfo; readonly num2?: keyof GlobalInfo }>
  > = {
    // «Undead Bonus Attack Player Enchant»: Nerubian Deathswarmer и
    // заклинание Butchering копят сюда надбавку ВСЕЙ нежити. Половины пары
    // живут в разных партиях: атака доходит до 284 в part50, где второго
    // тега нет ни разу, а здоровье — до 208 в part32.
    BG25_011pe: { num1: 'undeadAttackBuff', num2: 'undeadHealthBuff' },
    // «Eternal Knight Player Enchant»: сколько своих рыцарей умерло.
    BG25_008pe: { num1: 'eternalKnightsDead' },
    // «Beetle Army Player Enchant»: надбавка к каждому следующему жуку
    // (смысл — от игрока, сверено с рождением жуков: part46, part53).
    BG31_808pe: { num1: 'beetleAttackBuff', num2: 'beetleHealthBuff' },
  };

  /**
   * Узкий индекс сущностей-счётчиков.
   *
   * Полный обход таблицы сущностей стоит дорого не сам по себе, а потому,
   * что снимок берётся часто: к концу партии в таблице десятки тысяч
   * записей, а счётчиков среди них единицы. Индекс держит только их —
   * пополняется в `touch`, когда карта опознана.
   */
  const counterEnchantIds = new Set<number>();

  const noteCounterEnchant = (e: Entity): void => {
    if (e.cardId !== '' && PLAYER_ENCHANT_COUNTERS[e.cardId] !== undefined) {
      counterEnchantIds.add(e.id);
    }
  };

  /**
   * Контроллер соперника — НЕ `currentOpponentPlayerId`.
   *
   * Это два разных пространства номеров, и перепутать их легко: место
   * в лобби (1..7) приходит тегом `PLAYER_ID` на герое, а контроллер
   * сущности — полем `player=` дескриптора. В логе объявлены ровно ДВА
   * `Player`: свой (в part50 `PlayerID=8`, единственный с ненулевым
   * `GameAccountId`) и общий слот соперника (`PlayerID=16`), под которым
   * по очереди выступают все семеро. Первая версия правки искала энчанты
   * по месту в лобби и не находила НИ ОДНОГО — молча, потому что «нет
   * счётчика» выглядит как «у соперника нет нежити».
   *
   * Слот общий, но сущность у каждого боя СВОЯ: в part50 шесть разных
   * энчантов `BG25_011pe` под контроллером 16, по одному на бой с нежитью.
   */
  const opponentController = (): number | null => {
    const self = players.selfPlayerId;
    if (self === null) return null;
    return players.decls.find((d) => d.playerId !== self)?.playerId ?? null;
  };

  /**
   * Счётчики с энчантов ОДНОГО игрока, заданного номером контроллера.
   *
   * Параметр, а не «свой»: у каждого из восьми игроков лобби свой такой
   * энчант со своим числом, и обе стороны боя нужны симулятору. Отдать
   * только своё — значит стать точным к себе и слепым к сопернику, то есть
   * систематически завышать свои шансы против нежити; чужая надбавка
   * в корпусе встречается ЧАЩЕ своей.
   */
  const enchantCountersOf = (controller: number | null): Partial<GlobalInfo> => {
    if (controller === null) return {};

    // Берём НОВЕЙШУЮ сущность каждой карты: у слота соперника энчант
    // заводится заново на каждый бой (в part50 их шесть), и полагаться
    // на порядок обхода таблицы значило бы читать чужое число прошлого боя.
    // Идентификаторы растут монотонно по времени создания — это уже опора
    // для порядка энчантов на миньоне.
    const newest = new Map<string, Entity>();
    for (const id of counterEnchantIds) {
      const e = entities.get(id);
      if (e === undefined) continue;
      if (e.controller !== controller || e.zone !== 'PLAY') continue;
      const seen = newest.get(e.cardId);
      if (seen === undefined || e.id > seen.id) newest.set(e.cardId, e);
    }

    const out: Partial<Record<keyof GlobalInfo, number>> = {};
    for (const e of newest.values()) {
      const fields = PLAYER_ENCHANT_COUNTERS[e.cardId];
      if (fields === undefined) continue;
      for (const [tag, field] of [
        ['TAG_SCRIPT_DATA_NUM_1', fields.num1],
        ['TAG_SCRIPT_DATA_NUM_2', fields.num2],
      ] as const) {
        if (field === undefined) continue;
        const value = e.tags.get(tag);
        // Ноль не отдаём: сущность заводится заранее и до первого
        // срабатывания стоит пустой. Разница не косметическая — отсутствие
        // поля пакет превращает в ноль сам, но «мы не знаем» и «мы уверенно
        // говорим ноль» расходятся в тот день, когда поле начнут читать
        // из другого источника.
        if (value === undefined || value <= 0) continue;
        out[field] = value;
      }
    }
    return out;
  };

  /**
   * Кнопка апгрейда таверны — она же цена подъёма.
   *
   * Сущность `TB_BaconShopTechUp0N_Button` в `PLAY` под своим контроллером.
   * Её `COST` — это ровно та цена, что показана в игре: базовая для тира
   * минус единица за каждый ход, когда таверну не подняли. Пересоздаётся
   * при каждом подъёме, поэтому ищется каждый раз заново.
   *
   * Нулевой `COST` не отдаём: он приходит на миг при сбросе сущности внутри
   * блока, и снимок, взятый в этот момент, обещал бы бесплатный апгрейд.
   */
  const upgradeButton = (): { cost: number | null; target: number | null } => {
    const self = players.selfPlayerId;
    if (self === null) return { cost: null, target: null };

    for (const e of entities.values()) {
      if (e.controller !== self || e.zone !== 'PLAY') continue;
      if (!TECH_UP_BUTTON_RE.test(e.cardId)) continue;
      const cost = e.tags.get('COST') ?? 0;
      const target = e.tags.get('TECH_LEVEL') ?? 0;
      if (cost <= 0 || target <= 0) continue;
      return { cost, target };
    }
    return { cost: null, target: null };
  };

  interface HeroPowerInfo {
    heroPowerCardId: string | null;
    heroPowerEntityId: number | null;
    heroPowerCost: number | null;
    heroPowerUsedThisTurn: boolean;
    heroPowerUnplayable: boolean;
    heroPowerLocked: boolean;
    heroPowerHasActivate: boolean;
    heroPowerExhausted: boolean | null;
    heroPowerDisabled: boolean;
    heroPowerScriptData: readonly (number | null)[];
  }

  /** Своя сила героя: живая сущность HERO_POWER под своим контроллером. */
  const heroPower = (): HeroPowerInfo => {
    const self = players.selfPlayerId;
    const none: HeroPowerInfo = {
      heroPowerCardId: null,
      heroPowerEntityId: null,
      heroPowerCost: null,
      heroPowerUsedThisTurn: false,
      heroPowerUnplayable: false,
      heroPowerLocked: false,
      heroPowerHasActivate: false,
      heroPowerExhausted: null,
      heroPowerDisabled: false,
      heroPowerScriptData: [],
    };
    if (self === null) return none;

    for (const e of entities.values()) {
      if (e.cardType !== 'HERO_POWER' || e.controller !== self) continue;
      if (DEAD_ZONES.has(e.zone) || e.cardId === '') continue;
      return {
        heroPowerCardId: e.cardId,
        heroPowerEntityId: e.id,
        heroPowerCost: e.tags.get('COST') ?? null,
        heroPowerUsedThisTurn,
        heroPowerUnplayable: flag(e, 'LITERALLY_UNPLAYABLE'),
        // Замок «открывается на тире N» (part37, Алекстраза): ставится
        // блоком TRIGGER сразу за созданием силы и снимается в ход,
        // когда таверна дорастает до нужного тира. Тега
        // `LITERALLY_UNPLAYABLE` у такой силы нет ни разу.
        heroPowerLocked: flag(e, 'LOCK_VISUAL'),
        // part13, «Мана в минуту» Хроми: HAS_ACTIVATE_POWER=1, тега COST нет.
        // Пассивные силы тега не имеют, и «нажать» их советовать нельзя.
        heroPowerHasActivate: flag(e, 'HAS_ACTIVATE_POWER'),
        // «Жать нельзя прямо сейчас» — part45, сила Инге на два нажатия.
        // Тега может не быть вовсе (part8), и тогда `null`: молчание игры
        // нельзя читать ни как «можно», ни как «нельзя».
        heroPowerExhausted: e.tags.has('EXHAUSTED') ? flag(e, 'EXHAUSTED') : null,
        // «Один раз за партию» — part48, сила Рено: на нажатии игра ставит
        // `HERO_POWER_DISABLED=1` и не снимает его больше никогда, тогда как
        // `EXHAUSTED` возвращается в ноль со сменой хода. Без этого тега
        // потраченная сила до конца партии выглядит готовой.
        heroPowerDisabled: flag(e, 'HERO_POWER_DISABLED'),
        // Счётчик «после N покупок» (part34, «Бранное дело»): NUM_1 — остаток,
        // тега при создании нет вовсе, дальше 3 → 2 → 1 → 0.
        heroPowerScriptData: [1, 2, 3, 4].map(
          (i) => e.tags.get(`TAG_SCRIPT_DATA_NUM_${String(i)}`) ?? null,
        ),
      };
    }
    return none;
  };

  /**
   * Цена обновления витрины — `COST` кнопки обновления в `PLAY`.
   *
   * Ноль здесь ЗНАЧАЩИЙ, в отличие от кнопки подъёма: бесплатное обновление
   * — реальный эффект тринкетов и героев, и отбрасывать его как «сброс»
   * значит советовать по таблице вместо факта. Сброс кнопки в начале хода
   * нулями отсекается зоной: на это время сущность лежит
   * в `REMOVEDFROMGAME` (part17, ход 2 — COST=0 приходит именно там).
   */
  const rerollButton = (): number | null => {
    const self = players.selfPlayerId;
    if (self === null) return null;

    for (const e of entities.values()) {
      if (e.controller !== self || e.zone !== 'PLAY') continue;
      if (e.cardId !== REROLL_BUTTON) continue;
      return e.tags.get('COST') ?? null;
    }
    return null;
  };

  /**
   * Запас бесплатных обновлений — счётчик на своём энчанте, а не на кнопке:
   * кнопка на бой обнуляется и в новом ходу приходит новой сущностью,
   * а энчант держит остаток через смену хода (part57, см. `freeRefreshes`).
   */
  const freeRefreshStock = (): number => {
    const self = players.selfPlayerId;
    if (self === null) return 0;
    for (const e of entities.values()) {
      if (e.controller !== self || e.cardId !== FREE_REFRESH_ENCHANT) continue;
      return e.tags.get('BACON_FREE_REFRESH_COUNT') ?? 0;
    }
    return 0;
  };

  /**
   * Кнопка тёмного дара, если она сейчас есть И заряды не исчерпаны:
   * цена нажатия и число оставшихся зарядов.
   */
  const darkGiftButton = (): { readonly cost: number | null; readonly charges: number | null } => {
    const none = { cost: null, charges: null };
    const self = players.selfPlayerId;
    if (self === null) return none;

    for (const e of entities.values()) {
      if (e.controller !== self || e.zone !== 'PLAY') continue;
      if (e.cardId !== DARK_GIFT_BUTTON) continue;
      // Оставшиеся дары — TAG_SCRIPT_DATA_NUM_2 на кнопке: 3 при создании,
      // по единице за нажатие (part11: 3 → 2 → 1 → 0). После нуля кнопка
      // остаётся в PLAY с ценой, и совет по ней был тихо неверным.
      const charges = e.tags.get('TAG_SCRIPT_DATA_NUM_2');
      if (charges !== undefined && charges <= 0) return none;
      const cost = e.tags.get('COST') ?? 0;
      if (cost <= 0) return none;
      return { cost, charges: charges ?? null };
    }
    return none;
  };

  /**
   * Заклинания в зоне: рука своя, витрина чужая.
   *
   * Белый список по типу, как у миньонов, — но у заклинаний ДВА типа:
   * в руке `CARDTYPE=SPELL`, в витрине — `BATTLEGROUND_SPELL` (part11:
   * монетка таверны у бармена за 1 создаётся именно так). Разбор, знающий
   * один тип, молча теряет витринные. Служебные заклинания клиента
   * (`TB_BaconShop_*` — перетаскивание покупки, проверка троек) картами
   * не являются и отсеиваются по префиксу.
   */
  const collectSpells = (zone: string, ownedBySelf: boolean) => {
    const self = players.selfPlayerId;
    if (self === null) return [];
    return [...entities.values()]
      .filter(
        (e) =>
          (e.cardType === 'SPELL' || e.cardType === 'BATTLEGROUND_SPELL') &&
          e.zone === zone &&
          (ownedBySelf ? e.controller === self : e.controller !== self) &&
          e.cardId !== '' &&
          !e.cardId.startsWith('TB_BaconShop'),
      )
      .sort((a, b) => a.zonePos - b.zonePos)
      .map((e) => ({
        entityId: e.id,
        cardId: e.cardId,
        // Позиция в зоне — та же, по которой уже отсортирован список.
        // Наружу она идёт затем, что ряд ВИТРИНЫ на экране общий с миньонами
        // (part41): порядок в нём восстанавливается только по этому числу.
        zonePos: e.zonePos,
        cost: e.tags.get('COST') ?? 0,
        scriptData: [1, 2, 3, 4].map((i) => e.tags.get(`TAG_SCRIPT_DATA_NUM_${String(i)}`) ?? null),
        unplayable: flag(e, 'LITERALLY_UNPLAYABLE'),
        costsHealth: flag(e, 'BACON_COSTS_HEALTH_TO_BUY'),
      }));
  };

  const snapshot = (): GameState => {
    const self = players.selfPlayerId;
    const heroEntity = heroEntityId === null ? null : entities.get(heroEntityId);
    const darkGift = darkGiftButton();

    // Энчанты группируются один раз на снимок: миньонов единицы, а энчантов
    // за партию больше тысячи, и перебор для каждого был бы квадратичным.
    const enchantmentsByHost = groupEnchantments();

    // Числа ветвей модальных карт — один проход на снимок, как у энчантов:
    // ветви бывают и у карты в руке, и у карты витрины.
    const branchData = choiceBranchData();

    const mine = (zone: string): Minion[] =>
      collectMinions(zone, true, enchantmentsByHost, new Map(), branchData);
    const upgrade = upgradeButton();

    // Чужие миньоны в PLAY — это магазин в таверне и борд противника в бою.
    // Различает их только фаза: сама зона и контроллер одинаковые. Цены
    // покупки (кнопки `DragBuy`) осмыслены только у витрины: в бою кнопок
    // нет, и чужой борд честно остаётся без цен.
    const theirs =
      phase === 'gameOver'
        ? []
        : collectMinions(
            'PLAY',
            false,
            enchantmentsByHost,
            phase === 'tavern' ? dragBuyCosts() : new Map(),
            branchData,
          );

    /**
     * Вариант выбора — это СУЩНОСТЬ, а не строка, которой канал выбора её
     * когда-то назвал.
     *
     * Строки `Entities[i]=` приходят один раз, при открытии выбора, и держат
     * карту на тот момент. Дальше игра карту меняет: за ЖЕТОН в выборе героя
     * можно заменить одного из четырёх, и приходит это `CHANGE_ENTITY`
     * на той же сущности (part46, 23:04:55: `id=115` Зирелла `BG20_HERO_101`
     * → Инге `BG26_HERO_102`, а игрок выбрал её же шестью секундами позже).
     * Пока вариант хранил снятую копию, советник целую минуту предлагал взять
     * героя, которого на экране уже не было, — жалоба игрока по part46.
     *
     * Отсюда правило: cardId варианта берётся с сущности, когда она известна
     * и названа. Не известна (id канала выбора не всегда совпадает с зонной
     * копией, part9) — остаётся то, что сказал канал. Тем же проходом берутся
     * значения плейсхолдеров текста: у сокровища «+{0} Attack» число лежит
     * в `TAG_SCRIPT_DATA_NUM_1` (part10).
     */
    const resolveOption = (o: ChoiceOption): ChoiceOption => {
      const e = entities.get(o.entityId);
      if (e === undefined) return o;
      const minion = e.cardType === 'MINION';
      return {
        ...o,
        cardId: e.cardId === '' ? o.cardId : e.cardId,
        scriptData: [1, 2, 3, 4].map(
          (i) => e.tags.get(`TAG_SCRIPT_DATA_NUM_${String(i)}`) ?? null,
        ),
        attack: minion ? (e.tags.get('ATK') ?? null) : null,
        health: minion ? (e.tags.get('HEALTH') ?? null) : null,
        techLevel: minion ? (e.tags.get('TECH_LEVEL') ?? null) : null,
      };
    };

    // Открытое предложение тринкетов: варианты показаны, выбор ещё не сделан.
    // Маркер — BACON_TRINKET=1 при жизни в SETASIDE: на выборе клиент уводит
    // все варианты в REMOVEDFROMGAME (проверено на part6 по сущностям
    // 3371–3374 — и взятый, и отвергнутые). USE_DISCOVER_VISUALS для этого
    // не годится: он стоит лишь у части вариантов, у двух из четырёх.
    const trinketOffer = [...entities.values()]
      .filter(
        (e) =>
          e.cardType === 'BATTLEGROUND_TRINKET' &&
          e.controller === self &&
          e.zone === 'SETASIDE' &&
          e.cardId !== '' &&
          flag(e, 'BACON_TRINKET'),
      )
      .sort((a, b) => a.id - b.id)
      .map((e) => ({
        entityId: e.id,
        cardId: e.cardId,
        // Суффикс тега — не всегда имя племени снапшота: `QUILLBOAR`
        // и `ELEMENTALS` расходятся с `QUILBOAR` и `ELEMENTAL` (part36).
        subsetRaces: [...e.tags.entries()]
          .filter(([tag, v]) => tag.startsWith('BACON_SUBSET_') && v > 0)
          .map(([tag]) => raceOfSubsetTag(tag.slice('BACON_SUBSET_'.length))),
        cost: e.tags.get('COST') ?? null,
      }));

    // Взятые тринкеты всех игроков — теги на сущностях героев. Один игрок
    // может быть представлен несколькими сущностями героя (пересадки,
    // дубликаты в SETASIDE), поэтому значения сливаются в множество.
    const trinketsByPlayer: Record<number, number[]> = {};
    // Тем же проходом собираются сущности героев для таблицы лобби ниже:
    // снимок делается на каждом шаге разбора, и второй обход всей карты
    // сущностей стоит дороже, чем сортировка двух десятков героев.
    const heroEntities: Entity[] = [];
    for (const e of entities.values()) {
      if (e.cardType === 'HERO' && e.zone !== 'REMOVEDFROMGAME') heroEntities.push(e);
      const first = e.tags.get('BACON_FIRST_TRINKET_DATABASE_ID') ?? 0;
      const second = e.tags.get('BACON_SECOND_TRINKET_DATABASE_ID') ?? 0;
      if (first <= 0 && second <= 0) continue;
      const owner = heroOwner.get(e.id) ?? e.tags.get('PLAYER_ID');
      if (owner === undefined) continue;
      const known = (trinketsByPlayer[owner] ??= []);
      for (const dbfId of [first, second]) {
        if (dbfId > 0 && !known.includes(dbfId)) known.push(dbfId);
      }
    }

    // Игроки лобби — по сущностям ГЕРОЕВ: тег `PLAYER_ID` связывает сущность
    // с игроком, остальное лежит тегами там же (`PLAYER_TECH_LEVEL`,
    // `PLAYER_LEADERBOARD_PLACE`, `HEALTH`/`DAMAGE`/`ARMOR`).
    //
    // Сущностей героя у одного игрока НЕСКОЛЬКО, и лишние врут. Живые
    // изменения приходят на ту, что создана в начале партии; копии для
    // модальных выборов (варианты «Дружеской ставки», кандидаты муллигана)
    // создаются позже и остаются с тегами момента создания — у них
    // и `PLAYER_TECH_LEVEL=0`, и место чужое. Поэтому: отработавшие копии
    // отсеиваются зоной `REMOVEDFROMGAME`, а из оставшихся берётся сущность
    // с НАИМЕНЬШИМ id — настоящий герой; остальные лишь дополняют пустые
    // поля.
    const lobby: Record<number, LobbyPlayer> = {};
    // Сортируются только герои (их два десятка), а не все сущности. Порядок
    // убывающий, а запись перетирает: значит, последней ложится сущность
    // с НАИМЕНЬШИМ id — настоящий герой, — а старшие лишь заполняют пустые
    // поля через `previous`.
    heroEntities.sort((a, b) => b.id - a.id);
    for (const e of heroEntities) {
      const owner = heroOwner.get(e.id) ?? e.tags.get('PLAYER_ID');
      if (owner === undefined) continue;
      const previous = lobby[owner];
      lobby[owner] = {
        playerId: owner,
        heroCardId: e.cardId === '' ? (previous?.heroCardId ?? '') : e.cardId,
        health: e.tags.get('HEALTH') ?? previous?.health ?? null,
        damage: e.tags.get('DAMAGE') ?? previous?.damage ?? 0,
        armor: e.tags.get('ARMOR') ?? previous?.armor ?? 0,
        techLevel: e.tags.get('PLAYER_TECH_LEVEL') ?? previous?.techLevel ?? null,
        place: e.tags.get('PLAYER_LEADERBOARD_PLACE') ?? previous?.place ?? null,
      };
    }

    return {
      ...EMPTY_STATE,
      phase,
      turn,
      techLevel,
      techLevelUpTurn,
      tavernUpgradeCost: upgrade.cost,
      tavernUpgradeTarget: upgrade.target,
      rerollCost: rerollButton(),
      freeRefreshes: freeRefreshStock(),
      maxTechLevel,
      // Остаток, а не выданное на ход: в игре слева от дроби показан именно он.
      // Временное золото (`TEMP_RESOURCES`) входит в остаток, как в игре
      // в числитель («11/10» при двух золотых «на следующий ход»), а «всего»
      // остаётся базовым максимумом — знаменателем. Потраченная временная
      // часть входит в `goldSpent`: точки решения (`turns.ts`) и датасет
      // читают «потрачено ли что-то в этом ходу», и покупка целиком
      // из временного золота обязана считаться тратой.
      gold: Math.max(0, goldTotal + goldTemp - goldSpent),
      goldTotal,
      goldSpent: goldSpent + tempSpent,
      extraGoldNextTurn,
      anomalyCardId,
      globalInfo: { ...globalInfo, ...enchantCountersOf(players.selfPlayerId) },
      // Счётчики СОПЕРНИКА текущего боя — та же функция, другой контроллер.
      // Без них правка выше была бы асимметричной (см. её шапку).
      opponentGlobalInfo: { ...EMPTY_GLOBAL_INFO, ...enchantCountersOf(opponentController()) },
      nextOpponentPlayerId,
      currentOpponentPlayerId,
      wonLastCombat,
      lastCombatDamage,
      altTavern,
      gameType,
      lastSeenBoards: Object.fromEntries(lastSeenBoards),
      lastSeenBoardTurns: Object.fromEntries(lastSeenBoardTurns),
      lobby,
      darkGiftCost: darkGift.cost,
      darkGiftCharges: darkGift.charges,
      darkGiftUsedThisTurn,
      trinketOffer,
      openChoice:
        openChoice === null
          ? null
          : {
              id: openChoice.id,
              sourceCardId: openChoice.sourceCardId,
              options: openChoice.options.map(resolveOption),
            },
      heroChoice:
        heroChoice === null
          ? null
          : {
              id: heroChoice.id,
              sourceCardId: heroChoice.sourceCardId,
              options: heroChoice.options.map(resolveOption),
            },
      trinketsByPlayer,
      activatedEntityIds: [...activatedEntityIds].sort((a, b) => a - b),
      // Порядок фиксирован: множество недетерминированно только в порядке
      // обхода, а состояние обязано быть воспроизводимым до байта.
      seenShopCardIds: [...seenShopCardIds].sort(),
      // Порядок фиксирован по той же причине, что у витрины: снимок обязан
      // быть воспроизводимым до байта.
      logRaces: Object.fromEntries([...logRaces].sort(([a], [b]) => a.localeCompare(b))),
      finalPlace,
      buildNumber,
      playerBattleTag: players.selfName,
      playerId: self,
      // Копия на снимок: журнал растёт по ходу партии, а снимок обязан
      // быть неизменным. Порядок — порядок совершения, он детерминирован.
      actions: [...actions],
      board: mine('PLAY'),
      hand: mine('HAND'),
      // Заклинания руки — отдельным списком: белый список CARDTYPE=SPELL,
      // как у миньонов. Подтверждено на part10: монетка таверны BG28_810
      // создаётся в HAND с CARDTYPE=SPELL и живым тегом COST.
      handSpells: collectSpells('HAND', true),
      // Заклинания витрины — чужие SPELL в PLAY, только в фазе таверны:
      // в бою чужой PLAY — борд противника, а не магазин.
      shopSpells: phase === 'tavern' ? collectSpells('PLAY', false) : [],
      shop: phase === 'tavern' ? theirs : [],
      opponentBoard: phase === 'combat' ? theirs : [],
      hero:
        heroEntity === undefined || heroEntity === null
          ? null
          : {
              ...heroPower(),
              entityId: heroEntity.id,
              cardId: heroEntity.cardId,
              health: heroEntity.tags.get('HEALTH') ?? null,
              armor: heroEntity.tags.get('ARMOR') ?? 0,
              damage: heroEntity.tags.get('DAMAGE') ?? 0,
            },
    };
  };

  return { step, snapshot };
}

/** Свёртка целого лога — два прохода: игроки, затем события. */
export function reduceLog(text: string): GameState {
  const reducer = createReducer(readPlayers(text));
  for (const event of readPowerEvents(text)) reducer.step(event);
  return reducer.snapshot();
}
