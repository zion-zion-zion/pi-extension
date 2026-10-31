import { backgroundAnsi, getTerminalColorMode, rgbColor } from "@earendil-works/pi-tui";

/** Shared 24-bit RGB palette for image bubbles and the character fallback. */
export function userBubbleColor(appearance: "light" | "dark"): number {
  return appearance === "dark" ? 0x303030 : 0xe8f3fe;
}

/** Shade a bounded bubble row; keep Markdown foregrounds and OSC links intact. */
export function userBubbleBackground(text: string, appearance: "light" | "dark"): string {
  const color = userBubbleColor(appearance);
  const background = backgroundAnsi(rgbColor((color >>> 16) & 255, (color >>> 8) & 255, color & 255), getTerminalColorMode());
  // Reassert our background after every SGR, including resets and inline-code
  // backgrounds. This avoids holes without changing foreground or text attributes.
  return background + text.replace(/\x1b\[[0-9:;]*m/g, (sequence) => sequence + background) + "\x1b[49m";
}
