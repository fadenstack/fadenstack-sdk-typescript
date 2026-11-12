/**
 * What protects the data the SDK keeps on a device (the chats and "Allow always" of the IndexedDB stores). .NET:
 * `ISecretProtector` in `Fadenstack.Auth` (`SecretProtection.cs`) with DPAPI and the OS key store behind it.
 *
 * The TypeScript form differs where a browser cannot do what .NET does:
 * - the key is a non-extractable WebCrypto AES-GCM key, one per signed-in user, kept in the user's own IndexedDB database
 *   as a `CryptoKey` object (structured clone): script on the page can use it but never read its bytes;
 * - every record gets a fresh 12-byte IV, stored in front of the ciphertext, and its store and key name are the additional
 *   data, so a record cannot be moved to another place and still decrypt (`context`; .NET's files bind by their path);
 * - in Node there is no IndexedDB and the SDK writes no key material at all: a host that keeps its own stores supplies a
 *   `SecretProtector` backed by its own key store.
 */
export interface SecretProtector {
  /** Whether what it returns is encrypted at rest (as .NET's `Encrypts`). */
  readonly encrypts: boolean;
  /**
   * Encrypts `data`; `context` names the place the record belongs to and must be given again to `unprotect` (it is
   * authenticated, not hidden). The result carries what `unprotect` needs, a fresh nonce included.
   */
  protect(data: Uint8Array, context: string): Promise<Uint8Array>;
  /** The data back. Throws a `SecretProtectionError` when the record is not this protector's, was moved, or was changed. */
  unprotect(data: Uint8Array, context: string): Promise<Uint8Array>;
}

/** A record that does not decrypt. The message never carries the record's contents. */
export class SecretProtectionError extends Error {
  constructor(message = "The record could not be decrypted.") {
    super(message);
    this.name = "SecretProtectionError";
  }
}

/** Where a key lives: what the WebCrypto protector asks for its key. */
export interface KeySource {
  key(): Promise<CryptoKey>;
}

const FORMAT_VERSION = 1;
const IV_LENGTH = 12;
const KEYS = "keys";
const KEY_NAME = "data";

/**
 * AES-GCM with a key from `keys` (see `IndexedDbKeyStore`). A record is `version (1 byte) | IV (12 bytes) | ciphertext and
 * tag`; the IV is random for every record (a repeated IV under one key would break GCM).
 */
export class WebCryptoSecretProtector implements SecretProtector {
  readonly encrypts = true;
  readonly #keys: KeySource;
  readonly #crypto: Crypto;

  constructor(keys: KeySource, webCrypto: Crypto = globalThis.crypto) {
    if (!webCrypto?.subtle) throw new Error("WebCrypto is not available here; supply your own SecretProtector.");
    this.#keys = keys;
    this.#crypto = webCrypto;
  }

  async protect(data: Uint8Array, context: string): Promise<Uint8Array> {
    const key = await this.#keys.key();
    const iv = this.#crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const sealed = new Uint8Array(await this.#crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: bytes(context) }, key, data as BufferSource));
    const out = new Uint8Array(1 + IV_LENGTH + sealed.length);
    out[0] = FORMAT_VERSION;
    out.set(iv, 1);
    out.set(sealed, 1 + IV_LENGTH);
    return out;
  }

