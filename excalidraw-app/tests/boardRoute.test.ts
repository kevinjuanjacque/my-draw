import { describe, expect, test } from "vitest";

import { getBoardIdFromPathname, getBoardPathname } from "../data/boardRoute";

describe("board routes", () => {
  test("returns the board identifier from a board route", () => {
    // Arrange
    const pathname = "/board/board%20identifier";

    // Act
    const boardId = getBoardIdFromPathname(pathname);

    // Assert
    expect(boardId).toBe("board identifier");
  });

  test("returns null for paths that do not identify a board", () => {
    // Arrange
    const pathname = "/board/board-id/other";

    // Act
    const boardId = getBoardIdFromPathname(pathname);

    // Assert
    expect(boardId).toBeNull();
  });

  test("returns null for malformed encoded board identifiers", () => {
    // Arrange
    const pathname = "/board/%invalid";

    // Act
    const boardId = getBoardIdFromPathname(pathname);

    // Assert
    expect(boardId).toBeNull();
  });

  test("encodes board identifiers when creating a board route", () => {
    // Arrange
    const boardId = "board identifier";

    // Act
    const pathname = getBoardPathname(boardId);

    // Assert
    expect(pathname).toBe("/board/board%20identifier");
  });
});
