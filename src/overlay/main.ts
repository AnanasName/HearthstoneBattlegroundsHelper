import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, globalShortcut, screen } from 'electron';

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

/**
 * Последний показанный вид.
 *
 * Разметка грузится дольше, чем поднимается живой цикл, а сообщения,
 * отправленные до её готовности, пропадают молча. Поэтому вид хранится
 * и отправляется заново, когда окно готово: иначе оверлей до первой перемены
 * в игре показывал бы «жду партию» посреди уже идущей партии.
 */
let lastView: OverlayView = EMPTY_VIEW;

function send(view: OverlayView): void {
  lastView = view;
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

  // Путь абсолютный, и это не придирка: относительный `loadFile` считается
  // не от рабочего каталога, а от каталога точки входа (`app.getAppPath()`,
  // то есть dist/overlay), и разметка искалась в dist/overlay/src/overlay.
  // Поэтому она кладётся в сборку рядом с main.js — см. npm run build.
  created.webContents.on('did-finish-load', () => {
    created.webContents.send('overlay:view', lastView);
  });

  void created.loadFile(fileURLToPath(new URL('index.html', import.meta.url)));
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

/**
 * Проверка предела размера логов при каждом запуске.
 *
 * Файл лежит в каталоге игры, и обновление Hearthstone его сносит. Запись туда
 * требует прав на Program Files, поэтому отказ ожидаем и падением приложения
 * быть не должен: без починки помощник работает, просто лог оборвётся
 * на десяти мегабайтах.
 */
function checkLogLimit(): string | null {
  const installDir = DEFAULT_LOGS_ROOT.replace(/[\\/]Logs$/, '');
  try {
    if (inspectClientConfig(installDir).sufficient) return null;
    return ensureLogSizeLimit(installDir)
      ? 'предел размера логов поправлен — перезапустите Hearthstone'
      : 'предел размера логов мал, поправить не вышло';
  } catch {
    return 'не хватило прав поправить client.config — запустите от администратора';
  }
}

function start(): void {
  const cards = loadCardIndex();
  const worker = new PositionWorker();
  position = worker;

  const warning = checkLogLimit();
  if (warning !== null) send({ ...EMPTY_VIEW, header: warning });

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
        // В окно, а не в консоль: у GUI-сборки Electron на Windows стандартный
        // вывод к терминалу не подключён вовсе, и console.error никто
        // не увидит — ошибка выглядела бы как молчание советника.
        thinking = false;
        send({ ...lastView, header: `сбой советника: ${error.message}` });
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

/**
 * Как закрыть оверлей.
 *
 * Окно намеренно без рамки, без кнопок и не принимает фокус — закрыть его
 * мышью нельзя по построению. Терминал не всегда под рукой: помощник
 * запускают и ярлыком. Поэтому горячая клавиша, общесистемная — окно
 * ведь фокуса не получает.
 */
const QUIT_SHORTCUT = 'Control+Shift+Q';

void app.whenReady().then(() => {
  window = createWindow();
  globalShortcut.register(QUIT_SHORTCUT, () => {
    app.quit();
  });
  start();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  watcher?.stop();
  void position?.close();
});
