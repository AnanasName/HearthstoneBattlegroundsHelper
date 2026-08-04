import { describe, expect, it } from 'vitest';

import {
  innermostBlockType,
  insideBlock,
  readPowerEvents,
  SOURCE_OF_TRUTH,
} from '../../src/parser/blocks.js';
import { part2Game } from '../fixtures.js';

/**
 * Кусок взят дословно из data/fixtures/part2/game.log, строки 10203-10214:
 * игрок покупает улучшение таверны до 2-го уровня. Внутри вложены TRIGGER
 * и POWER — на нём и видно, что BLOCK_END идёт с отступом открывшего блока.
 */
const TAVERN_UPGRADE = [
  'D 00:00:01.0000000 GameState.DebugPrintPower() - BLOCK_START BlockType=PLAY Entity=[entityName=Таверна 2-го уровня id=655 zone=PLAY zonePos=0 cardId=TB_BaconShopTechUp02 player=4] EffectCardId=x EffectIndex=0 Target=0 SubOption=-1',
  'D 00:00:01.0000000 GameState.DebugPrintPower() -     TAG_CHANGE Entity=AngryMem#2886 tag=RESOURCES_USED value=4',
  'D 00:00:01.0000000 GameState.DebugPrintPower() -     BLOCK_START BlockType=TRIGGER Entity=[entityName=BaconShop8PlayerEnchant id=63 zone=PLAY zonePos=0 cardId=TB_BaconShop_8P_PlayerE player=4] EffectCardId=x EffectIndex=0 Target=0 SubOption=-1',
  'D 00:00:01.0000000 GameState.DebugPrintPower() -         TAG_CHANGE Entity=AngryMem#2886 tag=4212 value=7',
  'D 00:00:01.0000000 GameState.DebugPrintPower() -     BLOCK_END',
  'D 00:00:01.0000000 GameState.DebugPrintPower() -     BLOCK_START BlockType=POWER Entity=[entityName=Таверна 2-го уровня id=655 zone=PLAY zonePos=0 cardId=TB_BaconShopTechUp02 player=4] EffectCardId=x EffectIndex=0 Target=0 SubOption=-1',
  'D 00:00:01.0000000 GameState.DebugPrintPower() -         TAG_CHANGE Entity=AngryMem#2886 tag=PLAYER_TECH_LEVEL value=2',
].join('\r\n');

