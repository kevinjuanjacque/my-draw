import { createClient } from "@supabase/supabase-js";

import type { SupabaseClient } from "@supabase/supabase-js";

interface SupabaseEnvironment {
  readonly url: string | undefined;
  readonly publishableKey: string | undefined;
}

export type SupabaseConfigurationStatus = "missing" | "invalid" | "valid";

const PUBLISHABLE_KEY_PATTERN =
  /^(?:sb_publishable_[A-Za-z0-9_-]+|[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !!url.host
    );
  } catch {
    return false;
  }
};

export const getSupabaseConfigurationStatus = ({
  url,
  publishableKey,
}: SupabaseEnvironment): SupabaseConfigurationStatus => {
  const normalizedUrl = url?.trim();
  const normalizedPublishableKey = publishableKey?.trim();

  if (!normalizedUrl && !normalizedPublishableKey) {
    return "missing";
  }

  if (
    !normalizedUrl ||
    !normalizedPublishableKey ||
    !isHttpUrl(normalizedUrl) ||
    !PUBLISHABLE_KEY_PATTERN.test(normalizedPublishableKey)
  ) {
    return "invalid";
  }

  return "valid";
};

const supabaseEnvironment: SupabaseEnvironment = {
  url: import.meta.env.VITE_SUPABASE_URL,
  publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
};

let supabaseClient: SupabaseClient | null | undefined;
let isSupabaseClientInitializationFailed = false;

const initializeSupabaseClient = (): SupabaseClient | null => {
  if (supabaseClient !== undefined) {
    return supabaseClient;
  }

  const supabaseUrl = supabaseEnvironment.url?.trim();
  const supabasePublishableKey = supabaseEnvironment.publishableKey?.trim();
  if (
    !supabaseUrl ||
    !supabasePublishableKey ||
    getSupabaseConfigurationStatus(supabaseEnvironment) !== "valid"
  ) {
    supabaseClient = null;
    return supabaseClient;
  }

  try {
    supabaseClient = createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
      },
    });
  } catch {
    isSupabaseClientInitializationFailed = true;
    supabaseClient = null;
  }

  return supabaseClient;
};

export const hasInvalidSupabaseConfiguration = (): boolean =>
  getSupabaseConfigurationStatus(supabaseEnvironment) === "invalid" ||
  (initializeSupabaseClient() === null && isSupabaseClientInitializationFailed);

export const getSupabaseClient = (): SupabaseClient | null =>
  initializeSupabaseClient();
