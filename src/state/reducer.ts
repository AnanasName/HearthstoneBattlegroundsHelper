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
 */
const SHOW_ENTITY_RE = /^SHOW_ENTITY - Updating Entity=(\d+) CardID=(\S*)/;

/** Кнопка подъёма таверны — по одной на каждый достижимый тир. */
const TECH_UP_BUTTON_RE = /^TB_BaconShopTechUp\d+_Button$/;

/** Кнопка тёмного дара — `CARDTYPE=GAME_MODE_BUTTON`, цена в теге `COST`. */
const DARK_GIFT_BUTTON = 'BG36_Button_DarkGift';

/** Кнопка обновления витрины — её `COST` и есть живая цена реролла. */
const REROLL_BUTTON = 'TB_BaconShop_8p_Reroll_Button';

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

function toMinion(e: Entity, enchantments: readonly Enchantment[]): Minion {
  const health = e.tags.get('HEALTH') ?? null;
  const damage = e.tags.get('DAMAGE') ?? 0;
  return {
    entityId: e.id,
    cardId: e.cardId,
    zonePos: e.zonePos,
    attack: e.tags.get('ATK') ?? null,
    health: health === null ? null : health - damage,
    enchantments,
    scriptData: [1, 2, 3, 4, 5, 6].map(
      (i) => e.tags.get(`TAG_SCRIPT_DATA_NUM_${String(i)}`) ?? null,
    ),
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
  let anomalyCardId: string | null = null;
  let finalPlace: number | null = null;
  let buildNumber: number | null = null;
  let heroEntityId: number | null = null;
  let nextOpponentPlayerId: number | null = null;
  let currentOpponentPlayerId: number | null = null;
  let wonLastCombat: boolean | null = null;
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
  };

  const globalInfo: Record<keyof GlobalInfo, number | null> = { ...EMPTY_GLOBAL_INFO };

  /** id сущности героя → `PlayerID` его владельца. */
  const heroOwner = new Map<number, number>();
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

  /**
   * Журнал своих действий за партию — сырьё фазы 6 («какие действия ведут
   * к победе» не выучить, не записывая действий). Блок PLAY стоит в стеке
   * у многих событий подряд, а действие он значит ОДНО: WeakSet по самому
   * объекту блока делает запись одноразовой — стек держит один объект
   * от открытия до закрытия, и события несут ссылки на него.
   */
  const actions: PlayerAction[] = [];
  const journaledBlocks = new WeakSet<BlockContext>();

  const journal = (
    block: BlockContext,
    type: PlayerActionType,
    cardId: string | null,
    entityId: number | null,
  ): void => {
    if (journaledBlocks.has(block)) return;
    journaledBlocks.add(block);
    actions.push({ turn, type, cardId: cardId === '' ? null : cardId, entityId });
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
    return created;
  };

  const applyToEntity = (e: Entity, tag: string, value: string): void => {
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
          heroPowerUsedThisTurn = false;
          darkGiftUsedThisTurn = false;
          activatedEntityIds.clear();
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
        if (subject.kind === 'entity' && n !== null) heroOwner.set(subject.id, n);
        return;
      case 'BACON_WON_LAST_COMBAT':
        if (subject.kind === 'self' && n !== null) wonLastCombat = n > 0;
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
      .map((e) => toMinion(e, enchantments.get(e.id) ?? []));
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

  const step = (event: PowerEvent): void => {
    const { content } = event.line;

    // Номер билда — из канала метаданных, одной строкой после CREATE_GAME.
    // По нему приложение узнаёт, не отстал ли снапшот карт от патча.
    if (content.startsWith('BuildNumber=')) {
      const n = Number(content.slice('BuildNumber='.length));
      if (Number.isFinite(n)) buildNumber = n;
      return;
    }

    // Каналы модальных выборов идут отдельно от DebugPrintPower и не трогают
    // ни `current`, ни стек блоков: их строки вклиниваются между блоками.
    if (event.line.source !== SOURCE_OF_TRUTH) {
      stepChoice(event.line.source, content);
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
      if (pressed.cardType === 'HERO_POWER') {
        heroPowerUsedThisTurn = true;
        journal(block, 'heroPower', pressed.cardId, pressed.id);
      } else if (pressed.cardId === DARK_GIFT_BUTTON) {
        darkGiftUsedThisTurn = true;
        journal(block, 'darkGift', pressed.cardId, pressed.id);
      } else if (pressed.cardType === 'MINION' && pressed.zone === 'PLAY') {
        // Активация: блок PLAY на миньоне, уже СТОЯЩЕМ на борде, — розыгрыш
        // из руки отличается зоной сущности (part14, Suspicious Prisonguard).
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
        // Розыгрыш из руки: зона берётся из дескриптора строки BLOCK_START —
        // к следующим событиям блока карта уже успевает сменить зону.
        const zoneAtPress =
          block.entity !== null && block.entity.kind === 'descriptor'
            ? block.entity.descriptor.zone
            : pressed.zone;
        if (zoneAtPress === 'HAND') journal(block, 'play', pressed.cardId, pressed.id);
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

    if (content.startsWith('FULL_ENTITY') || content.startsWith('SHOW_ENTITY')) {
      const revealing = content.startsWith('SHOW_ENTITY');
      currentIsGameEntity = false;

      if (descriptorHere !== null) {
        // У SHOW_ENTITY с дескриптором cardId стоит в хвосте, после `CardID=`,
        // а внутри самого дескриптора он ещё пустой — карта же была скрыта.
        const revealed = /\bCardID=(\S+)\s*$/.exec(content)?.[1];
        const e = touch(descriptorHere.id, revealed ?? descriptorHere.cardId, revealing);
        e.zone = descriptorHere.zone;
        e.zonePos = descriptorHere.zonePos;
        e.controller ??= descriptorHere.player;
        current = e;
        return;
      }

      const shown = SHOW_ENTITY_RE.exec(content);
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
        applyToEntity(current, tag, value);
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
        const owner = heroOwner.get(numeric(value) ?? -1);
        if (owner !== undefined) currentOpponentPlayerId = owner;
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
    heroPowerHasActivate: boolean;
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
      heroPowerHasActivate: false,
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
        // part13, «Мана в минуту» Хроми: HAS_ACTIVATE_POWER=1, тега COST нет.
        // Пассивные силы тега не имеют, и «нажать» их советовать нельзя.
        heroPowerHasActivate: flag(e, 'HAS_ACTIVATE_POWER'),
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

  /** Кнопка тёмного дара, если она сейчас есть И заряды не исчерпаны. */
  const darkGiftButton = (): number | null => {
    const self = players.selfPlayerId;
    if (self === null) return null;

    for (const e of entities.values()) {
      if (e.controller !== self || e.zone !== 'PLAY') continue;
      if (e.cardId !== DARK_GIFT_BUTTON) continue;
      // Оставшиеся дары — TAG_SCRIPT_DATA_NUM_2 на кнопке: 3 при создании,
      // по единице за нажатие (part11: 3 → 2 → 1 → 0). После нуля кнопка
      // остаётся в PLAY с ценой, и совет по ней был тихо неверным.
      const charges = e.tags.get('TAG_SCRIPT_DATA_NUM_2');
      if (charges !== undefined && charges <= 0) return null;
      const cost = e.tags.get('COST') ?? 0;
      return cost > 0 ? cost : null;
    }
    return null;
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
        cost: e.tags.get('COST') ?? 0,
        scriptData: [1, 2, 3, 4].map((i) => e.tags.get(`TAG_SCRIPT_DATA_NUM_${String(i)}`) ?? null),
        unplayable: flag(e, 'LITERALLY_UNPLAYABLE'),
      }));
  };

  const snapshot = (): GameState => {
    const self = players.selfPlayerId;
    const heroEntity = heroEntityId === null ? null : entities.get(heroEntityId);

    // Энчанты группируются один раз на снимок: миньонов единицы, а энчантов
    // за партию больше тысячи, и перебор для каждого был бы квадратичным.
    const enchantmentsByHost = groupEnchantments();

    const mine = (zone: string): Minion[] => collectMinions(zone, true, enchantmentsByHost);
    const upgrade = upgradeButton();

    // Чужие миньоны в PLAY — это магазин в таверне и борд противника в бою.
    // Различает их только фаза: сама зона и контроллер одинаковые.
    const theirs = phase === 'gameOver' ? [] : collectMinions('PLAY', false, enchantmentsByHost);

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
        subsetRaces: [...e.tags.entries()]
          .filter(([tag, v]) => tag.startsWith('BACON_SUBSET_') && v > 0)
          .map(([tag]) => tag.slice('BACON_SUBSET_'.length)),
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
      maxTechLevel,
      // Остаток, а не выданное на ход: в игре слева от дроби показан именно он.
      gold: Math.max(0, goldTotal - goldSpent),
      goldTotal,
      goldSpent,
      anomalyCardId,
      globalInfo: { ...globalInfo },
      nextOpponentPlayerId,
      currentOpponentPlayerId,
      wonLastCombat,
      lastSeenBoards: Object.fromEntries(lastSeenBoards),
      lastSeenBoardTurns: Object.fromEntries(lastSeenBoardTurns),
      lobby,
      darkGiftCost: darkGiftButton(),
      darkGiftUsedThisTurn,
      trinketOffer,
      openChoice:
        openChoice === null
          ? null
          : {
              id: openChoice.id,
              sourceCardId: openChoice.sourceCardId,
              // Значения плейсхолдеров текста — с сущности варианта, когда
              // она известна. Id из канала выбора не всегда совпадает
              // с зонной копией (part9), тогда чисел просто нет.
              options: openChoice.options.map((o) => {
                const e = entities.get(o.entityId);
                return e === undefined
                  ? o
                  : {
                      ...o,
                      scriptData: [1, 2, 3, 4].map(
                        (i) => e.tags.get(`TAG_SCRIPT_DATA_NUM_${String(i)}`) ?? null,
                      ),
                    };
              }),
            },
      heroChoice:
        heroChoice === null
          ? null
          : {
              id: heroChoice.id,
              sourceCardId: heroChoice.sourceCardId,
              options: heroChoice.options,
            },
      trinketsByPlayer,
      activatedEntityIds: [...activatedEntityIds].sort((a, b) => a - b),
      // Порядок фиксирован: множество недетерминированно только в порядке
      // обхода, а состояние обязано быть воспроизводимым до байта.
      seenShopCardIds: [...seenShopCardIds].sort(),
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
