import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

private let ghosttyBundleIdentifier = "com.mitchellh.ghostty"
private let pollInterval: TimeInterval = 0.20
private let overlayInset: CGFloat = 8
private let logURL = URL(fileURLWithPath: "/tmp/herdr-shell.log")

@discardableResult
private func log(_ message: String) -> String {
    let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
    FileHandle.standardError.write(Data(line.utf8))
    if let handle = try? FileHandle(forWritingTo: logURL) {
        handle.seekToEndOfFile()
        handle.write(Data(line.utf8))
        try? handle.close()
    } else {
        try? Data(line.utf8).write(to: logURL)
    }
    return message
}

final class GhosttyWindowLocator {
    func runningApplication() -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first {
            $0.bundleIdentifier == ghosttyBundleIdentifier
        }
    }

    func windowElement() -> AXUIElement? {
        guard let application = runningApplication() else {
            log("Ghostty is not running")
            return nil
        }
        let appElement = AXUIElementCreateApplication(application.processIdentifier)
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(
            appElement,
            kAXWindowsAttribute as CFString,
            &value
        )
        guard result == .success else {
            log("Could not read Ghostty windows; AX error=\(result.rawValue). Is this executable trusted in Accessibilité?")
            return nil
        }
        guard let windows = value as? [AXUIElement] else {
            log("Ghostty returned no AX windows")
            return nil
        }

        return windows.first(where: isUsableWindow)
    }

    func frame(of window: AXUIElement) -> CGRect? {
        guard let position = point(of: window, attribute: kAXPositionAttribute),
              let size = size(of: window, attribute: kAXSizeAttribute)
        else { return nil }
        // Accessibility uses a top-left global origin; AppKit window frames use
        // a bottom-left global origin. Phase 0 handles the display containing
        // the main screen and falls back to the raw coordinates if unavailable.
        let axFrame = CGRect(origin: position, size: size)
        guard let screen = NSScreen.screens.first(where: { $0.frame.intersects(axFrame) })
        else { return axFrame }
        return CGRect(
            x: axFrame.minX,
            y: screen.frame.maxY - axFrame.maxY,
            width: axFrame.width,
            height: axFrame.height
        )
    }

    func isFrontmostAndVisible(_ window: AXUIElement) -> Bool {
        guard let application = runningApplication(), !application.isTerminated else {
            return false
        }
        if application.isHidden { return false }
        return frame(of: window)?.isEmpty == false
    }

    private func isUsableWindow(_ window: AXUIElement) -> Bool {
        guard let frame = frame(of: window), frame.width > 100, frame.height > 100 else {
            return false
        }
        var minimized: CFTypeRef?
        AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &minimized)
        return (minimized as? Bool) != true
    }

    private func point(of element: AXUIElement, attribute: String) -> CGPoint? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value
        else { return nil }
        let axValue = value as! AXValue
        guard AXValueGetType(axValue) == .cgPoint else { return nil }
        var point = CGPoint.zero
        AXValueGetValue(axValue, .cgPoint, &point)
        return point
    }

    private func size(of element: AXUIElement, attribute: String) -> CGSize? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value
        else { return nil }
        let axValue = value as! AXValue
        guard AXValueGetType(axValue) == .cgSize else { return nil }
        var size = CGSize.zero
        AXValueGetValue(axValue, .cgSize, &size)
        return size
    }
}

final class ShellView: NSView {
    var isGhosttyActive = false {
        didSet { needsDisplay = true }
    }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let context = NSGraphicsContext.current?.cgContext else { return }

        let bounds = bounds.insetBy(dx: overlayInset, dy: overlayInset)
        guard bounds.width > 0, bounds.height > 0 else { return }

        let radius = min(18, min(bounds.width, bounds.height) * 0.08)
        let path = CGPath(
            roundedRect: bounds,
            cornerWidth: radius,
            cornerHeight: radius,
            transform: nil
        )

        context.saveGState()
        context.setShadow(
            offset: CGSize(width: 0, height: 3),
            blur: 16,
            color: NSColor.black.withAlphaComponent(isGhosttyActive ? 0.22 : 0.10).cgColor
        )
        context.setFillColor(NSColor.clear.cgColor)
        context.addPath(path)
        context.drawPath(using: .fill)
        context.restoreGState()

        context.saveGState()
        context.addPath(path)
        // Phase 0 uses a deliberately visible purple stroke so window tracking
        // can be verified on both Ghostty's light and dark themes.
        context.setStrokeColor(
            NSColor(
                calibratedRed: 0.46,
                green: 0.40,
                blue: 0.78,
                alpha: isGhosttyActive ? 0.78 : 0.36
            ).cgColor
        )
        context.setLineWidth(2)
        context.strokePath()
        context.restoreGState()
    }
}

final class OverlayPanel: NSPanel {
    init() {
        super.init(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        level = .floating
        hidesOnDeactivate = false
        let view = ShellView(frame: .zero)
        view.autoresizingMask = [.width, .height]
        contentView = view
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class ShellController {
    private let locator = GhosttyWindowLocator()
    private let panel = OverlayPanel()
    private var timer: Timer?
    private var trackedWindow: AXUIElement?

    func start() {
        let trusted = AXIsProcessTrustedWithOptions(
            [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        )
        log("started; accessibilityTrusted=\(trusted)")
        timer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.synchronize()
        }
        synchronize()
    }

    private func synchronize() {
        guard let window = locator.windowElement(),
              let frame = locator.frame(of: window),
              locator.isFrontmostAndVisible(window)
        else {
            trackedWindow = nil
            panel.orderOut(nil)
            return
        }

        trackedWindow = window
        let overlayFrame = frame.insetBy(dx: -overlayInset, dy: -overlayInset)
        if panel.frame != overlayFrame {
            log("tracking Ghostty frame=\(frame.debugDescription), overlay=\(overlayFrame.debugDescription)")
            panel.setFrame(overlayFrame, display: true)
        }
        if panel.isVisible == false {
            panel.orderFrontRegardless()
        }

        let active = NSWorkspace.shared.frontmostApplication?.bundleIdentifier == ghosttyBundleIdentifier
        (panel.contentView as? ShellView)?.isGhosttyActive = active
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let controller = ShellController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller.start()
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
