const BOARD_PATH_PREFIX = "/board/";

export const getBoardIdFromPathname = (pathname: string): string | null => {
  if (!pathname.startsWith(BOARD_PATH_PREFIX)) {
    return null;
  }

  const boardId = pathname.slice(BOARD_PATH_PREFIX.length);
  if (!boardId || boardId.includes("/")) {
    return null;
  }

  try {
    return decodeURIComponent(boardId);
  } catch {
    return null;
  }
};

export const getBoardPathname = (boardId: string): string =>
  `${BOARD_PATH_PREFIX}${encodeURIComponent(boardId)}`;
