import { beforeAll, describe, expect, it } from 'vitest';

import { toPlayerEntity } from '../../src/advisors/battle/mapper.js';
import { readTavernTurns } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, normalizeCardText, type CardIndex } from '../../src/data/cards.js';
import { reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part50Game } from '../fixtures.js';

/**
 * part50 — Король-лич (07.09.2026), нежить на перерождении, 1-е место.
 *
 * Пункт игрока: «учитываешь ли при оценке стола нежить, которая может
 * появиться из нежити на столе? кажется, что идёт недооценка таких столов».
 *
 * Он прав, и промах оказался не в нашей шкале, а в том, чего мы не отдавали
 * СИМУЛЯТОРУ. Игра копит надбавку к атаке всей нежити на отдельной
 * сущности-энчанте, а симулятор применяет её к каждому телу, призванному
 * ВНУТРИ боя. На борде статы уже применены игрой, поэтому дефект был
 * невидим везде, кроме композиций, которые на призывах и стоят.
 *
 * Тест держит три слоя раздельно: что написала игра, что из этого читает
 * редьюсер и что уезжает в симулятор.
 */
describe('part50: надбавка к атаке нежити и счётчик вечных рыцарей', () => {
  let text: string;
  let cards: CardIndex;
  let turns: ReturnType<typeof readTavernTurns>;

  beforeAll(() => {
    text = part50Game();
    cards = loadCardIndex();
    turns = readTavernTurns(text);
  }, 300_000);

  /** Состояние на момент времени — срезом лога (метод part40, part43–part48). */
  const at = (until: string): GameState => {
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^D (\d\d:\d\d:\d\d)/.exec(line);
      if (m !== null && (m[1] ?? '') > until) break;
      lines.push(line);
    }
    return reduceLog(lines.join('\n'));
  };

  const decisionPoint = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    expect(found, `точка решения хода ${String(turn)}`).toBeDefined();
    return found!.state;
  };

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
  });

  it('герой — Король-лич с силой перерождения, итог первое место', () => {
    const last = turns[turns.length - 1]!.state;
    expect(last.hero?.heroPowerCardId).toBe('TB_BaconShop_HP_024');
    expect(last.finalPlace).toBe(1);
  });

  /**
   * ФАКТУРА. Надбавка лежит не на игроке, а на его энчанте, и именованного
   * тега у неё нет вовсе — только `TAG_SCRIPT_DATA_NUM_1`.
   */
  it('игра копит надбавку на сущности-энчанте BG25_011pe', () => {
    const ours = text
      .split(/\r?\n/)
      .filter(
        (l) =>
          l.includes('GameState.DebugPrintPower') &&
          l.includes('cardId=BG25_011pe player=8') &&
          l.includes('TAG_SCRIPT_DATA_NUM_1'),
      );
    expect(ours.length).toBeGreaterThan(30);
    expect(ours[0]).toMatch(/15:52:48/);

    const values = ours.map((l) => Number(/value=(\d+)/.exec(l)?.[1] ?? '0'));
    // Число только растёт и доходит до 284 — это накопление, а не разовый тег.
    expect(Math.max(...values)).toBe(284);
    expect(values[0]).toBeLessThan(5);

    // Кормят её две карты, и обе есть в этой партии: клич наги и заклинание,
    // которое игрок разыграл около тридцати раз.
    expect(cards.info('BG25_011')?.text ?? '').toMatch(/Your Undead have \+1 Attack this game/i);
    expect(cards.info('BG28_604')?.text ?? '').toMatch(/Your Undead have/i);
  });

  /**
   * Фильтр по контроллеру — НЕСУЩИЙ, а не косметика: такой же энчант есть
   * у соперника, и числа у них разные. Без фильтра чужой счётчик молча
   * подменял бы наш, и ошибка была бы не «нет данных», а «неверные данные».
   */
  it('у соперника свой такой же энчант, и число у него другое', () => {
    const valuesOf = (player: string): number[] =>
      text
        .split(/\r?\n/)
        .filter(
          (l) =>
            l.includes('GameState.DebugPrintPower') &&
            l.includes(`cardId=BG25_011pe player=${player}`) &&
            l.includes('TAG_SCRIPT_DATA_NUM_1'),
        )
        .map((l) => Number(/value=(\d+)/.exec(l)?.[1] ?? '0'));

    expect(Math.max(...valuesOf('8'))).toBe(284);
    expect(Math.max(...valuesOf('16'))).toBe(36);
  });

  /**
   * Число ЖИВОЕ: у каждой точки решения оно своё. Разница между последней
   * точкой (242) и концом лога (284) — не расхождение, а сорок два очка,
   * которые игрок набрал уже ВНУТРИ последнего хода, после снимка. Мерить
   * надо тем, что советник видит в момент решения.
   */
  it('редьюсер читает надбавку нежити со СВОЕГО энчанта', () => {
    // К кадру игрока (16:01, ход 23) надбавка равна 73.
    expect(at('16:01:00').globalInfo.undeadAttackBuff).toBe(73);
    expect(decisionPoint(23).globalInfo.undeadAttackBuff).toBe(73);

    // По точкам решения число только растёт.
    const series = turns
      .map((t) => t.state.globalInfo.undeadAttackBuff)
      .filter((v): v is number => v !== null);
    expect(series).toEqual([...series].sort((a, b) => a - b));
    expect(series[series.length - 1]).toBe(242);

    // На конце партии — 284, и это НАШЕ число, а не 36 соперника.
    expect(reduceLog(text).globalInfo.undeadAttackBuff).toBe(284);
  });

  it('счётчик вечных рыцарей читается тем же способом', () => {
    // На последней точке решения 16, к концу партии 20; у соперника
    // в этой же партии 81, и он к нам не приезжает.
    expect(decisionPoint(31).globalInfo.eternalKnightsDead).toBe(16);
    expect(reduceLog(text).globalInfo.eternalKnightsDead).toBe(20);
    expect(cards.info('BG25_008')?.text ?? '').toMatch(/for each friendly Eternal Knight that died/i);
  });

  /**
   * Ноль не отдаём: сущность-энчант заводится заранее и до первого
   * срабатывания стоит пустой. Записанное правило проекта — «неизвестные
   * счётчики нулями подставлять нельзя»: выдуманный ноль хуже отсутствия.
   */
  it('до первого срабатывания надбавки нет вовсе, а не ноль', () => {
    expect(decisionPoint(1).globalInfo.undeadAttackBuff).toBeNull();
    expect(decisionPoint(1).globalInfo.eternalKnightsDead).toBeNull();
  });

  it('оба счётчика уезжают в симулятор своими именами', () => {
    const state = at('16:01:00');
    expect(state.hero).not.toBeNull();
    const player = toPlayerEntity(state.hero!, state.techLevel, state.globalInfo);
    const global = player.globalInfo as Record<string, number>;
    // Имена — те, которых ждёт пакет: `add-minion-to-board.js` применяет
    // первое к каждому призванному телу, второе — к статам призванного рыцаря.
    expect(global['UndeadAttackBonus']).toBe(73);
    expect(global['EternalKnightsDeadThisGame']).toBeGreaterThan(0);
    // Прежние поля не потерялись.
    expect(global['GoldSpentThisGame']).toBeGreaterThan(0);
  });

  /**
   * Кадр игрока пришёл на ходу 23 и воспроизводится точкой решения ДОСЛОВНО —
   * редкий случай: прежние партии присылались кадрами из середины хода,
   * и состояние приходилось восстанавливать срезом.
   */
  it('кадр хода 23 воспроизводится точкой решения', () => {
    const s = decisionPoint(23);
    expect(s.techLevel).toBe(6);
    expect(s.gold).toBe(10);
    expect(s.board).toHaveLength(7);
    const last = s.board[6]!;
    expect(cards.info(last.cardId)?.name).toBe('Drustfallen Butcher');
    expect(last.attack).toBe(400);
    expect(last.health).toBe(337);
    // Именно эта композиция и недооценивалась: на борде три носителя
    // хрип-призыва, и все три призывают тела ВНУТРИ боя.
    const summoners = s.board.filter((m) =>
      ['BG30_125', 'BG25_010', 'BG25_009'].includes(m.cardId.replace(/_G$/, '')),
    );
    expect(summoners.length).toBeGreaterThan(0);
  });
});

