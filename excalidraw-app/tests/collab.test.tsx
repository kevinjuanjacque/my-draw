import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import {
  createRedoAction,
  createUndoAction,
} from "@excalidraw/excalidraw/actions/actionHistory";
import { syncInvalidIndices } from "@excalidraw/element";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { act, render, waitFor } from "@excalidraw/excalidraw/tests/test-utils";
import { afterEach, vi } from "vitest";

import { StoreIncrement } from "@excalidraw/element";

import type { DurableIncrement, EphemeralIncrement } from "@excalidraw/element";

import ExcalidrawApp from "../App";

const { h } = window;

const supabaseMocks = vi.hoisted(() => {
  const channel = {
    on: vi.fn(),
    subscribe: vi.fn(),
    track: vi.fn(async () => "ok"),
    send: vi.fn(async () => "ok"),
    unsubscribe: vi.fn(async () => "ok"),
    presenceState: vi.fn(() => ({})),
  };
  channel.on.mockImplementation(() => channel);
  channel.subscribe.mockImplementation((callback: (status: string) => void) => {
    callback("SUBSCRIBED");
    return channel;
  });

  return {
    channel,
    client: {
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(async () => "ok"),
    },
  };
});

Object.defineProperty(window, "crypto", {
  value: {
    getRandomValues: (arr: number[]) =>
      arr.forEach((v, i) => (arr[i] = Math.floor(Math.random() * 256))),
    subtle: {
      generateKey: () => {},
      exportKey: () => ({ k: "sTdLvMC_M3V8_vGa3UVRDg" }),
    },
  },
});

vi.mock("../../excalidraw-app/data/cloudinary.ts", () => {
  const loadFilesFromCloudinary = async () => ({
    loadedFiles: [],
    erroredFiles: [],
  });
  const saveFilesToCloudinary = async () => ({
    savedFiles: new Map(),
    erroredFiles: new Map(),
  });
  const isCloudinaryConfigured = () => false;
  const uploadImageToCloudinary = async () => "";

  return {
    isCloudinaryConfigured,
    loadFilesFromCloudinary,
    saveFilesToCloudinary,
    uploadImageToCloudinary,
  };
});

vi.mock("@excalidraw/excalidraw/data/encryption", async () => {
  const encryption = await vi.importActual<
    typeof import("@excalidraw/excalidraw/data/encryption")
  >("@excalidraw/excalidraw/data/encryption");

  return {
    ...encryption,
    encryptData: async () => ({
      encryptedBuffer: new ArrayBuffer(0),
      iv: new Uint8Array(),
    }),
  };
});

vi.mock("../data/supabase", () => {
  return {
    getSupabaseClient: () => supabaseMocks.client,
    hasInvalidSupabaseConfiguration: () => false,
  };
});

afterEach(() => {
  window.history.replaceState({}, "", window.location.origin);
  supabaseMocks.channel.subscribe.mockReset();
  supabaseMocks.channel.subscribe.mockImplementation(
    (callback: (status: string) => void) => {
      callback("SUBSCRIBED");
      return supabaseMocks.channel;
    },
  );
  supabaseMocks.channel.track.mockResolvedValue("ok");
  supabaseMocks.channel.send.mockResolvedValue("ok");
  supabaseMocks.channel.unsubscribe.mockResolvedValue("ok");
  supabaseMocks.channel.presenceState.mockReturnValue({});
});

/**
 * These test would deserve to be extended by testing collab with (at least) two clients simultanouesly,
 * while having access to both scenes, appstates stores, histories and etc.
 * i.e. multiplayer history tests could be a good first candidate, as we could test both history stacks simultaneously.
 */
