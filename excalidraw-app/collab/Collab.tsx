import {
  CaptureUpdateAction,
  getSceneVersion,
  restoreElements,
  zoomToFitBounds,
  reconcileElements,
} from "@excalidraw/excalidraw";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { APP_NAME, EVENT, toBrandedType } from "@excalidraw/common";
import {
  IDLE_THRESHOLD,
  ACTIVE_THRESHOLD,
  UserIdleState,
  assertNever,
  isDevEnv,
  isTestEnv,
  preventUnload,
  resolvablePromise,
  throttleRAF,
} from "@excalidraw/common";
import { decryptData } from "@excalidraw/excalidraw/data/encryption";
import { getVisibleSceneBounds } from "@excalidraw/element";
import { newElementWith } from "@excalidraw/element";
import { isImageElement, isInitializedImageElement } from "@excalidraw/element";
import { AbortError } from "@excalidraw/excalidraw/errors";
import { t } from "@excalidraw/excalidraw/i18n";
import { withBatchedUpdates } from "@excalidraw/excalidraw/reactUtils";

import throttle from "lodash.throttle";
import { PureComponent } from "react";

import { bumpElementVersions } from "@excalidraw/excalidraw/data/restore";

import type {
  ReconciledExcalidrawElement,
  RemoteExcalidrawElement,
} from "@excalidraw/excalidraw/data/reconcile";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type {
  ExcalidrawElement,
  FileId,
  InitializedExcalidrawImageElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
  SocketId,
  Collaborator,
  Gesture,
} from "@excalidraw/excalidraw/types";
import type { Mutable, ValueOf } from "@excalidraw/common/utility-types";

import { appJotaiStore, atom } from "../app-jotai";
import {
  CURSOR_SYNC_TIMEOUT,
  FILE_UPLOAD_MAX_BYTES,
  CLOUD_STORAGE_PREFIXES,
  INITIAL_SCENE_UPDATE_TIMEOUT,
  LOAD_IMAGES_TIMEOUT,
  WS_SUBTYPES,
  SYNC_FULL_SCENE_INTERVAL_MS,
} from "../app_constants";
import {
  generateCollaborationLinkData,
  getCollaborationLink,
  getSyncableElements,
} from "../data";
import {
  encodeFilesForUpload,
  FileManager,
  updateStaleImageStatuses,
} from "../data/FileManager";
import { FileStatusStore } from "../data/fileStatusStore";
import { LocalData } from "../data/LocalData";
import {
  loadFilesFromCloudinary,
  saveFilesToCloudinary,
} from "../data/cloudinary";
import {
  importUsernameFromLocalStorage,
  saveUsernameToLocalStorage,
} from "../data/localStorage";
import { resetBrowserStateVersions } from "../data/tabSync";

import { collabErrorIndicatorAtom } from "./CollabError";
import Portal, { isSessionId } from "./Portal";

import type { SocketUpdateDataSource } from "../data";
import type { EncryptedRealtimePayload } from "./Portal";

export const collabAPIAtom = atom<CollabAPI | null>(null);
export const isCollaboratingAtom = atom(false);
export const isOfflineAtom = atom(false);

interface CollabState {
  errorMessage: string | null;
  /** errors related to saving */
  dialogNotifiedErrors: Record<string, boolean>;
  username: string;
  activeRoomLink: string | null;
}

export const activeRoomLinkAtom = atom<string | null>(null);

type CollaborationScene =
  | (ImportedDataState & { elements: readonly OrderedExcalidrawElement[] })
  | null;

interface CollaborationScenePromise {
  resolve: (value: CollaborationScene) => void;
}

type CollabInstance = InstanceType<typeof Collab>;

export interface CollabAPI {
  /** function so that we can access the latest value from stale callbacks */
  isCollaborating: () => boolean;
  onPointerUpdate: CollabInstance["onPointerUpdate"];
  startCollaboration: CollabInstance["startCollaboration"];
  stopCollaboration: CollabInstance["stopCollaboration"];
  syncElements: CollabInstance["syncElements"];
  fetchImageFilesFromCloudStorage: CollabInstance["fetchImageFilesFromCloudStorage"];
  setUsername: CollabInstance["setUsername"];
  getUsername: CollabInstance["getUsername"];
  getActiveRoomLink: CollabInstance["getActiveRoomLink"];
  setCollabError: CollabInstance["setErrorDialog"];
}

interface CollabProps {
  excalidrawAPI: ExcalidrawImperativeAPI;
}