/**
 * Третья находка part50, и она из СТАРОГО класса: в снапшоте к тексту части
 * заклинаний приклеен золотой вариант (part17). Резался он по маркеру
 * «цифры + `[x]`», а у трёх карт набора маркера нет вовсе — цифра стоит
 * сразу после точки. Butchering был среди них, и числа обеих версий
 * складывались: советник обещал «+12 статов» там, где карта даёт +6.
 */
describe('part50: склейка золотого варианта голой цифрой', () => {
  const cards = loadCardIndex();

  it('у Butchering остаётся только обычная версия', () => {
    const text = cards.info('BG28_604')?.text ?? '';
    expect(text).toMatch(/Destroy a friendly Undead/);
    expect(text).toMatch(/\+\{0\} Attack this game/);
    // Золотая половина («+{0}/+{1}») отрезана — иначе числа складываются.
    expect(text).not.toMatch(/\+\{0\}\/\+\{1\}/);
    // И самой склейки в тексте больше нет.
    expect(text).not.toMatch(/\.<\/i>\d/);
  });

  it('срез ловит и две другие карты того же класса, и только их', () => {
    // У обеих «Bounty» базовая половина односторонняя («+{1} Health»
    // и «+{0} Attack»), а золотая — парная («+{0}/+{1}»). Режется вторая.
    for (const id of ['BG33_811', 'BG33_812']) {
      const text = cards.info(id)?.text ?? '';
      expect(text, id).not.toMatch(/\.\d+[A-Z]/);
      expect(text, id).not.toMatch(/\+\{0\}\/\+\{1\}/);
      expect(text.match(/friendly minions/g) ?? [], id).toHaveLength(1);
    }
    // Прежний маркер «цифры + [x]» продолжает работать: Fortify (part17).
    const fortify = cards.info('BG28_602')?.text ?? cards.info('BG24_500')?.text ?? '';
    if (fortify !== '') expect(fortify).not.toMatch(/\d\[x\]/);
  });

  /**
   * Срез обязан быть узким: свободный поиск цифры после точки резал бы прозу
   * в середине. Проверка на самой уязвимой форме — числа внутри предложения.
   */
  it('срез не трогает числа внутри предложения', () => {
    expect(normalizeCardText('Deal 3 damage. Then deal 2 more.')).toBe(
      'Deal 3 damage. Then deal 2 more.',
    );
    expect(normalizeCardText('Give +1/+1. 2 times.')).toBe('Give +1/+1. 2 times.');
    // А вот склейка без пробела режется.
    expect(normalizeCardText('Give +1 Attack.4Give four minions +1 Attack.')).toBe(
      'Give +1 Attack.',
    );
  });
});

