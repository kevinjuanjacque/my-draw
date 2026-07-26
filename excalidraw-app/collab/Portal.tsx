import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import { trackEvent } from "@excalidraw/excalidraw/analytics";
import { encryptData } from "@excalidraw/excalidraw/data/encryption";
import throttle from "lodash.throttle";

import type { UserIdleState } from "@excalidraw/common";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type {
  OnUserFollowedPayload,
  SocketId,
} from "@excalidraw/excalidraw/types";

import { FILE_UPLOAD_TIMEOUT, WS_SUBTYPES } from "../app_constants";
import { isSyncableElement } from "../data";
import { getSupabaseClient } from "../data/supabase";

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

import type {
  SocketUpdateData,
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../data";
import type { TCollabClass } from "./Collab";

const SUBSCRIPTION_TIMEOUT_MS = 10_000;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

const REALTIME_EVENTS = {
  COLLABORATION: "collaboration",
  USER_JOINED: "room-user-joined",
  USER_FOLLOW: "user-follow",
} as const;

interface RoomPresence {
  sessionId: string;
  username: string;
  followingSessionId: string | null;
  [key: string]: unknown;
}

export interface EncryptedRealtimePayload {
  sessionId: SocketId;
  encryptedData: number[];
  iv: number[];
}

interface UserJoinedPayload {
  sessionId: SocketId;
}

interface UserFollowPayload {
  sessionId: SocketId;
  targetSessionId: SocketId;
  action: OnUserFollowedPayload["action"];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isSessionId = (value: unknown): value is SocketId =>
  typeof value === "string" && SESSION_ID_PATTERN.test(value);

const isByteArray = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      typeof item === "number" &&
      Number.isInteger(item) &&
      item >= 0 &&
      item <= 255,
  );

const parseEncryptedPayload = (
  value: unknown,
): EncryptedRealtimePayload | null => {
  if (
    !isRecord(value) ||
    !isSessionId(value.sessionId) ||
    !isByteArray(value.encryptedData) ||
    !isByteArray(value.iv)
  ) {
    return null;
  }

  return {
    sessionId: value.sessionId,
    encryptedData: value.encryptedData,
    iv: value.iv,
  };
};

const parseUserJoinedPayload = (value: unknown): UserJoinedPayload | null => {
  if (!isRecord(value) || !isSessionId(value.sessionId)) {
    return null;
  }

  return { sessionId: value.sessionId };
};

const parseUserFollowPayload = (value: unknown): UserFollowPayload | null => {
  if (
    !isRecord(value) ||
    !isSessionId(value.sessionId) ||
    !isSessionId(value.targetSessionId) ||
    (value.action !== "FOLLOW" && value.action !== "UNFOLLOW")
  ) {
    return null;
  }

  return {
    sessionId: value.sessionId,
    targetSessionId: value.targetSessionId,
    action: value.action,
  };
};

const createSessionId = (): SocketId => {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  const sessionId = `session_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;

  if (!isSessionId(sessionId)) {
    throw new Error("Unable to create a valid collaboration session ID");
  }

  return sessionId;
};

class Portal {
  collab: TCollabClass;
  channel: RealtimeChannel | null = null;
  private supabase: SupabaseClient | null = null;
  readonly sessionId = createSessionId();
  socketInitialized = false;
  roomId: string | null = null;
  roomKey: string | null = null;
  broadcastedElementVersions: Map<string, number> = new Map();
  private followingSessionId: SocketId | null = null;

  constructor(collab: TCollabClass) {
    this.collab = collab;
  }

  async open(
    id: string,
    key: string,
    onEncryptedMessage: (payload: EncryptedRealtimePayload) => void,
  ): Promise<{ isFirstInRoom: boolean }> {
    const supabase = getSupabaseClient();
    if (!supabase) {
      throw new Error(
        "Collaboration requires VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY",
      );
    }

    this.supabase = supabase;
    this.roomId = id;
    this.roomKey = key;

    const channel = supabase.channel(`room:${id}`, {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: this.sessionId },
      },
    });
    this.channel = channel;

    channel.on(
      "broadcast",
      { event: REALTIME_EVENTS.COLLABORATION },
      ({ payload }) => {
        const message = parseEncryptedPayload(payload);
        if (message && message.sessionId !== this.sessionId) {
          onEncryptedMessage(message);
        }
      },
    );
    channel.on("broadcast", { event: REALTIME_EVENTS.USER_JOINED }, (event) => {
      const message = parseUserJoinedPayload(event.payload);
      if (message && message.sessionId !== this.sessionId) {
        void this.broadcastScene(
          WS_SUBTYPES.INIT,
          this.collab.getSceneElementsIncludingDeleted(),
          true,
        );
      }
    });
    channel.on("broadcast", { event: REALTIME_EVENTS.USER_FOLLOW }, (event) => {
      this.handleUserFollowEvent(event.payload);
    });
    channel.on("presence", { event: "sync" }, () => {
      this.syncPresence();
    });
    channel.on("presence", { event: "join" }, ({ newPresences }) => {
      if (
        newPresences.some(
          (presence) =>
            isSessionId(presence.sessionId) &&
            presence.sessionId !== this.sessionId,
        )
      ) {
        void this.broadcastScene(
          WS_SUBTYPES.INIT,
          this.collab.getSceneElementsIncludingDeleted(),
          true,
        );
      }
    });

    try {
      await this.subscribe(channel);
      const isFirstInRoom = this.getPresenceSessionIds().length === 0;
      await this.trackPresence();
      this.syncPresence();

      if (!isFirstInRoom) {
        await this.sendBroadcast(REALTIME_EVENTS.USER_JOINED, {
          sessionId: this.sessionId,
        });
      }

      trackEvent("share", "room joined");
      return { isFirstInRoom };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() {
    this.queueFileUpload.flush();

    const { channel, supabase } = this;
    this.channel = null;
    this.supabase = null;
    this.roomId = null;
    this.roomKey = null;
    this.socketInitialized = false;
    this.broadcastedElementVersions = new Map();
    this.followingSessionId = null;

    if (channel && supabase) {
      void channel
        .unsubscribe()
        .finally(() => supabase.removeChannel(channel))
        .catch((error: unknown) => {
          console.error("Failed to clean up the collaboration channel", error);
        });
    }
  }

  isOpen() {
    return !!(
      this.socketInitialized &&
      this.channel &&
      this.roomId &&
      this.roomKey
    );
  }

  async broadcastSocketData(
    data: SocketUpdateData,
    volatile = false,
  ): Promise<void> {
    if (!this.isOpen() || !this.channel || !this.roomKey) {
      return;
    }

    try {
      const json = JSON.stringify(data);
      const encoded = new TextEncoder().encode(json);
      const { encryptedBuffer, iv } = await encryptData(this.roomKey, encoded);
      const response = await this.sendBroadcast(REALTIME_EVENTS.COLLABORATION, {
        sessionId: this.sessionId,
        encryptedData: Array.from(new Uint8Array(encryptedBuffer)),
        iv: Array.from(iv),
      });

      if (response !== "ok") {
        throw new Error(`Realtime broadcast failed with status: ${response}`);
      }
    } catch (error) {
      console.error(
        volatile
          ? "Failed to broadcast volatile collaboration data"
          : "Failed to broadcast collaboration data",
        error,
      );
      this.collab.setErrorIndicator("Unable to synchronize collaboration data");
    }
  }

  queueFileUpload = throttle(async () => {
    try {
      await this.collab.fileManager.saveFiles({
        elements: this.collab.excalidrawAPI.getSceneElementsIncludingDeleted(),
        files: this.collab.excalidrawAPI.getFiles(),
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name !== "AbortError") {
        this.collab.excalidrawAPI.updateScene({
          appState: {
            errorMessage: error.message,
          },
        });
      }
    }

    let isChanged = false;
    const newElements = this.collab.excalidrawAPI
      .getSceneElementsIncludingDeleted()
      .map((element) => {
        if (this.collab.fileManager.shouldUpdateImageElementStatus(element)) {
          isChanged = true;
          return newElementWith(element, { status: "saved" });
        }
        return element;
      });

    if (isChanged) {
      this.collab.excalidrawAPI.updateScene({
        elements: newElements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  }, FILE_UPLOAD_TIMEOUT);

  broadcastScene = async (
    updateType: WS_SUBTYPES.INIT | WS_SUBTYPES.UPDATE,
    elements: readonly OrderedExcalidrawElement[],
    syncAll: boolean,
  ) => {
    if (updateType === WS_SUBTYPES.INIT && !syncAll) {
      throw new Error("syncAll must be true when sending SCENE.INIT");
    }

    const syncableElements = elements.reduce((acc, element) => {
      if (
        (syncAll ||
          !this.broadcastedElementVersions.has(element.id) ||
          element.version > this.broadcastedElementVersions.get(element.id)!) &&
        isSyncableElement(element)
      ) {
        acc.push(element);
      }
      return acc;
    }, [] as SyncableExcalidrawElement[]);

    const data: SocketUpdateDataSource[typeof updateType] = {
      type: updateType,
      payload: {
        elements: syncableElements,
      },
    };

    for (const syncableElement of syncableElements) {
      this.broadcastedElementVersions.set(
        syncableElement.id,
        syncableElement.version,
      );
    }

    this.queueFileUpload();

    await this.broadcastSocketData(data as SocketUpdateData);
  };

  broadcastIdleChange = (userState: UserIdleState) => {
    const data: SocketUpdateDataSource["IDLE_STATUS"] = {
      type: WS_SUBTYPES.IDLE_STATUS,
      payload: {
        socketId: this.sessionId,
        userState,
        username: this.collab.state.username,
      },
    };
    return this.broadcastSocketData(data as SocketUpdateData, true);
  };

  broadcastMouseLocation = (payload: {
    pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
    button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
  }) => {
    const data: SocketUpdateDataSource["MOUSE_LOCATION"] = {
      type: WS_SUBTYPES.MOUSE_LOCATION,
      payload: {
        socketId: this.sessionId,
        pointer: payload.pointer,
        button: payload.button || "up",
        selectedElementIds:
          this.collab.excalidrawAPI.getAppState().selectedElementIds,
        username: this.collab.state.username,
      },
    };

    return this.broadcastSocketData(data as SocketUpdateData, true);
  };

  broadcastVisibleSceneBounds = (payload: {
    sceneBounds: SocketUpdateDataSource["USER_VISIBLE_SCENE_BOUNDS"]["payload"]["sceneBounds"];
  }) => {
    const data: SocketUpdateDataSource["USER_VISIBLE_SCENE_BOUNDS"] = {
      type: WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS,
      payload: {
        socketId: this.sessionId,
        username: this.collab.state.username,
        sceneBounds: payload.sceneBounds,
      },
    };

    return this.broadcastSocketData(data as SocketUpdateData, true);
  };

  broadcastUserFollowed = async (payload: OnUserFollowedPayload) => {
    if (!this.isOpen() || !isSessionId(payload.userToFollow.socketId)) {
      return;
    }

    this.followingSessionId =
      payload.action === "FOLLOW" ? payload.userToFollow.socketId : null;

    try {
      await this.trackPresence();
      const response = await this.sendBroadcast(REALTIME_EVENTS.USER_FOLLOW, {
        sessionId: this.sessionId,
        targetSessionId: payload.userToFollow.socketId,
        action: payload.action,
      });
      if (response !== "ok") {
        throw new Error(
          `Realtime follow broadcast failed with status: ${response}`,
        );
      }
    } catch (error) {
      console.error("Failed to broadcast collaboration follow state", error);
      this.collab.setErrorIndicator("Unable to synchronize collaboration data");
    }
  };

  updatePresence = async () => {
    if (!this.isOpen()) {
      return;
    }

    try {
      await this.trackPresence();
    } catch (error) {
      console.error("Failed to update collaboration presence", error);
      this.collab.setErrorIndicator("Unable to synchronize collaboration data");
    }
  };

  private subscribe(channel: RealtimeChannel): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        reject(
          new Error("Timed out while subscribing to the collaboration room"),
        );
      }, SUBSCRIPTION_TIMEOUT_MS);

      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          window.clearTimeout(timeoutId);
          resolve();
          return;
        }

        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          window.clearTimeout(timeoutId);
          reject(
            new Error(
              `Unable to subscribe to the collaboration room: ${status}`,
            ),
          );
        }
      });
    });
  }

  private async trackPresence(): Promise<void> {
    if (!this.channel) {
      throw new Error("Cannot track collaboration presence without a channel");
    }

    const response = await this.channel.track({
      sessionId: this.sessionId,
      username: this.collab.state.username,
      followingSessionId: this.followingSessionId,
    });
    if (response !== "ok") {
      throw new Error(
        `Realtime presence update failed with status: ${response}`,
      );
    }
  }

  private getPresenceSessionIds(): SocketId[] {
    if (!this.channel) {
      return [];
    }

    const sessionIds = new Set<SocketId>();
    for (const presences of Object.values(
      this.channel.presenceState<RoomPresence>(),
    )) {
      for (const presence of presences) {
        if (isSessionId(presence.sessionId)) {
          sessionIds.add(presence.sessionId);
        }
      }
    }
    return [...sessionIds];
  }

  private syncPresence = () => {
    if (!this.channel) {
      return;
    }

    const collaborators = new Map<SocketId, string>();
    const followers = new Set<SocketId>();
    for (const presences of Object.values(
      this.channel.presenceState<RoomPresence>(),
    )) {
      for (const presence of presences) {
        if (!isSessionId(presence.sessionId)) {
          continue;
        }
        collaborators.set(presence.sessionId, presence.username);
        if (presence.followingSessionId === this.sessionId) {
          followers.add(presence.sessionId);
        }
      }
    }

    this.collab.setCollaborators([...collaborators.keys()], collaborators);
    this.collab.setFollowedBy([...followers]);
  };

  private handleUserFollowEvent = (value: unknown) => {
    const payload = parseUserFollowPayload(value);
    if (
      !payload ||
      payload.sessionId === this.sessionId ||
      payload.targetSessionId !== this.sessionId
    ) {
      return;
    }

    const followedBy = new Set(
      this.collab.excalidrawAPI.getAppState().followedBy,
    );
    if (payload.action === "FOLLOW") {
      followedBy.add(payload.sessionId);
    } else {
      followedBy.delete(payload.sessionId);
    }
    this.collab.setFollowedBy([...followedBy]);
  };

  private async sendBroadcast(
    event: typeof REALTIME_EVENTS[keyof typeof REALTIME_EVENTS],
    payload: EncryptedRealtimePayload | UserJoinedPayload | UserFollowPayload,
  ) {
    if (!this.channel) {
      throw new Error("Cannot broadcast collaboration data without a channel");
    }

    return this.channel.send({
      type: "broadcast",
      event,
      payload,
    });
  }
}

export default Portal;
