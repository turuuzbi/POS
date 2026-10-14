"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import type { CheckoutInputWire } from "@/domain/checkout-contract";
import {
  clearDraft,
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
  /** Start a fresh sale (new UUIDv7): only after a completed sale or a parked cart. */
  newSale: () => void;
  /** Park the current cart and open a new one. */
  holdCurrent: () => "OK" | "EMPTY" | "FULL";
  resume: (cart: HeldCart) => "OK" | "FULL";
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
  const [state, dispatch] = useReducer(reducer, undefined, () => initialPosState(uuidv7()));
  const [hydrated, setHydrated] = useState(false);
  const [held, setHeld] = useState<readonly HeldCart[]>([]);
  const [pendingCharge, setPendingChargeState] = useState<CheckoutInputWire | null>(null);
  const openedAt = useRef(0);
  const storage = useRef<StorageLike | null>(null);

  useEffect(() => {
    storage.current = browserStorage();
    const draft = loadDraft(storage.current, scope);
    openedAt.current = draft?.createdAt ?? Date.now();
    if (draft) {
      dispatch({
        type: "load",
        state: {
          saleId: draft.saleId,
          cart: draft.cart,
          approvals: {},
          entries: indexEntries(draft.entries),
        },
      });
      if (draft.pendingCharge) setPendingChargeState(draft.pendingCharge as CheckoutInputWire);
    }
    setHeld(loadHeld(storage.current, scope));
    setHydrated(true);
  }, [scope]);

  useEffect(() => {
    if (!hydrated) return;
    if (isCartEmpty(state.cart) && state.cart.lines.length === 0 && !pendingCharge) {
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
    });
  }, [hydrated, scope, state, pendingCharge]);

  const newSale = useCallback(() => {
    openedAt.current = Date.now();
    setPendingChargeState(null);
    dispatch({ type: "reset", saleId: uuidv7() });
  }, []);

  const holdCurrent = useCallback((): "OK" | "EMPTY" | "FULL" => {
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
  }, [scope, state, newSale]);

  const resume = useCallback(
    (cart: HeldCart): "OK" | "FULL" => {
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
      dispatch({
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
    [scope, state],
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
    newSale,
    holdCurrent,
    resume,
    discardHeld,
  };
}
