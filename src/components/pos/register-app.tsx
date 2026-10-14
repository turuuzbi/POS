"use client";

import { ShoppingCart, WifiOff } from "lucide-react";
import type * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { computeTotals, type Cart } from "@/domain/cart";
import type { CheckoutResult } from "@/domain/checkout-contract";
import { DEFAULT_APPROVAL_POLICY, type ApprovalRequirement } from "@/domain/discounts";
import { hasPermission, type Role } from "@/domain/permissions";
import { isFractionalUnit, MILLI_PER_UNIT } from "@/domain/qty";
import { cashUnitForRounding } from "@/domain/tender";
import { createSerialQueue } from "@/lib/pos/serial-queue";
import { useBarcodeWedge } from "@/hooks/use-barcode-wedge";
import { useOnline } from "@/hooks/use-online";
import { usePosStore } from "@/hooks/use-pos-store";
import { snapshotOf, type CatalogEntry } from "@/lib/pos/catalog-entry";
import { buildCheckoutInput } from "@/lib/pos/charge";
import { storageScope, type HeldCart } from "@/lib/pos/hold-storage";
import { createShortcutGuard } from "@/lib/pos/scan-burst";
import {
  approvalFingerprint,
  type PosAction,
  approvalTokens,
  cartSettings,
  pendingApprovals,
  type PosConfig,
} from "@/lib/pos/pos-state";
import { checkoutAction } from "@/server/actions/checkout";
import { lookupCodeAction, refreshEntriesAction } from "@/server/actions/register";
import type { RegisterContext } from "@/server/queries/register";
import { ApprovalDialog } from "./approval-dialog";
import { CameraDialog } from "./camera-dialog";
import { CartPanel, type CartHandlers } from "./cart-panel";
import { CatalogGrid } from "./catalog-grid";
import { HeldDialog } from "./held-dialog";
import { HelpPopover } from "./help-popover";
import { DiscountDialog, NoteDialog, PriceDialog, QtyDialog } from "./line-dialogs";
import { OpenShiftScreen } from "./open-shift";
import { SearchBox } from "./search-box";
import { SuccessDialog } from "./success-dialog";
import { TenderDialog } from "./tender-dialog";
import { useFormat } from "./use-format";
import { VariantDialog } from "./variant-dialog";

type DialogState =
  | null
  | { type: "qty"; lineId: string }
  | { type: "weigh"; entry: CatalogEntry }
  | { type: "price"; lineId: string }
  | { type: "discount"; lineId: string | null }
  | { type: "note"; lineId: string }
  | { type: "approval"; thenCharge: boolean }
  | { type: "tender" }
  | { type: "held" }
  | { type: "camera" }
  | { type: "variants"; title: string; entries: CatalogEntry[] }
  | { type: "clear" }
  | { type: "duplicate" }
  | { type: "success"; result: CheckoutResult };

export interface RegisterAppProps {
  user: { id: string; name: string; role: Role };
  context: RegisterContext;
  /** Server-rendered header controls (back office, language/theme, user menu). */
  headerActions: React.ReactNode;
}

/** The touch-first register: catalog on the left, cart and totals on the right. */
export function RegisterApp({ user, context, headerActions }: RegisterAppProps) {
  const t = useTranslations("pos");
  const router = useRouter();
  const online = useOnline();
  const { device, shift } = context;

  if (!device || !device.registerId) {
    return (
      <div className="flex h-dvh flex-col">
        <Header
          title={t("title")}
          subtitle={t("cashier", { name: user.name })}
          actions={headerActions}
        />
        <main id="main" className="flex flex-1 items-center justify-center p-4">
          <div className="max-w-md space-y-2 rounded-xl border border-dashed bg-background p-8 text-center">
            <h1 className="text-lg font-semibold">{t("noRegister.title")}</h1>
            <p className="text-muted-foreground">{t("noRegister.description")}</p>
          </div>
        </main>
      </div>
    );
  }

  if (!shift) {
    return (
      <div className="flex h-dvh flex-col">
        <Header
          title={`${device.locationName} · ${device.registerName ?? device.name}`}
          subtitle={t("cashier", { name: user.name })}
          actions={headerActions}
        />
        <OpenShiftScreen registerName={device.registerName ?? device.name} />
      </div>
    );
  }

  return (
    <Selling
      key={shift.id}
      user={user}
      context={context}
      registerId={device.registerId}
      title={`${device.locationName} · ${device.registerName ?? device.name}`}
      headerActions={headerActions}
      online={online}
      onShiftLost={() => router.refresh()}
    />
  );
}

