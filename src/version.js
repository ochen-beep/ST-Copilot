// Extension-wide mutable identity/runtime refs. These live OUTSIDE index.js on
// purpose: util-debug, lorebook engine and other low-level modules need them,
// and a static import from index.js made index.js the root of every import
// cycle in the graph — under vite SSR those cycles materialized facade
// re-exports as undefined. Live `export let` bindings keep the value current
// for all importers after init assigns it.

export let extVersion = '?';
export let __extPath = 'third-party/ST-Copilot';

// ST runtime modules, filled by index.js init after dynamic import.
export let ST_WorldInfo = null;
export let ST_Utils = null;

export function _setExtPath(p) { __extPath = p; }
export function _setExtVersion(v) { extVersion = v; }
export function _setSTModules(worldInfo, utils) { ST_WorldInfo = worldInfo; ST_Utils = utils; }
