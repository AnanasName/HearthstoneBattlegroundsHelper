import type { BgsBattleInfo } from '@firestone-hs/simulate-bgs-battle/dist/bgs-battle-info.js';
import type {
  BgsPlayerEntity,
  BoardTrinket,
} from '@firestone-hs/simulate-bgs-battle/dist/bgs-player-entity.js';
import type {
  BoardEnchantment,
  BoardEntity,
} from '@firestone-hs/simulate-bgs-battle/dist/board-entity.js';
import type { BoardSecret } from '@firestone-hs/simulate-bgs-battle/dist/board-secret.js';

import { loadCardIndex, type CardIndex } from '../../data/cards.js';
import { tavernTurnOf } from '../tavern/rules.js';
import {
  EMPTY_GLOBAL_INFO,
  type Deity,
  type Enchantment,
  type GlobalInfo,
  type Hero,
  type Minion,
} from '../../state/types.js';

/**
 * Перевод нашего состояния во входной формат симулятора.
 *
 * Контракт и список того, что мы пока не извлекаем, — в docs/simulator.md.
 */

function toEnchantment(e: Enchantment): BoardEnchantment {
  return {
    cardId: e.cardId,
    timing: e.timing,
    ...(e.scriptDataNum1 === null ? {} : { tagScriptDataNum1: e.scriptDataNum1 }),
    ...(e.scriptDataNum2 === null ? {} : { tagScriptDataNum2: e.scriptDataNum2 }),
  };
}

/** Сырые теги идут числовыми ключами — симулятор ждёт именно так. */
function numericTags(tags: Readonly<Record<string, number>>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [key, value] of Object.entries(tags)) {
    const numeric = Number(key);
    if (Number.isInteger(numeric)) out[numeric] = value;
  }
  return out;
}

export function toBoardEntity(m: Minion): BoardEntity {
  const [d1, d2, d3, d4, d5, d6] = m.scriptData;
  return {
    entityId: m.entityId,
    cardId: m.cardId,
    attack: m.attack ?? 0,
    health: m.health ?? 1,
    ...(m.maxHealth === null ? {} : { maxHealth: m.maxHealth }),
    taunt: m.taunt,
    divineShield: m.divineShield,
    poisonous: m.poisonous,
    venomous: m.venomous,
    reborn: m.reborn,
    windfury: m.windfury,
    stealth: m.stealth,
    ...(m.techLevel === null ? {} : { tavernTier: m.techLevel }),
    enchantments: m.enchantments.map(toEnchantment),
    ...(d1 === null ? {} : { scriptDataNum1: d1 }),
    ...(d2 === null ? {} : { scriptDataNum2: d2 }),
    ...(d3 === null ? {} : { scriptDataNum3: d3 }),
    ...(d4 === null ? {} : { scriptDataNum4: d4 }),
    ...(d5 === null ? {} : { scriptDataNum5: d5 }),
    ...(d6 === null ? {} : { scriptDataNum6: d6 }),
    tags: numericTags(m.tags),
  };
}

/**
 * Счётчики игрока для симулятора — только те, что реально прочитаны из лога.
 *
 * Заполнять неизвестные нулями было попыткой убрать `NaN` в статах спавнов,
 * но замеры это опровергли: калибровка ухудшилась вдвое с лишним
 * (расхождение 4.0 → 9.1 п.п., Brier 0.019 → 0.066). Выдуманный ноль хуже
 * отсутствия — механика начинает работать с заведомо неверным значением,
 * тогда как при отсутствии симулятор обходится своими умолчаниями.
 */
function toGlobalInfo(info: GlobalInfo): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (key: string, value: number | null): void => {
    if (value !== null) out[key] = value;
  };

  put('GoldSpentThisGame', info.goldSpentThisGame);
  put('SpellsCastThisGame', info.spellsCastThisGame);
  put('CardsPlayedThisTurn', info.cardsPlayedThisTurn);
  put('TavernSpellAttackBuff', info.tavernSpellAttackBuff);
  put('TavernSpellHealthBuff', info.tavernSpellHealthBuff);
  put('ElementalAttackBuff', info.elementalAttackBuff);
  put('ElementalHealthBuff', info.elementalHealthBuff);
  put('BloodGemAttackBonus', info.bloodGemAttackBuff);
  put('BloodGemHealthBonus', info.bloodGemHealthBuff);
  // Нежить (part50). Симулятор применяет эти два поля к телам, призванным
  // ВНУТРИ боя: `UndeadAttackBonus` — к любому призванному миньону нежити
  // (`add-minion-to-board.js`, строка 247), `EternalKnightsDeadThisGame` —
  // к статам призванного Eternal Knight (там же, строка 368). На борде статы
  // уже применены игрой, поэтому без этих полей ошибался ровно тот класс
  // бордов, который на призывах и стоит: скелеты, Руки, копии перерождения.
  put('UndeadAttackBonus', info.undeadAttackBuff);
  put('UndeadHealthBonus', info.undeadHealthBuff);
  put('EternalKnightsDeadThisGame', info.eternalKnightsDead);
  // Жуки (17.09): `beetle.js` прибавляет надбавку к каждому жуку, призванному
  // в бою, и вычитает её при исчезновении. Без поля жук выходит 2/2 при
  // счётчике в сотню, а вычитание даёт `NaN`.
  put('BeetleAttackBuff', info.beetleAttackBuff);
  put('BeetleHealthBuff', info.beetleHealthBuff);

  return out;
}

