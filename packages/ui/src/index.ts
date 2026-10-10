export const UI_VERSION = "1.0.0";
/** The brand accent. Change it here (and in `styles.css`); there is one, not one per tenant. */
export { BRAND_ACCENT } from "./theme";

export { cn } from "./lib/cn";
export { contrastRatio, legibleAccent, parseHex, readableForeground } from "./lib/color";
export { ThemeProvider, useTheme, type ThemeMode } from "./theme";
export {
  installSubmitShortcut,
  isApplePlatform,
  isSubmitShortcut,
  resolveSubmitAction,
  submitShortcutLabel,
  SUBMIT_SCOPE_ATTR,
} from "./lib/submit-shortcut";
export { AppearanceMenu } from "./components/appearance-menu";
export { Button, buttonVariants, type ButtonProps } from "./components/button";
export { Spinner } from "./components/spinner";
export {
  Input,
  PasswordInput,
  Textarea,
  Label,
  Field,
  Checkbox,
  Switch,
  inlineFieldClass,
} from "./components/form";
export { Select, type SelectOption } from "./components/select";
export {
  Combobox,
  filterComboboxOptions,
  type ComboboxOption,
  type ComboboxProps,
} from "./components/combobox";
export { ImageLightbox, LightboxImage } from "./components/lightbox";
export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogFooter,
  SheetContent,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverClose,
  Tooltip,
  InfoTip,
} from "./components/overlay";
export {
  Badge,
  badgeVariants,
  ColorLabel,
  LABEL_COLOR_CLASSES,
  LABEL_SWATCH_CLASSES,
  Avatar,
  AvatarStack,
  Card,
  CardHeader,
  CardBody,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Alert,
  Kbd,
  Skeleton,
  Separator,
} from "./components/display";
export {
  PageHeader,
  AppShell,
  useAppShellControls,
  useSidebarRail,
  SidebarAction,
  EmptyState,
  ErrorState,
  LoadingState,
  PermissionState,
  FilterBar,
  ActivityItem,
  formatRelative,
  type NavItemDef,
  type AppShellSearch,
} from "./components/patterns";
export {
  CommandPalette,
  filterCommandItems,
  commandModifier,
  inCommandScope,
  searchAllHref,
  SEARCH_ALL_PARAM,
  type CommandItem,
  type CommandScopes,
} from "./components/command";
export {
  MultiSelect,
  multiSelectSummary,
  toggleMultiSelect,
  type MultiSelectOption,
  type MultiSelectProps,
} from "./components/multi-select";
export {
  SidePanel,
  SidePanelResizeHandle,
  SIDE_PANEL_MIN_WIDTH,
  SIDE_PANEL_MAX_WIDTH,
  SIDE_PANEL_DEFAULT_WIDTH,
  clampSidePanelWidth,
  sidePanelWidthAfterDrag,
  readSidePanelWidth,
  writeSidePanelWidth,
  sidePanelLayout,
  useSidePanelWidth,
  type SidePanelLayout,
} from "./components/side-panel";
export { dismissToast, Toaster, toast, type ToastAction } from "./components/toast";
export {
  Markdown,
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownListItem,
} from "./components/markdown";
export { CopyButton } from "./components/copy-button";
export {
  ShimmerText,
  ChatThread,
  ChatMessage,
  ChatBubble,
  ChatText,
  ChatSteps,
  ChatPending,
  ChatWelcome,
  ChatComposer,
  ChatComposerButton,
  ModelPicker,
  splitModelLabel,
  ChatApproval,
  ChatError,
  type ChatStep,
  type ChatStepState,
  type ChatSuggestion,
  type ChatComposerProps,
  type EffortControl,
  type ModelOption,
} from "./components/chat";
export { stepCover, reasoningCover, formatElapsed, shortUrl } from "./lib/chat";
