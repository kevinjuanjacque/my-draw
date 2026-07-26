import type {
  JsonValue,
  SharedBoardSnapshot,
  SupabaseStorage,
} from "./supabaseStorage";

export type BoardReadShareLoadResult =
  | { status: "loaded"; sharedSnapshot: SharedBoardSnapshot }
  | { status: "unavailable" };

const hasElements = (snapshot: JsonValue): boolean => {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot)
  ) {
    return false;
  }

  const elements = (snapshot as Readonly<Record<string, JsonValue>>).elements;
  return Array.isArray(elements) && elements.length > 0;
};

export const createBoardReadShareLink = (
  token: string,
  currentUrl: string,
): string => {
  const url = new URL(currentUrl);
  // Read shares must use the SPA entry point: Vercel does not serve /board/:id.
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.searchParams.set("share", token);
  return url.toString();
};

export const getBoardReadShareToken = (url: string): string | null => {
  const parsedUrl = new URL(url);
  const token = parsedUrl.searchParams.get("share");
  return token && !parsedUrl.hash ? token : null;
};

export const publishBoardReadShare = async (
  storage: SupabaseStorage,
  boardId: string,
  snapshot: JsonValue,
  currentUrl: string,
): Promise<string> => {
  if (!hasElements(snapshot)) {
    throw new Error("No se puede compartir una pizarra vacía.");
  }

  await storage.saveSnapshot(boardId, snapshot);
  const token = await storage.createReadShare(boardId);
  return createBoardReadShareLink(token, currentUrl);
};

export const loadBoardReadShare = async (
  storage: SupabaseStorage,
  token: string,
  expectedBoardId?: string | null,
): Promise<BoardReadShareLoadResult> => {
  const sharedSnapshot = await storage.loadSharedSnapshot(token);
  if (
    !sharedSnapshot ||
    !hasElements(sharedSnapshot.snapshot) ||
    (expectedBoardId != null && sharedSnapshot.boardId !== expectedBoardId)
  ) {
    return { status: "unavailable" };
  }

  return { status: "loaded", sharedSnapshot };
};