describe("collaboration", () => {
  it("announces a new room even when presence has not loaded peers yet", async () => {
    // Arrange
    await render(<ExcalidrawApp />);

    // Act
    await act(() => window.collab.startCollaboration(null));

    // Assert
    expect(supabaseMocks.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "room-user-joined",
        payload: expect.objectContaining({
          sessionId: expect.stringMatching(/^session_[a-f0-9]{32}$/),
        }),
      }),
    );
  });

  it("preserves the URL when opening a new room cannot subscribe", async () => {
    // Arrange
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    supabaseMocks.channel.subscribe.mockImplementation(
      (callback: (status: string) => void) => {
        callback("CHANNEL_ERROR");
        return supabaseMocks.channel;
      },
    );
    const originalUrl = window.location.href;
    await render(<ExcalidrawApp />);

    // Act
    await act(() => window.collab.startCollaboration(null));

    // Assert
    expect(window.location.href).toBe(originalUrl);
    expect(window.collab.isCollaborating()).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Unable to subscribe to the collaboration room: CHANNEL_ERROR",
      }),
    );
    consoleErrorSpy.mockRestore();
  });

  it("should emit two ephemeral increments even though updates get batched", async () => {
    const durableIncrements: DurableIncrement[] = [];
    const ephemeralIncrements: EphemeralIncrement[] = [];

    await render(<ExcalidrawApp />);

    h.store.onStoreIncrementEmitter.on((increment) => {
      if (StoreIncrement.isDurable(increment)) {
        durableIncrements.push(increment);
      } else {
        ephemeralIncrements.push(increment);
      }
    });

    // eslint-disable-next-line dot-notation
    expect(h.store["scheduledMicroActions"].length).toBe(0);
    expect(durableIncrements.length).toBe(0);
    expect(ephemeralIncrements.length).toBe(0);

    const rectProps = {
      type: "rectangle",
      id: "A",
      height: 200,
      width: 100,
      x: 0,
      y: 0,
    } as const;

    const rect = API.createElement({ ...rectProps });

    API.updateScene({
      elements: [rect],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    await waitFor(() => {
      // expect(commitSpy).toHaveBeenCalledTimes(1);
      expect(durableIncrements.length).toBe(1);
    });

    // simulate two batched remote updates
    act(() => {
      h.app.updateScene({
        elements: [newElementWith(h.elements[0], { x: 100 })],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      h.app.updateScene({
        elements: [newElementWith(h.elements[0], { x: 200 })],
        captureUpdate: CaptureUpdateAction.NEVER,
      });

      // we scheduled two micro actions,
      // which confirms they are going to be executed as part of one batched component update
      // eslint-disable-next-line dot-notation
      expect(h.store["scheduledMicroActions"].length).toBe(2);
    });

    await waitFor(() => {
      // altough the updates get batched,
      // we expect two ephemeral increments for each update,
      // and each such update should have the expected change
      expect(ephemeralIncrements.length).toBe(2);
      expect(ephemeralIncrements[0].change.elements.A).toEqual(
        expect.objectContaining({ x: 100 }),
      );
      expect(ephemeralIncrements[1].change.elements.A).toEqual(
        expect.objectContaining({ x: 200 }),
      );
      // eslint-disable-next-line dot-notation
      expect(h.store["scheduledMicroActions"].length).toBe(0);
    });
  });

  it("should allow to undo / redo even on force-deleted elements", async () => {
    await render(<ExcalidrawApp />);
    const rect1Props = {
      type: "rectangle",
      id: "A",
      height: 200,
      width: 100,
    } as const;

    const rect2Props = {
      type: "rectangle",
      id: "B",
      width: 100,
      height: 200,
    } as const;

    const rect1 = API.createElement({ ...rect1Props });
    const rect2 = API.createElement({ ...rect2Props });

    API.updateScene({
      elements: syncInvalidIndices([rect1, rect2]),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    API.updateScene({
      elements: syncInvalidIndices([
        rect1,
        newElementWith(h.elements[1], { isDeleted: true }),
      ]),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    await waitFor(() => {
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: true }),
      ]);
      expect(h.elements).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: true }),
      ]);
    });

    // one form of force deletion happens when starting the collab, not to sync potentially sensitive data into the server
    window.collab.startCollaboration(null);

    await waitFor(() => {
      expect(API.getUndoStack().length).toBe(2);
      // we never delete from the local snapshot as it is used for correct diff calculation
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: true }),
      ]);
      expect(h.elements).toEqual([expect.objectContaining(rect1Props)]);
    });

    const undoAction = createUndoAction(h.history);
    act(() => h.app.actionManager.executeAction(undoAction));

    // with explicit undo (as addition) we expect our item to be restored from the snapshot!
    await waitFor(() => {
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(1);
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: false }),
      ]);
      expect(h.elements).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: false }),
      ]);
    });

    // simulate force deleting the element remotely
    API.updateScene({
      elements: syncInvalidIndices([rect1]),
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    await waitFor(() => {
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(1);
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: true }),
      ]);
      expect(h.elements).toEqual([expect.objectContaining(rect1Props)]);
    });

    const redoAction = createRedoAction(h.history);
    act(() => h.app.actionManager.executeAction(redoAction));

    // with explicit redo (as removal) we again restore the element from the snapshot!
    await waitFor(() => {
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getRedoStack().length).toBe(0);
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: true }),
      ]);
      expect(h.elements).toEqual([
        expect.objectContaining(rect1Props),
        expect.objectContaining({ ...rect2Props, isDeleted: true }),
      ]);
    });
  });
});
