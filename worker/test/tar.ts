// Builds a .tar.gz the way GitHub's tarball endpoint does: a PAX global header
// with the commit id, then every file under one top folder. Long paths get a
// PAX extended header, as git archive writes them.

const enc = new TextEncoder();
const BLOCK = 512;

function header(name: string, size: number, type: string): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const put = (s: string, at: number, len: number) => h.set(enc.encode(s).subarray(0, len), at);
  put(name.slice(0, 99), 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  put("00000000000\0", 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  const sum = h.reduce((a, b) => a + b, 0);
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

const pad = (n: number) => new Uint8Array((BLOCK - (n % BLOCK)) % BLOCK);

function pax(key: string, value: string): Uint8Array {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (`${len}${body}`.length !== len) len++;
  return enc.encode(`${len}${body}`);
}

/** Plain bytes of a tar archive holding `files` under `top/`. */
export function tar(files: Record<string, string>, top = "acme-shop-abc123"): Uint8Array {
  const parts: Uint8Array[] = [];
  const g = pax("comment", "abc123");
  parts.push(header("pax_global_header", g.length, "g"), g, pad(g.length));
  parts.push(header(`${top}/`, 0, "5"));
  for (const [path, text] of Object.entries(files)) {
    const full = `${top}/${path}`;
    const data = enc.encode(text);
    if (full.length > 99) {
      const x = pax("path", full);
      parts.push(header("././@PaxHeader", x.length, "x"), x, pad(x.length));
    }
    parts.push(header(full, data.length, "0"), data, pad(data.length));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The archive gzipped, as a response body. */
export async function tarGz(files: Record<string, string>, top?: string): Promise<ArrayBuffer> {
  const stream = new Blob([tar(files, top)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}
