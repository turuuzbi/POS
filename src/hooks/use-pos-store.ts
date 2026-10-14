"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import type { CheckoutInputWire } from "@/domain/checkout-contract";
import {
  clearDraft,
  draftKey,
  heldKey,
  holdCart,
  loadDraft,
  loadHeld,
  releaseHeld,
  saveDraft,
  type HeldCart,
  type StorageLike,
} from "@/lib/pos/hold-storage";
import { indexEntries } from "@/lib/pos/catalog-entry";
import {
  EMPTY_PAYMENT,
  dropUnlockedPayment,
  hasLockedPayment,
  isPaymentEmpty,
  reconcilePayment,
  type PaymentState,
} from "@/lib/pos/payment-state";
import type { Money } from "@/domain/money";
import {
  createPosReducer,
  initialPosState,
  isCartEmpty,
  type PosAction,
  type PosConfig,
  type PosState,
} from "@/lib/pos/pos-state";

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // blocked storage (private mode, policy)
  }
}

export interface PosStore {
  state: PosState;
  dispatch: (action: PosAction) => void;
  hydrated: boolean;
  held: readonly HeldCart[];
  /** The pure reducer, to preview the effect of an action before dispatching it. */
  reducer: (state: PosState, action: PosAction) => PosState;
  /** A charge whose outcome is unknown: it is resent as-is, never rebuilt. */
  pendingCharge: CheckoutInputWire | null;
  setPendingCharge: (input: CheckoutInputWire | null) => void;
  /** Payments taken for this sale (survive the tender dialog closing and reloads). */
  payment: PaymentState;
  setPayment: (update: (current: PaymentState) => PaymentState) => void;
  /** Drop tenders taken for another amount; call before opening the tender dialog. */
  reconcilePayment: (payable: Money) => void;
  /** A charge with unknown outcome, or money taken by QPay: the cart must not change. */
  locked: boolean;
  /** Another tab changed this register's saved draft: this tab must not keep selling. */
  conflict: boolean;
  /** Take over the other tab's latest state and carry on. */
  adoptStored: () => void;
  /** Start a fresh sale (new UUIDv7): only after a completed sale or a parked cart. */
  newSale: () => void;
  /** Park the current cart and open a new one. */
  holdCurrent: () => "OK" | "EMPTY" | "FULL" | "LOCKED";
  resume: (cart: HeldCart) => "OK" | "FULL" | "LOCKED";
  discardHeld: (cart: HeldCart) => void;
}

/**
 * The register's cart: reducer state, a draft saved on every change (a reload
 * loses nothing) and parked carts. Everything is scoped per register + cashier.
 */
