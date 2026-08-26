import { useEffect } from 'react';
import { create } from 'zustand';
import type { MissionBoardCard, PlanFactualRegister } from '../../shared/types';

/** WP-P6B-transport: the single, named cadence for mission-board reads. */
export const MISSION_BOARD_POLL_INTERVAL_MS = 5_000;

export type MissionBoardList = (
  planId: string,
) => Promise<MissionBoardCard[] | null>;

export type PlanFactualRegisterRead = (
  planId: string,
) => Promise<PlanFactualRegister | null>;

interface MissionBoardSnapshot {
  cards: MissionBoardCard[];
  error: string | null;
  loading: boolean;
}

interface PlanFactualRegisterSnapshot {
  register: PlanFactualRegister | null;
  error: string | null;
  loading: boolean;
}

interface MissionBoardStoreState {
  boards: Record<string, MissionBoardSnapshot>;
  factualRegisters: Record<string, PlanFactualRegisterSnapshot>;
  setLoading: (planId: string) => void;
  setCards: (planId: string, cards: MissionBoardCard[]) => void;
  setError: (planId: string, error: string) => void;
  setFactualRegisterLoading: (planId: string) => void;
  setFactualRegister: (planId: string, register: PlanFactualRegister | null) => void;
  setFactualRegisterError: (planId: string, error: string) => void;
}

const EMPTY_CARDS: MissionBoardCard[] = [];

export const useMissionBoardStore = create<MissionBoardStoreState>((set) => ({
  boards: {},
  factualRegisters: {},
  setLoading: (planId) => set((state) => ({
    boards: {
      ...state.boards,
      [planId]: {
        cards: state.boards[planId]?.cards ?? EMPTY_CARDS,
        error: null,
        loading: true,
      },
    },
  })),
  setCards: (planId, cards) => set((state) => ({
    boards: {
      ...state.boards,
      [planId]: { cards, error: null, loading: false },
    },
  })),
  setError: (planId, error) => set((state) => ({
    boards: {
      ...state.boards,
      [planId]: {
        cards: state.boards[planId]?.cards ?? EMPTY_CARDS,
        error,
        loading: false,
      },
    },
  })),
  setFactualRegisterLoading: (planId) => set((state) => ({
    factualRegisters: {
      ...state.factualRegisters,
      [planId]: {
        register: state.factualRegisters[planId]?.register ?? null,
        error: null,
        loading: true,
      },
    },
  })),
  setFactualRegister: (planId, register) => set((state) => ({
    factualRegisters: {
      ...state.factualRegisters,
      [planId]: { register, error: null, loading: false },
    },
  })),
  setFactualRegisterError: (planId, error) => set((state) => ({
    factualRegisters: {
      ...state.factualRegisters,
      [planId]: {
        register: state.factualRegisters[planId]?.register ?? null,
        error,
        loading: false,
      },
    },
  })),
}));

export interface MissionBoardPollingResult {
  cards: MissionBoardCard[];
  error: string | null;
  loading: boolean;
}

export interface PlanFactualRegisterResult {
  register: PlanFactualRegister | null;
  error: string | null;
  loading: boolean;
}

/** Load the async Git/ledger/ARC projection once per visible plan mount.
 *
 * This deliberately has no interval and is not called by the board poll. A
 * failed projection preserves any prior register and cannot affect board cards.
 */
export function usePlanFactualRegister(
  planId: string | null | undefined,
  paneVisible: boolean,
  readRegister: PlanFactualRegisterRead,
): PlanFactualRegisterResult {
  const snapshot = useMissionBoardStore((state) =>
    planId ? state.factualRegisters[planId] : undefined);

  useEffect(() => {
    if (!planId || !paneVisible) return;

    let active = true;
    const { setFactualRegisterLoading, setFactualRegister, setFactualRegisterError } =
      useMissionBoardStore.getState();
    setFactualRegisterLoading(planId);
    void readRegister(planId).then(
      (register) => { if (active) setFactualRegister(planId, register); },
      (error: unknown) => {
        if (!active) return;
        setFactualRegisterError(planId, error instanceof Error ? error.message : String(error));
      },
    );
    return () => { active = false; };
  }, [paneVisible, planId, readRegister]);

  return snapshot ?? { register: null, error: null, loading: false };
}

/**
 * Poll the one-shot `plan:board:list` transport while its pane is visible.
 *
 * `listCards` is injected because WP-P6C owns the preload bridge. A sequence is
 * allocated for every request; only the newest request may publish, and effect
 * cleanup advances the sequence so responses arriving after hide/unmount or a
 * plan change are inert.
 */
export function useMissionBoardPolling(
  planId: string | null | undefined,
  paneVisible: boolean,
  listCards: MissionBoardList,
): MissionBoardPollingResult {
  const snapshot = useMissionBoardStore((state) =>
    planId ? state.boards[planId] : undefined);

  useEffect(() => {
    if (!planId || !paneVisible) return;

    let requestSequence = 0;
    let active = true;
    const { setLoading, setCards, setError } = useMissionBoardStore.getState();

    const pollMissionBoard = () => {
      const sequence = ++requestSequence;
      setLoading(planId);
      void listCards(planId).then(
        (cards) => {
          if (!active || sequence !== requestSequence) return;
          setCards(planId, cards ?? []);
        },
        (error: unknown) => {
          if (!active || sequence !== requestSequence) return;
          setError(planId, error instanceof Error ? error.message : String(error));
        },
      );
    };

    pollMissionBoard();
    const missionBoardPollInterval = window.setInterval(
      pollMissionBoard,
      MISSION_BOARD_POLL_INTERVAL_MS,
    );

    return () => {
      active = false;
      requestSequence += 1;
      window.clearInterval(missionBoardPollInterval);
    };
  }, [listCards, paneVisible, planId]);

  return snapshot ?? { cards: EMPTY_CARDS, error: null, loading: false };
}
