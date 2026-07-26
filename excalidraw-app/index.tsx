import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";

import ExcalidrawApp from "./App";
import { hasInvalidSupabaseConfiguration } from "./data/supabase";

import "./index.scss";

const SupabaseConfigurationError = () => (
  <main
    className="supabase-configuration-error"
    aria-labelledby="supabase-configuration-error-title"
    role="alert"
  >
    <section>
      <h1 id="supabase-configuration-error-title">
        Supabase configuration required
      </h1>
      <p>
        This deployment cannot start because its Supabase configuration is
        invalid.
      </p>
      <p>
        In Vercel, configure <code>VITE_SUPABASE_URL</code> with an HTTP(S)
        Supabase project URL and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> with
        a valid public publishable key, then redeploy.
      </p>
    </section>
  </main>
);

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
registerSW();
root.render(
  <StrictMode>
    {hasInvalidSupabaseConfiguration() ? (
      <SupabaseConfigurationError />
    ) : (
      <ExcalidrawApp />
    )}
  </StrictMode>,
);