export function usePosStore(scope: string, config: PosConfig): PosStore {
  const reducer = useMemo(
    () => createPosReducer(config),
    // the reducer only reads the rounding unit and scale rules
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.totalRoundingUnit, config.rules],
  );
  const [state, rawDispatch] = useReducer(reducer, undefined, () => initialPosState(uuidv7()));
  const [hydrated, setHydrated] = useState(false);
  const [held, setHeld] = useState<readonly HeldCart[]>([]);
  const [pendingCharge, setPendingChargeState] = useState<CheckoutInputWire | null>(null);
  const [payment, setPaymentState] = useState<PaymentState>(EMPTY_PAYMENT);
  const [conflict, setConflict] = useState(false);
  const openedAt = useRef(0);
  const storage = useRef<StorageLike | null>(null);

  // A cart change invalidates tenders that real QPay money does not pin.
  const dispatch = useCallback((action: PosAction) => {
    if (action.type === "add" || action.type === "addScale" || action.type === "cart") {
      setPaymentState(dropUnlockedPayment);
    }
    rawDispatch(action);
  }, []);

  const locked = pendingCharge !== null || hasLockedPayment(payment);

  useEffect(() => {
    storage.current = browserStorage();
    const draft = loadDraft(storage.current, scope);
    openedAt.current = draft?.createdAt ?? Date.now();
    if (draft) {
      rawDispatch({
        type: "load",
        state: {
          saleId: draft.saleId,
          cart: draft.cart,
          approvals: {},
          entries: indexEntries(draft.entries),
        },
      });
      if (draft.pendingCharge) setPendingChargeState(draft.pendingCharge as CheckoutInputWire);
      if (draft.payment) setPaymentState(draft.payment);
    }
    setHeld(loadHeld(storage.current, scope));
    setHydrated(true);
  }, [scope]);

  // Two tabs on one register would both write the draft and could re-sell a
  // completed sale id. The tab that sees the other one write stops saving and
  // asks the cashier to take over the latest state first.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== null && event.storageArea !== storage.current) return;
      if (event.key === null || event.key === draftKey(scope)) setConflict(true);
      if (event.key === null || event.key === heldKey(scope)) {
        setHeld(loadHeld(storage.current, scope));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [scope]);

  useEffect(() => {
    if (!hydrated || conflict) return;
    if (
      isCartEmpty(state.cart) &&
      state.cart.lines.length === 0 &&
      !pendingCharge &&
      isPaymentEmpty(payment)
    ) {
      clearDraft(storage.current, scope);
      return;
    }
    const used = new Set(state.cart.lines.map((l) => l.variantId));
    saveDraft(storage.current, scope, {
      saleId: state.saleId,
      createdAt: openedAt.current,
      cart: state.cart,
      entries: Object.values(state.entries).filter((e) => used.has(e.variantId)),
      ...(pendingCharge ? { pendingCharge } : {}),
      ...(isPaymentEmpty(payment) ? {} : { payment }),
    });
  }, [hydrated, conflict, scope, state, pendingCharge, payment]);

  const adoptStored = useCallback(() => {
    const draft = loadDraft(storage.current, scope);
    setHeld(loadHeld(storage.current, scope));
    if (draft) {
      openedAt.current = draft.createdAt;
      rawDispatch({
        type: "load",
        state: {
          saleId: draft.saleId,
          cart: draft.cart,
          approvals: {},
          entries: indexEntries(draft.entries),
        },
      });
      setPendingChargeState((draft.pendingCharge as CheckoutInputWire | undefined) ?? null);
      setPaymentState(draft.payment ?? EMPTY_PAYMENT);
    } else {
      openedAt.current = Date.now();
      rawDispatch({ type: "reset", saleId: uuidv7() });
      setPendingChargeState(null);
      setPaymentState(EMPTY_PAYMENT);
    }
    setConflict(false);
  }, [scope]);

  const newSale = useCallback(() => {
    openedAt.current = Date.now();
    setPendingChargeState(null);
    setPaymentState(EMPTY_PAYMENT);
    rawDispatch({ type: "reset", saleId: uuidv7() });
  }, []);

  const holdCurrent = useCallback((): "OK" | "EMPTY" | "FULL" | "LOCKED" => {
    // A parked cart has no pending charge / QPay payment: it would lose them.
    if (locked) return "LOCKED";
    const result = holdCart(
      storage.current,
      scope,
      {
        saleId: state.saleId,
        createdAt: openedAt.current,
        cart: state.cart,
        entries: state.entries,
      },
      Date.now(),
    );
    if (!result.ok) return result.reason;
    setHeld(result.held);
    newSale();
    return "OK";
  }, [scope, state, newSale, locked]);

  const resume = useCallback(
    (cart: HeldCart): "OK" | "FULL" | "LOCKED" => {
      if (locked) return "LOCKED";
      // Park whatever is on the screen first (an empty cart is simply not parked).
      const parked = holdCart(
        storage.current,
        scope,
        {
          saleId: state.saleId,
          createdAt: openedAt.current,
          cart: state.cart,
          entries: state.entries,
        },
        Date.now(),
      );
      if (!parked.ok && parked.reason === "FULL") return "FULL";
      setHeld(releaseHeld(storage.current, scope, cart.saleId));
      openedAt.current = cart.createdAt;
      setPendingChargeState(null);
      setPaymentState(EMPTY_PAYMENT);
      rawDispatch({
        type: "load",
        state: {
          saleId: cart.saleId,
          cart: cart.cart,
          approvals: {},
          entries: indexEntries(cart.entries),
        },
      });
      return "OK";
    },
    [scope, state, locked],
  );

  const discardHeld = useCallback(
    (cart: HeldCart) => setHeld(releaseHeld(storage.current, scope, cart.saleId)),
    [scope],
  );

  return {
    state,
    dispatch,
    reducer,
    hydrated,
    held,
    pendingCharge,
    setPendingCharge: setPendingChargeState,
    payment,
    setPayment: setPaymentState,
    reconcilePayment: (payable: Money) => setPaymentState((p) => reconcilePayment(p, payable)),
    locked,
    conflict,
    adoptStored,
    newSale,
    holdCurrent,
    resume,
    discardHeld,
  };
}
