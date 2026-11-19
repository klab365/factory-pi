import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** Reads and refreshes credentials from the same auth.json used by the Pi CLI. */
export class PiCredentialStore implements CredentialStore {
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async read(providerId: string): Promise<Credential | undefined> {
    const auth = await this.readAuth();
    const value = auth[providerId];
    return isCredential(value) ? value : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const auth = await this.readAuth();
    return Object.entries(auth).flatMap(([providerId, value]) =>
      isCredential(value) ? [{ providerId, type: value.type }] : [],
    );
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.withLock(async () => {
      const auth = await this.readAuth();
      const value = auth[providerId];
      const current = isCredential(value) ? value : undefined;
      const updated = await fn(current);
      if (updated !== undefined) {
        auth[providerId] = updated;
        await this.writeAuth(auth);
      }
      return updated ?? current;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.withLock(async () => {
      const auth = await this.readAuth();
      if (!(providerId in auth)) return;
      delete auth[providerId];
      await this.writeAuth(auth);
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.lock = previous.then(() => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readAuth(): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeAuth(auth: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

function isCredential(value: unknown): value is Credential {
  return (
    !!value &&
    typeof value === "object" &&
    "type" in value &&
    ((value as { type?: unknown }).type === "api_key" || (value as { type?: unknown }).type === "oauth")
  );
}
