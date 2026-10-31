import { deflateSync } from "node:zlib";
import { allocateImageId, getCapabilities, getCellDimensions, visibleWidth } from "@earendil-works/pi-tui";

const ESC = "\x1b";
const MARKER = /\x1b\]1337;PrettyBubble=(\d+),(\d+),(\d+),(\d+),(\d+)\x07/g;
const PATCH = Symbol.for("pretty-tui.rounded-bubble-images");
const END_SYNC = `${ESC}[?2026l`;
let nextBubble = 1;
export const bubbleKey = () => nextBubble++;
export const stripBubbleMarkers = (value: string) => value.replace(MARKER, "");
export function markBubbleRow(id: number, row: number, rows: number, columns: number, color: number): string {
  return `${ESC}]1337;PrettyBubble=${id},${row},${rows},${columns},${color}\x07`;
}

// Encode small RGBA PNGs without adding a runtime dependency. Only the visible
// slice is allocated, even when a message is thousands of rows tall.
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let c = index;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const size = Buffer.alloc(4), check = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, name, data, check]);
}
export function roundedSlicePng(width: number, fullHeight: number, sourceY: number, height: number, color: number): Buffer {
  for (const value of [width, fullHeight, height]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid bubble dimensions");
  }
  if (!Number.isSafeInteger(sourceY) || sourceY < 0 || sourceY + height > fullHeight ||
      width > 8192 || height > 8192 || width * height > 8_000_000) throw new Error("Bubble image exceeds bounds");
  const radius = Math.min(24, width / 2, fullHeight / 2);
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Signed distance to a rounded rectangle, sampled at pixel centers.
      const dx = Math.max(radius - (x + 0.5), x + 0.5 - (width - radius), 0);
      const gy = sourceY + y + 0.5;
      const dy = Math.max(radius - gy, gy - (fullHeight - radius), 0);
      const alpha = Math.round(255 * Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(dx, dy))));
      const offset = y * stride + 1 + x * 4;
      pixels[offset] = (color >>> 16) & 255;
      pixels[offset + 1] = (color >>> 8) & 255;
      pixels[offset + 2] = color & 255;
      pixels[offset + 3] = alpha;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

export type BubbleSlice = { x: number; y: number; columns: number; rows: number; sourceRow: number; totalRows: number; color: number };
export function visibleBubbleSlices(lines: string[], columns: number): BubbleSlice[] {
  const result: (BubbleSlice & { id: number })[] = [];
  for (let y = 0; y < lines.length; y++) {
    const line = lines[y];
    const match = [...line.matchAll(MARKER)][0];
    if (!match) continue;
    const [id, sourceRow, totalRows, requestedColumns, color] = match.slice(1).map(Number);
    const x = visibleWidth(line.slice(0, match.index));
    const width = Math.min(requestedColumns, columns - x);
    if (sourceRow >= totalRows || width < 1 || x < 0) continue;
    const previous = result.at(-1);
    if (previous && previous.id === id && previous.x === x && previous.columns === width &&
        previous.y + previous.rows === y && previous.sourceRow + previous.rows === sourceRow &&
        previous.totalRows === totalRows && previous.color === color) previous.rows++;
    else result.push({ id, x, y, columns: width, rows: 1, sourceRow, totalRows, color });
  }
  return result;
}
const kitty = (controls: string, payload = "") => `${ESC}_G${controls};${payload}${ESC}\\`;
function upload(id: number, data: string): string {
  let out = "";
  for (let offset = 0; offset < data.length; offset += 4096) {
    const more = offset + 4096 < data.length ? 1 : 0;
    out += kitty(offset === 0 ? `a=t,f=100,i=${id},q=2,m=${more}` : `m=${more}`, data.slice(offset, offset + 4096));
  }
  return out;
}
type Cached = { id: number; data: string; uploaded: boolean };
export class BubbleImagePainter {
  private cache = new Map<string, Cached>();
  paint(lines: string[], columns: number, cell: { widthPx: number; heightPx: number }, reset: boolean, hidden = false): string {
    let out = "";
    // Remove only OUR placements, not native image attachments or other plugins.
    for (const entry of this.cache.values()) {
      if (reset) entry.uploaded = false;
      else out += kitty(`a=d,d=i,i=${entry.id},q=2`);
    }
    const used = new Set<string>();
    const slices = hidden ? [] : visibleBubbleSlices(lines, columns);
    let placement = 1;
    for (const slice of slices.slice(0, 64)) {
      const width = slice.columns * cell.widthPx;
      const height = slice.rows * cell.heightPx;
      const fullHeight = slice.totalRows * cell.heightPx;
      const sourceY = slice.sourceRow * cell.heightPx;
      const key = [width, fullHeight, sourceY, height, slice.color].join(":");
      let entry = this.cache.get(key);
      if (!entry) {
        const png = roundedSlicePng(width, fullHeight, sourceY, height, slice.color);
        entry = { id: allocateImageId(), data: png.toString("base64"), uploaded: false };
        this.cache.set(key, entry);
      }
      used.add(key);
      if (!entry.uploaded) {
        out += upload(entry.id, entry.data);
        entry.uploaded = true;
      }
      out += `${ESC}[${slice.y + 1};${slice.x + 1}H` +
        kitty(`a=p,i=${entry.id},p=${placement++},c=${slice.columns},r=${slice.rows},z=-1073741825,C=1,q=2`);
    }
    for (const [key, entry] of this.cache) {
      if (used.has(key)) continue;
      out += kitty(`a=d,d=I,i=${entry.id},q=2`);
      this.cache.delete(key);
    }
    return out ? `${ESC}7${out}${ESC}8` : "";
  }
  dispose(): string {
    const out = [...this.cache.values()].map(entry => kitty(`a=d,d=I,i=${entry.id},q=2`)).join("");
    this.cache.clear();
    return out;
  }
}