describe('readPowerEvents', () => {
  it('даёт каждому событию стек блоков, в которых оно произошло', () => {
    const events = [...readPowerEvents(TAVERN_UPGRADE)];
    expect(events).toHaveLength(3);

    expect(events[0]?.line.content).toContain('RESOURCES_USED');
    expect(events[0]?.blocks.map((b) => b.blockType)).toEqual(['PLAY']);

    expect(events[1]?.line.content).toContain('tag=4212');
    expect(events[1]?.blocks.map((b) => b.blockType)).toEqual(['PLAY', 'TRIGGER']);

    expect(events[2]?.line.content).toContain('PLAYER_TECH_LEVEL');
    expect(events[2]?.blocks.map((b) => b.blockType)).toEqual(['PLAY', 'POWER']);
  });

  it('BLOCK_END закрывает ровно один уровень, внешний блок остаётся', () => {
    const events = [...readPowerEvents(TAVERN_UPGRADE)];
    // После BLOCK_END на отступе 4 событие снова оказалось внутри PLAY.
    expect(innermostBlockType(events[2]!)).toBe('POWER');
    expect(insideBlock(events[2]!, 'PLAY')).toBe(true);
  });

  it('сохраняет источник блока', () => {
    const [first] = [...readPowerEvents(TAVERN_UPGRADE)];
    expect(first?.blocks[0]?.entityId).toBe(655);
    expect(first?.blocks[0]?.blockType).toBe('PLAY');
  });

  it('сами BLOCK_START и BLOCK_END событиями не считаются', () => {
    for (const e of readPowerEvents(TAVERN_UPGRADE)) {
      expect(e.line.content.startsWith('BLOCK_')).toBe(false);
    }
  });

  it('читает только канал-источник, второй канал игнорирует', () => {
    const mixed = [
      'D 00:00:01.0000000 GameState.DebugPrintPower() - TAG_CHANGE Entity=11 tag=PLAYSTATE value=PLAYING',
      'D 00:00:01.0000000 PowerTaskList.DebugPrintPower() -     TAG_CHANGE Entity=AngryMem#2886 tag=PLAYSTATE value=PLAYING',
    ].join('\r\n');

    const events = [...readPowerEvents(mixed)];
    expect(events).toHaveLength(1);
    expect(events[0]?.line.source).toBe(SOURCE_OF_TRUTH);
    expect(events[0]?.line.content).toContain('Entity=11');
  });

  it('незакрытый блок схлопывается следующей строкой того же уровня', () => {
    // 38 блоков за партию не имеют BLOCK_END. Стек, ждущий его, копил бы глубину.
    const unclosed = [
      'D 00:00:01.0000000 GameState.DebugPrintPower() - BLOCK_START BlockType=PLAY Entity=1 EffectCardId=x EffectIndex=0 Target=0 SubOption=-1',
      'D 00:00:01.0000000 GameState.DebugPrintPower() -     TAG_CHANGE Entity=2 tag=A value=1',
      'D 00:00:01.0000000 GameState.DebugPrintPower() - BLOCK_START BlockType=TRIGGER Entity=3 EffectCardId=x EffectIndex=0 Target=0 SubOption=-1',
      'D 00:00:01.0000000 GameState.DebugPrintPower() -     TAG_CHANGE Entity=4 tag=B value=1',
    ].join('\r\n');

    const events = [...readPowerEvents(unclosed)];
    expect(events[0]?.blocks.map((b) => b.blockType)).toEqual(['PLAY']);
    expect(events[1]?.blocks.map((b) => b.blockType)).toEqual(['TRIGGER']);
  });
});

describe('инвариант на эталонной партии', () => {
  it('глубина не убегает: незакрытые блоки не копятся до конца партии', () => {
    let maxDepth = 0;
    let events = 0;
    let lastDepth = 0;

    for (const e of readPowerEvents(part2Game())) {
      events += 1;
      maxDepth = Math.max(maxDepth, e.blocks.length);
      lastDepth = e.blocks.length;
    }

    expect(events).toBeGreaterThan(100_000);
    // Если бы блоки закрывались только по BLOCK_END, к концу партии
    // накопилось бы 38 незакрытых уровней.
    expect(maxDepth).toBeLessThan(15);
    expect(lastDepth).toBeLessThan(15);
  });

  it('бои видны через блоки ATTACK', () => {
    let attackEvents = 0;
    const attackers = new Set<number>();

    for (const e of readPowerEvents(part2Game())) {
      if (!insideBlock(e, 'ATTACK')) continue;
      attackEvents += 1;
      const attacker = e.blocks.find((b) => b.blockType === 'ATTACK')?.entityId;
      if (attacker !== null && attacker !== undefined) attackers.add(attacker);
    }

    // 172 блока ATTACK за партию, у каждого есть содержимое.
    expect(attackEvents).toBeGreaterThan(0);
    expect(attackers.size).toBeGreaterThan(10);
  });

  it('покупка улучшения таверны поднимает PLAYER_TECH_LEVEL внутри блока PLAY', () => {
    const levels: number[] = [];

    for (const e of readPowerEvents(part2Game())) {
      const m = /tag=PLAYER_TECH_LEVEL value=(\d+)/.exec(e.line.content);
      if (m === null || !insideBlock(e, 'PLAY')) continue;
      const value = Number(m[1]);
      if (levels.at(-1) !== value) levels.push(value);
    }

    // Тир растёт от 1 и доходит до 5 — подтверждено в part2.expected.json.
    expect(levels.length).toBeGreaterThan(0);
    expect(Math.max(...levels)).toBe(5);
  });
});
