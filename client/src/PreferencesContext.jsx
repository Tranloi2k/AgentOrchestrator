import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { translate } from "./i18n.js";

const PreferencesContext = createContext(null);

function readStorage(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

export function PreferencesProvider({ children }) {
  const [locale, setLocale] = useState(() => readStorage("locale", "vi"));
  const [theme, setTheme] = useState(() => readStorage("theme", "light"));

  useEffect(() => {
    document.documentElement.setAttribute("lang", locale);
    try {
      localStorage.setItem("locale", locale);
    } catch {
      /* ignore */
    }
  }, [locale]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      theme,
      setTheme,
      t: (key, vars) => translate(locale, key, vars),
    }),
    [locale, theme]
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error("usePreferences must be used within PreferencesProvider");
  return ctx;
}
