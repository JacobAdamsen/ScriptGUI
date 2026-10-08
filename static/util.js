// Small helpers shared by the editor and the app.

export const GRID = 10;   // canvas grid in px; nodes snap to it

export const snap = (v) => Math.round(v / GRID) * GRID;

/** "C:\a\b\script.py" or "a/b/script.py" -> "script.py" */
export const basename = (p) => p.split(/[\\/]/).pop();
