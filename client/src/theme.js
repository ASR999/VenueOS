// Theme is an attribute on <html>, which is what the `dark:` variant keys off.
// Stored choice wins over the OS preference; with no stored choice we follow
// the OS, which is what people expect the first time they open a site.
const KEY = 'venueos-theme';

export function resolveTheme() {
  const stored = localStorage.getItem(KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyStoredTheme() {
  document.documentElement.dataset.theme = resolveTheme();
}

export function setTheme(theme) {
  localStorage.setItem(KEY, theme);
  document.documentElement.dataset.theme = theme;
  return theme;
}
