import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, test, vi } from "vitest";

import {
  createSupabaseStorage,
  SupabaseStorageError,
} from "../data/supabaseStorage";

describe("Supabase board storage", () => {
  test("returns the single token produced by the read-share RPC", async () => {
    // Arrange
    const rpc = vi.fn().mockResolvedValue({
      data: [{ token: "opaque-read-token" }],
      error: null,
    });
    const storage = createSupabaseStorage({ rpc } as unknown as SupabaseClient);

    // Act
    const token = await storage.createReadShare("board-id");

    // Assert
    expect(token).toBe("opaque-read-token");
    expect(rpc).toHaveBeenCalledWith("create_board_read_share", {
      target_board_id: "board-id",
    });
  });

  test("throws a contextual error when the read-share RPC returns no token", async () => {
    // Arrange
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const storage = createSupabaseStorage({ rpc } as unknown as SupabaseClient);

    // Act
    const createShare = storage.createReadShare("board-id");

    // Assert
    await expect(createShare).rejects.toEqual(
      expect.objectContaining<SupabaseStorageError>({
        message:
          "Could not create read share: The server did not return a token",
        name: "SupabaseStorageError",
      }),
    );
  });

  test("returns null when a read token does not resolve to a snapshot", async () => {
    // Arrange
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const storage = createSupabaseStorage({ rpc } as unknown as SupabaseClient);

    // Act
    const snapshot = await storage.loadSharedSnapshot("invalid-token");

    // Assert
    expect(snapshot).toBeNull();
    expect(rpc).toHaveBeenCalledWith("get_shared_board_snapshot", {
      read_token: "invalid-token",
    });
  });
});
