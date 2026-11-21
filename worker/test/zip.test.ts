import { describe, expect, it } from "vitest";
import { crc32, zipOf } from "../src/zip";

describe("zipOf", () => {
  it("computes the zip CRC-32", () => {
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("stores each file with a central directory that points back at it", () => {
    const zip = zipOf([
      { path: "checkout.md", text: "# Checkout\n" },
      { path: "a/ü.md", text: "x" },
    ]);
    const v = new DataView(zip.buffer);
    const end = zip.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    const dirAt = v.getUint32(end + 16, true);
    expect(v.getUint32(dirAt, true)).toBe(0x02014b50);
    // The second entry's local header is where its directory entry says.
    const second = dirAt + 46 + "checkout.md".length;
    const at = v.getUint32(second + 42, true);
    expect(v.getUint32(at, true)).toBe(0x04034b50);
    const nameLen = v.getUint16(at + 26, true);
    expect(new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLen))).toBe("a/ü.md");
  });
});
