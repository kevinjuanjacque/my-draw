import { describe, expect, test, vi } from "vitest";

import {
  createBoardReadShareLink,
  getBoardReadShareToken,
  loadBoardReadShare,
  publishBoardReadShare,
} from "../data/boardReadShare";

import type { JsonValue, SupabaseStorage } from "../data/supabaseStorage";

const snapshot: JsonValue = {
  elements: [{ id: "element-a" }],
  appState: {},
};

const createStorage = (): SupabaseStorage =>
  ({
    saveSnapshot: vi.fn(),
    createReadShare: vi.fn().mockResolvedValue("token-for-board-a"),
    loadSharedSnapshot: vi.fn(),
  } as unknown as SupabaseStorage);

describe("board read shares", () => {
  test("publishes a snapshot and token for only the current board", async () => {
    // Arrange
    const storage = createStorage();

    // Act
    const link = await publishBoardReadShare(
      storage,
      "board-a",
      snapshot,
      "https://app.example.com/board/board-a#room=ephemeral,key",
    );

    // Assert
    expect(storage.saveSnapshot).toHaveBeenCalledWith("board-a", snapshot);
    expect(storage.createReadShare).toHaveBeenCalledWith("board-a");
    expect(link).toBe(
      "https://app.example.com/board/board-a?share=token-for-board-a",
    );
    expect(link).not.toContain("room=");
  });

  test("loads the snapshot returned for a valid read token", async () => {
    // Arrange
    const storage = createStorage();
    vi.mocked(storage.loadSharedSnapshot).mockResolvedValue({
      boardId: "board-a",
      title: "Board A",
      snapshot,
      snapshotCreatedAt: "2026-07-26T00:00:00.000Z",
    });

    // Act
    const result = await loadBoardReadShare(storage, "valid-token");

    // Assert
    expect(result).toEqual({
      status: "loaded",
      sharedSnapshot: expect.objectContaining({
        boardId: "board-a",
        snapshot,
      }),
    });
    expect(storage.loadSharedSnapshot).toHaveBeenCalledWith("valid-token");
  });

  test("does not load an invalid, expired, or empty read share", async () => {
    // Arrange
    const storage = createStorage();
    vi.mocked(storage.loadSharedSnapshot)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        boardId: "board-a",
        title: "Board A",
        snapshot: { elements: [], appState: {} },
        snapshotCreatedAt: "2026-07-26T00:00:00.000Z",
      });

    // Act
    const invalid = await loadBoardReadShare(storage, "invalid-token");
    const expired = await loadBoardReadShare(storage, "expired-token");
    const empty = await loadBoardReadShare(storage, "empty-token");

    // Assert
    expect(invalid).toEqual({ status: "unavailable" });
    expect(expired).toEqual({ status: "unavailable" });
    expect(empty).toEqual({ status: "unavailable" });
  });

  test("does not load a token through a different board route", async () => {
    // Arrange
    const storage = createStorage();
    vi.mocked(storage.loadSharedSnapshot).mockResolvedValue({
      boardId: "board-a",
      title: "Board A",
      snapshot,
      snapshotCreatedAt: "2026-07-26T00:00:00.000Z",
    });

    // Act
    const result = await loadBoardReadShare(
      storage,
      "token-for-board-a",
      "board-b",
    );

    // Assert
    expect(result).toEqual({ status: "unavailable" });
  });

  test("only accepts a token from a persistent board-share URL", () => {
    // Arrange
    const link = createBoardReadShareLink(
      "read-token",
      "https://app.example.com/board/board-a",
    );

    // Act
    const token = getBoardReadShareToken(link);
    const roomToken = getBoardReadShareToken(
      "https://app.example.com/board/board-a?share=read-token#room=room,key",
    );

    // Assert
    expect(token).toBe("read-token");
    expect(roomToken).toBeNull();
  });
});
