// Generates the app icon and menu-bar template images from code, so the
// artwork is reproducible and carries no third-party marks.
//
//   swift scripts/make-icons.swift assets
//
// Writes assets/icon-1024.png, assets/icon.icns (via iconutil) and the
// trayTemplate pair. The wordmark is deliberately plain: this is an unofficial
// project, and an icon that resembles an upstream brand would misrepresent it.

import AppKit
import Foundation

let arguments = CommandLine.arguments
let assetsDir = URL(fileURLWithPath: arguments.count > 1 ? arguments[1] : "assets")
let WORDMARK = "DS"

/// Neutral charcoal, chosen to stay clear of any upstream brand palette.
let background = NSColor(calibratedRed: 0.13, green: 0.15, blue: 0.18, alpha: 1)

func png(size: CGFloat, draw: (CGFloat) -> Void) -> Data {
  let pixels = Int(size)
  guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0
  ) else { fatalError("could not allocate \(pixels)px bitmap") }
  rep.size = NSSize(width: size, height: size)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  draw(size)
  NSGraphicsContext.current?.flushGraphics()
  NSGraphicsContext.restoreGraphicsState()
  guard let data = rep.representation(using: .png, properties: [:]) else {
    fatalError("could not encode \(pixels)px png")
  }
  return data
}

/// Draws the wordmark centred, scaled to a share of the canvas.
func drawWordmark(size: CGFloat, color: NSColor, fraction: CGFloat) {
  let font = NSFont.systemFont(ofSize: size * fraction, weight: .bold)
  let attributes: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: color,
    // Tight tracking keeps two letters readable at menu-bar sizes.
    .kern: -size * 0.02,
  ]
  let text = NSAttributedString(string: WORDMARK, attributes: attributes)
  let bounds = text.size()
  text.draw(at: NSPoint(x: (size - bounds.width) / 2, y: (size - bounds.height) / 2))
}

/// App icon: rounded square with the wordmark knocked out in white.
func appIcon(size: CGFloat) {
  let inset = size * 0.06
  let rect = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
  let path = NSBezierPath(roundedRect: rect, xRadius: size * 0.22, yRadius: size * 0.22)
  background.setFill()
  path.fill()
  drawWordmark(size: size, color: .white, fraction: 0.42)
}

/// Menu-bar icon: a `...Template` image is pure black plus alpha; macOS tints
/// it for light and dark menu bars, so any colour here would fight the system.
func trayIcon(size: CGFloat) {
  drawWordmark(size: size, color: .black, fraction: 0.62)
}

let fileManager = FileManager.default
try? fileManager.createDirectory(at: assetsDir, withIntermediateDirectories: true)

try png(size: 1024, draw: appIcon).write(to: assetsDir.appendingPathComponent("icon-1024.png"))
try png(size: 16, draw: trayIcon).write(to: assetsDir.appendingPathComponent("trayTemplate.png"))
try png(size: 32, draw: trayIcon).write(to: assetsDir.appendingPathComponent("trayTemplate@2x.png"))

// Every iconset slot is rendered at its own size rather than downscaled from
// 1024: two bold letters lose their edges badly under resampling.
let iconset = assetsDir.appendingPathComponent("icon.iconset")
try? fileManager.removeItem(at: iconset)
try fileManager.createDirectory(at: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
  try png(size: CGFloat(base), draw: appIcon)
    .write(to: iconset.appendingPathComponent("icon_\(base)x\(base).png"))
  try png(size: CGFloat(base * 2), draw: appIcon)
    .write(to: iconset.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = [
  "-c", "icns", iconset.path,
  "-o", assetsDir.appendingPathComponent("icon.icns").path,
]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { fatalError("iconutil failed") }
try fileManager.removeItem(at: iconset)

print("wrote icon-1024.png, icon.icns, trayTemplate.png, trayTemplate@2x.png to \(assetsDir.path)")
