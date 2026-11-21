// Reads the files of a gzipped tar stream, as GitHub serves a repository
// (`GET /repos/{owner}/{repo}/tarball/{ref}`): one request for the whole tree
// instead of one per file. Only the files `want` accepts are kept in memory.
//
// Handles ustar names (with `prefix`), PAX extended headers (`x`, for long
// paths) and skips PAX global headers (`g`, where GitHub puts the commit id),
// directories, links and GNU long-name entries it does not need.

export interface TarFile {
  /** Path inside the repository: the archive's top folder (`owner-repo-sha/`) is removed. */
  path: string;
  text: string;
}

export interface TarLimits {
  /** Bigger files are skipped. */
  maxFileBytes: number;
  /** Reading stops (and `truncated` is set) once this many bytes are kept. */
  maxTotalBytes: number;
}

export interface TarResult {
  files: TarFile[];
  truncated: boolean;
}

const BLOCK = 512;

/** Reads exactly-sized chunks out of a byte stream. */
class Reader {
  private buf = new Uint8Array(0);
  private done = false;
  constructor(private readonly src: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.done) {
      const { value, done } = await this.src.read();
      if (done) {
        this.done = true;
        break;
      }
      const next = new Uint8Array(this.buf.length + value.length);
      next.set(this.buf);
      next.set(value, this.buf.length);
      this.buf = next;
    }
    return this.buf.length >= n;
  }

  /** The next `n` bytes, or null at the end of the stream. */
  async take(n: number): Promise<Uint8Array | null> {
    if (!(await this.fill(n))) return null;
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Drops `n` bytes without keeping them. */
  async skip(n: number): Promise<boolean> {
    let left = n;
    while (left > 0) {
      const step = Math.min(left, 1 << 20);
      if (!(await this.take(step))) return false;
      left -= step;
    }
    return true;
  }

  cancel() {
    void this.src.cancel().catch(() => undefined);
  }
}

const decoder = new TextDecoder();
const str = (b: Uint8Array, start: number, len: number) => {
  const s = b.subarray(start, start + len);
  const end = s.indexOf(0);
  return decoder.decode(end === -1 ? s : s.subarray(0, end));
};
const octal = (b: Uint8Array, start: number, len: number) => parseInt(str(b, start, len).trim() || "0", 8);

/** PAX records: `<len> <key>=<value>\n`. */
function paxPath(b: Uint8Array): string | null {
  const text = decoder.decode(b);
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp === -1) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = text.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq !== -1 && rec.slice(0, eq) === "path") return rec.slice(eq + 1);
    i += len;
  }
  return null;
}

const stripTop = (p: string) => {
  const i = p.indexOf("/");
  return i === -1 ? "" : p.slice(i + 1);
};

/** Reads a `.tar.gz` stream; `want(path)` picks which regular files to keep. */
export async function readTarGz(body: ReadableStream<Uint8Array>, want: (path: string) => boolean, limits: TarLimits): Promise<TarResult> {
  const reader = new Reader(body.pipeThrough(new DecompressionStream("gzip")).getReader());
  const files: TarFile[] = [];
  let kept = 0;
  let longName: string | null = null;
  try {
    for (;;) {
      const h = await reader.take(BLOCK);
      if (!h || h.every((x) => x === 0)) break;
      const size = octal(h, 124, 12);
      const type = String.fromCharCode(h[156] ?? 0);
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      if (type === "x" || type === "L") {
        const data = await reader.take(padded);
        if (!data) break;
        const body = data.subarray(0, size);
        longName = type === "x" ? paxPath(body) : str(body, 0, size);
        continue;
      }
      const name = str(h, 0, 100);
      const prefix = str(h, 345, 155);
      const full = longName ?? (prefix ? `${prefix}/${name}` : name);
      longName = null;
      const path = stripTop(full);
      const regular = type === "0" || type === "\0";
      if (!regular || !path || size > limits.maxFileBytes || !want(path)) {
        if (!(await reader.skip(padded))) break;
        continue;
      }
      if (kept + size > limits.maxTotalBytes) return { files, truncated: true };
      const data = await reader.take(padded);
      if (!data) break;
      files.push({ path, text: decoder.decode(data.subarray(0, size)) });
      kept += size;
    }
    return { files, truncated: false };
  } finally {
    reader.cancel();
  }
}
