// Shared mutable module refs and render-window state for the ui-chat
// submodule split. Historical import sites keep importing from ui-chat.js,
// which is a pure re-export facade now.
export let apiMod = null;
import('../api.js').then(m => apiMod = m);
export let uiWinMod = null;
import('./ui-window.js').then(m => uiWinMod = m);
export let uiWdgMod = null;
import('./ui-widgets.js').then(m => uiWdgMod = m);
export let uiSetMod = null;
import('./ui-settings.js').then(m => uiSetMod = m);
export let featCharUiMod = null;
import('../features/feature-character-ui.js').then(m => featCharUiMod = m);

// sessionId -> первый отрисованный индекс (окно ленивого рендера);
// пишется в renderSession, читается в performSearch.
export const _renderFromBySession = new Map();