export function toPlayerEntity(
  hero: Hero,
  tavernTier: number,
  globalInfo: GlobalInfo,
): BgsPlayerEntity {
  return {
    cardId: hero.cardId,
    hpLeft: (hero.health ?? 0) - hero.damage + hero.armor,
    tavernTier,
    globalInfo: toGlobalInfo(globalInfo),
    heroPowers:
      hero.heroPowerCardId === null
        ? []
        : [
            {
              cardId: hero.heroPowerCardId,
              entityId: hero.heroPowerEntityId ?? 0,
              used: false,
              info: 0,
              info2: 0,
              info3: 0,
              info4: 0,
              info5: 0,
              info6: 0,
            },
          ],
    questEntities: [],
  };
}

/**
 * Миньон РУКИ во входе симулятора.
 *
 * Отличается от бордового одним: `maxHealth` обязателен. Симулятор отбирает
 * кандидатов на призыв из руки условием `!!e.maxHealth` (expert-aviator.js),
 * и миньон руки без этого поля молча не призывается вовсе — а у нас поле
 * необязательное, оно приходит тегом и в руке бывает пустым.
 */
function toHandEntity(m: Minion): BoardEntity {
  return { ...toBoardEntity(m), maxHealth: m.maxHealth ?? m.health ?? 1 };
}

/**
 * Всё, что нужно знать о положении дел перед боем.
 *
 * Выделено из `BattleEpisode` затем, что эпизод — это бой из лога с уже
 * известным исходом, а советнику расстановки надо считать бой, которого ещё
 * не было. Набор полей тот же, `BattleEpisode` подходит сюда как есть.
 */
export interface BattleSetup {
  readonly turn: number;
  readonly playerBoard: readonly Minion[];
  /**
   * Своя РУКА на момент боя — миньоны, не заклинания.
   *
   * Нужна затем, что часть карт пула играет рукой прямо в бою: «Rally:
   * Summon the highest-Attack minion from your hand for this combat only»
   * (Expert Aviator, part21), «Whenever this takes damage, give a minion
   * in your hand +2/+1» (Very Hungry Winterfinner). Симулятор это умеет
   * (`expert-aviator.js` читает `attackingHero.hand`), а мы руку
   * не передавали — и ралли в счёте не срабатывало ни разу: строка «по бою»
   * оценивала носителя ралли как голое тело.
   *
   * Поле необязательное: у старых эпизодов руки нет, и отсутствие честнее
   * пустого списка — оно означает «не знаем», а не «рука пуста».
   */
  readonly playerHand?: readonly Minion[];
  readonly opponentBoard: readonly Minion[];
  readonly playerHero: Hero;
  readonly techLevel: number;
  readonly anomalyCardId: string | null;
  readonly globalInfo: GlobalInfo;
  /**
   * Счётчики СОПЕРНИКА этого боя.
   *
   * Необязательное: у старых эпизодов их нет, и отсутствие честнее пустого
   * набора. Без них бой асимметричен — свои призванные тела получают
   * надбавку, чужие нет (part50).
   */
  readonly opponentGlobalInfo?: GlobalInfo;
  /**
   * Взятые тринкеты, свои и противника, как dbfId из лога.
   *
   * Поля необязательные: старые фикстуры сыграны до тринкетов, а часть
   * вызовов собирает вход там, где тринкеты неизвестны. Отсутствие честнее
   * пустого списка — оно означает «не знаем», а не «нет тринкетов».
   */
  readonly playerTrinketDbfIds?: readonly number[];
  readonly opponentTrinketDbfIds?: readonly number[];
  /**
   * Божества сторон (D287): сигил, из которого симулятор В БОЮ выпускает
   * тело после смерти нужного числа своих аберраций. Необязательные
   * по той же причине, что тринкеты: `undefined` — «не знаем», `null` —
   * «сигила нет».
   */
  readonly playerDeity?: Deity | null;
  readonly opponentDeity?: Deity | null;
  /**
   * Сколько игроков живо на начало боя — вход потолка урона (D288).
   *
   * Урон боя пакет ограничивает сам (`damage-cap.js`: при пяти и больше
   * живых 5 на ходах таверны 1–3, 10 на 4–7, 15 дальше), но только зная
   * число живых. Необязательное по той же причине, что тринкеты:
   * `undefined` и `null` — «не знаем», и потолка нет, как до правки.
   */
  readonly playersAlive?: number | null;
}

