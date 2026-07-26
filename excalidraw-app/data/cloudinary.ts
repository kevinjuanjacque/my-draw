/**
 * Free, backend-less file storage for shareable links and collaboration
 * images, backed by Cloudinary's unsigned upload API. Replaces the previous
 * Firebase Storage integration; no server of our own is required.
 */
import { MIME_TYPES } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";

import type { FileId } from "@excalidraw/element/types";
import type {
  BinaryFileData,
  BinaryFileMetadata,
} from "@excalidraw/excalidraw/types";

const CLOUD_NAME = import.meta.env.VITE_APP_CLOUDINARY_CLOUD_NAME;
const UPLOAD_PRESET = import.meta.env.VITE_APP_CLOUDINARY_UPLOAD_PRESET;

const publicId = (prefix: string, id: FileId) =>
  `${prefix.replace(/^\/+/, "")}/${id}`;

const isCloudinaryUploadResponse = (
  payload: unknown,
): payload is { secure_url: string } =>
  typeof payload === "object" &&
  payload !== null &&
  "secure_url" in payload &&
  typeof payload.secure_url === "string";

const resourceUrl = (prefix: string, id: FileId) =>
  `https://res.cloudinary.com/${CLOUD_NAME}/raw/upload/${publicId(prefix, id)}`;

export const isCloudinaryConfigured = () => !!CLOUD_NAME && !!UPLOAD_PRESET;

export const uploadImageToCloudinary = async ({
  dataURL,
}: {
  dataURL: BinaryFileData["dataURL"];
}): Promise<BinaryFileData["dataURL"]> => {
  if (!isCloudinaryConfigured()) {
    throw new Error("Cloudinary image upload is not configured");
  }

  const formData = new FormData();
  formData.append("file", dataURL);
  formData.append("upload_preset", UPLOAD_PRESET);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
    { method: "POST", body: formData },
  );

  if (!response.ok) {
    throw new Error(`Cloudinary image upload failed (${response.status})`);
  }

  const payload: unknown = await response.json();
  if (!isCloudinaryUploadResponse(payload)) {
    throw new Error("Cloudinary image upload returned an invalid response");
  }

  return payload.secure_url as BinaryFileData["dataURL"];
};

export const saveFilesToCloudinary = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const formData = new FormData();
        formData.append(
          "file",
          new Blob([new Uint8Array(buffer)]),
          publicId(prefix, id),
        );
        formData.append("upload_preset", UPLOAD_PRESET);
        formData.append("public_id", publicId(prefix, id));

        const response = await fetch(
          `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/raw/upload`,
          { method: "POST", body: formData },
        );

        if (!response.ok) {
          throw new Error(`Cloudinary upload failed (${response.status})`);
        }

        savedFiles.push(id);
      } catch (error: unknown) {
        console.error(error);
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

export const loadFilesFromCloudinary = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await fetch(resourceUrl(prefix, id));
        if (response.status >= 400) {
          erroredFiles.set(id, true);
          return;
        }

        const arrayBuffer = await response.arrayBuffer();
        const { data, metadata } = await decompressData<BinaryFileMetadata>(
          new Uint8Array(arrayBuffer),
          { decryptionKey },
        );

        const dataURL = new TextDecoder().decode(
          data,
        ) as BinaryFileData["dataURL"];

        loadedFiles.push({
          mimeType: metadata.mimeType || MIME_TYPES.binary,
          id,
          dataURL,
          created: metadata?.created || Date.now(),
          lastRetrieved: metadata?.created || Date.now(),
        });
      } catch (error: unknown) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
