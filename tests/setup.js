// Глобальные моки для SillyTavern-окружения.
// Имитируем только то, что нужно для загрузки модулей расширения
// (чистые функции не должны тянуть ST-зависимости в тестах).

const noop = () => {};
const ctxStub = {
  eventSource: { on: noop, off: noop, emit: noop },
  event_types: {},
  getRequestHeaders: () => ({ 'X-ST-Test': '1' }),
  substituteParams: (t) => t,
  saveMetadata: noop,
  saveSettingsDebounced: noop,
  chatMetadata: {},
  chat: [],
  characters: [],
  characterId: 0,
  name1: 'User',
  name2: 'Character',
  extensionSettings: {},
  getContext: () => ctxStub,
};

globalThis.SillyTavern = {
  getContext: () => ctxStub,
  ...ctxStub,
};

globalThis.window = globalThis.window || {};
globalThis.window.eventSource = ctxStub.eventSource;
globalThis.window.event_types = ctxStub.event_types;
globalThis.window.selected_world_info = [];
globalThis.window.world_info = { charLore: [] };
globalThis.window.world_names = [];

// toastr используется расширением для UI-уведомлений.
globalThis.toastr = {
  success: noop,
  warning: noop,
  error: noop,
  info: noop,
};

// performance.now нужен для некоторых утилит.
if (!globalThis.performance) {
  globalThis.performance = { now: () => Date.now() };
}

// DocumentFragment / Range — если кому-то нужен DOM.
// jsdom даёт document по умолчанию.