/**
 * Сигил Божества → секрет симулятора.
 *
 * Пакет (с 1.1.757, `simulation/deity.js`) ищет среди секретов героя карту
 * `BG_OldGod` и читает с неё ровно те теги, что лежат на сигиле в логе:
 * `scriptDataNum1` — остаток счётчика, `_2`/`_3` — статы тела, `_6` — dbfId
 * тела. Отсюда и перевод один к одному, без пересчёта.
 */
function toDeitySecrets(deity: Deity | null | undefined): BoardSecret[] {
  if (deity === null || deity === undefined) return [];
  return [
    {
      entityId: deity.entityId,
      cardId: 'BG_OldGod',
      scriptDataNum1: deity.remaining,
      scriptDataNum2: deity.attack,
      scriptDataNum3: deity.health,
      ...(deity.cardDbfId === null ? {} : { scriptDataNum6: deity.cardDbfId }),
    },
  ];
}

/**
 * dbfId тринкетов → вход симулятора.
 *
 * Справочник карт грузится лениво и один раз: он нужен только партиям
 * с тринкетами, а тесты маппера на старых фикстурах не должны платить
 * секунду за разбор снапшота, которым не пользуются.
 */
let trinketCards: CardIndex | null = null;

function toTrinkets(dbfIds: readonly number[] | undefined): BoardTrinket[] {
  if (dbfIds === undefined || dbfIds.length === 0) return [];
  trinketCards ??= loadCardIndex();

  return dbfIds.flatMap((dbfId) => {
    const info = trinketCards?.infoByDbfId(dbfId);
    // Незнакомый dbfId молча пропускается: выдуманный тринкет исказил бы
    // бой сильнее, чем отсутствующий.
    if (info === undefined || info === null) return [];
    return [{ cardId: info.id, entityId: 0, scriptDataNum1: 0 }];
  });
}

/**
 * Собирает вход симулятора для одного боя.
 *
 * Герой противника нам неизвестен: в логе видно его борд, но не карточку героя
 * на момент боя. Подставляется заглушка — на исход боя герой влияет только
 * через силу, а её мы всё равно не извлекаем.
 */
export function toBattleInfo(
  episode: BattleSetup,
  numberOfSimulations: number,
): BgsBattleInfo {
  const opponentHero: BgsPlayerEntity = {
    cardId: 'TB_BaconShop_HERO_PH',
    hpLeft: 40,
    tavernTier: episode.techLevel,
    heroPowers: [],
    questEntities: [],
    globalInfo: toGlobalInfo(episode.opponentGlobalInfo ?? EMPTY_GLOBAL_INFO),
    trinkets: toTrinkets(episode.opponentTrinketDbfIds),
    secrets: toDeitySecrets(episode.opponentDeity),
  };
  // Потолок урона (D288): число живых и флаг — только вместе и только
  // при известном числе. Исхода боя потолок не меняет, меняет урон,
  // а с ним смерть в ближайшем бою (D283).
  const alive = episode.playersAlive ?? null;

  return {
    playerBoard: {
      player: {
        ...toPlayerEntity(episode.playerHero, episode.techLevel, episode.globalInfo),
        trinkets: toTrinkets(episode.playerTrinketDbfIds),
        secrets: toDeitySecrets(episode.playerDeity),
        // Рука — только когда она известна: у старых эпизодов её нет,
        // и пустой список означал бы «рука пуста», а не «не знаем».
        ...(episode.playerHand === undefined
          ? {}
          : { hand: episode.playerHand.map(toHandEntity) }),
      },
      board: episode.playerBoard.map(toBoardEntity),
    },
    opponentBoard: {
      player: opponentHero,
      board: episode.opponentBoard.map(toBoardEntity),
    },
    options: {
      numberOfSimulations,
      skipInfoLogs: true,
      ...(alive === null ? {} : { applyDamageCap: true }),
    },
    gameState: {
      // Ход ТАВЕРНЫ, а не партии (D286): у симулятора это шкала силы
      // «Unlocks on Turn 7» (Drek'Thar, Vanndar) и ограничителя урона.
      // Сырой ход партии отпирал силу Drek'Thar на четвёртом ходу таверны
      // и ставил в бой копию, которой не было (part71, ходы 8–12).
      currentTurn: tavernTurnOf(episode.turn),
      ...(alive === null ? {} : { numberOfPlayersAlive: alive }),
      ...(episode.anomalyCardId === null ? {} : { anomalies: [episode.anomalyCardId] }),
    },
  };
}

/**
 * Тот же бой, но со своим бордом в другом порядке.
 *
 * Позиция миньона для симулятора — это индекс в массиве, отдельного поля под
 * неё нет. Поэтому советник расстановки меняет ровно одно: порядок элементов
 * `playerBoard.board`. Всё прочее — герой, счётчики, борд противника, ход —
 * обязано остаться тем же, иначе кандидаты сравниваются в разных условиях.
 */
export function withPlayerBoard(
  input: BgsBattleInfo,
  board: readonly Minion[],
): BgsBattleInfo {
  return {
    ...input,
    playerBoard: { ...input.playerBoard, board: board.map(toBoardEntity) },
  };
}
