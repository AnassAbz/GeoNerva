/**
 * MapLibre GL JS v6 requires WebGL2 (ADR-014). The map is progressive enhancement: when this
 * returns false the page shows a note and the Nearby list carries everything the map would.
 */
export function hasWebGL2(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2');
    return context !== null && typeof context === 'object';
  } catch {
    return false;
  }
}
