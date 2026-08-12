import { readFileSync } from 'node:fs';

import { readPowerEvents } from './src/parser/blocks.js';
import { readPlayers } from './src/state/players.js';
import { createReducer } from './src/state/reducer.js';

for (const [name, path] of [
  ['part2', 'data/fixtures/part2/game.log'],
  ['part3', 'data/fixtures/part3/game.log'],
] as const) {
  const text = readFileSync(path, 'utf8');
  const reducer = createReducer(readPlayers(text));

  let phase = '';
  let hpBefore: number | null = null;
  let armorBefore = 0;
  let boardBefore = 0;
  let oppBefore = 0;

  console.log(`\n═══ ${name} ═══`);
  console.log(
    '  ход  мой борд  борд врага   hp до    hp после   вывод      wonLastCombat',
  );

  for (const ev of readPowerEvents(text)) {
    reducer.step(ev);
    const c = ev.line.content;
    // Снимок дорогой, берём только на переключении фазы и рядом с ним.
    if (!c.includes('BOARD_VISUAL_STATE')) continue;

    const s = reducer.snapshot();

    if (s.phase === 'combat' && phase !== 'combat') {
      hpBefore = (s.hero?.health ?? 0) - (s.hero?.damage ?? 0) + (s.hero?.armor ?? 0);
      armorBefore = s.hero?.armor ?? 0;
      boardBefore = s.board.length;
      oppBefore = 0;
    }

    if (s.phase === 'tavern' && phase === 'combat') {
      const hpAfter = (s.hero?.health ?? 0) - (s.hero?.damage ?? 0) + (s.hero?.armor ?? 0);
      const lost = hpBefore !== null && hpAfter < hpBefore;
      console.log(
        `  ${String(s.turn).padStart(3)}` +
          `  ${String(boardBefore).padStart(8)}` +
          `  ${String(oppBefore).padStart(10)}` +
          `  ${String(hpBefore ?? '—').padStart(6)}` +
          `  ${String(hpAfter).padStart(9)}` +
          `   ${(lost ? 'поражение' : 'не проиграл').padEnd(11)}` +
          `  ${String(s.wonLastCombat)}`,
      );
      void armorBefore;
    }

    phase = s.phase;
  }
}
