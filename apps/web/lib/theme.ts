/**
 * Theme persistence, shared by the toggle (client) and the layout (server).
 * A plain module, because a constant exported from a `'use client'` file
 * reaches a server component as a client reference, not as its value.
 */

export const THEME_STORAGE_KEY = 'scaffoldbench-theme';

/**
 * Applied in <head> before first paint, so a stored choice never flashes the
 * other theme. A string, because it runs before React does.
 */
export const THEME_BOOTSTRAP = `try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
