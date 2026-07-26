import { vi } from "vitest";

import type { FileId } from "@excalidraw/element/types";
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

describe("Cloudinary raw file storage", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_APP_CLOUDINARY_CLOUD_NAME", "demo");
    vi.stubEnv("VITE_APP_CLOUDINARY_UPLOAD_PRESET", "unsigned-preset");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("rejects raw uploads before making a request when Cloudinary is not configured", async () => {
    // Arrange
    vi.stubEnv("VITE_APP_CLOUDINARY_CLOUD_NAME", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { CloudinaryConfigurationError, saveFilesToCloudinary } =
      await import("../data/cloudinary");

    // Act
    const upload = saveFilesToCloudinary({
      prefix: "collab/room",
      files: [{ id: "file-id" as FileId, buffer: new Uint8Array([1]) }],
    });

    // Assert
    await expect(upload).rejects.toBeInstanceOf(CloudinaryConfigurationError);
    await expect(upload).rejects.toThrow(
      "Cloudinary is not configured. Set VITE_APP_CLOUDINARY_CLOUD_NAME and VITE_APP_CLOUDINARY_UPLOAD_PRESET.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects raw downloads before making a request when Cloudinary is not configured", async () => {
    // Arrange
    vi.stubEnv("VITE_APP_CLOUDINARY_UPLOAD_PRESET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { CloudinaryConfigurationError, loadFilesFromCloudinary } =
      await import("../data/cloudinary");

    // Act
    const download = loadFilesFromCloudinary("collab/room", "decryption-key", [
      "file-id" as FileId,
    ]);

    // Assert
    await expect(download).rejects.toBeInstanceOf(CloudinaryConfigurationError);
    await expect(download).rejects.toThrow(
      "Cloudinary is not configured. Set VITE_APP_CLOUDINARY_CLOUD_NAME and VITE_APP_CLOUDINARY_UPLOAD_PRESET.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads raw files using the configured Cloudinary cloud and preset", async () => {
    // Arrange
    const { saveFilesToCloudinary } = await import("../data/cloudinary");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // Act
    const result = await saveFilesToCloudinary({
      prefix: "/collab/room",
      files: [{ id: "file-id" as FileId, buffer: new Uint8Array([1]) }],
    });

    // Assert
    expect(result).toEqual({
      savedFiles: ["file-id"],
      erroredFiles: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudinary.com/v1_1/demo/raw/upload",
      expect.objectContaining({ method: "POST" }),
    );
    const [, options] = fetchMock.mock.calls[0];
    const formData = options.body as FormData;
    expect(formData.get("upload_preset")).toBe("unsigned-preset");
    expect(formData.get("public_id")).toBe("collab/room/file-id");
  });

  it("builds raw download URLs from the configured Cloudinary cloud", async () => {
    // Arrange
    const { loadFilesFromCloudinary } = await import("../data/cloudinary");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    // Act
    const result = await loadFilesFromCloudinary(
      "/collab/room",
      "decryption-key",
      ["file-id" as FileId],
    );

    // Assert
    expect(result.loadedFiles).toEqual([]);
    expect([...result.erroredFiles.keys()]).toEqual(["file-id"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://res.cloudinary.com/demo/raw/upload/collab/room/file-id",
    );
  });
});
