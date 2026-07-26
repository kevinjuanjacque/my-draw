import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import { AuthBoardUI } from "../components/AuthBoardUI";

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { SupabaseStorage } from "../data/supabaseStorage";

const createStorage = (
  overrides: Partial<SupabaseStorage> = {},
): SupabaseStorage => ({
  createBoard: vi.fn(),
  listBoards: vi.fn().mockResolvedValue([]),
  saveSnapshot: vi.fn(),
  loadLatestSnapshot: vi.fn().mockResolvedValue(null),
  createReadShare: vi.fn(),
  revokeReadShare: vi.fn(),
  loadSharedSnapshot: vi.fn(),
  signInWithPassword: vi.fn().mockResolvedValue(undefined),
  signUpWithPassword: vi.fn(),
  signOut: vi.fn(),
  ...overrides,
});

const createClient = (session: Session | null): SupabaseClient =>
  ({
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: {
          subscription: {
            unsubscribe: vi.fn(),
          },
        },
      }),
    },
  } as unknown as SupabaseClient);

describe("AuthBoardUI", () => {
  const originalShowModalDescriptor = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    "showModal",
  );

  beforeAll(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
  });

  afterAll(() => {
    if (originalShowModalDescriptor) {
      Object.defineProperty(
        HTMLDialogElement.prototype,
        "showModal",
        originalShowModalDescriptor,
      );
      return;
    }

    delete (HTMLDialogElement.prototype as { showModal?: unknown }).showModal;
  });

  it("mantiene el control oculto, inicia sesión y permite cerrarlo con Escape", async () => {
    const storage = createStorage();
    const onClose = vi.fn();
    const { container, rerender } = render(
      <AuthBoardUI
        client={createClient(null)}
        storage={storage}
        isOpen={false}
        onClose={onClose}
        getSnapshot={() => null}
        onLoadSnapshot={vi.fn()}
      />,
    );

    const dialog = container.querySelector("dialog");
    expect(dialog?.open).toBe(false);

    rerender(
      <AuthBoardUI
        client={createClient(null)}
        storage={storage}
        isOpen={true}
        onClose={onClose}
        getSnapshot={() => null}
        onLoadSnapshot={vi.fn()}
      />,
    );

    await waitFor(() => expect(dialog?.open).toBe(true));

    fireEvent.change(screen.getByLabelText("Correo electrónico"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));

    await waitFor(() =>
      expect(storage.signInWithPassword).toHaveBeenCalledWith(
        "user@example.com",
        "password",
      ),
    );

    fireEvent.keyDown(dialog!, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lista, crea y abre pizarras de la cuenta", async () => {
    const existingBoard = {
      id: "board-existing",
      title: "Pizarra existente",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
    };
    const createdBoard = {
      id: "board-created",
      title: "Pizarra nueva",
      createdAt: "2026-07-26T00:01:00.000Z",
      updatedAt: "2026-07-26T00:01:00.000Z",
    };
    const storage = createStorage({
      createBoard: vi.fn().mockResolvedValue(createdBoard),
      listBoards: vi.fn().mockResolvedValue([existingBoard, createdBoard]),
      loadLatestSnapshot: vi.fn().mockResolvedValue({
        id: "snapshot-created",
        boardId: "board-created",
        snapshot: { elements: [], appState: {} },
        createdAt: "2026-07-26T00:02:00.000Z",
      }),
    });
    const onLoadSnapshot = vi.fn();

    render(
      <AuthBoardUI
        client={createClient({ user: { id: "user-id" } } as unknown as Session)}
        storage={storage}
        isOpen={true}
        onClose={vi.fn()}
        getSnapshot={() => null}
        onLoadSnapshot={onLoadSnapshot}
      />,
    );

    await screen.findByRole("button", { name: existingBoard.title });

    fireEvent.click(screen.getByRole("button", { name: existingBoard.title }));

    await waitFor(() =>
      expect(storage.loadLatestSnapshot).toHaveBeenCalledWith(existingBoard.id),
    );

    fireEvent.change(screen.getByLabelText("Nueva pizarra"), {
      target: { value: createdBoard.title },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear pizarra" }));

    await waitFor(() =>
      expect(storage.createBoard).toHaveBeenCalledWith(createdBoard.title),
    );
    await waitFor(() =>
      expect(storage.loadLatestSnapshot).toHaveBeenCalledWith(createdBoard.id),
    );
    expect(onLoadSnapshot).toHaveBeenLastCalledWith({
      elements: [],
      appState: {},
    });

    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));

    await waitFor(() => expect(storage.signOut).toHaveBeenCalledTimes(1));
  });
});