  async unprotect(data: Uint8Array, context: string): Promise<Uint8Array> {
    if (!(data instanceof Uint8Array) || data.length < 1 + IV_LENGTH + 16 || data[0] !== FORMAT_VERSION) throw new SecretProtectionError();
    try {
      const key = await this.#keys.key();
      const iv = data.slice(1, 1 + IV_LENGTH);
      return new Uint8Array(await this.#crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: bytes(context) }, key, data.slice(1 + IV_LENGTH) as BufferSource));
    } catch {
      throw new SecretProtectionError(); // the platform's error is not passed on: it tells nothing the caller may act on
    }
  }
}

export interface IndexedDbKeyStoreOptions {
  /** The database's name; the agent uses `userStoreName("fadenstack-keys", principal)`. */
  name: string;
  /** The IndexedDB factory (default `globalThis.indexedDB`). */
  indexedDB?: IDBFactory;
  /** WebCrypto (default `globalThis.crypto`). */
  crypto?: Crypto;
}

/**
 * One person's key, in an IndexedDB database of its own: a non-extractable AES-GCM `CryptoKey`, made the first time it is
 * asked for. Another origin cannot open the database; script on this origin can use the key but cannot export it.
 * Deleting the database (`FadenstackAgent.deleteMyData`) makes every record encrypted under it unreadable for good.
 */
export class IndexedDbKeyStore implements KeySource {
  readonly #name: string;
  readonly #factory: IDBFactory;
  readonly #crypto: Crypto;
  #db: Promise<IDBDatabase> | undefined;
  #key: Promise<CryptoKey> | undefined;

  constructor(options: IndexedDbKeyStoreOptions) {
    this.#name = options.name;
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available here; supply your own SecretProtector.");
    this.#factory = factory;
    const webCrypto = options.crypto ?? globalThis.crypto;
    if (!webCrypto?.subtle) throw new Error("WebCrypto is not available here; supply your own SecretProtector.");
    this.#crypto = webCrypto;
  }

  /** The key (read once, then held). If two tabs make one at the same moment, the first stored wins and both use it. */
  key(): Promise<CryptoKey> {
    this.#key ??= this.#load().catch((error: unknown) => {
      this.#key = undefined; // try again next time
      throw error;
    });
    return this.#key;
  }

  /** Closes the database and forgets the key held in memory (a later call opens and reads again). */
  async closeAsync(): Promise<void> {
    const db = this.#db;
    this.#db = undefined;
    this.#key = undefined;
    if (db) (await db.catch(() => undefined))?.close();
  }

  async #load(): Promise<CryptoKey> {
    const db = await this.#open();
    const fresh = await this.#crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction([KEYS], "readwrite");
      const store = tx.objectStore(KEYS);
      let chosen = fresh;
      const get = store.get(KEY_NAME);
      get.onsuccess = () => {
        if (get.result) chosen = get.result as CryptoKey;
        else store.put(fresh, KEY_NAME);
      };
      tx.oncomplete = () => resolve(chosen);
      tx.onerror = () => reject(tx.error ?? new Error("The key store could not be read."));
      tx.onabort = () => reject(tx.error ?? new Error("The key store could not be read."));
    });
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = this.#factory.open(this.#name, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore(KEYS);
      };
      open.onsuccess = () => {
        const db = open.result;
        db.onversionchange = () => {
          db.close();
          this.#db = undefined;
          this.#key = undefined;
        };
        resolve(db);
      };
      open.onerror = () => reject(open.error ?? new Error("The key store could not be opened."));
      open.onblocked = () => reject(new Error("The key store is blocked by another open version."));
    });
    return this.#db;
  }
}

/**
 * The protector the SDK uses for a user in a browser: a WebCrypto key in a database of its own. Undefined where IndexedDB
 * or WebCrypto is missing (Node, an insecure page): the stores then keep nothing in IndexedDB either, or the host
 * supplies a protector.
 */
export function browserSecretProtector(keyDatabase: string, factory: IDBFactory | undefined = globalThis.indexedDB): { protector: WebCryptoSecretProtector; keys: IndexedDbKeyStore } | undefined {
  if (!factory || !globalThis.crypto?.subtle) return undefined;
  const keys = new IndexedDbKeyStore({ name: keyDatabase, indexedDB: factory });
  return { protector: new WebCryptoSecretProtector(keys), keys };
}

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

/** The place a record belongs to, as the additional data binds it: the store's database, the object store and the record's key. */
export function recordContext(database: string, store: string, ...key: (string | number)[]): string {
  return JSON.stringify(["fadenstack", FORMAT_VERSION, database, store, ...key]);
}