/**
 * Вторая половина пары и вторая сторона боя — проверяются НЕ на part50.
 *
 * Так вышло не случайно: у надбавки нежити две половины, и живут они
 * в разных партиях. В part50 приходит только атака (до 284), тега здоровья
 * нет ни разу; в part32 приходят обе — 527 и 208. Проверять надо обе,
 * иначе «в этой партии тега нет» легко принять за «тега не бывает».
 */
describe('part50: вторая половина надбавки и симметрия сторон', () => {
  it('в part32 читается и надбавка к ЗДОРОВЬЮ нежити', async () => {
    const { part32Game } = await import('../fixtures.js');
    const state = reduceLog(part32Game());
    expect(state.globalInfo.undeadAttackBuff).toBe(527);
    expect(state.globalInfo.undeadHealthBuff).toBe(208);
  }, 300_000);

  /**
   * Асимметрия была бы ХУЖЕ прежней слепоты: до правки мы не видели надбавку
   * ни у себя, ни у соперника, и ошибка была симметричной. Отдав только своё,
   * мы стали бы систематически завышать свои шансы против нежити — а чужая
   * надбавка в корпусе встречается чаще своей.
   */
  it('счётчики соперника читаются отдельно и не смешиваются со своими', async () => {
    const { readBattleEpisodes } = await import('../../src/advisors/battle/episodes.js');
    const episodes = readBattleEpisodes(part50Game());

    // Слот соперника ОБЩИЙ на всех семерых, но сущность энчанта у каждого
    // боя своя, и читается именно она. Проверка на этом и стоит: у соперника
    // 7 надбавка держится на 2, а у соперника 6 растёт 18 → 32. Совпади
    // числа, тест не отличил бы верную сторону от перепутанной.
    const byTurn = new Map(episodes.map((e) => [e.turn, e]));
    const opp = (turn: number) => byTurn.get(turn)?.opponentGlobalInfo;
    const own = (turn: number) => byTurn.get(turn)?.globalInfo;

    expect(opp(24)?.undeadAttackBuff).toBe(18);
    expect(opp(30)?.undeadAttackBuff).toBe(32);
    expect(opp(28)?.undeadAttackBuff).toBe(2);
    expect(opp(32)?.undeadAttackBuff).toBe(2);
    // И это НЕ наши числа тех же ходов.
    expect(own(24)?.undeadAttackBuff).toBe(121);
    expect(own(30)?.undeadAttackBuff).toBe(242);

    // У соперника без нежити счётчика нет вовсе — не ноль.
    expect(opp(26)?.undeadAttackBuff).toBeNull();
  }, 300_000);
});

