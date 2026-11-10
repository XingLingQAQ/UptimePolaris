export function readLocalPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocalPreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

let themeSelected = false;

export function selectTheme(theme: string, setTheme: (theme: string) => void): void {
  themeSelected = true;
  setTheme(theme);
}

export function applyDefaultTheme(theme: string, setTheme: (theme: string) => void): void {
  if (themeSelected) return;
  let storage: Storage;
  try {
    storage = window.localStorage;
    if (storage.getItem('theme')) return;
  } catch {
    setTheme(theme);
    return;
  }
  setTheme(theme);
  try {
    if (storage.getItem('theme') === theme) storage.removeItem('theme');
  } catch {}
}
