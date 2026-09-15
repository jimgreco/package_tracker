import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { query } from "./db";
import type { PoolClient } from "pg";
import { AppError, safeUrl } from "./security";
const types = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
function s3() {
  return new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: !!process.env.S3_ENDPOINT,
    credentials: process.env.S3_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
        }
      : undefined,
  });
}
export function publicIp(ip: string) {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
export async function safeImageDownload(
  url: string,
  redirects = 0,
): Promise<{ bytes: Buffer; type: string }> {
  const safe = safeUrl(url);
  if (!safe || redirects > 3) throw new Error("Invalid image URL.");
  const u = new URL(safe);
  if (u.port && u.port !== "443") throw new Error("Invalid image port.");
  const addresses = await lookup(u.hostname, { family: 4, all: true });
  if (!addresses.length || addresses.some((a) => !publicIp(a.address)))
    throw new Error("Image host is not public.");
  const result = await new Promise<
    { bytes: Buffer; type: string } | { redirect: string }
  >((resolve, reject) => {
    const req = https.get(
      u,
      {
        family: 4,
        headers: {
          "User-Agent": "Doorstep/1.0 image-cache",
          Accept: "image/png,image/jpeg,image/webp,image/gif",
        },
        lookup: (_hostname, _options, cb) => cb(null, addresses[0].address, 4),
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          resolve({ redirect: new URL(res.headers.location, u).toString() });
          return;
        }
        const type = res.headers["content-type"]?.split(";")[0] || "";
        if (res.statusCode !== 200 || !types.has(type)) {
          res.resume();
          reject(new Error("Unsupported image."));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 5_000_000) {
            req.destroy(new Error("Image is too large."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ bytes: Buffer.concat(chunks), type }));
        res.on("error", reject);
      },
    );
    req.setTimeout(12_000, () =>
      req.destroy(new Error("Image download timed out.")),
    );
    req.on("error", reject);
  });
  return "redirect" in result
    ? safeImageDownload(result.redirect, redirects + 1)
    : result;
}
export async function storeImage(
  householdId: string,
  bytes: Buffer,
  type: string,
  client?: PoolClient,
) {
  if (!types.has(type) || bytes.length > 5_000_000 || !bytes.length)
    throw new AppError("Unsupported image.");
  const id = randomUUID();
  const key = `${householdId}/${id}`;
  if (process.env.S3_BUCKET)
    await s3().send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: bytes,
        ContentType: type,
      }),
    );
  else {
    const dir = path.resolve(
      process.env.UPLOAD_DIR || ".local/uploads",
      householdId,
    );
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(/* turbopackIgnore: true */ dir, id), bytes, {
      mode: 0o600,
    });
  }
  const sql =
    "INSERT INTO assets(id,household_id,storage_key,content_type,size) VALUES($1,$2,$3,$4,$5)";
  const values = [id, householdId, key, type, bytes.length];
  if (client) await client.query(sql, values);
  else await query(sql, values);
  return `/api/assets/${id}`;
}
export async function asset(id: string, householdId: string) {
  const [a] = await query(
    "SELECT * FROM assets WHERE id=$1 AND household_id=$2",
    [id, householdId],
  );
  if (!a) throw new AppError("Image not found.", 404);
  const bytes = process.env.S3_BUCKET
    ? Buffer.from(
        await (
          await s3().send(
            new GetObjectCommand({
              Bucket: process.env.S3_BUCKET,
              Key: a.storage_key,
            }),
          )
        ).Body!.transformToByteArray(),
      )
    : await readFile(
        /* turbopackIgnore: true */ path.resolve(
          process.env.UPLOAD_DIR || ".local/uploads",
          a.storage_key,
        ),
      );
  return { bytes, type: a.content_type };
}
