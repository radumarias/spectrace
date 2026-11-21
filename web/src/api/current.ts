const KEY = "spectrace-proj";

/** The project the person is working in. Kept in the browser so a reload stays in the same project. */
export function getCurrentProjectId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setCurrentProjectId(id: string) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Private mode or blocked storage: the project just is not remembered.
  }
}

export function clearCurrentProjectId() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
}
