import { useCallback, useEffect, useRef, useState } from "react";

import { getBoardIdFromPathname, getBoardPathname } from "../data/boardRoute";

import styles from "./AuthBoardUI.module.scss";

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type {
  Board,
  JsonValue,
  SupabaseStorage,
} from "../data/supabaseStorage";

interface AuthBoardUIProps {
  client: SupabaseClient;
  storage: SupabaseStorage;
  isOpen: boolean;
  onClose: () => void;
  onLoadSnapshot: (snapshot: JsonValue) => void;
  getSnapshot: () => JsonValue;
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "No se pudo completar la acción.";

export const AuthBoardUI = ({
  client,
  storage,
  isOpen,
  onClose,
  onLoadSnapshot,
  getSnapshot,
}: AuthBoardUIProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const isClosingRef = useRef(false);
  const [session, setSession] = useState<Session | null>(null);
  const [boards, setBoards] = useState<readonly Board[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(() =>
    getBoardIdFromPathname(window.location.pathname),
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newBoardTitle, setNewBoardTitle] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
      return;
    }

    if (dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  const refreshBoards = useCallback(async () => {
    const nextBoards = await storage.listBoards();
    setBoards(nextBoards);
    return nextBoards;
  }, [storage]);

  const openBoard = useCallback(
    async (boardId: string, updateRoute: boolean) => {
      setIsPending(true);
      setStatus("");
      try {
        const snapshot = await storage.loadLatestSnapshot(boardId);
        onLoadSnapshot(snapshot?.snapshot ?? { elements: [], appState: {} });
        setSelectedBoardId(boardId);
        if (updateRoute) {
          window.history.pushState({}, "", getBoardPathname(boardId));
        }
        setStatus(
          snapshot ? "Pizarra cargada." : "Pizarra nueva, sin guardados.",
        );
      } catch (error: unknown) {
        setStatus(getErrorMessage(error));
      } finally {
        setIsPending(false);
      }
    },
    [onLoadSnapshot, storage],
  );

  useEffect(() => {
    let isMounted = true;
    const loadSession = async () => {
      const { data, error } = await client.auth.getSession();
      if (error) {
        throw error;
      }
      if (isMounted) {
        setSession(data.session);
      }
    };

    void loadSession().catch((error: unknown) => {
      if (isMounted) {
        setStatus(getErrorMessage(error));
      }
    });

    const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (isMounted) {
        setSession(nextSession);
      }
    });

    return () => {
      isMounted = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  useEffect(() => {
    if (!isOpen || !session) {
      setBoards([]);
      setSelectedBoardId(null);
      return;
    }
    void refreshBoards().catch((error: unknown) =>
      setStatus(getErrorMessage(error)),
    );
  }, [isOpen, refreshBoards, session]);

  useEffect(() => {
    const onPopState = () => {
      const boardId = getBoardIdFromPathname(window.location.pathname);
      if (boardId) {
        void openBoard(boardId, false);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [openBoard]);

  useEffect(() => {
    const boardId = getBoardIdFromPathname(window.location.pathname);
    if (isOpen && session && boardId) {
      void openBoard(boardId, false);
    }
  }, [isOpen, openBoard, session]);

  const submitAuthentication = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    setIsPending(true);
    setStatus("");
    try {
      if (isRegistering) {
        await storage.signUpWithPassword(email, password);
        setStatus(
          "Registro creado. Revisa tu correo si debes confirmar la cuenta.",
        );
      } else {
        await storage.signInWithPassword(email, password);
      }
      setPassword("");
    } catch (error: unknown) {
      setStatus(getErrorMessage(error));
    } finally {
      setIsPending(false);
    }
  };

  const createBoard = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = newBoardTitle.trim();
    if (!title) {
      setStatus("Escribe un nombre para la pizarra.");
      return;
    }
    setIsPending(true);
    setStatus("");
    try {
      const board = await storage.createBoard(title);
      setNewBoardTitle("");
      await refreshBoards();
      await openBoard(board.id, true);
    } catch (error: unknown) {
      setStatus(getErrorMessage(error));
    } finally {
      setIsPending(false);
    }
  };

  const saveBoard = async () => {
    if (!selectedBoardId) {
      return;
    }
    setIsPending(true);
    setStatus("");
    try {
      await storage.saveSnapshot(selectedBoardId, getSnapshot());
      await refreshBoards();
      setStatus("Pizarra guardada.");
    } catch (error: unknown) {
      setStatus(getErrorMessage(error));
    } finally {
      setIsPending(false);
    }
  };

  const signOut = async () => {
    setIsPending(true);
    setStatus("");
    try {
      await storage.signOut();
      window.history.pushState({}, "", "/");
    } catch (error: unknown) {
      setStatus(getErrorMessage(error));
    } finally {
      setIsPending(false);
    }
  };

  const requestClose = () => {
    const dialog = dialogRef.current;
    isClosingRef.current = true;
    if (typeof dialog?.close === "function") {
      dialog.close();
    }
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="auth-board-title"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClose={() => {
        if (isOpen && !isClosingRef.current) {
          onClose();
        }
        isClosingRef.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          requestClose();
        }
      }}
    >
      <section className={styles.panel}>
        <header className={styles.header}>
          <h2 id="auth-board-title" className={styles.title}>
            Tus pizarras
          </h2>
          <button
            className={styles.closeButton}
            type="button"
            onClick={requestClose}
          >
            Cerrar
          </button>
        </header>
        {!session ? (
          <>
            <form className={styles.form} onSubmit={submitAuthentication}>
              <label className={styles.field}>
                Correo electrónico
                <input
                  className={styles.input}
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </label>
              <label className={styles.field}>
                Contraseña
                <input
                  className={styles.input}
                  type="password"
                  autoComplete={
                    isRegistering ? "new-password" : "current-password"
                  }
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={6}
                  required
                />
              </label>
              <div className={styles.authActions}>
                <button
                  className={styles.button}
                  type="submit"
                  disabled={isPending}
                >
                  {isRegistering ? "Crear cuenta" : "Iniciar sesión"}
                </button>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  onClick={() => setIsRegistering((value) => !value)}
                  disabled={isPending}
                >
                  {isRegistering ? "Ya tengo una cuenta" : "Crear una cuenta"}
                </button>
              </div>
            </form>
            {status && (
              <p className={styles.status} role="status">
                {status}
              </p>
            )}
          </>
        ) : (
          <>
            <form className={styles.form} onSubmit={createBoard}>
              <label className={styles.field}>
                Nueva pizarra
                <input
                  className={styles.input}
                  value={newBoardTitle}
                  onChange={(event) => setNewBoardTitle(event.target.value)}
                  placeholder="Nombre de la pizarra"
                  required
                />
              </label>
              <button
                className={styles.button}
                type="submit"
                disabled={isPending}
              >
                Crear pizarra
              </button>
            </form>
            <div className={styles.actions}>
              {boards.map((board) => (
                <button
                  key={board.id}
                  className={`${styles.boardButton} ${
                    board.id === selectedBoardId ? styles.activeBoard : ""
                  }`}
                  type="button"
                  onClick={() => void openBoard(board.id, true)}
                  disabled={isPending}
                  aria-current={
                    board.id === selectedBoardId ? "page" : undefined
                  }
                >
                  {board.title}
                </button>
              ))}
            </div>
            <div className={styles.actions}>
              <button
                className={styles.button}
                type="button"
                onClick={() => void saveBoard()}
                disabled={isPending || !selectedBoardId}
              >
                Guardar pizarra
              </button>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => void signOut()}
                disabled={isPending}
              >
                Cerrar sesión
              </button>
            </div>
            {status && (
              <p className={styles.status} role="status">
                {status}
              </p>
            )}
          </>
        )}
      </section>
    </dialog>
  );
};
