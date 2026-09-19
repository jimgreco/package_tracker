import Foundation

struct Estimate: Codable, Equatable, Sendable {
  var kind: String
  var start: String
  var end: String?
  var timeZone: String
  var label: String?
}
struct PackageItem: Codable, Equatable, Sendable {
  var name: String
  var quantity: Int
  var imageUrl: String?
}
struct Shipment: Codable, Identifiable, Equatable, Sendable {
  var id: String
  var orderId: String
  var merchant: String
  var orderNumber: String?
  var orderedAt: String?
  var items: [PackageItem]
  var carrier: String?
  var trackingNumber: String?
  var trackingUrl: String?
  var status: String
  var shippedAt: String?
  var estimate: Estimate?
  var deliveredAt: String?
  var createdAt: String
  var timelineAt: String
  var firstEmailAt: String?
  var dismissedAt: String?
  var archivedAt: String?
  var updatedAt: String
  var statusAt: String
  var lastCheckedAt: String?
  var trackingState: String
  var needsReview: Bool
  var reviewReason: String?
  var manualOverride: Bool
  var isDemo: Bool
  var summary: String {
    items.map { $0.quantity == 1 ? $0.name : "\($0.quantity) × \($0.name)" }.joined(separator: ", ")
  }
  var canDeliver: Bool {
    dismissedAt == nil && !["delivered", "cancelled", "return_to_sender"].contains(status)
  }
  static func newestFirst(_ lhs: Self, _ rhs: Self) -> Bool {
    let left = Dates.instant(lhs.timelineAt) ?? .distantPast
    let right = Dates.instant(rhs.timelineAt) ?? .distantPast
    if left != right { return left > right }
    let lc = Dates.instant(lhs.createdAt) ?? .distantPast
    let rc = Dates.instant(rhs.createdAt) ?? .distantPast
    return lc == rc ? lhs.id > rhs.id : lc > rc
  }
}
enum PackageFilter: String, CaseIterable, Identifiable {
  case all = "All packages"
  case onTheWay = "On the way"
  case delivered = "Delivered"
  case attention = "Needs attention"
  case dismissed = "Dismissed"
  var id: String { rawValue }
  func includes(_ s: Shipment) -> Bool {
    guard s.archivedAt == nil else { return false }
    if self == .dismissed { return s.dismissedAt != nil }
    guard s.dismissedAt == nil else { return false }
    switch self {
    case .all: return true
    case .onTheWay:
      return [
        "ordered", "pre_transit", "in_transit", "out_for_delivery", "delayed",
        "available_for_pickup", "failure",
      ].contains(s.status)
    case .delivered: return s.status == "delivered"
    case .attention: return s.needsReview || ["failure", "delayed", "unknown"].contains(s.status)
    case .dismissed: return false
    }
  }
  func results(_ shipments: [Shipment], search: String = "") -> [Shipment] {
    shipments.filter {
      includes($0)
        && (search.isEmpty
          || [$0.merchant, $0.summary, $0.orderNumber ?? "", $0.trackingNumber ?? ""].contains {
            $0.localizedCaseInsensitiveContains(search)
          })
    }
  }
}
enum PackageStatus {
  static let labels = [
    "ordered": "Order placed", "pre_transit": "Label created", "in_transit": "On the way",
    "out_for_delivery": "Out for delivery", "delivered": "Delivered",
    "available_for_pickup": "Ready for pickup", "delayed": "Delayed",
    "failure": "Delivery exception", "return_to_sender": "Returning to sender",
    "cancelled": "Cancelled", "unknown": "Awaiting an update",
  ]
  static let values = [
    "ordered", "pre_transit", "in_transit", "out_for_delivery", "delivered", "available_for_pickup",
    "delayed", "failure", "return_to_sender", "cancelled", "unknown",
  ]
  static func label(_ value: String) -> String {
    labels[value] ?? value.replacingOccurrences(of: "_", with: " ").capitalized
  }
  static func symbol(_ value: String) -> String {
    switch value {
    case "delivered": "checkmark.circle"
    case "failure", "delayed": "exclamationmark.triangle"
    case "out_for_delivery", "in_transit": "truck.box"
    case "cancelled", "return_to_sender": "arrow.uturn.backward"
    default: "shippingbox"
    }
  }
}
struct TrackingEvent: Codable, Identifiable, Equatable, Sendable {
  var id: String
  var status: String
  var message: String
  var location: String?
  var occurredAt: String
  var source: String
}
struct SourceEmail: Codable, Identifiable, Sendable {
  var id: String
  var subject: String
  var from: String
  var text: String?
  var receivedAt: String
  var sentAt: String?
}
struct ExtractionSummary: Codable, Sendable {
  var relevant: Bool?
  var reviewReason: String?
}
struct PackageReference: Codable, Identifiable, Sendable {
  var id: String
  var merchant: String
}
struct InboxEmail: Codable, Identifiable, Sendable {
  var id: String
  var subject: String
  var from: String
  var receivedAt: String
  var sentAt: String?
  var status: String
  var error: String?
  var text: String?
  var extraction: ExtractionSummary?
  var shipments: [PackageReference]?
  var stateLabel: String {
    switch status {
    case "queued", "processing": "Processing"
    case "processed": "Processed"
    case "ignored": "Not a physical delivery"
    case "needs_review": "Needs review"
    case "failed": "Could not process"
    default: status.replacingOccurrences(of: "_", with: " ").capitalized
    }
  }
}
struct PackageDetail: Codable, Sendable {
  var shipment: Shipment
  var events: [TrackingEvent]
  var emails: [SourceEmail]
}
struct Household: Codable, Identifiable, Sendable {
  var id: String
  var name: String
  var role: String
}
struct Member: Codable, Identifiable, Sendable {
  var userId: String?
  var name: String?
  var email: String
  var role: String
  var pending: Bool
  var id: String { userId ?? email }
}
struct Settings: Codable, Sendable {
  struct Account: Codable, Sendable { var email: String }
  struct Google: Codable, Sendable {
    var connected: Bool
    var calendarId: String?
    var lastSyncedAt: String?
    var error: String?
  }
  struct Gmail: Codable, Sendable {
    var connected: Bool
    var email: String?
    var enabled: Bool
    var needsReconnect: Bool
    var lastSyncedAt: String?
    var importedCount: Int
    var importing: Bool
    var error: String?
    var otherHouseholdName: String?
  }
  struct Worker: Codable, Sendable {
    var lastSeenAt: String?
    var failedJobs: Int
  }
  var householdName: String
  var timeZone: String
  var forwardingAddress: String?
  var calendarFeedUrl: String
  var demo: Bool
  var google: Google
  var gmail: Gmail
  var worker: Worker
  var userName: String
  var account: Account
  var householdId: String
  var role: String
  var households: [Household]
  var members: [Member]
}
struct Dashboard: Codable, Sendable {
  var shipments: [Shipment]
  var emails: [InboxEmail]
  var settings: Settings
}
struct NativeSession: Codable, Sendable, Equatable {
  var token: String
  var expiresAt: String
  var userId: String
  var householdId: String
}
struct ManualPackage: Codable, Equatable, Sendable {
  var merchant = ""
  var orderNumber: String?
  var orderedAt: String?
  var items = [PackageItem(name: "", quantity: 1)]
  var carrier: String?
  var trackingNumber: String?
  var trackingUrl: String?
  var status = "ordered"
  var shippedAt: String?
  var estimate: Estimate?
  var deliveredAt: String?
  var manualOverride = false
  init(_ s: Shipment? = nil) {
    guard let s else { return }
    merchant = s.merchant
    orderNumber = s.orderNumber
    orderedAt = s.orderedAt
    items = s.items
    carrier = s.carrier
    trackingNumber = s.trackingNumber
    trackingUrl = s.trackingUrl
    status = s.status
    shippedAt = s.shippedAt
    estimate = s.estimate
    deliveredAt = s.deliveredAt
    manualOverride = s.manualOverride
  }
  // The server's strict validator expects explicit nulls for optional form fields.
  func payload() throws -> Data {
    var value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as! [String: Any]
    for key in [
      "orderNumber", "orderedAt", "carrier", "trackingNumber", "trackingUrl", "shippedAt",
      "estimate", "deliveredAt",
    ] where value[key] == nil { value[key] = NSNull() }
    value["items"] = items.map {
      ["name": $0.name, "quantity": $0.quantity, "imageUrl": $0.imageUrl as Any? ?? NSNull()]
    }
    if let e = estimate {
      value["estimate"] = [
        "kind": e.kind, "start": e.start, "end": e.end as Any? ?? NSNull(), "timeZone": e.timeZone,
        "label": e.label as Any? ?? NSNull(),
      ]
    }
    return try JSONSerialization.data(withJSONObject: value, options: .sortedKeys)
  }
  var validation: String? {
    if merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return "Enter a merchant."
    }
    if items.isEmpty
      || items.contains(where: {
        $0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || $0.quantity < 1
      })
    {
      return "Give every item a name and quantity."
    }
    if let orderedAt, Dates.dateOnly(orderedAt, zone: "UTC") == nil {
      return "Order date must be YYYY-MM-DD."
    }
    if let trackingUrl, URL(string: trackingUrl)?.scheme != "https" {
      return "Tracking links must use HTTPS."
    }
    return nil
  }
}
