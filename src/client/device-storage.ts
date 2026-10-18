// localStorage that never throws: in private mode or with storage blocked, the app still works,
// it just keeps nothing on the device.

export function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or full storage: the app still works, it just will not open offline.
  }
}

export function hasItem(key: string | null): boolean {
  try {
    return key !== null && window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

export function removeItem(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage blocked: nothing was kept anyway.
  }
}

export function removeKeys(drop: (key: string) => boolean) {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (drop(key)) window.localStorage.removeItem(key);
    }
  } catch {
    // Storage blocked: nothing was kept anyway.
  }
}