function Header({
  title,
  subtitle,
  actions,
  extra,
}: {
  title: string;
  subtitle: string;
  actions: React.ReactNode;
  extra?: React.ReactNode;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3">
      <div className="min-w-0">
        <p className="truncate font-semibold">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <div className="ml-auto flex items-center gap-1">
        {extra}
        {actions}
      </div>
    </header>
  );
}

function Selling({
  user,
  context,
  registerId,
  title,
  headerActions,
  online,
  onShiftLost,
}: {
  user: RegisterAppProps["user"];
  context: RegisterContext;
  registerId: string;
  title: string;
  headerActions: React.ReactNode;
  online: boolean;
  onShiftLost: () => void;
}) {
  const t = useTranslations("pos");
  const format = useFormat();
  const config: PosConfig = useMemo(
    () => ({
      totalRoundingUnit: context.settings.totalRoundingUnit,
      rules: context.settings.scaleRules,
    }),
    [context.settings],
  );
  const store = usePosStore(storageScope(registerId, user.id), config);
  const { state, dispatch } = store;
  const [dialog, setDialog] = useState<DialogState>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [announce, setAnnounce] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());
  // The latest state for callbacks that run after an await (a stale closure there
  // would reprice the cart that was on screen BEFORE the await).
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });

  // Prices for tiles/search come with each entry; quick-key entries seed the lookup.
  useEffect(() => {
    dispatch({ type: "entries", entries: context.entries });
  }, [context.entries, dispatch]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const totals = useMemo(() => {
    try {
      return computeTotals(state.cart, snapshotOf(state.entries), cartSettings(config));
    } catch {
      return computeTotals({ lines: [], discounts: [] }, { variants: {} }, cartSettings(config));
    }
  }, [state.cart, state.entries, config]);

  const pending = useMemo(
    () => pendingApprovals(state, config, user.role, now),
    [state, config, user.role, now],
  );
  const pendingKeys = useMemo(() => new Set(pending.map((p) => p.key)), [pending]);
  // An unconfirmed charge, or QPay money already taken: the cart must not change.
  const locked = store.locked;
  const modalOpen = dialog !== null;
  const canSkipApproval = (permission: ApprovalRequirement["permission"]) =>
    hasPermission(user.role, permission);

  const focusSearch = useCallback(() => {
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);
  const closeDialog = useCallback(() => {
    setDialog(null);
    focusSearch();
  }, [focusSearch]);

  /**
   * Dispatch an edit and, when it created a requirement the cashier cannot
   * satisfy, go straight to the manager-PIN dialog instead of closing.
   */
  const applyEdit = (action: PosAction) => {
    dispatch(action);
    const next = store.reducer(state, action);
    if (pendingApprovals(next, config, user.role, Date.now()).length > 0) {
      setDialog({ type: "approval", thenCharge: false });
    } else {
      closeDialog();
    }
  };

  // --- Adding items -------------------------------------------------------------

  const guardLocked = useCallback(() => {
    if (!locked) return false;
    toast.error(t("pending.locked"));
    return true;
  }, [locked, t]);

  /** Add to the cart; says so (and announces) only when the cart really took it. */
  const commitAdd = useCallback(
    (action: Extract<PosAction, { type: "add" | "addScale" }>): boolean => {
      if (store.reducer(latest.current, action) === latest.current) {
        toast.error(t("search.addRejected"));
        return false;
      }
      dispatch(action);
      setAnnounce(t("announce.added", { name: action.entry.label }));
      return true;
    },
    [dispatch, store, t],
  );

  const addEntry = useCallback(
    (entry: CatalogEntry, qtyMilli?: number): boolean => {
      if (guardLocked()) return false;
      if (isFractionalUnit(entry.unit) && qtyMilli === undefined) {
        setDialog({ type: "weigh", entry });
        return true;
      }
      return commitAdd({
        type: "add",
        entry,
        qtyMilli: qtyMilli ?? MILLI_PER_UNIT,
        lineId: uuidv4(),
      });
    },
    [commitAdd, guardLocked],
  );

  const resolveCode = useCallback(
    async (code: string, qtyMilli?: number, options?: { quiet?: boolean }): Promise<boolean> => {
      if (guardLocked()) return true;
      try {
        const result = await lookupCodeAction({ code });
        if (!result.ok) {
          if (!options?.quiet) toast.error(t("search.lookupFailed"));
          return false;
        }
        const { entry, scaleBarcode } = result.data;
        if (!entry) {
          if (!options?.quiet) toast.error(t("search.codeNotFound", { code }));
          return false;
        }
        if (scaleBarcode) {
          commitAdd({ type: "addScale", entry, barcode: scaleBarcode, lineId: uuidv4() });
        } else {
          addEntry(entry, qtyMilli);
        }
        return true;
      } catch {
        if (!options?.quiet) toast.error(t("search.lookupFailed"));
        return false;
      }
    },
    [addEntry, commitAdd, guardLocked, t],
  );

  // Scans arriving while a lookup is in flight are resolved in scan order, none dropped.
  const scanQueue = useRef(createSerialQueue());
  useBarcodeWedge({
    enabled: !modalOpen && !locked,
    onScan: (code) => void scanQueue.current.run(() => resolveCode(code)),
  });

  // --- Cart handlers ----------------------------------------------------------------

  const lineOf = (lineId: string) => state.cart.lines.find((l) => l.lineId === lineId);

  const { reconcilePayment } = store;
  const startCharge = useCallback(() => {
    if (!online || store.conflict) return;
    if (locked) {
      setDialog({ type: "tender" });
      return;
    }
    if (state.cart.lines.every((l) => l.voided)) return;
    // Tenders taken for another amount no longer apply.
    reconcilePayment(totals.payable);
    if (pending.length > 0) setDialog({ type: "approval", thenCharge: true });
    else setDialog({ type: "tender" });
  }, [
    locked,
    online,
    pending.length,
    reconcilePayment,
    state.cart.lines,
    store.conflict,
    totals.payable,
  ]);

  const openHeld = useCallback(() => {
    // Resuming parks this cart, which would lose the unconfirmed charge / payment.
    if (guardLocked()) return;
    setDialog({ type: "held" });
  }, [guardLocked]);

  const hold = useCallback(() => {
    if (guardLocked()) return;
    const result = store.holdCurrent();
    if (result === "LOCKED") {
      toast.error(t("pending.locked"));
    } else if (result === "OK") {
      toast.success(t("held.parked"));
      setCartOpen(false);
      focusSearch();
    } else if (result === "FULL") {
      toast.error(t("held.full"));
    }
  }, [focusSearch, guardLocked, store, t]);

  const handlers: CartHandlers = {
    onStep: (lineId, delta) => {
      if (guardLocked()) return;
      const line = lineOf(lineId);
      if (!line) return;
      const next = line.qtyMilli + delta;
      dispatch(
        next <= 0
          ? { type: "cart", action: { type: "REMOVE_LINE", lineId } }
          : { type: "cart", action: { type: "SET_QTY", lineId, qtyMilli: next } },
      );
    },
    onEditQty: (lineId) => !guardLocked() && setDialog({ type: "qty", lineId }),
    onPrice: (lineId) => !guardLocked() && setDialog({ type: "price", lineId }),
    onLineDiscount: (lineId) => !guardLocked() && setDialog({ type: "discount", lineId }),
    onNote: (lineId) => !guardLocked() && setDialog({ type: "note", lineId }),
    onVoid: (lineId) =>
      !guardLocked() && dispatch({ type: "cart", action: { type: "VOID_LINE", lineId } }),
    onRemove: (lineId) =>
      !guardLocked() && dispatch({ type: "cart", action: { type: "REMOVE_LINE", lineId } }),
    onCartDiscount: () => !guardLocked() && setDialog({ type: "discount", lineId: null }),
    onClear: () => !guardLocked() && setDialog({ type: "clear" }),
    onHold: hold,
    onHeld: openHeld,
    onApprove: () => setDialog({ type: "approval", thenCharge: false }),
    onCharge: startCharge,
    onClose: () => setCartOpen(false),
  };

  // --- Keyboard shortcuts -------------------------------------------------------------

  useEffect(() => {
    const guard = createShortcutGuard();
    const onKeyDown = (event: KeyboardEvent) => {
      // A scanner's burst (the wedge already swallowed most of it) or a held key is
      // typing, not a shortcut: a "/" or "?" inside a scanned code must not steal it.
      if (
        guard.ignore({
          key: event.key,
          time: event.timeStamp,
          defaultPrevented: event.defaultPrevented,
          repeat: event.repeat,
        })
      ) {
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (event.key === "?" && !typing) {
        event.preventDefault();
        setHelpOpen((open) => !open);
        return;
      }
      if (modalOpen) return;
      switch (event.key) {
        case "/":
          if (typing) return;
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          break;
        case "F6":
          event.preventDefault();
          searchRef.current?.focus();
          break;
        case "F2":
          event.preventDefault();
          startCharge();
          break;
        case "F3":
          event.preventDefault();
          hold();
          break;
        case "F4":
          event.preventDefault();
          openHeld();
          break;
        case "F7":
          event.preventDefault();
          setDialog({ type: "camera" });
          break;
        case "F8":
          event.preventDefault();
          if (!locked) setDialog({ type: "discount", lineId: null });
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hold, locked, modalOpen, openHeld, startCharge]);

  // --- Dialog callbacks --------------------------------------------------------------

  /** Take the current catalog prices for `cart` (default: the one on screen right now). */
  const refreshPrices = useCallback(
    async (cart: Cart = latest.current.cart) => {
      const ids = [...new Set(cart.lines.map((l) => l.variantId))];
      if (ids.length === 0) return 0;
      try {
        const result = await refreshEntriesAction({ variantIds: ids });
        if (!result.ok) return 0;
        const changed = result.data.filter((entry) =>
          cart.lines.some((l) => l.variantId === entry.variantId && l.unitPrice !== entry.price),
        ).length;
        dispatch({ type: "reprice", entries: result.data });
        return changed;
      } catch {
        return 0;
      }
    },
    [dispatch],
  );

  // A draft restored after a reload may be days old: look at the prices once.
  const repricedDraft = useRef(false);
  useEffect(() => {
    if (!store.hydrated || repricedDraft.current) return;
    repricedDraft.current = true;
    if (store.locked || latest.current.cart.lines.length === 0) return;
    void refreshPrices(latest.current.cart).then((changed) => {
      if (changed > 0) toast.warning(t("pending.pricesUpdated"));
    });
  }, [refreshPrices, store.hydrated, store.locked, t]);

  const onResume = async (cart: HeldCart) => {
    const outcome = store.resume(cart);
    if (outcome === "FULL") {
      toast.error(t("held.full"));
      return;
    }
    if (outcome === "LOCKED") {
      toast.error(t("pending.locked"));
      return;
    }
    setDialog(null);
    focusSearch();
    // The resumed cart, not the stale closure's: store.resume has only queued the load.
    const changed = await refreshPrices(cart.cart);
    if (changed > 0) toast.warning(t("held.pricesChanged"));
  };

  const describe = (requirement: ApprovalRequirement): string => {
    const line = requirement.lineId ? lineOf(requirement.lineId) : undefined;
    const name = line ? (state.entries[line.variantId]?.label ?? "") : "";
    if (requirement.kind === "PRICE_OVERRIDE") return t("approval.price", { name });
    return requirement.scope === "CART"
      ? t("approval.cartDiscount")
      : t("approval.lineDiscount", { name });
  };

  const buildInput = (tenders: Parameters<typeof buildCheckoutInput>[0]["tenders"]) =>
    buildCheckoutInput({
      saleId: state.saleId,
      cart: state.cart,
      tenders,
      expectedPayable: totals.payable,
      approvals: approvalTokens(state, config),
    });

  const activeLine =
    dialog && "lineId" in dialog && dialog.lineId ? lineOf(dialog.lineId) : undefined;
  const activeEntry = activeLine ? state.entries[activeLine.variantId] : undefined;
  const itemCount = state.cart.lines.filter((l) => !l.voided).length;
  const lineDiscountTotal = totals.lines.reduce((acc, l) => acc + l.lineDiscount, 0n);

  return (
    <div className="flex h-dvh flex-col">
      <Header
        title={title}
        subtitle={t("cashier", { name: user.name })}
        actions={headerActions}
        extra={
          <>
            {!online ? (
              <Badge variant="destructive" role="status">
                <WifiOff aria-hidden /> {t("offline.badge")}
              </Badge>
            ) : null}
            <HelpPopover open={helpOpen} onOpenChange={setHelpOpen} />
          </>
        }
      />
      {!online ? (
        <p role="status" className="bg-destructive/10 px-3 py-1.5 text-center text-sm">
          {t("offline.banner")}
        </p>
      ) : null}
      {locked ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-center gap-3 bg-warning/25 px-3 py-2 text-sm"
        >
          <span>{store.pendingCharge ? t("pending.banner") : t("pending.paymentBanner")}</span>
          <Button size="sm" onClick={() => setDialog({ type: "tender" })}>
            {store.pendingCharge ? t("pending.retry") : t("pending.paymentResume")}
          </Button>
        </div>
      ) : null}

      <main
        id="main"
        className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_26rem]"
      >
        <div className="flex min-h-0 min-w-0 flex-col gap-3 p-3 pb-20 lg:pb-3">
          <SearchBox
            inputRef={searchRef}
            disabled={locked}
            onPick={(entry, qty) => addEntry(entry, qty)}
            onCode={resolveCode}
            onCamera={() => setDialog({ type: "camera" })}
          />
          <CatalogGrid
            quickKeys={context.quickKeys}
            categories={context.categories}
            entries={state.entries}
            onPick={(entry) => addEntry(entry)}
            onChoose={(entries, name) => setDialog({ type: "variants", title: name, entries })}
          />
        </div>

        <CartPanel
          state={state}
          totals={totals}
          pendingKeys={pendingKeys}
          heldCount={store.held.length}
          offline={!online}
          charging={false}
          handlers={handlers}
          className={
            cartOpen ? "fixed inset-0 z-40 lg:static lg:z-auto" : "hidden border-l lg:flex"
          }
        />
      </main>

      <div className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t bg-background p-3 lg:hidden">
        <Button
          size="lg"
          className="w-full justify-between"
          onClick={() => setCartOpen(true)}
          aria-label={t("cart.open", { count: itemCount })}
        >
          <span className="flex items-center gap-2">
            <ShoppingCart aria-hidden /> {itemCount}
          </span>
          <span className="tabular-nums">{format.money(totals.payable)}</span>
        </Button>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>

      {/* --- dialogs ----------------------------------------------------------------- */}

      {dialog?.type === "weigh" ? (
        <QtyDialog
          open
          onClose={closeDialog}
          title={dialog.entry.label}
          unit={dialog.entry.unit}
          qtyMilli={null}
          onSubmit={(qtyMilli) => {
            if (commitAdd({ type: "add", entry: dialog.entry, qtyMilli, lineId: uuidv4() })) {
              closeDialog();
            }
          }}
        />
      ) : null}

      {dialog?.type === "qty" && activeLine && activeEntry ? (
        <QtyDialog
          open
          onClose={closeDialog}
          title={activeEntry.label}
          unit={activeEntry.unit}
          qtyMilli={activeLine.qtyMilli}
          onSubmit={(qtyMilli) => {
            dispatch({
              type: "cart",
              action: { type: "SET_QTY", lineId: activeLine.lineId, qtyMilli },
            });
            closeDialog();
          }}
        />
      ) : null}

      {dialog?.type === "price" && activeLine && activeEntry ? (
        <PriceDialog
          open
          onClose={closeDialog}
          title={activeEntry.label}
          listedPrice={activeLine.unitPrice}
          currentOverride={activeLine.priceOverride}
          onSubmit={(price) => {
            applyEdit({
              type: "cart",
              action: { type: "SET_PRICE_OVERRIDE", lineId: activeLine.lineId, price },
            });
          }}
          onReset={() => {
            dispatch({
              type: "cart",
              action: { type: "SET_PRICE_OVERRIDE", lineId: activeLine.lineId, price: null },
            });
            closeDialog();
          }}
        />
      ) : null}

      {dialog?.type === "discount" ? (
        <DiscountDialog
          open
          onClose={closeDialog}
          title={dialog.lineId && activeEntry ? activeEntry.label : t("discount.cartTitle")}
          base={
            dialog.lineId
              ? (totals.lines.find((l) => l.lineId === dialog.lineId)?.subtotal ?? 0n)
              : totals.subtotal - lineDiscountTotal
          }
          hasExisting={
            dialog.lineId
              ? (activeLine?.discounts.length ?? 0) > 0
              : state.cart.discounts.length > 0
          }
          canSkipApproval={canSkipApproval("pos.discount.manual")}
          maxBpsWithoutApproval={DEFAULT_APPROVAL_POLICY.maxDiscountBpsWithoutApproval}
          onApply={(discount) => {
            applyEdit({
              type: "cart",
              action: dialog.lineId
                ? { type: "ADD_LINE_DISCOUNT", lineId: dialog.lineId, discount }
                : { type: "APPLY_CART_DISCOUNT", discount },
            });
          }}
          onClear={() => {
            dispatch({
              type: "cart",
              action: dialog.lineId
                ? { type: "CLEAR_LINE_DISCOUNTS", lineId: dialog.lineId }
                : { type: "CLEAR_CART_DISCOUNTS" },
            });
            closeDialog();
          }}
        />
      ) : null}

      {dialog?.type === "note" && activeLine && activeEntry ? (
        <NoteDialog
          open
          onClose={closeDialog}
          title={activeEntry.label}
          note={activeLine.note ?? ""}
          onSubmit={(note) => {
            dispatch({
              type: "cart",
              action: { type: "SET_NOTE", lineId: activeLine.lineId, note },
            });
            closeDialog();
          }}
        />
      ) : null}

      {dialog?.type === "approval" ? (
        <ApprovalDialog
          open
          onClose={closeDialog}
          saleId={state.saleId}
          pending={pending}
          describe={describe}
          fingerprintOf={(requirement) => approvalFingerprint(requirement)}
          onGranted={(grants, complete) => {
            dispatch({ type: "approve", grants });
            if (!complete) return;
            if (dialog.thenCharge) setDialog({ type: "tender" });
            else closeDialog();
          }}
        />
      ) : null}

      {dialog?.type === "tender" && !store.conflict ? (
        <TenderDialog
          open
          onClose={closeDialog}
          payment={store.payment}
          onPayment={store.setPayment}
          payable={totals.payable}
          cashUnit={cashUnitForRounding(config.totalRoundingUnit)}
          saleId={state.saleId}
          buildInput={buildInput}
          charge={checkoutAction}
          resume={store.pendingCharge}
          onPending={store.setPendingCharge}
          onSuccess={(result) => {
            store.newSale();
            setCartOpen(false);
            setDialog({ type: "success", result });
          }}
          onProblem={async (kind) => {
            setDialog(null);
            if (kind === "DUPLICATE_SALE") {
              // This sale id is already recorded and this register never sent it: a
              // second tab or a stale draft. Nothing was charged now; start over.
              store.newSale();
              setCartOpen(false);
              setDialog({ type: "duplicate" });
            } else if (kind === "STALE_PRICE") {
              await refreshPrices();
              toast.warning(t("pending.pricesUpdated"));
            } else if (kind === "APPROVAL") {
              dispatch({ type: "dropApprovals" });
              toast.warning(t("pending.approvalExpired"));
              setDialog({ type: "approval", thenCharge: true });
            } else {
              toast.error(t("pending.shiftClosed"));
              onShiftLost();
            }
          }}
        />
      ) : null}

      {dialog?.type === "success" ? (
        <SuccessDialog
          result={dialog.result}
          onNewSale={() => {
            setDialog(null);
            focusSearch();
          }}
        />
      ) : null}

      {dialog?.type === "held" ? (
        <HeldDialog
          open
          onClose={closeDialog}
          held={store.held}
          now={now}
          totalRoundingUnit={config.totalRoundingUnit}
          onResume={(cart) => void onResume(cart)}
          onDiscard={store.discardHeld}
        />
      ) : null}

      {dialog?.type === "camera" ? (
        <CameraDialog onClose={closeDialog} onDetect={(code) => resolveCode(code)} />
      ) : null}

      {dialog?.type === "variants" ? (
        <VariantDialog
          title={dialog.title}
          entries={dialog.entries}
          onClose={closeDialog}
          onPick={(entry) => {
            addEntry(entry);
            if (!isFractionalUnit(entry.unit)) closeDialog();
          }}
        />
      ) : null}

      <AlertDialog open={dialog?.type === "duplicate"}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("duplicate.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("duplicate.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={closeDialog}>{t("duplicate.ok")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={store.conflict}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("conflict.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("conflict.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              onClick={() => {
                store.adoptStored();
                setDialog(null);
                setCartOpen(false);
              }}
            >
              {t("conflict.reload")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={dialog?.type === "clear"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("clearConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("clearConfirm.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("clearConfirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                dispatch({ type: "cart", action: { type: "CLEAR" } });
              }}
            >
              {t("clearConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
