import Foundation

enum DeliveryCalendar {
  private static var utc: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    calendar.firstWeekday = 2
    return calendar
  }

  static func today(zone: String, now: Date) -> String {
    Dates.formatter("yyyy-MM-dd", zone: zone).string(from: now)
  }

  static func moveMonth(_ month: String, by offset: Int) -> String {
    guard let first = Dates.dateOnly(month + "-01", zone: "UTC"),
      let moved = utc.date(byAdding: .month, value: offset, to: first)
    else { return month }
    return Dates.formatter("yyyy-MM", zone: "UTC").string(from: moved)
  }

  static func days(in month: String) -> [String] {
    guard let first = Dates.dateOnly(month + "-01", zone: "UTC"),
      let dayCount = utc.range(of: .day, in: .month, for: first)?.count,
      let gridStart = utc.date(
        byAdding: .day, value: -((utc.component(.weekday, from: first) + 5) % 7), to: first)
    else { return [] }
    let leading = (utc.component(.weekday, from: first) + 5) % 7
    let count = ((leading + dayCount + 6) / 7) * 7
    let format = Dates.formatter("yyyy-MM-dd", zone: "UTC")
    return (0..<count).compactMap { offset in
      utc.date(byAdding: .day, value: offset, to: gridStart).map(format.string(from:))
    }
  }

  static func span(_ shipment: Shipment, householdZone: String) -> ClosedRange<String>? {
    guard shipment.archivedAt == nil, shipment.dismissedAt == nil,
      shipment.status != "cancelled"
    else { return nil }
    if shipment.status == "delivered" {
      guard let delivered = Dates.instant(shipment.deliveredAt) else { return nil }
      let day = Dates.formatter("yyyy-MM-dd", zone: householdZone).string(from: delivered)
      return day...day
    }
    guard let estimate = shipment.estimate else { return nil }
    if estimate.kind == "date" || estimate.kind == "date_range" {
      guard Dates.dateOnly(estimate.start, zone: estimate.timeZone) != nil else { return nil }
      let validEnd = estimate.end.flatMap {
        Dates.dateOnly($0, zone: estimate.timeZone) == nil ? nil : $0
      }
      let end = estimate.kind == "date_range" ? (validEnd ?? estimate.start) : estimate.start
      return estimate.start...max(estimate.start, end)
    }
    guard let start = Dates.local(estimate.start, zone: estimate.timeZone) else { return nil }
    let day = Dates.formatter("yyyy-MM-dd", zone: estimate.timeZone).string(from: start)
    return day...day
  }

  static func includes(_ shipment: Shipment, on day: String, householdZone: String) -> Bool {
    span(shipment, householdZone: householdZone)?.contains(day) ?? false
  }
}
