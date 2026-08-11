"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import {
  CARDS,
  getCardDisplayName,
  type CardDefinition,
} from "../data/cards";
import {
  SPREAD_TEMPLATES,
  UI_COPY,
  type SpreadTemplate,
  type UiCopyKey,
} from "../data/i18n";
import {
  createInitialState,
  loadStateSnapshot,
  makeBackup,
  parseBackup,
  saveState,
  StateConflictError,
} from "../lib/storage";
import {
  createReading,
  isReadingComplete,
  makeId,
  readingProgress,
} from "../lib/reading";
import { publicPath } from "../lib/publicPath";
import type {
  AppState,
  BackupPayload,
  FirstSeenAspect,
  Language,
  Orientation,
  Pull,
  PullRole,
  Reading,
  ReadingLens,
  SpreadSnapshot,
} from "../types";
import { CardArtwork } from "./CardArtwork";

type Screen = "home" | "setup" | "reading" | "journal" | "insights" | "settings";
type SaveStatus = "idle" | "saving" | "saved" | "error";
type JournalFilter = "all" | "draft" | "complete";
type CardFilter = "all" | "major" | "minor";
type ConfirmationState =
  | { kind: "duplicate"; card: CardDefinition }
  | { kind: "delete" }
  | { kind: "restore"; backup: BackupPayload }
  | { kind: "reset" };

const NAV_ITEMS: readonly { screen: Screen; label: UiCopyKey; symbol: string }[] = [
  { screen: "home", label: "nav.home", symbol: "⌂" },
  { screen: "setup", label: "nav.newReading", symbol: "✣" },
  { screen: "journal", label: "nav.journal", symbol: "▣" },
  { screen: "insights", label: "nav.insights", symbol: "⌁" },
  { screen: "settings", label: "nav.settings", symbol: "⚙" },
];

const LENSES: readonly { id: ReadingLens; name: UiCopyKey; description: UiCopyKey }[] = [
  { id: "combined", name: "lenses.mirraName", description: "lenses.mirraDescription" },
  { id: "tarot", name: "lenses.prismaName", description: "lenses.prismaDescription" },
  { id: "oracle", name: "lenses.cosmaName", description: "lenses.cosmaDescription" },
  { id: "mixed", name: "lenses.mixedName", description: "lenses.mixedDescription" },
];

const FIRST_SEEN: readonly { id: FirstSeenAspect; label: UiCopyKey }[] = [
  { id: "tarot", label: "firstSeen.prisma" },
  { id: "oracle", label: "firstSeen.cosma" },
  { id: "both", label: "firstSeen.both" },
  { id: "unclear", label: "firstSeen.unclear" },
];

function interpolate(text: string, values: Record<string, string | number> = {}): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    text,
  );
}

function formatDate(value: string, language: Language, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(language === "nl" ? "nl-NL" : "en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(language === "nl" ? "nl-NL" : "en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(date);
  }
}

function toSpreadSnapshot(template: SpreadTemplate): SpreadSnapshot {
  return {
    id: template.id,
    name: { ...template.name },
    positions: template.positions.map((position) => ({
      id: position.id,
      name: { ...position.name },
      prompt: { ...position.prompt },
      ...(position.defaultLens ? { defaultLens: position.defaultLens } : {}),
    })),
    ...(template.isFreeform !== undefined ? { isFreeform: template.isFreeform } : {}),
  };
}

