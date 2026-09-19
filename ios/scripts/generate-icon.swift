// Reproduce the existing app/icon.svg using the same package geometry and blue.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let c = CGContext(
  data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
c.setFillColor(CGColor(red: 40 / 255, green: 90 / 255, blue: 240 / 255, alpha: 1))
c.fill(CGRect(x: 0, y: 0, width: size, height: size))
c.translateBy(x: 0, y: 1024)
c.scaleBy(x: 16, y: -16)
c.setStrokeColor(CGColor(gray: 1, alpha: 1))
c.setLineWidth(3)
c.setLineJoin(.round)
c.setLineCap(.round)
func line(_ points: [(CGFloat, CGFloat)], closed: Bool = false) {
  c.beginPath()
  c.move(to: CGPoint(x: points[0].0, y: points[0].1))
  for point in points.dropFirst() { c.addLine(to: CGPoint(x: point.0, y: point.1)) }
  if closed { c.closePath() }
  c.strokePath()
}
line([(16, 22), (32, 13), (48, 22), (48, 42), (32, 51), (16, 42)], closed: true)
line([(16, 22), (32, 31), (48, 22)])
line([(32, 31), (32, 51)])
line([(24, 18), (40, 27), (40, 36)])
let destination = CGImageDestinationCreateWithURL(
  URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, UTType.png.identifier as CFString, 1, nil
)!
CGImageDestinationAddImage(destination, c.makeImage()!, nil)
precondition(CGImageDestinationFinalize(destination))
