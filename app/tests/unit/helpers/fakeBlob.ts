/** In-memory stand-in for the parts of `@vercel/blob` the app uses. */

type Meta = { pathname: string; url: string; downloadUrl: string };
type PutOptions = { allowOverwrite?: boolean; addRandomSuffix?: boolean };

export const BLOB_ORIGIN = "https://blob.test/";
const tick = () => new Promise<void>((r) => setImmediate(r));

class FakeBlob {
  files = new Map<string, string>();
  /** Page size for `list`, to exercise cursor pagination. */
  pageSize = 1000;
  /** Called before each `list`; lets a test simulate a concurrent writer. */
  beforeList: ((prefix: string) => void | Promise<void>) | null = null;
  /** Called before each `put`; throw from it to simulate a storage failure. */
  beforePut: ((pathname: string) => void) | null = null;
  calls = { put: [] as string[], del: [] as string[], list: [] as string[], head: [] as string[] };
  private suffix = 0;

  reset() {
    this.files.clear();
    this.pageSize = 1000;
    this.beforeList = null;
    this.beforePut = null;
    this.calls = { put: [], del: [], list: [], head: [] };
  }

  meta(pathname: string): Meta {
    const url = BLOB_ORIGIN + pathname;
    return { pathname, url, downloadUrl: `${url}?download=1` };
  }

  api = {
    put: async (pathname: string, body: string, opts: PutOptions = {}) => {
      await tick();
      this.calls.put.push(pathname);
      this.beforePut?.(pathname);
      if (opts.addRandomSuffix) pathname = pathname.replace(/(\.[^./]+)?$/, `-r${++this.suffix}$1`);
      if (this.files.has(pathname) && !opts.allowOverwrite) {
        throw new Error("Vercel Blob: This blob already exists, use `allowOverwrite: true` if you want to overwrite it.");
      }
      this.files.set(pathname, body);
      return this.meta(pathname);
    },
    head: async (pathname: string) => {
      await tick();
      this.calls.head.push(pathname);
      if (!this.files.has(pathname)) throw new Error("Vercel Blob: The requested blob does not exist");
      return this.meta(pathname);
    },
    list: async ({ prefix = "", cursor, limit = 1000 }: { prefix?: string; cursor?: string; limit?: number } = {}) => {
      await tick();
      this.calls.list.push(prefix);
      await this.beforeList?.(prefix);
      const all = [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const size = Math.min(limit, this.pageSize);
      const page = all.slice(start, start + size);
      const hasMore = start + size < all.length;
      return { blobs: page.map((p) => this.meta(p)), hasMore, cursor: hasMore ? String(start + size) : undefined };
    },
    del: async (paths: string | string[]) => {
      await tick();
      for (const p of Array.isArray(paths) ? paths : [paths]) {
        this.calls.del.push(p);
        this.files.delete(p);
      }
    },
  };

  /** Serves stored files by URL, like the Blob CDN. */
  fetch: typeof fetch = async (input) => {
    const url = String(input);
    if (!url.startsWith(BLOB_ORIGIN)) throw new Error(`unexpected fetch: ${url}`);
    const pathname = url.slice(BLOB_ORIGIN.length).replace(/\?.*$/, "");
    const body = this.files.get(pathname);
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
  };
}

export const blob = new FakeBlob();