function screenTitle(screen: Screen, t: (key: UiCopyKey) => string): string {
  if (screen === "reading") return t("nav.reading");
  const key = NAV_ITEMS.find((item) => item.screen === screen)?.label ?? "app.name";
  return t(key);
}

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function newestDraftId(readings: readonly Reading[], excludingId?: string): string | null {
  return (
    readings
      .filter((reading) => reading.status === "draft" && reading.id !== excludingId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null
  );
}

export default function TarotApp() {
  const [appState, setAppState] = useState<AppState>(() => createInitialState());
  const [loaded, setLoaded] = useState(false);
  const [storageLoadFailed, setStorageLoadFailed] = useState(false);
  const [storageConflict, setStorageConflict] = useState(false);
  const [screen, setScreen] = useState<Screen>("home");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [activeReadingId, setActiveReadingId] = useState<string | null>(null);
  const [activePullIndex, setActivePullIndex] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [cardFilter, setCardFilter] = useState<CardFilter>("all");
  const [journalSearch, setJournalSearch] = useState("");
  const [journalFilter, setJournalFilter] = useState<JournalFilter>("all");
  const [setupSpreadId, setSetupSpreadId] = useState<SpreadTemplate["id"]>(SPREAD_TEMPLATES[1].id);
  const [setupLens, setSetupLens] = useState<ReadingLens>("combined");
  const [setupQuestion, setSetupQuestion] = useState("");
  const [reflectionDrafts, setReflectionDrafts] = useState<Record<string, string>>({});
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  const [cardAnnouncement, setCardAnnouncement] = useState("");
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);
  const [resetPhrase, setResetPhrase] = useState("");
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [offlineReady, setOfflineReady] = useState(() =>
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    Boolean(navigator.serviceWorker.controller),
  );
  const importInputRef = useRef<HTMLInputElement>(null);
  const screenRef = useRef<HTMLElement>(null);
  const pickerDialogRef = useRef<HTMLElement>(null);
  const pickerSearchInputRef = useRef<HTMLInputElement>(null);
  const pickerReturnFocusRef = useRef<HTMLElement | null>(null);
  const confirmationDialogRef = useRef<HTMLElement>(null);
  const confirmationReturnFocusRef = useRef<HTMLElement | null>(null);
  const latestStateRef = useRef(appState);
  const storageRevisionRef = useRef(0);
  const dirtyStateRef = useRef(false);
  const storageConflictRef = useRef(false);
  const suppressNextAutosaveRef = useRef(false);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const channelRef = useRef<BroadcastChannel | null>(null);
  const instanceIdRef = useRef(makeId("tab"));

  const language = appState.settings.language;
  const copy = UI_COPY[language];
  const t = (key: UiCopyKey, values?: Record<string, string | number>) =>
    interpolate(copy[key], values);

  const persistState = useCallback((state: AppState): Promise<void> => {
    const operation = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (storageConflictRef.current) {
          throw new Error("Resolve the local-data conflict before saving.");
        }
        setSaveStatus("saving");
        try {
          const revision = await saveState(state, storageRevisionRef.current);
          storageRevisionRef.current = revision;
          if (latestStateRef.current === state) dirtyStateRef.current = false;
          setSaveStatus("saved");
          channelRef.current?.postMessage({
            type: "state-saved",
            sourceId: instanceIdRef.current,
            revision,
          });
        } catch (error) {
          if (error instanceof StateConflictError) {
            storageConflictRef.current = true;
            setStorageConflict(true);
          }
          setSaveStatus("error");
          throw error;
        }
      });
    saveQueueRef.current = operation;
    return operation;
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadStateSnapshot()
      .then(({ state: stored, revision }) => {
        if (cancelled) return;
        storageRevisionRef.current = revision;
        suppressNextAutosaveRef.current = true;
        dirtyStateRef.current = false;
        setStorageLoadFailed(false);
        setAppState(stored);
        if (stored.activeDraftId) setActiveReadingId(stored.activeDraftId);
      })
      .catch(() => {
        if (!cancelled) {
          setStorageLoadFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded || storageLoadFailed) return;
    if (suppressNextAutosaveRef.current) {
      suppressNextAutosaveRef.current = false;
      dirtyStateRef.current = false;
      return;
    }
    dirtyStateRef.current = true;
    setSaveStatus("saving");
    const timeout = window.setTimeout(() => {
      persistState(appState).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [appState, loaded, persistState, storageLoadFailed]);

  useEffect(() => {
    latestStateRef.current = appState;
  }, [appState]);

  useEffect(() => {
    if (!loaded || storageLoadFailed) return;
    const flushLatestState = () => {
      if (document.visibilityState === "hidden" && dirtyStateRef.current) {
        persistState(latestStateRef.current).catch(() => undefined);
      }
    };
    const flushOnPageHide = () => {
      if (dirtyStateRef.current) {
        persistState(latestStateRef.current).catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", flushLatestState);
    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", flushLatestState);
      window.removeEventListener("pagehide", flushOnPageHide);
    };
  }, [loaded, persistState, storageLoadFailed]);

  useEffect(() => {
    if (!loaded || storageLoadFailed || !("BroadcastChannel" in window)) return;
    const channel = new BroadcastChannel("ritual-atlas-state");
    channelRef.current = channel;
    const handleMessage = async (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "state-saved" ||
        !("sourceId" in message) ||
        message.sourceId === instanceIdRef.current ||
        !("revision" in message) ||
        typeof message.revision !== "number" ||
        message.revision <= storageRevisionRef.current
      ) {
        return;
      }

      if (dirtyStateRef.current) {
        storageConflictRef.current = true;
        setStorageConflict(true);
        setSaveStatus("error");
        return;
      }

      try {
        const snapshot = await loadStateSnapshot();
        if (snapshot.revision <= storageRevisionRef.current) return;
        storageRevisionRef.current = snapshot.revision;
        suppressNextAutosaveRef.current = true;
        dirtyStateRef.current = false;
        setAppState(snapshot.state);
        setActiveReadingId(snapshot.state.activeDraftId);
        setSaveStatus("saved");
      } catch {
        setStorageLoadFailed(true);
      }
    };
    channel.addEventListener("message", handleMessage);
    return () => {
      channel.removeEventListener("message", handleMessage);
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [loaded, storageLoadFailed]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    if (!loaded) return;
    window.requestAnimationFrame(() => screenRef.current?.focus({ preventScroll: true }));
  }, [loaded, screen]);

  useEffect(() => {
    if (!pickerOpen) return;

    pickerReturnFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => pickerSearchInputRef.current?.focus());

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPickerOpen(false);
        return;
      }
      if (event.key !== "Tab" || !pickerDialogRef.current) return;

      const focusable = [...pickerDialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDialogKeyDown);
      document.body.style.overflow = previousOverflow;
      pickerReturnFocusRef.current?.focus();
    };
  }, [pickerOpen]);

  useEffect(() => {
    if (!confirmation) return;

    confirmationReturnFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => {
      confirmationDialogRef.current
        ?.querySelector<HTMLElement>("[data-autofocus]")
        ?.focus();
    });

    const handleConfirmationKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        const returnToPicker = confirmation.kind === "duplicate";
        setConfirmation(null);
        setResetPhrase("");
        if (returnToPicker) setPickerOpen(true);
        return;
      }
      if (event.key !== "Tab" || !confirmationDialogRef.current) return;
      const focusable = [...confirmationDialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleConfirmationKeyDown);
    return () => {
      document.removeEventListener("keydown", handleConfirmationKeyDown);
      document.body.style.overflow = previousOverflow;
      confirmationReturnFocusRef.current?.focus();
    };
  }, [confirmation]);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    let registration: ServiceWorkerRegistration | null = null;
    let hasSeenController =
      "serviceWorker" in navigator && Boolean(navigator.serviceWorker.controller);
    const handleControllerChange = () => {
      setOfflineReady(true);
      if (hasSeenController) setUpdateAvailable(true);
      hasSeenController = true;
    };
    const checkForUpdate = () => {
      if (document.visibilityState === "visible") {
        registration?.update().catch(() => undefined);
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
      document.addEventListener("visibilitychange", checkForUpdate);
      const localHost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
      const shouldRegister =
        location.protocol === "https:" || (localHost && process.env.NODE_ENV === "production");
      if (shouldRegister) {
        navigator.serviceWorker
          .register(publicPath("/sw.js"))
          .then((registered) => {
            registration = registered;
            return registered.update().catch(() => undefined);
          })
          .then(() => navigator.serviceWorker.ready)
          .then(() => setOfflineReady(true))
          .catch(() => undefined);
      } else if (localHost) {
        navigator.serviceWorker
          .getRegistrations()
          .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
          .catch(() => undefined);
      }
    }
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", checkForUpdate);
      navigator.serviceWorker?.removeEventListener("controllerchange", handleControllerChange);
    };
  }, []);

  const activeReading = useMemo(
    () => appState.readings.find((reading) => reading.id === activeReadingId) ?? null,
    [activeReadingId, appState.readings],
  );

  const activePull = activeReading?.pulls[activePullIndex] ?? null;
  const activePosition = activeReading?.spreadSnapshot.positions[activePullIndex] ?? null;
  const activeCard = activePull?.cardId
    ? CARDS.find((card) => card.id === activePull.cardId) ?? null
    : null;

  const completedReadings = useMemo(
    () =>
      appState.readings.filter(
        (reading) => reading.status === "complete" && isReadingComplete(reading),
      ),
    [appState.readings],
  );

  async function retryStorageLoad() {
    setLoaded(false);
    setStorageLoadFailed(false);
    storageConflictRef.current = false;
    setStorageConflict(false);
    setNotice(null);
    try {
      await saveQueueRef.current.catch(() => undefined);
      const { state: stored, revision } = await loadStateSnapshot();
      storageRevisionRef.current = revision;
      suppressNextAutosaveRef.current = true;
      dirtyStateRef.current = false;
      setAppState(stored);
      setActiveReadingId(stored.activeDraftId);
      setSaveStatus("idle");
    } catch {
      setStorageLoadFailed(true);
    } finally {
      setLoaded(true);
    }
  }

  function navigate(next: Screen, preserveNotice = false) {
    setScreen(next);
    if (!preserveNotice) setNotice(null);
    window.scrollTo({ top: 0, behavior: appState.settings.reducedMotion ? "auto" : "smooth" });
  }

  function setLanguage(next: Language) {
    setNotice(null);
    setAppState((current) => ({
      ...current,
      settings: { ...current.settings, language: next },
    }));
  }

  function openReading(reading: Reading, position = 0) {
    setActiveReadingId(reading.id);
    setActivePullIndex(Math.min(position, Math.max(0, reading.pulls.length - 1)));
    setAppState((current) => ({
      ...current,
      activeDraftId: reading.status === "draft" ? reading.id : current.activeDraftId,
    }));
    navigate("reading");
  }

  function updateReading(readingId: string, updater: (reading: Reading) => Reading) {
    setAppState((current) => ({
      ...current,
      readings: current.readings.map((reading) =>
        reading.id === readingId
          ? { ...updater(reading), updatedAt: new Date().toISOString() }
          : reading,
      ),
    }));
  }

  function updateActivePull(patch: Partial<Pull>) {
    if (!activeReading) return;
    updateReading(activeReading.id, (reading) => ({
      ...reading,
      pulls: reading.pulls.map((pull, index) =>
        index === activePullIndex ? { ...pull, ...patch } : pull,
      ),
    }));
  }

  function beginReading() {
    const template = SPREAD_TEMPLATES.find((spread) => spread.id === setupSpreadId);
    if (!template) return;
    const reading = createReading(toSpreadSnapshot(template), setupLens, setupQuestion);
    setAppState((current) => ({
      ...current,
      readings: [reading, ...current.readings],
      activeDraftId: reading.id,
    }));
    setActiveReadingId(reading.id);
    setActivePullIndex(0);
    setSetupQuestion("");
    navigate("reading");
  }

  function applyCardSelection(card: CardDefinition) {
    updateActivePull({
      cardId: card.id,
      lensOverride: card.combinedOnly ? "combined" : activePull?.lensOverride ?? null,
      firstSeenAspect: card.combinedOnly ? null : activePull?.firstSeenAspect ?? null,
    });
    setPickerOpen(false);
    setPickerSearch("");
    setCardAnnouncement(
      t("cardPicker.selectedAnnouncement", {
        card: getCardDisplayName(card, language),
      }),
    );
  }

  function selectCard(card: CardDefinition) {
    if (!activeReading) return;
    const duplicate = activeReading.pulls.some(
      (pull, index) => index !== activePullIndex && pull.cardId === card.id,
    );
    if (duplicate) {
      setPickerOpen(false);
      setConfirmation({ kind: "duplicate", card });
      return;
    }
    applyCardSelection(card);
  }

  function finishReading() {
    if (!activeReading) return;
    if (!isReadingComplete(activeReading)) {
      setNotice(t("reading.tapPosition"));
      return;
    }
    setAppState((current) => {
      const readings = current.readings.map((reading) =>
        reading.id === activeReading.id
          ? { ...reading, status: "complete" as const, updatedAt: new Date().toISOString() }
          : reading,
      );
      return {
        ...current,
        readings,
        activeDraftId: newestDraftId(readings, activeReading.id),
      };
    });
    setNotice(t("reading.savedNotice"));
    navigate("journal", true);
  }

  function deleteActiveReading() {
    if (!activeReading) return;
    setConfirmation({ kind: "delete" });
  }

  function confirmDeleteActiveReading() {
    if (!activeReading) return;
    setAppState((current) => {
      const readings = current.readings.filter((reading) => reading.id !== activeReading.id);
      return {
        ...current,
        readings,
        activeDraftId:
          current.activeDraftId === activeReading.id
            ? newestDraftId(readings)
            : current.activeDraftId,
      };
    });
    setActiveReadingId(null);
    setConfirmation(null);
    navigate("journal");
  }

  function addFreeformPosition() {
    if (!activeReading?.spreadSnapshot.isFreeform) return;
    const nextOrder = activeReading.pulls.length;
    const slotId = makeId("placement");
    updateReading(activeReading.id, (reading) => ({
      ...reading,
      status: "draft",
      spreadSnapshot: {
        ...reading.spreadSnapshot,
        positions: [
          ...reading.spreadSnapshot.positions,
          {
            id: slotId,
            name: { en: `Placement ${nextOrder + 1}`, nl: `Plaatsing ${nextOrder + 1}` },
            prompt: {
              en: "What does this card add to the unfolding table?",
              nl: "Wat voegt deze kaart toe aan de legging die ontstaat?",
            },
          },
        ],
      },
      pulls: [
        ...reading.pulls,
        {
          slotId,
          order: nextOrder,
          cardId: null,
          orientation: "upright",
          role: "primary",
          lensOverride: reading.readingLens === "mixed" ? "combined" : null,
          firstSeenAspect: null,
          firstImpression: "",
          interpretation: "",
        },
      ],
    }));
    setAppState((current) => ({ ...current, activeDraftId: activeReading.id }));
    setActivePullIndex(nextOrder);
  }

  function removeFreeformPosition() {
    if (!activeReading?.spreadSnapshot.isFreeform || activeReading.pulls.length <= 1) return;
    const nextIndex = Math.max(0, Math.min(activePullIndex - 1, activeReading.pulls.length - 2));
    updateReading(activeReading.id, (reading) => ({
      ...reading,
      spreadSnapshot: {
        ...reading.spreadSnapshot,
        positions: reading.spreadSnapshot.positions.filter((_, index) => index !== activePullIndex),
      },
      pulls: reading.pulls
        .filter((_, index) => index !== activePullIndex)
        .map((pull, order) => ({ ...pull, order })),
    }));
    setActivePullIndex(nextIndex);
  }

  function addLaterReflection() {
    if (!activeReading) return;
    const draft = reflectionDrafts[activeReading.id] ?? "";
    if (!draft.trim()) return;
    updateReading(activeReading.id, (reading) => ({
      ...reading,
      laterReflections: [
        ...reading.laterReflections,
        {
          id: makeId("reflection"),
          createdAt: new Date().toISOString(),
          text: draft.trim(),
        },
      ],
    }));
    setReflectionDrafts((current) => {
      const next = { ...current };
      delete next[activeReading.id];
      return next;
    });
  }

  async function exportBackup() {
    try {
      const payload = makeBackup(appState);
      const json = JSON.stringify(payload, null, 2);
      const filename = `ritual-atlas-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const file = new File([json], filename, { type: "application/json" });
      const shareData = { title: t("importExport.backupShareTitle"), files: [file] };
      if (navigator.share && navigator.canShare?.(shareData)) {
        await navigator.share(shareData);
      } else {
        const url = URL.createObjectURL(file);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
      }
      setNotice(t("importExport.backupReady"));
    } catch {
      setNotice(t("errors.exportFailed"));
    }
  }

  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setNotice(t("errors.invalidBackup"));
      return;
    }
    try {
      const backup = parseBackup(await file.text());
      setConfirmation({ kind: "restore", backup });
    } catch {
      setNotice(t("errors.invalidBackup"));
    }
  }

  async function confirmRestoreBackup(backup: BackupPayload) {
    try {
      await saveQueueRef.current.catch(() => undefined);
      const revision = await saveState(backup.state);
      storageRevisionRef.current = revision;
      storageConflictRef.current = false;
      setStorageConflict(false);
      suppressNextAutosaveRef.current = true;
      dirtyStateRef.current = false;
      setAppState(backup.state);
      setActiveReadingId(backup.state.activeDraftId);
      setReflectionDrafts({});
      setTagDrafts({});
      setJournalSearch("");
      setJournalFilter("all");
      setSaveStatus("saved");
      channelRef.current?.postMessage({
        type: "state-saved",
        sourceId: instanceIdRef.current,
        revision,
      });
      setConfirmation(null);
      setNotice(t("importExport.restoreComplete"));
      navigate("journal", true);
    } catch {
      setConfirmation(null);
      setNotice(t("errors.importFailed"));
    }
  }

  async function requestPersistentStorage() {
    try {
      if (!navigator.storage?.persist) {
        setNotice(t("settings.persistentStorageDenied"));
        return;
      }
      const granted = await navigator.storage.persist();
      setNotice(
        granted
          ? t("settings.persistentStorageGranted")
          : t("settings.persistentStorageDenied"),
      );
    } catch {
      setNotice(t("settings.persistentStorageDenied"));
    }
  }

  async function resetApp() {
    const requiredPhrase = language === "nl" ? "VERWIJDEREN" : "DELETE";
    if (resetPhrase.trim().toLocaleUpperCase(language === "nl" ? "nl" : "en") !== requiredPhrase) return;
    try {
      await saveQueueRef.current.catch(() => undefined);
      const initial = createInitialState();
      const revision = await saveState(initial);
      storageRevisionRef.current = revision;
      storageConflictRef.current = false;
      setStorageConflict(false);
      suppressNextAutosaveRef.current = true;
      dirtyStateRef.current = false;
      setAppState(initial);
      setActiveReadingId(null);
      setReflectionDrafts({});
      setTagDrafts({});
      setJournalSearch("");
      setJournalFilter("all");
      setPickerSearch("");
      setConfirmation(null);
      setResetPhrase("");
      setNotice(UI_COPY[initial.settings.language]["privacy.dataCleared"]);
      channelRef.current?.postMessage({
        type: "state-saved",
        sourceId: instanceIdRef.current,
        revision,
      });
      navigate("home", true);
    } catch {
      setConfirmation(null);
      setResetPhrase("");
      setNotice(t("errors.deleteFailed"));
    }
  }

  function cancelConfirmation() {
    const returnToPicker = confirmation?.kind === "duplicate";
    setConfirmation(null);
    setResetPhrase("");
    if (returnToPicker) setPickerOpen(true);
  }

  const usedCardIds = new Set(activeReading?.pulls.map((pull) => pull.cardId).filter(Boolean));
  const filteredCards = useMemo(() => {
    const query = pickerSearch.trim().toLocaleLowerCase(language === "nl" ? "nl" : "en");
    return CARDS.filter((card) => {
      if (cardFilter !== "all" && card.arcana !== cardFilter) return false;
      if (!query) return true;
      const haystack = [
        card.prismaTitleEn,
        card.prismaTitleNl ?? "",
        card.cosmaTitleEn,
        card.cosmaAliasNl ?? "",
        ...card.searchAliases,
      ]
        .join(" ")
        .toLocaleLowerCase(language === "nl" ? "nl" : "en");
      return haystack.includes(query);
    });
  }, [cardFilter, language, pickerSearch]);

  const filteredReadings = useMemo(() => {
    const query = journalSearch.trim().toLocaleLowerCase(language === "nl" ? "nl" : "en");
    return [...appState.readings]
      .filter((reading) => journalFilter === "all" || reading.status === journalFilter)
      .filter((reading) => {
        if (!query) return true;
        const cards = reading.pulls
          .map((pull) => CARDS.find((card) => card.id === pull.cardId))
          .filter((card): card is CardDefinition => Boolean(card));
        const cardNames = cards.flatMap((card) => [
          getCardDisplayName(card, language),
          card.prismaTitleEn,
          card.prismaTitleNl ?? "",
          card.cosmaTitleEn,
          card.cosmaAliasNl ?? "",
          ...card.searchAliases,
        ]);
        return [
          reading.question,
          reading.initialReflection,
          ...reading.tags,
          ...reading.pulls.flatMap((pull) => [pull.firstImpression, pull.interpretation]),
          ...reading.laterReflections.map((reflection) => reflection.text),
          ...cardNames,
        ]
          .join(" ")
          .toLocaleLowerCase(language === "nl" ? "nl" : "en")
          .includes(query);
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [appState.readings, journalFilter, journalSearch, language]);

  const insights = useMemo(() => {
    const cardCounts = new Map<string, number>();
    const spreadCounts = new Map<
      string,
      { name: Readonly<Record<Language, string>>; count: number }
    >();
    let upright = 0;
    let reversed = 0;
    const lensCounts = new Map<Exclude<ReadingLens, "mixed">, number>();
    completedReadings.forEach((reading) => {
      const previousSpread = spreadCounts.get(reading.spreadSnapshot.id);
      spreadCounts.set(reading.spreadSnapshot.id, {
        name: reading.spreadSnapshot.name,
        count: (previousSpread?.count ?? 0) + 1,
      });
      reading.pulls.forEach((pull) => {
        if (!pull.cardId) return;
        const card = CARDS.find((candidate) => candidate.id === pull.cardId);
        if (!card) return;
        cardCounts.set(card.id, (cardCounts.get(card.id) ?? 0) + 1);
        if (pull.orientation === "reversed") reversed += 1;
        else upright += 1;
        const lens: Exclude<ReadingLens, "mixed"> = card.combinedOnly
          ? "combined"
          : pull.lensOverride ?? (reading.readingLens === "mixed" ? "combined" : reading.readingLens);
        lensCounts.set(lens, (lensCounts.get(lens) ?? 0) + 1);
      });
    });
    const frequent = [...cardCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cardId, count]) => ({ card: CARDS.find((card) => card.id === cardId), count }))
      .filter((entry): entry is { card: CardDefinition; count: number } => Boolean(entry.card))
      .slice(0, 5);
    const spreads = [...spreadCounts.values()].sort((a, b) => b.count - a.count);
    return { frequent, upright, reversed, lensCounts, spreads };
  }, [completedReadings]);

  if (!loaded) {
    return (
      <main className="loading-screen" role="status" aria-live="polite">
        <div className="loading-mark" aria-hidden="true">✣</div>
        <p>{UI_COPY.en["app.name"]}</p>
      </main>
    );
  }

  return (
    <div className={`tarot-app screen-${screen}${appState.settings.reducedMotion ? " reduce-motion" : ""}`}>
      <aside
        className="desktop-rail"
        aria-label={t("nav.menu")}
        aria-hidden={pickerOpen || Boolean(confirmation) ? true : undefined}
        inert={pickerOpen || Boolean(confirmation) ? true : undefined}
      >
        <button className="brand-lockup" type="button" onClick={() => navigate("home")}>
          <span className="brand-mark" aria-hidden="true">✣</span>
          <span><strong>{t("app.name")}</strong><small>EN / NL</small></span>
        </button>
        <nav className="rail-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.screen}
              type="button"
              className={screen === item.screen ? "is-active" : ""}
              aria-current={screen === item.screen ? "page" : undefined}
              onClick={() => navigate(item.screen)}
            >
              <span aria-hidden="true">{item.symbol}</span>{t(item.label)}
            </button>
          ))}
        </nav>
        <div className="rail-privacy">
          <span
            className={`status-dot${storageLoadFailed ? " is-error" : online ? "" : " is-offline"}`}
            aria-hidden="true"
          />
          <strong>
            {storageLoadFailed
              ? t("errors.loadFailed")
              : !online
              ? t("privacy.offlineTitle")
              : offlineReady
                ? t("app.offlineReady")
                : t("app.personalOnly")}
          </strong>
          <p>{storageLoadFailed ? t("errors.tryAgain") : t("home.offlineNote")}</p>
        </div>
      </aside>

      <div
        className="app-stage"
        aria-hidden={pickerOpen || Boolean(confirmation) ? true : undefined}
        inert={pickerOpen || Boolean(confirmation) ? true : undefined}
      >
        <header className="mobile-header">
          <button className="mobile-brand" type="button" onClick={() => navigate("home")}>
            <span aria-hidden="true">✣</span> {t("app.name")}
          </button>
          <span className="mobile-screen-title">{screenTitle(screen, t)}</span>
          <button
            className="language-shortcut"
            type="button"
            onClick={() => setLanguage(language === "en" ? "nl" : "en")}
            aria-label={t(
              language === "en" ? "language.switchToDutch" : "language.switchToEnglish",
            )}
          >
            {language.toUpperCase()}
          </button>
        </header>

        {storageConflict ? (
          <div className="notice notice--error" role="alert">
            <span>{t("errors.staleData")}</span>
            <div className="notice-actions">
              <button type="button" onClick={exportBackup}>
                {t("actions.exportUnsaved")}
              </button>
              <button type="button" onClick={retryStorageLoad}>
                {t("actions.reload")}
              </button>
            </div>
          </div>
        ) : saveStatus === "error" ? (
          <div className="notice notice--error" role="alert">
            <span>{t("errors.saveFailed")}</span>
            <button type="button" onClick={() => setAppState((current) => ({ ...current }))}>
              {t("actions.retry")}
            </button>
          </div>
        ) : updateAvailable ? (
          <div className="notice" role="status">
            <span>{t("app.updateAvailable")}</span>
            <button type="button" onClick={() => window.location.reload()}>
              {t("actions.update")}
            </button>
          </div>
        ) : notice ? (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button type="button" aria-label={t("nav.close")} onClick={() => setNotice(null)}>×</button>
          </div>
        ) : null}

        <main
          ref={screenRef}
          className={`screen screen--${screen}`}
          tabIndex={-1}
          aria-label={screenTitle(screen, t)}
        >
          {storageLoadFailed ? (
            <section className="empty-state" role="alert">
              <span aria-hidden="true">!</span>
              <h1>{t("errors.loadFailed")}</h1>
              <p>{t("errors.tryAgain")}</p>
              <button className="primary-action" type="button" onClick={retryStorageLoad}>
                {t("actions.retry")}
              </button>
            </section>
          ) : (
            <>
              {screen === "home" && renderHome()}
              {screen === "setup" && renderSetup()}
              {screen === "reading" && renderReading()}
              {screen === "journal" && renderJournal()}
              {screen === "insights" && renderInsights()}
              {screen === "settings" && renderSettings()}
            </>
          )}
        </main>

        <nav className="bottom-nav" aria-label={t("nav.menu")}>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.screen}
              type="button"
              aria-current={screen === item.screen ? "page" : undefined}
              onClick={() => navigate(item.screen)}
            >
              <span aria-hidden="true">{item.symbol}</span>
              {t(item.label)}
            </button>
          ))}
        </nav>
      </div>

      {pickerOpen && renderCardPicker()}
      {confirmation && renderConfirmationDialog()}
      <input
        ref={importInputRef}
        hidden
        type="file"
        accept="application/json,.json"
        tabIndex={-1}
        onChange={importBackup}
      />
    </div>
  );

  function renderHome(): ReactNode {
    const draft =
      appState.readings.find((reading) => reading.id === appState.activeDraftId) ??
      appState.readings
        .filter((reading) => reading.status === "draft")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const recent = [...appState.readings]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 3);
    const featuredCard = CARDS.find((card) => card.id === "wands-three") ?? null;
    return (
      <div className="home-layout">
        <section className="home-hero">
          <div className="hero-copy">
            <p className="eyebrow">{t("home.eyebrow")}</p>
            <h1>{t("home.title")}</h1>
            <p className="lede">{t("home.subtitle")}</p>
            <div className="hero-actions">
              <button className="primary-action" type="button" onClick={() => navigate("setup")}>
                <span aria-hidden="true">✣</span>{t("home.startReading")}
              </button>
              {draft && (
                <button className="secondary-action" type="button" onClick={() => openReading(draft)}>
                  {t("home.continueDraft")} · {readingProgress(draft).complete}/{readingProgress(draft).total}
                </button>
              )}
            </div>
            <p className="privacy-line"><span aria-hidden="true">●</span>{t("home.offlineNote")}</p>
          </div>
          <div className="hero-art" aria-label={t("home.referenceArtwork")}>
            <CardArtwork
              card={featuredCard}
              alt={t("home.referenceArtworkAlt")}
            />
            <div className="hero-art-caption">
              <span>{t("home.referenceArtwork")}</span>
              <strong>
                {featuredCard
                  ? language === "nl"
                    ? featuredCard.prismaTitleNl ?? featuredCard.prismaTitleEn
                    : featuredCard.prismaTitleEn
                  : t("reading.emptyPosition")}
              </strong>
            </div>
          </div>
        </section>

        <section className="home-section">
          <div className="section-heading">
            <div><p className="eyebrow">{t("journal.title")}</p><h2>{t("home.recentReadings")}</h2></div>
            {appState.readings.length > 0 && (
              <button className="text-action" type="button" onClick={() => navigate("journal")}>
                {t("home.viewJournal")} →
              </button>
            )}
          </div>
          {recent.length ? (
            <div className="reading-grid">
              {recent.map((reading) => <ReadingPreview key={reading.id} reading={reading} />)}
            </div>
          ) : (
            <div className="empty-state">
              <span aria-hidden="true">✦</span>
              <h3>{t("home.noReadingsTitle")}</h3>
              <p>{t("home.noReadingsBody")}</p>
            </div>
          )}
        </section>
      </div>
    );
  }

  function renderSetup(): ReactNode {
    return (
      <div className="content-page setup-page">
        <header className="page-heading">
          <p className="eyebrow">{t("newReading.physicalDeckTitle")}</p>
          <h1>{t("newReading.title")}</h1>
          <p>{t("newReading.subtitle")}</p>
        </header>

        <section className="form-section">
          <div className="section-heading"><div><p className="step-number">01</p><h2>{t("newReading.chooseSpread")}</h2></div></div>
          <div className="spread-grid">
            {SPREAD_TEMPLATES.map((spread) => (
              <button
                className={`spread-choice${setupSpreadId === spread.id ? " is-selected" : ""}`}
                type="button"
                key={spread.id}
                aria-pressed={setupSpreadId === spread.id}
                onClick={() => {
                  setSetupSpreadId(spread.id);
                  if (spread.id === "dual-aspect") setSetupLens("mixed");
                }}
              >
                <span className="spread-count">{spread.positions.length}</span>
                <strong>{spread.name[language]}</strong>
                <small>{spread.description[language]}</small>
                <span className="spread-nodes" aria-hidden="true">
                  {spread.positions.slice(0, 6).map((position) => <i key={position.id} />)}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="form-section">
          <div className="section-heading"><div><p className="step-number">02</p><h2>{t("newReading.chooseLens")}</h2></div></div>
          <div className="lens-grid">
            {LENSES.map((lens) => (
              <button
                className={`lens-choice${setupLens === lens.id ? " is-selected" : ""}`}
                type="button"
                key={lens.id}
                aria-pressed={setupLens === lens.id}
                onClick={() => setSetupLens(lens.id)}
              >
                <strong>{t(lens.name)}</strong>
                <small>{t(lens.description)}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="form-section intention-section">
          <div className="section-heading"><div><p className="step-number">03</p><h2>{t("newReading.stepIntention")}</h2></div></div>
          <label className="field-label" htmlFor="reading-question">{t("newReading.questionLabel")} <span>{t("newReading.optional")}</span></label>
          <textarea
            id="reading-question"
            className="text-field"
            rows={4}
            value={setupQuestion}
            placeholder={t("newReading.questionPlaceholder")}
            onChange={(event) => setSetupQuestion(event.target.value)}
          />
          <div className="begin-row">
            <p><span aria-hidden="true">●</span>{t("newReading.savedAsDraft")}</p>
            <button className="primary-action" type="button" onClick={beginReading}>{t("newReading.begin")} →</button>
          </div>
        </section>
      </div>
    );
  }

  function renderReading(): ReactNode {
    if (!activeReading || !activePull || !activePosition) {
      return (
        <div className="empty-state reading-missing">
          <h1>{t("reading.title")}</h1>
          <p>{t("journal.emptyBody")}</p>
          <button className="primary-action" type="button" onClick={() => navigate("setup")}>{t("home.startReading")}</button>
        </div>
      );
    }
    const progress = readingProgress(activeReading);
    const cardName = activeCard ? getCardDisplayName(activeCard, language) : t("reading.emptyPosition");
    const effectiveLens = activeCard?.combinedOnly
      ? "combined"
      : activePull.lensOverride ?? (activeReading.readingLens === "mixed" ? "combined" : activeReading.readingLens);

    return (
      <div className="reading-page">
        <header className="reading-topbar">
          <button className="icon-button" type="button" onClick={() => navigate("home")} aria-label={t("nav.back")}>‹</button>
          <div>
            <p className="eyebrow">{activeReading.spreadSnapshot.name[language]}</p>
            <h1>{activeReading.question || t("reading.title")}</h1>
          </div>
          <button className="icon-button" type="button" onClick={deleteActiveReading} aria-label={t("actions.delete")}>•••</button>
        </header>

        <div className="reading-status-line">
          <span role="status" aria-live="polite" aria-atomic="true">
            <span className={`status-dot${saveStatus === "error" ? " is-error" : ""}`} aria-hidden="true" />
            {saveStatus === "saving" ? t("reading.saving") : saveStatus === "error" ? t("reading.saveFailed") : t("reading.autosaved")}
          </span>
          <span aria-label={t("reading.progress")}>{progress.complete}/{progress.total}</span>
        </div>

        <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {t("reading.positionCount", {
            current: activePullIndex + 1,
            total: activeReading.pulls.length,
          })}: {activePosition.name[language]}. {activePosition.prompt[language]}
        </p>
        <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {cardAnnouncement}
        </p>

        <section className="position-banner" aria-labelledby="position-title">
          <p className="eyebrow">{t("reading.positionCount", { current: activePullIndex + 1, total: activeReading.pulls.length })}</p>
          <h2 id="position-title">{activePosition.name[language]}</h2>
          <p>{activePosition.prompt[language]}</p>
          <div className="position-map" aria-label={t("reading.progress") }>
            {activeReading.spreadSnapshot.positions.map((position, index) => {
              const pull = activeReading.pulls[index];
              return (
                <button
                  key={position.id}
                  type="button"
                  className={index === activePullIndex ? "is-current" : ""}
                  aria-current={index === activePullIndex ? "step" : undefined}
                  onClick={() => setActivePullIndex(index)}
                >
                  <span>{index + 1}</span>
                  <small>{position.name[language]}</small>
                  {pull.cardId && <i aria-label={t("actions.done")}>✓</i>}
                </button>
              );
            })}
          </div>
          {activeReading.spreadSnapshot.isFreeform && (
            <div className="freeform-actions">
              <button type="button" onClick={addFreeformPosition}>＋ {t("reading.addAnotherCard")}</button>
              <button
                type="button"
                disabled={activeReading.pulls.length <= 1}
                onClick={removeFreeformPosition}
              >
                − {t("spreads.removePosition")}
              </button>
            </div>
          )}
        </section>

        <section className="card-focus">
          <button
            className="artwork-button"
            type="button"
            onClick={() => {
              setCardAnnouncement("");
              setPickerOpen(true);
            }}
            aria-label={
              activeCard
                ? `${t("reading.changeCard")}: ${cardName}`
                : t("reading.addCard")
            }
          >
            <CardArtwork
              card={activeCard}
              reversed={activePull.orientation === "reversed"}
              alt={cardName}
            />
            {!activeCard && <span className="artwork-empty-callout">＋ {t("reading.addCard")}</span>}
          </button>
          <div className="card-title-block">
            <p className="eyebrow">{activeCard ? t("reading.cardDetails") : t("reading.tapPosition")}</p>
            <h2>{cardName}</h2>
            {language === "nl" && activeCard && appState.settings.showEnglishCardNamesInDutch && (
              <p className="printed-title">{activeCard.prismaTitleEn} / {activeCard.cosmaTitleEn}</p>
            )}
            <button className="text-action" type="button" onClick={() => setPickerOpen(true)}>
              {activeCard ? t("reading.changeCard") : t("reading.addCard")}
            </button>
          </div>
        </section>

        <div className="position-navigation">
          <button type="button" disabled={activePullIndex === 0} onClick={() => setActivePullIndex((index) => index - 1)}>← {t("actions.previous")}</button>
          <button type="button" disabled={activePullIndex === activeReading.pulls.length - 1} onClick={() => setActivePullIndex((index) => index + 1)}>{t("actions.next")} →</button>
        </div>

        <button
          className="journal-peek"
          type="button"
          onClick={() => document.getElementById("reading-journal")?.scrollIntoView({
            behavior: appState.settings.reducedMotion ? "auto" : "smooth",
            block: "start",
          })}
        >
          <span><small>{t("journal.title")}</small><strong>{t("reading.summaryLabel")}</strong></span>
          <span aria-hidden="true">↓</span>
        </button>

        {activeCard && (
          <section className="reading-controls">
            <ControlGroup label={t("orientation.label")}>
              {(["upright", "reversed"] as Orientation[]).map((orientation) => (
                <button
                  key={orientation}
                  type="button"
                  aria-pressed={activePull.orientation === orientation}
                  onClick={() => updateActivePull({ orientation })}
                >
                  {t(orientation === "upright" ? "orientation.upright" : "orientation.reversed")}
                </button>
              ))}
            </ControlGroup>

            <ControlGroup label={t("lenses.label")}>
              {(["combined", "tarot", "oracle"] as const).map((lens) => (
                <button
                  key={lens}
                  type="button"
                  disabled={activeCard.combinedOnly && lens !== "combined"}
                  aria-pressed={effectiveLens === lens}
                  onClick={() => updateActivePull({ lensOverride: lens })}
                >
                  {t(lens === "combined" ? "lenses.combinedShort" : lens === "tarot" ? "lenses.tarotShort" : "lenses.oracleShort")}
                </button>
              ))}
            </ControlGroup>
            {activeCard.combinedOnly && <p className="field-note">{t("lenses.combinedOnly")}</p>}

            <ControlGroup label={t("reading.roleLabel")}>
              {(["primary", "jumper", "clarifier"] as PullRole[]).map((role) => (
                <button
                  key={role}
                  type="button"
                  aria-pressed={activePull.role === role}
                  onClick={() => updateActivePull({ role })}
                >
                  {t(role === "primary" ? "reading.rolePrimary" : role === "jumper" ? "reading.roleJumper" : "reading.roleClarifier")}
                </button>
              ))}
            </ControlGroup>

            {!activeCard.combinedOnly && <div className="field-block" role="group" aria-label={t("firstSeen.label")}>
              <span className="field-label">{t("firstSeen.label")}</span>
              <div className="choice-chips">
                {FIRST_SEEN.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={activePull.firstSeenAspect === option.id}
                    onClick={() => updateActivePull({ firstSeenAspect: option.id })}
                  >
                    {t(option.label)}
                  </button>
                ))}
              </div>
            </div>}

            <label className="field-label" htmlFor="card-impression">{t("reading.notesLabel")}</label>
            <textarea
              id="card-impression"
              className="text-field"
              rows={4}
              value={activePull.firstImpression}
              placeholder={t("reading.notesPlaceholder")}
              onChange={(event) => updateActivePull({ firstImpression: event.target.value })}
            />
            <label className="field-label" htmlFor="card-interpretation">{t("reading.interpretationLabel")}</label>
            <textarea
              id="card-interpretation"
              className="text-field"
              rows={4}
              value={activePull.interpretation}
              placeholder={t("reading.interpretationPlaceholder")}
              onChange={(event) => updateActivePull({ interpretation: event.target.value })}
            />
          </section>
        )}

        <section className="journal-sheet" id="reading-journal">
          <div className="section-heading">
            <div><p className="eyebrow">{t("journal.title")}</p><h2>{t("reading.summaryLabel")}</h2></div>
            <span>{formatDate(activeReading.performedAt, language, activeReading.timezone)}</span>
          </div>
          <label className="field-label" htmlFor="reading-reflection">{t("reading.summaryLabel")}</label>
          <textarea
            id="reading-reflection"
            className="text-field journal-reflection"
            rows={5}
            value={activeReading.initialReflection}
            placeholder={t("reading.summaryPlaceholder")}
            onChange={(event) => updateReading(activeReading.id, (reading) => ({ ...reading, initialReflection: event.target.value }))}
          />
          <label className="field-label" htmlFor="reading-tags">{t("reading.tagsLabel")}</label>
          <input
            id="reading-tags"
            className="text-input"
            value={tagDrafts[activeReading.id] ?? activeReading.tags.join(", ")}
            placeholder={t("reading.tagsPlaceholder")}
            onChange={(event) => {
              const value = event.target.value;
              setTagDrafts((current) => ({ ...current, [activeReading.id]: value }));
              updateReading(activeReading.id, (reading) => ({
                ...reading,
                tags: parseTags(value),
              }));
            }}
            onBlur={() => setTagDrafts((current) => {
              const next = { ...current };
              delete next[activeReading.id];
              return next;
            })}
          />
          {activeReading.status === "complete" && (
            <div className="later-reflections">
              <h3>{t("reading.laterReflectionTitle")}</h3>
              {activeReading.laterReflections.map((reflection) => (
                <article key={reflection.id}>
                  <time dateTime={reflection.createdAt}>{formatDate(reflection.createdAt, language, activeReading.timezone)}</time>
                  <p>{reflection.text}</p>
                </article>
              ))}
              <label className="field-label" htmlFor="later-reflection">{t("reading.laterReflectionPrompt")}</label>
              <textarea
                id="later-reflection"
                className="text-field"
                rows={3}
                value={reflectionDrafts[activeReading.id] ?? ""}
                placeholder={t("reading.laterReflectionPrompt")}
                onChange={(event) =>
                  setReflectionDrafts((current) => ({
                    ...current,
                    [activeReading.id]: event.target.value,
                  }))
                }
              />
              <button className="secondary-action" type="button" disabled={!(reflectionDrafts[activeReading.id] ?? "").trim()} onClick={addLaterReflection}>
                {t("reading.addReflection")}
              </button>
            </div>
          )}
          <div className="reading-footer-actions">
            {activeReading.status === "draft" ? (
              <>
                <button className="secondary-action" type="button" onClick={() => navigate("home")}>{t("reading.keepDraft")}</button>
                <button className="primary-action" type="button" onClick={finishReading}>{t("reading.markComplete")}</button>
              </>
            ) : (
              <button className="primary-action" type="button" onClick={() => navigate("journal")}>← {t("journal.title")}</button>
            )}
          </div>
        </section>

      </div>
    );
  }

  function renderJournal(): ReactNode {
    return (
      <div className="content-page journal-page">
        <header className="page-heading">
          <p className="eyebrow">{t("app.personalOnly")}</p>
          <h1>{t("journal.title")}</h1>
          <p>{t("journal.subtitle")}</p>
        </header>
        <div className="journal-toolbar">
          <label className="search-field">
            <span aria-hidden="true">⌕</span>
            <span className="visually-hidden">{t("journal.searchLabel")}</span>
            <input value={journalSearch} onChange={(event) => setJournalSearch(event.target.value)} placeholder={t("journal.searchPlaceholder")} />
          </label>
          <div className="filter-row" role="group" aria-label={t("journal.filterLabel")}>
            {(["all", "draft", "complete"] as JournalFilter[]).map((filter) => (
              <button key={filter} type="button" aria-pressed={journalFilter === filter} onClick={() => setJournalFilter(filter)}>
                {t(filter === "all" ? "journal.filterAll" : filter === "draft" ? "journal.filterDrafts" : "journal.filterComplete")}
              </button>
            ))}
          </div>
        </div>
        <p className="result-count">
          {t(filteredReadings.length === 1 ? "journal.resultsOne" : "journal.resultsMany", { count: filteredReadings.length })}
        </p>
        {filteredReadings.length ? (
          <div className="journal-list">
            {filteredReadings.map((reading) => <ReadingPreview key={reading.id} reading={reading} wide />)}
          </div>
        ) : (
          <div className="empty-state">
            <span aria-hidden="true">◇</span>
            <h2>{journalSearch || journalFilter !== "all" ? t("journal.noResultsTitle") : t("journal.emptyTitle")}</h2>
            <p>{journalSearch || journalFilter !== "all" ? t("journal.noResultsBody") : t("journal.emptyBody")}</p>
            <button className="primary-action" type="button" onClick={() => navigate("setup")}>{t("home.startReading")}</button>
          </div>
        )}
      </div>
    );
  }

  function renderInsights(): ReactNode {
    const totalCards = insights.upright + insights.reversed;
    return (
      <div className="content-page insights-page">
        <header className="page-heading">
          <p className="eyebrow">{t("insights.contextTitle")}</p>
          <h1>{t("insights.title")}</h1>
          <p>{t("insights.subtitle")}</p>
        </header>
        {completedReadings.length === 0 ? (
          <div className="empty-state">
            <span aria-hidden="true">⌁</span>
            <h2>{t("insights.notEnoughTitle")}</h2>
            <p>{t("insights.notEnoughBody")}</p>
          </div>
        ) : (
          <>
            <p className="insights-basis">{t(completedReadings.length === 1 ? "insights.basedOnOne" : "insights.basedOnMany", { count: completedReadings.length })}</p>
            <div className="insight-grid">
              <section className="insight-panel insight-panel--wide">
                <p className="eyebrow">{t("insights.frequentCards")}</p>
                {insights.frequent.length ? (
                  <ol className="frequency-list">
                    {insights.frequent.map(({ card, count }, index) => card && (
                      <li key={card.id}>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <strong>{getCardDisplayName(card, language)}</strong>
                        <small>{t(count === 1 ? "insights.drawnOnce" : "insights.drawnTimes", { count })}</small>
                        <i style={{ width: `${Math.max(16, (count / insights.frequent[0].count) * 100)}%` }} />
                      </li>
                    ))}
                  </ol>
                ) : <p>{t("insights.noData")}</p>}
              </section>
              <section className="insight-panel">
                <p className="eyebrow">{t("insights.orientationBalance")}</p>
                <div className="donut-wrap">
                  <div className="donut" style={{ "--upright": `${totalCards ? (insights.upright / totalCards) * 100 : 0}%` } as React.CSSProperties}>
                    <strong>{totalCards}</strong><small>{t(totalCards === 1 ? "insights.cardsOneLabel" : "insights.cardsManyLabel")}</small>
                  </div>
                  <dl><div><dt>{t("orientation.upright")}</dt><dd>{insights.upright}</dd></div><div><dt>{t("orientation.reversed")}</dt><dd>{insights.reversed}</dd></div></dl>
                </div>
              </section>
              <section className="insight-panel">
                <p className="eyebrow">{t("insights.lensBalance")}</p>
                <div className="lens-stats">
                  {LENSES.filter((lens) => lens.id !== "mixed").map((lens) => (
                    <div key={lens.id}><span>{t(lens.name)}</span><strong>{insights.lensCounts.get(lens.id as Exclude<ReadingLens, "mixed">) ?? 0}</strong></div>
                  ))}
                </div>
              </section>
              <section className="insight-panel insight-panel--wide">
                <p className="eyebrow">{t("insights.spreadPatterns")}</p>
                <div className="lens-stats">
                  {insights.spreads.map((spread) => (
                    <div key={`${spread.name.en}-${spread.name.nl}`}>
                      <span>{spread.name[language]}</span>
                      <strong>
                        {t(
                          spread.count === 1
                            ? "insights.readingsOne"
                            : "insights.readingsMany",
                          { count: spread.count },
                        )}
                      </strong>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </>
        )}
        <section className="privacy-panel">
          <span aria-hidden="true">●</span>
          <div><h2>{t("insights.privateTitle")}</h2><p>{t("insights.privateBody")} {t("insights.contextBody")}</p></div>
        </section>
      </div>
    );
  }

  function renderSettings(): ReactNode {
    return (
      <div className="content-page settings-page">
        <header className="page-heading">
          <p className="eyebrow">{t("settings.version", { version: "1.0" })}</p>
          <h1>{t("settings.title")}</h1>
          <p>{t("settings.subtitle")}</p>
        </header>
        <div className="settings-grid">
          <section className="settings-panel">
            <p className="eyebrow">{t("settings.languageTitle")}</p>
            <h2>{t("language.label")}</h2>
            <div className="setting-options">
              <button type="button" aria-pressed={language === "en"} onClick={() => setLanguage("en")}><strong>{t("language.english")}</strong><span>EN</span></button>
              <button type="button" aria-pressed={language === "nl"} onClick={() => setLanguage("nl")}><strong>{t("language.dutch")}</strong><span>NL</span></button>
            </div>
            <label
              className="toggle-row"
              htmlFor="show-printed-names"
              aria-label={t("settings.showEnglishCardNames")}
            >
              <span><strong>{t("settings.showEnglishCardNames")}</strong><small>{t("settings.showEnglishCardNamesBody")}</small></span>
              <input
                id="show-printed-names"
                type="checkbox"
                checked={appState.settings.showEnglishCardNamesInDutch}
                onChange={(event) => setAppState((current) => ({ ...current, settings: { ...current.settings, showEnglishCardNamesInDutch: event.target.checked } }))}
              />
            </label>
          </section>

          <section className="settings-panel">
            <p className="eyebrow">{t("settings.appearanceTitle")}</p>
            <h2>{t("settings.motionLabel")}</h2>
            <label
              className="toggle-row"
              htmlFor="reduce-motion"
              aria-label={t("settings.reducedMotion")}
            >
              <span><strong>{t("settings.reducedMotion")}</strong><small>{t("settings.reducedMotionBody")}</small></span>
              <input
                id="reduce-motion"
                type="checkbox"
                checked={appState.settings.reducedMotion}
                onChange={(event) => setAppState((current) => ({ ...current, settings: { ...current.settings, reducedMotion: event.target.checked } }))}
              />
            </label>
          </section>

          <section className="settings-panel settings-panel--wide">
            <p className="eyebrow">{t("settings.dataTitle")}</p>
            <h2>{t("importExport.title")}</h2>
            <p>{t("importExport.subtitle")}</p>
            <div className="data-actions">
              <button className="primary-action" type="button" onClick={exportBackup}>{t("importExport.exportBackup")}</button>
              <button className="secondary-action" type="button" onClick={() => importInputRef.current?.click()}>{t("importExport.chooseFile")}</button>
              <button className="secondary-action" type="button" onClick={requestPersistentStorage}>{t("settings.requestPersistentStorage")}</button>
            </div>
            <p className="field-note">{t("privacy.deviceRiskBody")}</p>
          </section>

          <section className="settings-panel settings-panel--wide privacy-settings">
            <p className="eyebrow">{t("settings.privacyTitle")}</p>
            <h2>{t("privacy.localOnlyTitle")}</h2>
            <div className="privacy-points">
              <div><span>01</span><strong>{t("privacy.localOnlyTitle")}</strong><p>{t("privacy.localOnlyBody")}</p></div>
              <div><span>02</span><strong>{t("privacy.noAnalyticsTitle")}</strong><p>{t("privacy.noAnalyticsBody")}</p></div>
              <div><span>03</span><strong>{t("privacy.offlineTitle")}</strong><p>{t("privacy.offlineBody")}</p></div>
            </div>
          </section>

          <section className="settings-panel settings-panel--wide">
            <p className="eyebrow">{t("settings.aboutTitle")}</p>
            <h2>{t("app.name")}</h2>
            <p>{t("settings.aboutBody")}</p>
          </section>

          <section className="settings-panel settings-panel--danger">
            <p className="eyebrow">{t("settings.resetTitle")}</p>
            <h2>{t("privacy.clearData")}</h2>
            <p>{t("settings.resetBody")}</p>
            <button className="danger-action" type="button" onClick={() => setConfirmation({ kind: "reset" })}>{t("privacy.clearData")}</button>
          </section>
        </div>
        <section className="install-panel">
          <span className="brand-mark" aria-hidden="true">✣</span>
          <div><h2>{t("app.installTitle")}</h2><p>{t("app.installBody")}</p></div>
        </section>
      </div>
    );
  }

  function renderConfirmationDialog(): ReactNode {
    if (!confirmation) return null;
    const requiredPhrase = language === "nl" ? "VERWIJDEREN" : "DELETE";
    const resetMatches =
      resetPhrase.trim().toLocaleUpperCase(language === "nl" ? "nl" : "en") ===
      requiredPhrase;
    const title =
      confirmation.kind === "duplicate"
        ? t("reading.noDuplicateTitle")
        : confirmation.kind === "delete"
          ? t("reading.deleteTitle")
          : confirmation.kind === "restore"
            ? t("importExport.replaceTitle")
            : t("privacy.clearData");
    const body =
      confirmation.kind === "duplicate"
        ? t("reading.noDuplicateBody")
        : confirmation.kind === "delete"
          ? t("reading.deleteBody")
          : confirmation.kind === "restore"
            ? t("importExport.replaceBody")
            : t("settings.resetBody");

    return (
      <div
        className="modal-backdrop confirmation-backdrop"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) cancelConfirmation();
        }}
      >
        <section
          ref={confirmationDialogRef}
          className="confirmation-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirmation-title"
          aria-describedby="confirmation-body"
        >
          <header>
            <div>
              <p className="eyebrow">{t("app.personalOnly")}</p>
              <h2 id="confirmation-title">{title}</h2>
            </div>
            <button className="icon-button" type="button" aria-label={t("nav.close")} onClick={cancelConfirmation}>×</button>
          </header>
          <p id="confirmation-body">{body}</p>
          {confirmation.kind === "reset" && (
            <label className="confirmation-phrase">
              <span>{t("privacy.clearDataConfirm")}</span>
              <input
                data-autofocus=""
                className="text-input"
                value={resetPhrase}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setResetPhrase(event.target.value)}
              />
            </label>
          )}
          <div className="confirmation-actions">
            <button
              className="secondary-action"
              data-autofocus={confirmation.kind === "reset" ? undefined : ""}
              type="button"
              onClick={cancelConfirmation}
            >
              {t("actions.cancel")}
            </button>
            {confirmation.kind === "duplicate" && (
              <button className="primary-action" type="button" onClick={() => {
                const card = confirmation.card;
                setConfirmation(null);
                applyCardSelection(card);
              }}>
                {t("reading.addDuplicateAnyway")}
              </button>
            )}
            {confirmation.kind === "delete" && (
              <button className="danger-action" type="button" onClick={confirmDeleteActiveReading}>{t("actions.delete")}</button>
            )}
            {confirmation.kind === "restore" && (
              <button className="danger-action" type="button" onClick={() => confirmRestoreBackup(confirmation.backup)}>{t("actions.replace")}</button>
            )}
            {confirmation.kind === "reset" && (
              <button className="danger-action" type="button" disabled={!resetMatches} onClick={resetApp}>{t("privacy.clearData")}</button>
            )}
          </div>
        </section>
      </div>
    );
  }

  function renderCardPicker(): ReactNode {
    return (
      <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPickerOpen(false); }}>
        <section ref={pickerDialogRef} className="card-picker" role="dialog" aria-modal="true" aria-labelledby="card-picker-title">
          <header>
            <div><p className="eyebrow">{activePosition?.name[language]}</p><h2 id="card-picker-title">{t("cardPicker.title")}</h2></div>
            <button className="icon-button" type="button" aria-label={t("nav.close")} onClick={() => setPickerOpen(false)}>×</button>
          </header>
          <label className="search-field card-search">
            <span aria-hidden="true">⌕</span>
            <span className="visually-hidden">{t("cardPicker.searchLabel")}</span>
            <input ref={pickerSearchInputRef} value={pickerSearch} onChange={(event) => setPickerSearch(event.target.value)} placeholder={t("cardPicker.searchPlaceholder")} />
          </label>
          <div className="filter-row" role="group" aria-label={t("cardPicker.filterLabel")}>
            {(["all", "major", "minor"] as CardFilter[]).map((filter) => (
              <button key={filter} type="button" aria-pressed={cardFilter === filter} onClick={() => setCardFilter(filter)}>
                {t(filter === "all" ? "cardPicker.filterAll" : filter === "major" ? "cardPicker.filterMajor" : "cardPicker.filterMinor")}
              </button>
            ))}
          </div>
          <div className="picker-meta">
            <p className="picker-hint">{t("cardPicker.searchHint")}</p>
            <p className="picker-result-count" role="status" aria-live="polite" aria-atomic="true">
              {t(
                filteredCards.length === 1
                  ? "cardPicker.resultsOne"
                  : "cardPicker.resultsMany",
                { count: filteredCards.length },
              )}
            </p>
          </div>
          <div className="card-results">
            {filteredCards.map((card) => {
              const used = usedCardIds.has(card.id) && activePull?.cardId !== card.id;
              return (
                <button key={card.id} type="button" className={activePull?.cardId === card.id ? "is-selected" : ""} onClick={() => selectCard(card)}>
                  <span className="card-result-number">{String(card.order + 1).padStart(2, "0")}</span>
                  <span className="card-result-titles">
                    <strong>{getCardDisplayName(card, language)}</strong>
                    {language === "nl" && appState.settings.showEnglishCardNamesInDutch && <small>{card.prismaTitleEn} / {card.cosmaTitleEn}</small>}
                  </span>
                  {card.combinedOnly ? <em>{t("cardPicker.combinedOnly")}</em> : used ? <em>{t("cardPicker.alreadyUsed")}</em> : <span aria-hidden="true">＋</span>}
                </button>
              );
            })}
            {!filteredCards.length && (
              <div className="empty-state"><h3>{t("cardPicker.noResultsTitle")}</h3><p>{t("cardPicker.noResultsBody")}</p></div>
            )}
          </div>
        </section>
      </div>
    );
  }

  function ReadingPreview({ reading, wide = false }: { reading: Reading; wide?: boolean }) {
    const progress = readingProgress(reading);
    const cards = reading.pulls
      .map((pull) => CARDS.find((card) => card.id === pull.cardId))
      .filter((card): card is CardDefinition => Boolean(card));
    return (
      <button className={`reading-preview${wide ? " reading-preview--wide" : ""}`} type="button" onClick={() => openReading(reading)}>
        <span className="preview-date">{formatDate(reading.performedAt, language, reading.timezone)}</span>
        <span className={`reading-state reading-state--${reading.status}`}>{t(reading.status === "draft" ? "reading.draft" : "reading.complete")}</span>
        <strong>{reading.question || reading.spreadSnapshot.name[language]}</strong>
        <small>{reading.spreadSnapshot.name[language]} · {progress.complete}/{progress.total}</small>
        <span className="preview-cards">
          {cards.slice(0, 4).map((card) => <i key={card.id} aria-hidden="true">{getCardDisplayName(card, language).slice(0, 1)}</i>)}
          {!cards.length && <i aria-hidden="true">＋</i>}
        </span>
        {wide && reading.initialReflection && <span className="preview-reflection">{reading.initialReflection}</span>}
        <span className="preview-open">{t("journal.openReading")} →</span>
      </button>
    );
  }

  function ControlGroup({ label, children }: { label: string; children: ReactNode }) {
    return <div className="field-block" role="group" aria-label={label}><span className="field-label">{label}</span><div className="segmented-control">{children}</div></div>;
  }
}
