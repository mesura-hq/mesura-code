/**
 * Little-endian numbers, ASCII, and back.
 *
 * Shared by the archive fixtures rather than copied into each, which is not
 * only tidiness: `packages/fm-core` compiles with `lib: ["ES2023"]` and
 * `types: []` and its `include` covers this directory, so there is no
 * `TextEncoder` and no `TextDecoder` here. Every fixture in this package has to
 * build its bytes by hand, so every fixture wants exactly these five.
 *
 * Not a `.test.ts` file, so vitest does not collect it — but the tsconfig does
 * type-check it, which is the point.
 */

export function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

export function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** Eight little-endian bytes from a safe integer. No `BigInt` literal needed. */
export function u64(value: number): number[] {
  const low = value % 0x100000000;
  const high = Math.floor(value / 0x100000000);
  return [...u32(low), ...u32(high)];
}

/** ASCII to bytes. There is no `TextEncoder` in this package. */
export function ascii(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff);
  return bytes;
}

/** ASCII from bytes, which is what these fixtures decode names with. */
export function decodeAscii(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}
