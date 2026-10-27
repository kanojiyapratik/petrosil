/**
 * Where files live.
 *
 * Two places behind one shape: a directory on disk (a laptop, or a mounted
 * volume) and an S3-compatible bucket (R2, S3, MinIO, Railway buckets). The
 * estate's files come to about 14 GB, which is a bucket's job in production;
 * the disk store is for development and for small installs.
 *
 * A key is `<brand>/<area>/<folder>/<name>`, forward slashes only. Anything
 * that could climb out of its place — `..`, a leading slash, a backslash, an
 * empty segment — is refused here, in the one function every store calls, so
 * no caller has to remember to check.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export type StoredFile = { body: Uint8Array; contentType: string; bytes: number };

export type FileStore = {
  name: string;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
};

export class InvalidKey extends Error {
  constructor(key: string) {
    super(`not a file key: "${key}"`);
    this.name = "InvalidKey";
  }
}

/**
 * A segment is any name that is not empty, does not start with a dot (which
 * also rules out `.` and `..`), and holds no slash, backslash or control
 * character. Ordinary punctuation and non-English letters pass: two of the old
 * report PDFs have an en dash in their names.
 */
const SEGMENT = /^[^./\\\u0000-\u001f\u007f][^/\\\u0000-\u001f\u007f]*$/u;

/** Throws unless every segment is a plain name. */
export function checkKey(key: string): string {
  if (key === "" || key.split("/").some((segment) => !SEGMENT.test(segment))) {
    throw new InvalidKey(key);
  }

  return key;
}

/** The key is valid, or null — for callers that answer "not found" rather than throw. */
export function safeKey(key: string): string | null {
  try {
    return checkKey(key);
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- disk */

export function diskStore(rootDir: string): FileStore {
  const root = resolve(rootDir);

  // Belt and braces: even a key that passed checkKey must land under root.
  const pathOf = (key: string) => {
    const path = resolve(join(root, checkKey(key)));

    if (!path.startsWith(root)) {
      throw new InvalidKey(key);
    }

    return path;
  };

  // Sidecar for the content type, so `get` answers what `put` was told.
  const typeOf = (path: string) => `${path}.type`;

  return {
    name: "disk",
    async put(key, body, contentType) {
      const path = pathOf(key);

      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      await writeFile(typeOf(path), contentType);
    },
    async get(key) {
      const path = pathOf(key);

      try {
        const body = await readFile(/* turbopackIgnore: true */ path);
        const contentType = await readFile(/* turbopackIgnore: true */ typeOf(path), "utf8").catch(() => "application/octet-stream");

        return { body: new Uint8Array(body), contentType, bytes: body.byteLength };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }

        throw error;
      }
    },
    async exists(key) {
      return stat(pathOf(key)).then(
        () => true,
        () => false,
      );
    },
    async delete(key) {
      const path = pathOf(key);

      await rm(path, { force: true });
      await rm(typeOf(path), { force: true });
    },
  };
}

/* ------------------------------------------------------------------- S3 */

export type S3Options = {
  endpoint?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** MinIO wants it; R2 and S3 do not mind it. */
  forcePathStyle?: boolean;
};

export function s3Store(options: S3Options): FileStore {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region ?? "auto",
    forcePathStyle: options.forcePathStyle ?? false,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
  });
  const Bucket = options.bucket;

  const missing = (error: unknown) => {
    const name = (error as { name?: string }).name;
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

    return name === "NoSuchKey" || name === "NotFound" || status === 404;
  };

  return {
    name: "s3",
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: checkKey(key), Body: body, ContentType: contentType }));
    },
    async get(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket, Key: checkKey(key) }));
        const body = await object.Body!.transformToByteArray();

        return { body, contentType: object.ContentType ?? "application/octet-stream", bytes: body.byteLength };
      } catch (error) {
        if (missing(error)) {
          return null;
        }

        throw error;
      }
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket, Key: checkKey(key) }));

        return true;
      } catch (error) {
        if (missing(error)) {
          return false;
        }

        throw error;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: checkKey(key) }));
    },
  };
}

/* ------------------------------------------------------------ from env */

let configured: FileStore | undefined;

/**
 * The bucket when `FILES_S3_BUCKET` is set (with its key pair and, for
 * anything but AWS, `FILES_S3_ENDPOINT`); otherwise the directory in
 * `FILES_DIR`, by default `storage/files` beside the app.
 */
export function storeFromEnv(env: Record<string, string | undefined> = process.env): FileStore {
  const bucket = env.FILES_S3_BUCKET?.trim();

  if (bucket) {
    return s3Store({
      bucket,
      endpoint: env.FILES_S3_ENDPOINT?.trim() || undefined,
      accessKeyId: env.FILES_S3_KEY ?? "",
      secretAccessKey: env.FILES_S3_SECRET ?? "",
      region: env.FILES_S3_REGION?.trim() || "auto",
      forcePathStyle: env.FILES_S3_PATH_STYLE === "true",
    });
  }

  return diskStore(env.FILES_DIR?.trim() || "storage/files");
}

/** One store per process. */
export function fileStore(): FileStore {
  configured ??= storeFromEnv();

  return configured;
}