/**
 * Активация, которая УНИЧТОЖАЕТ указанного миньона.
 *
 * «Мертвый звонарь» `BG36_511`: «Give a different friendly Undead Reborn.
 * Then destroy it to gain +{1}/+{2}». Общее правило «цель баффа —
 * крупнейший свой» давало здесь совет, который при буквальном исполнении
 * убивает главную карту борда: план хода 31 предлагал указать
 * на Drustfallen Butcher 2636/2401.
 */
describe('part50: активация, уничтожающая цель', () => {
  const cards = loadCardIndex();

  it('карта говорит прямо: цель получает перерождение и уничтожается', () => {
    const text = cards.info('BG36_511')?.text ?? '';
    expect(text).toMatch(/Give a different friendly Undead/i);
    expect(text).toMatch(/Then destroy it to gain/i);
  });

  /**
   * ФАКТУРА из лога, а не вывод из текста: цель уходит в GRAVEYARD
   * и возвращается БАЗОВОЙ копией, а прибавку получает сам звонарь.
   */
  it('в логе цель уничтожается, а статы получает активирующий', () => {
    const window = part50Game()
      .split(/\r?\n/)
      .filter((l) => l.includes('16:01:58') && l.includes('GameState.DebugPrintPower'));

    // Цели дали перерождение и тут же отправили в кладбище.
    expect(window.some((l) => l.includes('id=14129') && l.includes('tag=REBORN value=1'))).toBe(true);
    expect(window.some((l) => l.includes('id=14129') && l.includes('tag=ZONE value=GRAVEYARD'))).toBe(
      true,
    );
    // А прибавка +8/+8 ушла звонарю: 111/44 → 119/52.
    expect(window.some((l) => l.includes('id=14119') && l.includes('tag=ATK value=119'))).toBe(true);
    expect(window.some((l) => l.includes('id=14119') && l.includes('tag=HEALTH value=52'))).toBe(true);
  });

  /**
   * Куда целился ИГРОК — одиннадцать нажатий, и ни одного в крупное тело.
   * Это и есть довод за «наименьший», а не рассуждение о правильной игре.
   */
  it('игрок целился в мелкое тело, а не в крупнейшее', () => {
    const targets = part50Game()
      .split(/\r?\n/)
      .filter(
        (l) =>
          l.includes('GameState.DebugPrintPower') &&
          l.includes('BLOCK_START BlockType=PLAY') &&
          /cardId=BG36_511(_G)? /.test(l) &&
          l.includes('zone=PLAY') &&
          l.includes('Target=[entityName='),
      )
      .map((l) => /Target=\[entityName=([^ ]+)/.exec(l)?.[1] ?? '');

    expect(targets.length).toBeGreaterThan(8);
    // Мумификатор — мелкое тело с хрипом, и он же самая частая цель.
    expect(targets.filter((t) => t.includes('Мумификатор')).length).toBeGreaterThan(5);
    // В главную карту борда игрок не целился ни разу.
    expect(targets.some((t) => t.includes('Друстфал'))).toBe(false);
  });
});
