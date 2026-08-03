/**
 * Разбор ссылок на сущности в Power.log.
 *
 * Полный дескриптор выглядит так:
 *
 *   [entityName=Выживший красный дракон id=408 zone=PLAY zonePos=1 cardId=BG35_814 player=11]
 *
 * Но `Entity=` встречается и в двух других видах — голым числом и именем
 * (`GameEntity`, BattleTag игрока), поэтому разбор ссылки отделён от разбора
 * дескриптора. Счёт по эталонной партии: дескриптор 84 686, голый id 17 831,
 * имя 11 000+.
 */

/**
 * Поля дескриптора идут в фиксированном порядке, и разбор идёт ПО НИМ, а не по
 * закрывающей скобке.
 *
 * Причина: `entityName` может содержать вложенные квадратные скобки —
 * `[entityName=UNKNOWN ENTITY [cardType=INVALID] id=255 …]`. Поиск до первой `]`
 * обрезал бы такой дескриптор на `[cardType=INVALID]` и молча терял id, zone,
 * cardId и player. В эталонной партии таких строк 11 525 — около 10% всех
 * дескрипторов, то есть ошибка была бы массовой и незаметной.
 *
 * Нежадный `entityName` в связке с обязательным хвостом из пяти полей
 * устойчив и к пробелам в имени («Воришка Бигглсуорт»), и к вложенным скобкам:
 * при неудачном совпадении движок сам сдвинет границу имени дальше.
 */
const DESCRIPTOR_RE =
  /\[entityName=(.*?) id=(\d+) zone=([A-Z_]*) zonePos=(-?\d+) cardId=(\S*) player=(\d+)\]/;

export interface EntityDescriptor {
  /** Локализованное имя. Опираться нельзя, бывает пустым (1 725 раз за партию). */
  readonly entityName: string;
  readonly id: number;
  readonly zone: string;
  readonly zonePos: number;
  /** Пустой у скрытых карт — 11 113 раз за партию. */
  readonly cardId: string;
  /** Номер контроллера. НЕ уникален для героя на концовке, см. docs/power-log.md. */
  readonly player: number;
}

/** Ссылка на сущность в том виде, в каком она стоит после `Entity=`. */
export type EntityRef =
  | { readonly kind: 'descriptor'; readonly descriptor: EntityDescriptor }
  | { readonly kind: 'id'; readonly id: number }
  /** `GameEntity` либо BattleTag игрока — самый надёжный способ узнать игрока. */
  | { readonly kind: 'name'; readonly name: string };

/** Ищет первый дескриптор в произвольном куске текста. */
export function parseEntityDescriptor(text: string): EntityDescriptor | null {
  const m = DESCRIPTOR_RE.exec(text);
  if (m === null) return null;

  const [, entityName, id, zone, zonePos, cardId, player] = m;
  if (
    entityName === undefined ||
    id === undefined ||
    zone === undefined ||
    zonePos === undefined ||
    cardId === undefined ||
    player === undefined
  ) {
    return null;
  }

  return {
    entityName,
    id: Number(id),
    zone,
    zonePos: Number(zonePos),
    cardId,
    player: Number(player),
  };
}

/**
 * Разбирает то, что стоит после `Entity=`.
 *
 * Имя может содержать `#` и пробелы не может — BattleTag и `GameEntity` идут
 * одним токеном, поэтому имя берётся до первого пробела.
 */
export function parseEntityRef(text: string): EntityRef | null {
  const trimmed = text.trimStart();
  if (trimmed === '') return null;

  if (trimmed.startsWith('[')) {
    const descriptor = parseEntityDescriptor(trimmed);
    return descriptor === null ? null : { kind: 'descriptor', descriptor };
  }

  const token = trimmed.split(' ')[0] ?? '';
  if (token === '') return null;

  if (/^\d+$/.test(token)) {
    return { kind: 'id', id: Number(token) };
  }

  return { kind: 'name', name: token };
}

/** Достаёт ссылку из конструкции `Entity=…` внутри строки. */
export function parseEntityFrom(content: string, key = 'Entity='): EntityRef | null {
  const at = content.indexOf(key);
  if (at < 0) return null;
  return parseEntityRef(content.slice(at + key.length));
}

/** Идентификатор сущности, если он выводится из ссылки. */
export function entityIdOf(ref: EntityRef): number | null {
  switch (ref.kind) {
    case 'descriptor':
      return ref.descriptor.id;
    case 'id':
      return ref.id;
    case 'name':
      return null;
  }
}
