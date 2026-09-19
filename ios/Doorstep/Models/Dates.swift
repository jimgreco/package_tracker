import Foundation

enum Dates {
  static func instant(_ value: String?) -> Date? {
    guard let value else { return nil }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = f.date(from: value) { return date }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: value)
  }
  static func formatter(_ format: String, zone: String) -> DateFormatter {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.calendar = Calendar(identifier: .gregorian)
    f.timeZone = TimeZone(identifier: zone) ?? TimeZone(secondsFromGMT: 0)
    f.dateFormat = format
    f.isLenient = false
    return f
  }
  static func dateOnly(_ value: String, zone: String) -> Date? {
    guard value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
      return nil
    }
    let f = formatter("yyyy-MM-dd HH:mm", zone: zone)
    guard let d = f.date(from: value + " 12:00"), f.string(from: d) == value + " 12:00" else {
      return nil
    }
    return d
  }
  static func local(_ value: String, zone: String) -> Date? {
    if let absolute = instant(value) { return absolute }
    for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm"] {
      let f = formatter(format, zone: zone)
      if let d = f.date(from: value), f.string(from: d) == value {
        // Reject DST gaps and repeated local hours, matching server review semantics.
        if [-3600.0, 3600.0].contains(where: { f.string(from: d.addingTimeInterval($0)) == value })
        {
          return nil
        }
        return d
      }
    }
    return nil
  }
  static func timestamp(_ value: String?, zone: String) -> String {
    guard let d = instant(value) else { return "Not available" }
    return formatter("MMM d, yyyy 'at' h:mm a", zone: zone).string(from: d)
  }
  static func day(_ value: String?, zone: String) -> String {
    guard let value, let d = dateOnly(value, zone: zone) ?? instant(value) else {
      return "Not specified"
    }
    return formatter("MMM d, yyyy", zone: zone).string(from: d)
  }
  static func estimate(_ e: Estimate?, now: Date, phoneZone: String = TimeZone.current.identifier)
    -> String
  {
    guard let e else { return "Delivery date not yet known" }
    let suffix = " (\(e.timeZone.replacingOccurrences(of: "_", with: " ")))"
    let zoneSuffix = e.timeZone == phoneZone ? "" : suffix
    let short = formatter("MMM d", zone: e.timeZone)
    if ["date", "date_range"].contains(e.kind) {
      guard let start = dateOnly(e.start, zone: e.timeZone) else {
        return "Delivery date needs review"
      }
      if e.kind == "date_range", let endString = e.end,
        let end = dateOnly(endString, zone: e.timeZone)
      {
        return "Expected \(short.string(from: start))–\(short.string(from: end))" + zoneSuffix
      }
      return "Expected \(short.string(from: start))" + zoneSuffix
    }
    guard let start = local(e.start, zone: e.timeZone) else { return "Delivery time needs review" }
    let sameDay =
      formatter("yyyy-MM-dd", zone: e.timeZone).string(from: now)
      == formatter("yyyy-MM-dd", zone: e.timeZone).string(from: start)
    let date = sameDay ? "Today" : short.string(from: start)
    let time = formatter("h:mm a", zone: e.timeZone)
    switch e.kind {
    case "window":
      guard let endString = e.end, let end = local(endString, zone: e.timeZone) else {
        return "Delivery window needs review"
      }
      let endDay =
        short.string(from: end) == short.string(from: start) ? "" : short.string(from: end) + ", "
      return "\(date), \(time.string(from: start))–\(endDay)\(time.string(from: end))" + zoneSuffix
    case "point": return "Expected \(date), \(time.string(from: start))" + zoneSuffix
    case "deadline": return "By \(date), \(time.string(from: start))" + zoneSuffix
    default: return e.label ?? "Delivery estimate pending"
    }
  }
  static func delivery(_ shipment: Shipment, zone: String, now: Date) -> String {
    if shipment.status == "delivered" {
      return shipment.deliveredAt == nil
        ? "Delivered · date not specified" : "Delivered \(day(shipment.deliveredAt, zone: zone))"
    }
    return estimate(shipment.estimate, now: now)
  }
  static func arrivingToday(_ s: Shipment, zone: String, now: Date) -> Bool {
    guard PackageFilter.onTheWay.includes(s), let e = s.estimate else { return false }
    let dayFormat = formatter("yyyy-MM-dd", zone: zone)
    let today = dayFormat.string(from: now)
    if ["date", "date_range"].contains(e.kind) {
      guard dateOnly(e.start, zone: e.timeZone) != nil else { return false }
      // Date-only deliveries are destination calendar days, compared to household's current day.
      return e.start <= today && (e.end ?? e.start) >= today
    }
    guard let start = local(e.start, zone: e.timeZone) else { return false }
    let end = e.end.flatMap { local($0, zone: e.timeZone) } ?? start
    return dayFormat.string(from: start) <= today && dayFormat.string(from: end) >= today
  }
}
