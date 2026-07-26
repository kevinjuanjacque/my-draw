import { vi } from "vitest";

import type { BinaryFileData } from "@excalidraw/excalidraw/types";

describe("uploadImageToCloudinary", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_APP_CLOUDINARY_CLOUD_NAME", "demo");
    vi.stubEnv("VITE_APP_CLOUDINARY_UPLOAD_PRESET", "unsigned-preset");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uploads the image data and returns Cloudinary's secure URL", async () => {
    // Arrange
    const { uploadImageToCloudinary } = await import("../data/cloudinary");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          secure_url: "https://res.cloudinary.com/demo/image/upload/image.png",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Act
    const url = await uploadImageToCloudinary({
      dataURL: "data:image/png;base64,aW1hZ2U=" as BinaryFileData["dataURL"],
    });

    // Assert
    expect(url).toBe("https://res.cloudinary.com/demo/image/upload/image.png");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/image\/upload$/),
      expect.objectContaining({ method: "POST" }),
    );

    const [, options] = fetchMock.mock.calls[0];
    const formData = options.body as FormData;
    expect(formData.get("file")).toBe("data:image/png;base64,aW1hZ2U=");
    expect(formData.has("public_id")).toBe(false);
  });
});