class Collab extends PureComponent<CollabProps, CollabState> {
  portal: Portal;
  fileManager: FileManager;
  excalidrawAPI: CollabProps["excalidrawAPI"];
  activeIntervalId: number | null;
  idleTimeoutId: number | null;

  private socketInitializationTimer?: number;
  private lastBroadcastedOrReceivedSceneVersion: number = -1;
  private collaborators = new Map<SocketId, Collaborator>();

  constructor(props: CollabProps) {
    super(props);
    this.state = {
      errorMessage: null,
      dialogNotifiedErrors: {},
      username: importUsernameFromLocalStorage() || "",
      activeRoomLink: null,
    };
    this.portal = new Portal(this);
    this.fileManager = new FileManager({
      onFileStatusChange: FileStatusStore.updateStatuses.bind(FileStatusStore),
      getFiles: async (fileIds) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        return loadFilesFromCloudinary(
          `${CLOUD_STORAGE_PREFIXES.collabFiles}/${roomId}`,
          roomKey,
          fileIds,
        );
      },
      saveFiles: async ({ addedFiles }) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        const { savedFiles, erroredFiles } = await saveFilesToCloudinary({
          prefix: `${CLOUD_STORAGE_PREFIXES.collabFiles}/${roomId}`,
          files: await encodeFilesForUpload({
            files: addedFiles,
            encryptionKey: roomKey,
            maxBytes: FILE_UPLOAD_MAX_BYTES,
          }),
        });

        return {
          savedFiles: savedFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
          erroredFiles: erroredFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
        };
      },
    });
    this.excalidrawAPI = props.excalidrawAPI;
    this.activeIntervalId = null;
    this.idleTimeoutId = null;
  }

  private onUmmount: (() => void) | null = null;

  componentDidMount() {
    window.addEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.addEventListener("online", this.onOfflineStatusToggle);
    window.addEventListener("offline", this.onOfflineStatusToggle);
    window.addEventListener(EVENT.UNLOAD, this.onUnload);

    const unsubOnUserFollow = this.excalidrawAPI.onUserFollow((payload) => {
      void this.portal.broadcastUserFollowed(payload);
    });
    const throttledRelayUserViewportBounds = throttleRAF(
      this.relayVisibleSceneBounds,
    );
    const unsubOnScrollChange = this.excalidrawAPI.onScrollChange(() =>
      throttledRelayUserViewportBounds(),
    );
    this.onUmmount = () => {
      unsubOnUserFollow();
      unsubOnScrollChange();
    };

    this.onOfflineStatusToggle();

    const collabAPI: CollabAPI = {
      isCollaborating: this.isCollaborating,
      onPointerUpdate: this.onPointerUpdate,
      startCollaboration: this.startCollaboration,
      syncElements: this.syncElements,
      fetchImageFilesFromCloudStorage: this.fetchImageFilesFromCloudStorage,
      stopCollaboration: this.stopCollaboration,
      setUsername: this.setUsername,
      getUsername: this.getUsername,
      getActiveRoomLink: this.getActiveRoomLink,
      setCollabError: this.setErrorDialog,
    };

    appJotaiStore.set(collabAPIAtom, collabAPI);

    if (isTestEnv() || isDevEnv()) {
      window.collab = window.collab || ({} as Window["collab"]);
      Object.defineProperties(window, {
        collab: {
          configurable: true,
          value: this,
        },
      });
    }
  }

  onOfflineStatusToggle = () => {
    appJotaiStore.set(isOfflineAtom, !window.navigator.onLine);
  };

  componentWillUnmount() {
    window.removeEventListener("online", this.onOfflineStatusToggle);
    window.removeEventListener("offline", this.onOfflineStatusToggle);
    window.removeEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.removeEventListener(EVENT.UNLOAD, this.onUnload);
    window.removeEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    window.removeEventListener(
      EVENT.VISIBILITY_CHANGE,
      this.onVisibilityChange,
    );
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    this.onUmmount?.();
    this.destroySocketClient({ isUnload: true });
  }

  isCollaborating = () => appJotaiStore.get(isCollaboratingAtom)!;

  private setIsCollaborating = (isCollaborating: boolean) => {
    appJotaiStore.set(isCollaboratingAtom, isCollaborating);
  };

  private onUnload = () => {
    this.destroySocketClient({ isUnload: true });
  };

  private beforeUnload = withBatchedUpdates((event: BeforeUnloadEvent) => {
    const syncableElements = getSyncableElements(
      this.getSceneElementsIncludingDeleted(),
    );

    if (
      this.isCollaborating() &&
      this.fileManager.shouldPreventUnload(syncableElements)
    ) {
      // this won't run in time if user decides to leave the site, but
      //  the purpose is to run in immediately after user decides to stay
      if (import.meta.env.VITE_APP_DISABLE_PREVENT_UNLOAD !== "true") {
        preventUnload(event);
      } else {
        console.warn(
          "preventing unload disabled (VITE_APP_DISABLE_PREVENT_UNLOAD)",
        );
      }
    }
  });

  stopCollaboration = (keepRemoteState = true) => {
    this.queueBroadcastAllElements.cancel();
    this.loadImageFiles.cancel();
    this.resetErrorIndicator(true);

    if (!keepRemoteState) {
      LocalData.fileStorage.reset();
      this.destroySocketClient();
    } else if (window.confirm(t("alerts.collabStopOverridePrompt"))) {
      // hack to ensure that we prefer we disregard any new browser state
      // that could have been saved in other tabs while we were collaborating
      resetBrowserStateVersions();

      window.history.pushState({}, APP_NAME, window.location.origin);
      this.destroySocketClient();

      LocalData.fileStorage.reset();

      const elements = this.excalidrawAPI
        .getSceneElementsIncludingDeleted()
        .map((element) => {
          if (isImageElement(element) && element.status === "saved") {
            return newElementWith(element, { status: "pending" });
          }
          return element;
        });

      this.excalidrawAPI.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  };

  private destroySocketClient = (opts?: { isUnload: boolean }) => {
    this.lastBroadcastedOrReceivedSceneVersion = -1;
    this.portal.close();
    this.fileManager.reset();
    if (!opts?.isUnload) {
      this.setIsCollaborating(false);
      this.setActiveRoomLink(null);
      this.collaborators = new Map();
      this.excalidrawAPI.updateScene({
        collaborators: this.collaborators,
      });
      LocalData.resumeSave("collaboration");
    }
  };

  private fetchImageFilesFromCloudStorage = async (opts: {
    elements: readonly ExcalidrawElement[];
    /**
     * Indicates whether to fetch files that are errored or pending and older
     * than 10 seconds.
     *
     * Use this as a mechanism to fetch files which may be ok but for some
     * reason their status was not updated correctly.
     */
    forceFetchFiles?: boolean;
  }) => {
    const unfetchedImages = opts.elements
      .filter((element) => {
        return (
          isInitializedImageElement(element) &&
          !this.fileManager.isFileTracked(element.fileId) &&
          !element.isDeleted &&
          (opts.forceFetchFiles
            ? element.status !== "pending" ||
              Date.now() - element.updated > 10000
            : element.status === "saved")
        );
      })
      .map((element) => (element as InitializedExcalidrawImageElement).fileId);

    return await this.fileManager.getFiles(unfetchedImages);
  };

  private decryptPayload = async (
    iv: Uint8Array<ArrayBuffer>,
    encryptedData: ArrayBuffer,
    decryptionKey: string,
  ): Promise<ValueOf<SocketUpdateDataSource>> => {
    try {
      const decrypted = await decryptData(iv, encryptedData, decryptionKey);

      const decodedData = new TextDecoder("utf-8").decode(
        new Uint8Array(decrypted),
      );
      return JSON.parse(decodedData);
    } catch (error) {
      window.alert(t("alerts.decryptFailed"));
      console.error(error);
      return {
        type: WS_SUBTYPES.INVALID_RESPONSE,
      };
    }
  };

  startCollaboration = async (
    existingRoomLinkData: null | { roomId: string; roomKey: string },
  ) => {
    try {
      this.portal.assertConfiguration();
    } catch (error: unknown) {
      this.setErrorDialog(
        error instanceof Error
          ? error.message
          : "Unable to start live collaboration",
      );
      return null;
    }

    if (!this.state.username) {
      import("@excalidraw/random-username").then(({ getRandomUsername }) => {
        const username = getRandomUsername();
        this.setUsername(username);
      });
    }

    if (this.portal.channel) {
      return null;
    }

    let roomId: string;
    let roomKey: string;
    let shouldUpdateUrl = false;

    if (existingRoomLinkData) {
      ({ roomId, roomKey } = existingRoomLinkData);
    } else {
      ({ roomId, roomKey } = await generateCollaborationLinkData());
      shouldUpdateUrl = true;
    }

    // TODO: `ImportedDataState` type here seems abused
    const scenePromise = resolvablePromise<CollaborationScene>();
    const previousUrl = window.location.href;
    let didUpdateUrl = false;

    this.setIsCollaborating(true);
    LocalData.pauseSave("collaboration");

    try {
      const { isFirstInRoom } = await this.portal.open(
        roomId,
        roomKey,
        (payload) => {
          void this.handleEncryptedBroadcast(payload, scenePromise);
        },
      );

      if (shouldUpdateUrl) {
        window.history.pushState(
          {},
          APP_NAME,
          getCollaborationLink({ roomId, roomKey }),
        );
        didUpdateUrl = true;
      }

      if (existingRoomLinkData) {
        // when joining existing room, don't merge it with current scene data
        this.excalidrawAPI.resetScene();
      } else {
        const elements = this.excalidrawAPI
          .getSceneElements()
          .map((element) => {
            if (isImageElement(element) && element.status === "saved") {
              return newElementWith(element, { status: "pending" });
            }
            return element;
          });
        // remove deleted elements from elements array to ensure we don't
        // expose potentially sensitive user data in case user manually deletes
        // existing elements (or clears scene) before sharing them with peers
        this.excalidrawAPI.updateScene({
          elements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }

      if (isFirstInRoom) {
        scenePromise.resolve(
          await this.initializeRoom({
            fetchScene: true,
            roomLinkData: existingRoomLinkData,
          }),
        );
      } else {
        // fallback in case you're not alone in the room but still don't receive
        // an initial SCENE_INIT message
        this.socketInitializationTimer = window.setTimeout(() => {
          void this.initializeRoom({
            roomLinkData: existingRoomLinkData,
            fetchScene: true,
          }).then((scene) => scenePromise.resolve(scene));
        }, INITIAL_SCENE_UPDATE_TIMEOUT);
      }
    } catch (error: unknown) {
      console.error(error);
      if (didUpdateUrl) {
        window.history.replaceState({}, APP_NAME, previousUrl);
      }
      this.destroySocketClient();
      this.setErrorDialog(
        error instanceof Error
          ? error.message
          : "Unable to join the collaboration room",
      );
      return null;
    }

    this.initializeIdleDetector();

    this.setActiveRoomLink(window.location.href);

    return scenePromise;
  };

  private handleEncryptedBroadcast = async (
    payload: EncryptedRealtimePayload,
    scenePromise: CollaborationScenePromise,
  ) => {
    if (!this.portal.roomKey) {
      return;
    }

    const decryptedData = await this.decryptPayload(
      new Uint8Array(payload.iv),
      new Uint8Array(payload.encryptedData).buffer,
      this.portal.roomKey,
    );

    switch (decryptedData.type) {
      case WS_SUBTYPES.INVALID_RESPONSE:
        return;
      case WS_SUBTYPES.INIT: {
        if (!this.portal.socketInitialized) {
          await this.initializeRoom({ fetchScene: false });
        }
        const remoteElements = toBrandedType<
          readonly RemoteExcalidrawElement[]
        >(decryptedData.payload.elements);
        const reconciledElements = this._reconcileElements(remoteElements);
        this.handleRemoteSceneUpdate(reconciledElements);
        scenePromise.resolve({
          elements: reconciledElements,
          scrollToContent: true,
        });
        break;
      }
      case WS_SUBTYPES.UPDATE:
        this.handleRemoteSceneUpdate(
          this._reconcileElements(
            toBrandedType<readonly RemoteExcalidrawElement[]>(
              decryptedData.payload.elements,
            ),
          ),
        );
        break;
      case WS_SUBTYPES.MOUSE_LOCATION: {
        const { pointer, button, username, selectedElementIds, socketId } =
          decryptedData.payload;

        if (!isSessionId(socketId) || socketId !== payload.sessionId) {
          return;
        }

        this.updateCollaborator(socketId, {
          pointer,
          button,
          selectedElementIds,
          username,
        });
        break;
      }
      case WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS: {
        const { sceneBounds, socketId } = decryptedData.payload;
        if (!isSessionId(socketId) || socketId !== payload.sessionId) {
          return;
        }
        const appState = this.excalidrawAPI.getAppState();

        if (appState.userToFollow?.socketId !== socketId) {
          return;
        }

        if (
          appState.userToFollow &&
          appState.followedBy.has(appState.userToFollow.socketId)
        ) {
          return;
        }

        this.excalidrawAPI.updateScene({
          appState: zoomToFitBounds({
            appState,
            bounds: sceneBounds,
            fit: "contain",
          }).appState,
        });
        break;
      }
      case WS_SUBTYPES.IDLE_STATUS: {
        const { userState, socketId, username } = decryptedData.payload;
        if (!isSessionId(socketId) || socketId !== payload.sessionId) {
          return;
        }
        this.updateCollaborator(socketId, {
          userState,
          username,
        });
        break;
      }
      default:
        assertNever(decryptedData, null);
    }
  };

  private initializeRoom = async ({
    fetchScene,
    roomLinkData,
  }:
    | {
        fetchScene: true;
        roomLinkData: { roomId: string; roomKey: string } | null;
      }
    | { fetchScene: false; roomLinkData?: null }) => {
    if (this.socketInitializationTimer) {
      window.clearTimeout(this.socketInitializationTimer);
      this.socketInitializationTimer = undefined;
    }
    // no backend-persisted scene to fetch anymore: whoever is first in the
    // room simply keeps whatever is already on their canvas, and other
    // peers will sync the scene once they join
    void fetchScene;
    void roomLinkData;
    this.portal.socketInitialized = true;
    return null;
  };

  private _reconcileElements = (
    remoteElements: readonly RemoteExcalidrawElement[],
  ): ReconciledExcalidrawElement[] => {
    const appState = this.excalidrawAPI.getAppState();

    const existingElements = this.getSceneElementsIncludingDeleted();

    // NOTE ideally we restore _after_ reconciliation but we can't do that
    // as we'd regenerate even elements such as appState.newElement which would
    // break the state
    remoteElements = restoreElements(remoteElements, existingElements);

    let reconciledElements = reconcileElements(
      existingElements,
      remoteElements,
      appState,
    );

    reconciledElements = bumpElementVersions(
      reconciledElements,
      existingElements,
    );

    // Avoid broadcasting to the rest of the collaborators the scene
    // we just received!
    // Note: this needs to be set before updating the scene as it
    // synchronously calls render.
    this.setLastBroadcastedOrReceivedSceneVersion(
      getSceneVersion(reconciledElements),
    );

    return reconciledElements;
  };

  private loadImageFiles = throttle(async () => {
    const { loadedFiles, erroredFiles } =
      await this.fetchImageFilesFromCloudStorage({
        elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      });

    this.excalidrawAPI.addFiles(loadedFiles);

    updateStaleImageStatuses({
      excalidrawAPI: this.excalidrawAPI,
      erroredFiles,
      elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    });
  }, LOAD_IMAGES_TIMEOUT);

  private handleRemoteSceneUpdate = (
    elements: ReconciledExcalidrawElement[],
  ) => {
    this.excalidrawAPI.updateScene({
      elements,
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    this.loadImageFiles();
  };

  private onPointerMove = () => {
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }

    this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);

    if (!this.activeIntervalId) {
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
    }
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      if (this.idleTimeoutId) {
        window.clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }
      if (this.activeIntervalId) {
        window.clearInterval(this.activeIntervalId);
        this.activeIntervalId = null;
      }
      this.onIdleStateChange(UserIdleState.AWAY);
    } else {
      this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
      this.onIdleStateChange(UserIdleState.ACTIVE);
    }
  };

  private reportIdle = () => {
    this.onIdleStateChange(UserIdleState.IDLE);
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
  };

  private reportActive = () => {
    this.onIdleStateChange(UserIdleState.ACTIVE);
  };

  private initializeIdleDetector = () => {
    document.addEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, this.onVisibilityChange);
  };

  setCollaborators(
    sockets: SocketId[],
    usernames?: ReadonlyMap<SocketId, string>,
  ) {
    const collaborators: InstanceType<typeof Collab>["collaborators"] =
      new Map();
    for (const socketId of sockets) {
      collaborators.set(
        socketId,
        Object.assign({}, this.collaborators.get(socketId), {
          username: usernames?.get(socketId),
          isCurrentUser: socketId === this.portal.sessionId,
        }),
      );
    }
    this.collaborators = collaborators;
    this.excalidrawAPI.updateScene({ collaborators });
  }

  updateCollaborator = (socketId: SocketId, updates: Partial<Collaborator>) => {
    const collaborators = new Map(this.collaborators);
    const user: Mutable<Collaborator> = Object.assign(
      {},
      collaborators.get(socketId),
      updates,
      {
        isCurrentUser: socketId === this.portal.sessionId,
      },
    );
    collaborators.set(socketId, user);
    this.collaborators = collaborators;

    this.excalidrawAPI.updateScene({
      collaborators,
    });
  };

  public setLastBroadcastedOrReceivedSceneVersion = (version: number) => {
    this.lastBroadcastedOrReceivedSceneVersion = version;
  };

  public getLastBroadcastedOrReceivedSceneVersion = () => {
    return this.lastBroadcastedOrReceivedSceneVersion;
  };

  public getSceneElementsIncludingDeleted = () => {
    return this.excalidrawAPI.getSceneElementsIncludingDeleted();
  };

  setFollowedBy = (followedBy: SocketId[]) => {
    this.excalidrawAPI.updateScene({
      appState: { followedBy: new Set(followedBy) },
    });

    this.relayVisibleSceneBounds({ force: true });
  };

  onPointerUpdate = throttle(
    (payload: {
      pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
      button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
      pointersMap: Gesture["pointers"];
    }) => {
      payload.pointersMap.size < 2 &&
        this.portal.channel &&
        this.portal.broadcastMouseLocation(payload);
    },
    CURSOR_SYNC_TIMEOUT,
  );

  relayVisibleSceneBounds = (props?: { force: boolean }) => {
    const appState = this.excalidrawAPI.getAppState();

    if (this.portal.channel && (appState.followedBy.size > 0 || props?.force)) {
      this.portal.broadcastVisibleSceneBounds({
        sceneBounds: getVisibleSceneBounds(appState),
      });
    }
  };

  onIdleStateChange = (userState: UserIdleState) => {
    this.portal.broadcastIdleChange(userState);
  };

  broadcastElements = (elements: readonly OrderedExcalidrawElement[]) => {
    if (
      getSceneVersion(elements) >
      this.getLastBroadcastedOrReceivedSceneVersion()
    ) {
      this.portal.broadcastScene(WS_SUBTYPES.UPDATE, elements, false);
      this.lastBroadcastedOrReceivedSceneVersion = getSceneVersion(elements);
      this.queueBroadcastAllElements();
    }
  };

  syncElements = (elements: readonly OrderedExcalidrawElement[]) => {
    this.broadcastElements(elements);
  };

  queueBroadcastAllElements = throttle(() => {
    this.portal.broadcastScene(
      WS_SUBTYPES.UPDATE,
      this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      true,
    );
    const currentVersion = this.getLastBroadcastedOrReceivedSceneVersion();
    const newVersion = Math.max(
      currentVersion,
      getSceneVersion(this.getSceneElementsIncludingDeleted()),
    );
    this.setLastBroadcastedOrReceivedSceneVersion(newVersion);
  }, SYNC_FULL_SCENE_INTERVAL_MS);

  setUsername = (username: string) => {
    this.setState({ username }, () => {
      void this.portal.updatePresence();
    });
    saveUsernameToLocalStorage(username);
  };

  getUsername = () => this.state.username;

  setActiveRoomLink = (activeRoomLink: string | null) => {
    this.setState({ activeRoomLink });
    appJotaiStore.set(activeRoomLinkAtom, activeRoomLink);
  };

  getActiveRoomLink = () => this.state.activeRoomLink;

  setErrorIndicator = (errorMessage: string | null) => {
    appJotaiStore.set(collabErrorIndicatorAtom, {
      message: errorMessage,
      nonce: Date.now(),
    });
  };

  resetErrorIndicator = (resetDialogNotifiedErrors = false) => {
    appJotaiStore.set(collabErrorIndicatorAtom, { message: null, nonce: 0 });
    if (resetDialogNotifiedErrors) {
      this.setState({
        dialogNotifiedErrors: {},
      });
    }
  };

  setErrorDialog = (errorMessage: string | null) => {
    this.setState({
      errorMessage,
    });
  };

  render() {
    const { errorMessage } = this.state;

    return (
      <>
        {errorMessage != null && (
          <ErrorDialog onClose={() => this.setErrorDialog(null)}>
            {errorMessage}
          </ErrorDialog>
        )}
      </>
    );
  }
}

declare global {
  interface Window {
    collab: InstanceType<typeof Collab>;
  }
}

if (isTestEnv() || isDevEnv()) {
  window.collab = window.collab || ({} as Window["collab"]);
}

export default Collab;

export type TCollabClass = Collab;
