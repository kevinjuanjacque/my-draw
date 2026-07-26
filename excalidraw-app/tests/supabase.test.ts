import { describe, expect, test } from "vitest";

import { getSupabaseConfigurationStatus } from "../data/supabase";

describe("Supabase configuration", () => {
  test("accepts an HTTPS project URL and publishable key", () => {
    // Arrange
    const configuration = {
      url: "https://example.supabase.co",
      publishableKey: "sb_publishable_public_key",
    };

    // Act
    const status = getSupabaseConfigurationStatus(configuration);

    // Assert
    expect(status).toBe("valid");
  });

  test("rejects a non-HTTP(S) URL without exposing its value", () => {
    // Arrange
    const configuration = {
      url: "not-a-url",
      publishableKey: "sb_publishable_public_key",
    };

    // Act
    const status = getSupabaseConfigurationStatus(configuration);

    // Assert
    expect(status).toBe("invalid");
  });

  test("rejects an invalid publishable key", () => {
    // Arrange
    const configuration = {
      url: "https://example.supabase.co",
      publishableKey: "not a publishable key",
    };

    // Act
    const status = getSupabaseConfigurationStatus(configuration);

    // Assert
    expect(status).toBe("invalid");
  });
});
