import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type RouteName = "dash" | "camps" | "detail" | "review" | "models" | "infra" | "settings";
export type WizardSource = "url" | "input" | "spec";

export interface ToastState {
  cmd: string;
  cap: string;
  isError: boolean;
}

interface StoreShape {
  route: RouteName;
  camp: string | null;
  go: (route: RouteName, camp?: string) => void;
  toast: (cmd: string, cap?: string) => void;
  toastError: (message: string) => void;
  toastState: ToastState | null;
  hideToast: () => void;
  modal: ReactNode | null;
  openModal: (node: ReactNode) => void;
  closeModal: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  wizardOpen: boolean;
  wizardSource: WizardSource | null;
  setWizardOpen: (open: boolean, source?: WizardSource | null) => void;
}

const StoreCtx = createContext<StoreShape | null>(null);

export function StoreProvider({ children }: { children: ReactNode }): JSX.Element {
  const [route, setRoute] = useState<RouteName>("dash");
  const [camp, setCamp] = useState<string | null>(null);
  const [toastState, setToastState] = useState<ToastState | null>(null);
  const [modal, setModal] = useState<ReactNode | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [wizardOpen, setWizardOpenState] = useState(false);
  const [wizardSource, setWizardSource] = useState<WizardSource | null>(null);
  const setWizardOpen = useCallback((open: boolean, source: WizardSource | null = null) => {
    setWizardOpenState(open);
    setWizardSource(source);
  }, []);

  const go = useCallback((r: RouteName, c?: string) => {
    setRoute(r);
    if (c !== undefined) setCamp(c);
    window.scrollTo(0, 0);
  }, []);
  const toast = useCallback((cmd: string, cap = "已执行 · CLI 等价命令") => setToastState({ cmd, cap, isError: false }), []);
  const toastError = useCallback((message: string) => setToastState({ cmd: message, cap: "出错了", isError: true }), []);
  const hideToast = useCallback(() => setToastState(null), []);
  const openModal = useCallback((node: ReactNode) => setModal(node), []);
  const closeModal = useCallback(() => setModal(null), []);

  const value = useMemo(
    () => ({
      route,
      camp,
      go,
      toast,
      toastError,
      toastState,
      hideToast,
      modal,
      openModal,
      closeModal,
      paletteOpen,
      setPaletteOpen,
      wizardOpen,
      wizardSource,
      setWizardOpen,
    }),
    [route, camp, go, toast, toastError, toastState, hideToast, modal, openModal, closeModal, paletteOpen, wizardOpen, wizardSource, setWizardOpen],
  );
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore(): StoreShape {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error("useStore outside StoreProvider");
  return ctx;
}
