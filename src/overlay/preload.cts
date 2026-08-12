import electron = require('electron');

/**
 * Мост между главным процессом и разметкой.
 *
 * Разметке дан ровно один канал и ровно в одну сторону: показывать готовый
 * вид. Ни доступа к файлам, ни к Node — оверлей ничего не решает и решать
 * не должен.
 *
 * Файл на CommonJS (`.cts`) намеренно: preload грузится раньше всего
 * остального и модульной системы проекта не разделяет. Отсюда и форма
 * импорта — под `verbatimModuleSyntax` в CommonJS-файле пишут `import =`.
 */
electron.contextBridge.exposeInMainWorld('overlay', {
  onView: (handler: (view: unknown) => void): void => {
    electron.ipcRenderer.on('overlay:view', (_event: unknown, view: unknown) => {
      handler(view);
    });
  },
});