/** Keep image commands outside the text layout so selection/search remain native. */
export function installRoundedBubbles(prototype: any, onError: (error: unknown) => void) {
  const states = new Map<any, BubbleImagePainter>();
  let failed = false;
  const available = () => !failed && process.env.HERDR_ENV === "1" && getCapabilities().images === "kitty";
  const original = prototype.doRender;
  if (prototype[PATCH] || typeof original !== "function") return { available: () => false, dispose() {} };
  const patched = function (this: any, ...args: unknown[]) {
    const terminal = this.terminal;
    if (!terminal || !available()) return original.apply(this, args);
    const write = terminal.write;
    const buffers: string[] = [];
    terminal.write = (data: string) => buffers.push(data);
    let result;
    try {
      result = original.apply(this, args);
    } catch (error) {
      for (const data of buffers) write.call(terminal, stripBubbleMarkers(data));
      throw error;
    } finally {
      terminal.write = write;
    }
    if (buffers.length === 0) return result;
    let data = stripBubbleMarkers(buffers.join(""));
    let painter = states.get(this);
    if (!painter) {
      painter = new BubbleImagePainter();
      states.set(this, painter);
    }
    try {
      const hidden = this.hasOverlay?.() === true;
      const cell = getCellDimensions();
      const images = painter.paint(this.previousScreen ?? [], terminal.columns, cell,
        /\x1b_G[^;]*a=d[^;]*d=A(?:,|;)/.test(data), hidden);
      if (data.endsWith(END_SYNC)) data = data.slice(0, -END_SYNC.length) + images + END_SYNC;
      else data += images;
    } catch (error) {
      failed = true;
      data += painter.dispose();
      // Preserve the completed native frame even if image generation fails.
      write.call(terminal, data);
      this.invalidate?.();
      this.requestRender?.();
      onError(error);
      return result;
    }
    write.call(terminal, data);
    return result;
  };
  const originalStop = prototype.stop;
  const patchedStop = function (this: any, ...args: unknown[]) {
    const painter = states.get(this);
    if (painter) this.terminal?.write(painter.dispose());
    states.delete(this);
    const terminal = this.terminal;
    if (!terminal) return originalStop?.apply(this, args);
    const write = terminal.write;
    terminal.write = (data: string) => write.call(terminal, stripBubbleMarkers(data));
    try { return originalStop?.apply(this, args); }
    finally { terminal.write = write; }
  };
  prototype[PATCH] = { original, patched, originalStop, patchedStop };
  prototype.doRender = patched;
  prototype.stop = patchedStop;
  return {
    available,
    dispose() {
      for (const [screen, painter] of states) screen.terminal?.write(painter.dispose());
      states.clear();
      if (prototype.doRender === patched) prototype.doRender = original;
      if (prototype.stop === patchedStop) prototype.stop = originalStop;
      if (prototype[PATCH]?.patched === patched) delete prototype[PATCH];
    },
  };
}
