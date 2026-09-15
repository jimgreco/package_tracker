import {
  randomBytes,
  createHash,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { query } from "./db";
export function randomToken() {
  return randomBytes(32).toString("hex");
}
export function hash(s: string) {
  return createHash("sha256").update(s).digest("hex");
}
export function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function encryptionKey() {
  const value = process.env.ENCRYPTION_KEY;
  if (!value || !/^[0-9a-f]{64}$/i.test(value))
    throw new Error(
      "ENCRYPTION_KEY must contain 32 random bytes encoded as 64 hexadecimal characters.",
    );
  return Buffer.from(value, "hex");
}
export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const out = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), out]
    .map((x) => x.toString("base64url"))
    .join(".");
}
export function decrypt(value: string) {
  const [iv, tag, data] = value
    .split(".")
    .map((x) => Buffer.from(x, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function origin() {
  const configured = process.env.APP_URL;
  if (!configured) throw new AppError("APP_URL is not configured.", 503);
  return new URL(configured).origin;
}
export function checkOrigin(req: Request) {
  const value = req.headers.get("origin");
  if (!value || value !== origin())
    throw new AppError("This request must come from your Doorstep app.", 403);
}
export async function rateLimit(key: string, limit: number, seconds: number) {
  const rows = await query(
    `INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,now()+$2*interval '1 second') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<now() THEN 1 ELSE rate_limits.count+1 END,expires_at=CASE WHEN rate_limits.expires_at<now() THEN EXCLUDED.expires_at ELSE rate_limits.expires_at END RETURNING count`,
    [key, seconds],
  );
  if (rows[0].count > limit)
    throw new AppError("Too many attempts. Please try again later.", 429);
}
export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}
export async function jsonBody(req: Request, max = 100_000) {
  if (Number(req.headers.get("content-length") || 0) > max)
    throw new AppError("This message is too large.", 413);
  const reader = req.body?.getReader();
  if (!reader) throw new AppError("Missing request body.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new AppError("This message is too large.", 413);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("Invalid JSON.");
  }
}
export function configured(name: string) {
  const v = process.env[name];
  if (!v) throw new AppError(`${name} is not configured.`, 503);
  return v;
}
