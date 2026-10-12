const decoder = new TextDecoder("utf-8", { fatal: false });

export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
