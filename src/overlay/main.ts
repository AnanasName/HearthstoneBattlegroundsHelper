import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, screen } from 'electron';

import { loadCardIndex } from '../data/cards.js';
import { LiveAdvisor } from '../live/advisor.js';
import { PositionWorker } from '../live/position/client.js';
import { LiveWatcher, type LiveNotice } from '../live/watcher.js';
import type { GameState } from '../state/types.js';
import { DEFAULT_LOGS_ROOT } from '../watcher/logPaths.js';
import { ensureLogSizeLimit, inspectClientConfig } from '../watcher/clientConfig.js';
import { buildView, EMPTY_VIEW, type OverlayView, type ViewInput } from './view.js';

/**
 * Оверлей поверх игры.
 *
 *   npm run overlay
 *
 * Здесь только окно и передача готового вида в разметку: что показывать,
 * решает `view.ts`, а когда считать — `live/advisor.ts`. Оба проверены
 * тестами, окно проверить нечем.
 *
 * ## Свойства окна и почему именно такие
 *
 * - **прозрачное и без рамки** — поверх игры не должно быть ничего лишнего;
 * - **сквозное для мыши** (`setIgnoreMouseEvents`) — иначе оверлей крал бы
 *   клики, а в Battlegrounds кликают по всему экрану;
 * - **не в панели задач и не забирает фокус** — переключение фокуса
 *   в полноэкранной игре сворачивает её.
 *
 * Оговорка, которую не обойти: поверх ИСКЛЮЧИТЕЛЬНОГО полноэкранного режима
 * Windows не показывает ничего. Игру надо ставить в оконный без рамки —
 * это стандартное требование ко всем оверлеям, а не наше ограничение.
 */

const WIDTH = 460;
const HEIGHT = 300;
const MARGIN = 24;

let window: BrowserWindow | null = null;
let position: PositionWorker | null = null;
let watcher: LiveWatcher | null = null;

function send(view: OverlayView): void {
  window?.webContents.send('overlay:view', view);
}

function createWindow(): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea;

  const created = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: area.x + area.width - WIDTH - MARGIN,
    y: area.y + MARGIN,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: fileURLToPath(new URL('preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Поверх полноэкранных окон, а не только поверх обычных.
  created.setAlwaysOnTop(true, 'screen-saver');
  created.setVisibleOnAllWorkspaces(true);
  // forward: события мыши всё равно доходят до игры, а окно их не перехватывает.
  created.setIgnoreMouseEvents(true, { forward: true });

  // Разметка берётся из исходников, а не из сборки: копировать её незачем,
  // а рабочий каталог у проекта и так один — оттуда же читается снапшот карт.
  void created.loadFile('src/overlay/index.html');
  return created;
}

function describeNotice(notice: LiveNotice): OverlayView | null {
  switch (notice.kind) {
    case 'noLog':
      return { ...EMPTY_VIEW, header: 'логов нет: включите log.config и перезапустите игру' };
    case 'watching':
      return { ...EMPTY_VIEW, header: 'жду партию' };
    case 'switched':
      return { ...EMPTY_VIEW, header: 'клиент перезапущен, слежу за новым логом' };
    case 'restarted':
      return { ...EMPTY_VIEW, header: 'лог обрезан, собираю состояние заново' };
    case 'newGame':
      return { ...EMPTY_VIEW, header: 'новая партия' };
    case 'caughtUp':
      return null;
  }
}

function start(): void {
  const cards = loadCardIndex();
  const worker = new PositionWorker();
  position = worker;

  // Предел размера логов проверяется при каждом запуске: файл лежит в каталоге
  // игры, и обновление Hearthstone его сносит.
  const installDir = DEFAULT_LOGS_ROOT.replace(/[\\/]Logs$/, '');
  if (!inspectClientConfig(installDir).sufficient) ensureLogSizeLimit(installDir);

  let latest: GameState | null = null;
  let tavern: ViewInput['tavern'] = null;
  let thinking = false;
  let last: ViewInput['position'] = null;

  const show = (): void => {
    if (latest === null) return;
    send(buildView({ state: latest, tavern, thinking, position: last }, cards));
  };

  const advisor = new LiveAdvisor(
    { cards, position: worker },
    {
      onTavern: (advice, state) => {
        latest = state;
        tavern = advice;
        // Новое положение — прошлый совет по расстановке к нему не относится.
        last = null;
        thinking = false;
        show();
      },
      onThinking: () => {
        thinking = true;
        show();
      },
      onPosition: (advice, opponent) => {
        thinking = false;
        last = advice === null ? { kind: 'dropped' } : { kind: 'advice', advice, opponent };
        show();
      },
      onNoOpponent: (opponent) => {
        thinking = false;
        last = { kind: 'noOpponent', opponent };
        show();
      },
      onError: (error) => {
        console.error(`советник расстановки: ${error.message}`);
      },
    },
  );

  watcher = new LiveWatcher({
    onUpdate: ({ state, catchingUp }) => {
      if (!catchingUp) advisor.update(state);
    },
    onNotice: (notice) => {
      const view = describeNotice(notice);
      if (view !== null) send(view);
    },
  });
  watcher.start();
}

void app.whenReady().then(() => {
  window = createWindow();
  start();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  watcher?.stop();
  void position?.close();
});
