import { describe, expect, it } from 'vitest';

import {
  entityIdOf,
  parseEntityDescriptor,
  parseEntityFrom,
  parseEntityRef,
} from '../../src/parser/entity.js';
import { parseLogLine, splitLogLines } from '../../src/parser/logLine.js';
import { part2Game } from '../fixtures.js';

/** Все строки взяты дословно из data/fixtures/part2/game.log. */
describe('parseEntityDescriptor', () => {
  it('обычный дескриптор', () => {
    expect(
      parseEntityDescriptor(
        '[entityName=Выживший красный дракон id=408 zone=PLAY zonePos=1 cardId=BG35_814 player=11]',
      ),
    ).toEqual({
      entityName: 'Выживший красный дракон',
      id: 408,
      zone: 'PLAY',
      zonePos: 1,
      cardId: 'BG35_814',
      player: 11,
    });
  });

  it('имя с пробелами не ломает разбор', () => {
    const d = parseEntityDescriptor(
      '[entityName=Воришка Бигглсуорт id=94 zone=PLAY zonePos=0 cardId=TB_BaconShop_HERO_70_SKIN_H player=4]',
    );
    expect(d?.entityName).toBe('Воришка Бигглсуорт');
    expect(d?.id).toBe(94);
  });

  it('ВЛОЖЕННЫЕ СКОБКИ в имени: разбор идёт по полям, а не до первой "]"', () => {
    // 11 525 таких строк в эталонной партии. Обрезка по первой "]" отдала бы
    // "UNKNOWN ENTITY [cardType=INVALID]" и потеряла id, zone, cardId, player.
    const d = parseEntityDescriptor(
      '[entityName=UNKNOWN ENTITY [cardType=INVALID] id=255 zone=SETASIDE zonePos=0 cardId= player=4]',
    );
    expect(d).toEqual({
      entityName: 'UNKNOWN ENTITY [cardType=INVALID]',
      id: 255,
      zone: 'SETASIDE',
      zonePos: 0,
      cardId: '',
      player: 4,
    });
  });

  it('пустой cardId — скрытая карта', () => {
    const d = parseEntityDescriptor(
      '[entityName=UNKNOWN ENTITY [cardType=INVALID] id=255 zone=SETASIDE zonePos=0 cardId= player=4]',
    );
    expect(d?.cardId).toBe('');
  });

  it('пустой entityName', () => {
    const d = parseEntityDescriptor(
      '[entityName= id=479 zone=PLAY zonePos=0 cardId=TB_BaconShopBadsongE player=4]',
    );
    expect(d?.entityName).toBe('');
    expect(d?.cardId).toBe('TB_BaconShopBadsongE');
  });

  it('null, если дескриптора нет', () => {
    expect(parseEntityDescriptor('TAG_CHANGE Entity=GameEntity tag=STEP value=MAIN_READY')).toBeNull();
    expect(parseEntityDescriptor('')).toBeNull();
  });
});

describe('parseEntityRef', () => {
  it('различает три вида ссылок', () => {
    const byName = parseEntityRef('GameEntity tag=STEP value=MAIN_READY');
    expect(byName).toEqual({ kind: 'name', name: 'GameEntity' });

    const byId = parseEntityRef('1 tag=STATE value=RUNNING');
    expect(byId).toEqual({ kind: 'id', id: 1 });

    const byDesc = parseEntityRef(
      '[entityName=Бармен Боб id=64 zone=PLAY zonePos=0 cardId=TB_BaconShopBob player=4] tag=X value=1',
    );
    expect(byDesc?.kind).toBe('descriptor');
  });

  it('BattleTag игрока — самый надёжный якорь для "кто я"', () => {
    expect(parseEntityRef('AngryMem#2886 tag=PLAYSTATE value=LOST ')).toEqual({
      kind: 'name',
      name: 'AngryMem#2886',
    });
  });
});

describe('parseEntityFrom', () => {
  it('достаёт ссылку из середины строки', () => {
    const ref = parseEntityFrom(
      'TAG_CHANGE Entity=[entityName=Благой Фаэлин id=104 zone=HAND zonePos=4 cardId=BG22_HERO_201_SKIN_D player=6] tag=ARMOR value=14',
    );
    expect(ref?.kind).toBe('descriptor');
    expect(entityIdOf(ref!)).toBe(104);
  });

  it('работает с другим ключом — BLOCK_START использует тот же формат', () => {
    const ref = parseEntityFrom(
      'SHOW_ENTITY - Updating Entity=[entityName=UNKNOWN ENTITY [cardType=INVALID] id=255 zone=SETASIDE zonePos=0 cardId= player=4] CardID=TB_BaconShop_HP_038e',
    );
    expect(entityIdOf(ref!)).toBe(255);
  });

  it('у ссылки по имени идентификатора нет', () => {
    expect(entityIdOf(parseEntityFrom('TAG_CHANGE Entity=GameEntity tag=TURN value=1')!)).toBeNull();
  });
});

describe('инвариант на эталонной партии', () => {
  it('каждый дескриптор в 300 тысячах строк разбирается без потерь', () => {
    let descriptors = 0;
    let failed = 0;
    const examples: string[] = [];

    for (const raw of splitLogLines(part2Game())) {
      const line = parseLogLine(raw);
      if (line === null) continue;

      let from = 0;
      for (;;) {
        const at = line.content.indexOf('[entityName=', from);
        if (at < 0) break;
        descriptors += 1;

        const parsed = parseEntityDescriptor(line.content.slice(at));
        if (parsed === null) {
          failed += 1;
          if (examples.length < 3) examples.push(line.content.slice(at, at + 160));
        }
        from = at + 1;
      }
    }

    expect(examples).toEqual([]);
    expect(failed).toBe(0);
    expect(descriptors).toBeGreaterThan(100_000);
  });

  it('находит своего героя и его финальное место, не спутав со служебным двойником', () => {
    // Проверенная человеком точка: Воришка Бигглсуорт, 5-е место.
    // У настоящего героя id=94 (2812 упоминаний), у служебной копии id=16441 (20).
    const counts = new Map<number, number>();

    for (const raw of splitLogLines(part2Game())) {
      const line = parseLogLine(raw);
      if (line === null) continue;
      const at = line.content.indexOf('[entityName=');
      if (at < 0) continue;

      const d = parseEntityDescriptor(line.content.slice(at));
      if (d === null || d.cardId !== 'TB_BaconShop_HERO_70_SKIN_H') continue;
      counts.set(d.id, (counts.get(d.id) ?? 0) + 1);
    }

    const byUsage = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    expect(byUsage.length).toBe(2);
    expect(byUsage[0]?.[0]).toBe(94);
    expect(byUsage[1]?.[0]).toBe(16441);
    // Разрыв на два порядка — на нём и держится правило «свой тот, кто жил всю партию».
    expect(byUsage[0]?.[1]).toBeGreaterThan((byUsage[1]?.[1] ?? 0) * 10);
  });
});
