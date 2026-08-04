import { readPowerEvents, type PowerEvent } from '../parser/blocks.js';
import { parseEntityDescriptor } from '../parser/entity.js';
import { readPlayers, type Players } from './players.js';
import {
  BOARD_VISUAL_STATE_COMBAT,
  BOARD_VISUAL_STATE_TAVERN,
  EMPTY_STATE,
  type GameState,
  type Minion,
  type Phase,
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

/** Теги-признаки, которые нас интересуют у миньона. */
interface Entity {
  id: number;
  cardId: string;
  zone: string;
  zonePos: number;
  controller: number | null;
  cardType: string | null;
  tags: Map<string, number>;
}

function numeric(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function flag(e: Entity, tag: string): boolean {
  return (e.tags.get(tag) ?? 0) > 0;
}

function toMinion(e: Entity): Minion {
  const health = e.tags.get('HEALTH') ?? null;
  const damage = e.tags.get('DAMAGE') ?? 0;
  return {
    entityId: e.id,
    cardId: e.cardId,
    zonePos: e.zonePos,
    attack: e.tags.get('ATK') ?? null,
    health: health === null ? null : health - damage,
    taunt: flag(e, 'TAUNT'),
    divineShield: flag(e, 'DIVINE_SHIELD'),
    poisonous: flag(e, 'POISONOUS'),
    venomous: flag(e, 'VENOMOUS'),
    reborn: flag(e, 'REBORN'),
    windfury: flag(e, 'WINDFURY'),
    // Признак золотого пока не подтверждён; суффикс _G в cardId — наблюдение,
    // встреченное в фикстуре (BG31_815_G), но правилом его считать рано.
    golden: e.cardId.endsWith('_G'),
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
  let goldTotal = 0;
  let goldSpent = 0;
  let anomalyCardId: string | null = null;
  let finalPlace: number | null = null;
  let heroEntityId: number | null = null;

  /** Сущность, к которой относятся идущие следом строки `tag=…`. */
  let current: Entity | null = null;

  const touch = (id: number, cardId?: string): Entity => {
    const found = entities.get(id);
    if (found !== undefined) {
      if (cardId !== undefined && cardId !== '' && found.cardId === '') found.cardId = cardId;
      return found;
    }
    const created: Entity = {
      id,
      cardId: cardId ?? '',
      zone: '',
      zonePos: 0,
      controller: null,
      cardType: null,
      tags: new Map(),
    };
    entities.set(id, created);
    return created;
  };

  const applyToEntity = (e: Entity, tag: string, value: string): void => {
    const n = numeric(value);

    switch (tag) {
      case 'ZONE':
        e.zone = value;
        return;
      case 'ZONE_POSITION':
        if (n !== null) e.zonePos = n;
        return;
      case 'CONTROLLER':
        if (n !== null) e.controller = n;
        return;
      case 'CARDTYPE':
        e.cardType = value;
        if (value === 'BATTLEGROUND_ANOMALY' && e.cardId !== '') anomalyCardId = e.cardId;
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
        else if (n === BOARD_VISUAL_STATE_COMBAT) phase = 'combat';
        return;
      case 'TURN':
        if (subject.kind === 'game' && n !== null) turn = n;
        return;
      case 'STEP':
        if (subject.kind === 'game' && value === 'FINAL_GAMEOVER') phase = 'gameOver';
        return;
      case 'PLAYER_TECH_LEVEL':
        if (subject.kind === 'self' && n !== null) techLevel = n;
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
      default:
        return;
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

  const step = (event: PowerEvent): void => {
    const { content } = event.line;

    const descriptorHere = content.includes('[entityName=')
      ? parseEntityDescriptor(content)
      : null;

    if (content.startsWith('FULL_ENTITY') || content.startsWith('SHOW_ENTITY')) {
      if (descriptorHere !== null) {
        const e = touch(descriptorHere.id, descriptorHere.cardId);
        e.zone = descriptorHere.zone;
        e.zonePos = descriptorHere.zonePos;
        e.controller ??= descriptorHere.player;
        current = e;
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
          selfPlayerEntityIds.has(current.id)
            ? { kind: 'self' }
            : { kind: 'entity', id: current.id },
        );
      }
      return;
    }

    current = null;

    const change = TAG_CHANGE_RE.exec(content);
    if (change === null) return;
    const [, entityRef, tag, value] = change;
    if (entityRef === undefined || tag === undefined || value === undefined) return;

    // Свой герой объявляется именно так: HERO_ENTITY у сущности со своим именем.
    if (tag === 'HERO_ENTITY' && isSelf(entityRef)) {
      heroEntityId = numeric(value);
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

  const snapshot = (): GameState => {
    const self = players.selfPlayerId;
    const heroEntity = heroEntityId === null ? null : entities.get(heroEntityId);

    // Белый список, а не чёрный: у части сущностей CARDTYPE в логе не встречается
    // вовсе, и при фильтрации «всё кроме» они молча оказывались на борду —
    // 455 штук вместо максимум семи. Берём только явные MINION.
    const minionsIn = (zone: string, ownedBySelf: boolean): Minion[] =>
      self === null
        ? []
        : [...entities.values()]
            .filter(
              (e) =>
                e.cardType === 'MINION' &&
                e.zone === zone &&
                (ownedBySelf ? e.controller === self : e.controller !== self),
            )
            .sort((a, b) => a.zonePos - b.zonePos)
            .map(toMinion);

    const mine = (zone: string): Minion[] => minionsIn(zone, true);

    // Чужие миньоны в PLAY — это магазин в таверне и борд противника в бою.
    // Различает их только фаза: сама зона и контроллер одинаковые.
    const theirs = phase === 'gameOver' ? [] : minionsIn('PLAY', false);

    return {
      ...EMPTY_STATE,
      phase,
      turn,
      techLevel,
      // Остаток, а не выданное на ход: в игре слева от дроби показан именно он.
      gold: Math.max(0, goldTotal - goldSpent),
      goldTotal,
      goldSpent,
      anomalyCardId,
      finalPlace,
      playerBattleTag: players.selfName,
      playerId: self,
      board: mine('PLAY'),
      hand: mine('HAND'),
      shop: phase === 'tavern' ? theirs : [],
      opponentBoard: phase === 'combat' ? theirs : [],
      hero:
        heroEntity === undefined || heroEntity === null
          ? null
          : {
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
