import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { legibleAccent, readableForeground } from "./lib/color";
import { installSubmitShortcut } from "./lib/submit-shortcut";

export type ThemeMode = "light" | "dark" | "system";

/**
 * The brand accent: one color for the whole product (Custombase let each business pick its own;
 * this template has one brand). It's nudged for contrast in dark mode.
 */
export const BRAND_ACCENT = "#4f46e5";

type ThemeContextValue = {
  mode: ThemeMode;
  resolved: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = "theme";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function storedMode(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch {
    return "system";
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() =>
    typeof window === "undefined" ? "system" : storedMode(),
  );
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  // ⌘/Ctrl+Enter runs the primary action of the focused form, dialog or side panel.
  useEffect(() => installSubmitShortcut(), []);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  const resolved = mode === "system" ? (systemDark ? "dark" : "light") : mode;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
    const surface = getComputedStyle(document.documentElement)
      .getPropertyValue("--ui-surface")
      .trim();
    const shown = legibleAccent(BRAND_ACCENT, surface);
    const root = document.documentElement.style;
    root.setProperty("--ui-accent", shown);
    root.setProperty("--ui-accent-foreground", readableForeground(shown));
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private windows can refuse storage; the choice still applies until reload.
    }
    setModeState(next);
  }, []);

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
