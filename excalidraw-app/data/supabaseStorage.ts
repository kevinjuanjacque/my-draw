import type { SupabaseClient } from "@supabase/supabase-js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface Board {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface BoardSnapshot {
  id: string;
  boardId: string;
  snapshot: JsonValue;
  createdAt: string;
}

export interface SharedBoardSnapshot {
  boardId: string;
  title: string;
  snapshot: JsonValue;
  snapshotCreatedAt: string;
}

interface BoardRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface BoardSnapshotRow {
  id: string;
  board_id: string;
  snapshot: JsonValue;
  created_at: string;
}

interface SharedBoardSnapshotRow {
  board_id: string;
  title: string;
  snapshot: JsonValue;
  snapshot_created_at: string;
}

interface ReadShareRow {
  token: string;
}

export class SupabaseStorageError extends Error {
  constructor(operation: string, cause: { message: string }) {
    super(`${operation}: ${cause.message}`);
    this.name = "SupabaseStorageError";
  }
}

const throwIfError = (
  operation: string,
  error: { message: string } | null,
): void => {
  if (error) {
    throw new SupabaseStorageError(operation, error);
  }
};

const toBoard = (row: BoardRow): Board => ({
  id: row.id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toSnapshot = (row: BoardSnapshotRow): BoardSnapshot => ({
  id: row.id,
  boardId: row.board_id,
  snapshot: row.snapshot,
  createdAt: row.created_at,
});

const toSharedSnapshot = (
  row: SharedBoardSnapshotRow,
): SharedBoardSnapshot => ({
  boardId: row.board_id,
  title: row.title,
  snapshot: row.snapshot,
  snapshotCreatedAt: row.snapshot_created_at,
});

export interface SupabaseStorage {
  createBoard(title: string): Promise<Board>;
  listBoards(): Promise<readonly Board[]>;
  saveSnapshot(boardId: string, snapshot: JsonValue): Promise<BoardSnapshot>;
  loadLatestSnapshot(boardId: string): Promise<BoardSnapshot | null>;
  createReadShare(boardId: string): Promise<string>;
  revokeReadShare(boardId: string): Promise<void>;
  loadSharedSnapshot(token: string): Promise<SharedBoardSnapshot | null>;
  signInWithPassword(email: string, password: string): Promise<void>;
  signUpWithPassword(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

export const createSupabaseStorage = (
  client: SupabaseClient,
): SupabaseStorage => ({
  async createBoard(title) {
    const { data, error } = await client
      .from("boards")
      .insert({ title })
      .select("id, title, created_at, updated_at")
      .single();
    throwIfError("Could not create board", error);
    return toBoard(data as BoardRow);
  },

  async listBoards() {
    const { data, error } = await client
      .from("boards")
      .select("id, title, created_at, updated_at")
      .order("updated_at", { ascending: false });
    throwIfError("Could not list boards", error);
    return (data as readonly BoardRow[]).map(toBoard);
  },

  async saveSnapshot(boardId, snapshot) {
    const { data, error } = await client
      .from("board_snapshots")
      .insert({ board_id: boardId, snapshot })
      .select("id, board_id, snapshot, created_at")
      .single();
    throwIfError("Could not save board snapshot", error);
    return toSnapshot(data as BoardSnapshotRow);
  },

  async loadLatestSnapshot(boardId) {
    const { data, error } = await client
      .from("board_snapshots")
      .select("id, board_id, snapshot, created_at")
      .eq("board_id", boardId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    throwIfError("Could not load board snapshot", error);
    return data ? toSnapshot(data as BoardSnapshotRow) : null;
  },

  async createReadShare(boardId) {
    const { data, error } = await client.rpc("create_board_read_share", {
      target_board_id: boardId,
    });
    throwIfError("Could not create read share", error);
    const share = (data as readonly ReadShareRow[] | null)?.[0];
    if (!share?.token) {
      throw new SupabaseStorageError("Could not create read share", {
        message: "The server did not return a token",
      });
    }
    return share.token;
  },

  async revokeReadShare(boardId) {
    const { error } = await client.rpc("revoke_board_read_share", {
      target_board_id: boardId,
    });
    throwIfError("Could not revoke read share", error);
  },

  async loadSharedSnapshot(token) {
    const { data, error } = await client.rpc("get_shared_board_snapshot", {
      read_token: token,
    });
    throwIfError("Could not load shared board", error);
    const sharedSnapshot = (
      data as readonly SharedBoardSnapshotRow[] | null
    )?.[0];
    return sharedSnapshot ? toSharedSnapshot(sharedSnapshot) : null;
  },

  async signInWithPassword(email, password) {
    const { error } = await client.auth.signInWithPassword({ email, password });
    throwIfError("Could not sign in", error);
  },

  async signUpWithPassword(email, password) {
    const { error } = await client.auth.signUp({ email, password });
    throwIfError("Could not sign up", error);
  },

  async signOut() {
    const { error } = await client.auth.signOut();
    throwIfError("Could not sign out", error);
  },
});
