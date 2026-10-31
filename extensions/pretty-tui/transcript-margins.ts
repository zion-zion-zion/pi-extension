import { visibleWidth } from "@earendil-works/pi-tui";

const PATCH = Symbol.for("pretty-tui.transcript-margins");
const ZONES = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
export const DEFAULT_TRANSCRIPT_MARGIN_RATIO = 0.12;
export const MIN_TRANSCRIPT_COLUMNS = 60;
export function transcriptGeometry(width: number, configuredRatio: unknown = DEFAULT_TRANSCRIPT_MARGIN_RATIO) {
  const columns = Math.max(1, Math.floor(width));
  const ratio = typeof configuredRatio === "number" && Number.isFinite(configuredRatio)
    ? Math.max(0, Math.min(0.30, configuredRatio)) : DEFAULT_TRANSCRIPT_MARGIN_RATIO;
  const desired = Math.floor(columns * ratio);
  const margin = Math.max(0, Math.min(desired, Math.floor((columns - MIN_TRANSCRIPT_COLUMNS) / 2)));
  return { columns, margin, contentWidth: columns - margin * 2 };
}
export function padTranscriptLine(line: string, width: number, configuredRatio?: unknown): string {
  const { columns, margin } = transcriptGeometry(width, configuredRatio);
  if (margin === 0) return line;
  // Native prompt navigation strips zones only at the beginning of a line.
  const prefix = line.match(ZONES)?.[0] ?? "";
  const content = line.slice(prefix.length);
  const trailing = Math.max(margin, columns - margin - visibleWidth(content));
  return prefix + " ".repeat(margin) + content + "\x1b[0m" + " ".repeat(trailing);
}

/** Apply shared margins to explicit transcript/input-dock containers, never the entire UI. */
export function createTranscriptMargins(getRatio: () => unknown) {
  const cleanups = new Map<any, () => void>();
  return {
    attach(container: any) {
      if (!container || typeof container.render !== "function" || container[PATCH]) return;
      const renderDescriptor = Object.getOwnPropertyDescriptor(container, "render");
      const mouseDescriptor = Object.getOwnPropertyDescriptor(container, "handleMouse");
      const originalRender = container.render;
      const originalMouse = container.handleMouse;
      const render = function (this: any, width: number): string[] {
        const geometry = transcriptGeometry(width, getRatio());
        return originalRender.call(this, geometry.contentWidth)
          .map((line: string) => padTranscriptLine(line, width, getRatio()));
      };
      const handleMouse = function (this: any, event: any) {
        const geometry = transcriptGeometry(event.width, getRatio());
        if (event.x < geometry.margin || event.x >= geometry.margin + geometry.contentWidth) return undefined;
        return originalMouse?.call(this, {
          ...event, x: event.x - geometry.margin, width: geometry.contentWidth,
        });
      };
      container[PATCH] = true;
      container.render = render;
      container.handleMouse = handleMouse;
      container.invalidate?.();
      cleanups.set(container, () => {
        if (container.render === render) {
          if (renderDescriptor) Object.defineProperty(container, "render", renderDescriptor);
          else delete container.render;
        }
        if (container.handleMouse === handleMouse) {
          if (mouseDescriptor) Object.defineProperty(container, "handleMouse", mouseDescriptor);
          else delete container.handleMouse;
        }
        delete container[PATCH];
        container.invalidate?.();
      });
    },
    dispose() {
      for (const cleanup of cleanups.values()) cleanup();
      cleanups.clear();
    },
  };
}
