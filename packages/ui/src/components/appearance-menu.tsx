import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemeMode } from "../theme";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "./overlay";

const THEME_CHOICES: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: "light", label: "Light", icon: Sun },
  { mode: "dark", label: "Dark", icon: Moon },
  { mode: "system", label: "System", icon: Monitor },
];

/** Light, dark, or system. Nest this in the account menu; the trigger carries its own chevron. */
export function AppearanceMenu() {
  const { mode, setMode } = useTheme();
  const current = THEME_CHOICES.find((choice) => choice.mode === mode) ?? THEME_CHOICES[2]!;
  const CurrentIcon = current.icon;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <CurrentIcon className="text-muted-foreground" />
        <span className="flex-1">Appearance</span>
        <span className="text-xs text-muted-foreground">{current.label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {THEME_CHOICES.map((choice) => {
          const selected = choice.mode === mode;
          const Icon = choice.icon;
          return (
            <DropdownMenuItem key={choice.mode} onSelect={() => setMode(choice.mode)}>
              <Icon />
              <span className="flex-1">{choice.label}</span>
              {selected ? <Check aria-label="Current" /> : <span className="size-4" aria-hidden />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
