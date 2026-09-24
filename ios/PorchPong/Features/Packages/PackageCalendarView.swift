import SwiftUI

struct PackageCalendarView: View {
  @Environment(AppStore.self) private var store
  @State private var displayedMonth: String?
  @State private var selectedDay: String?

  private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)
  private let weekdays = ["M", "T", "W", "T", "F", "S", "S"]

  var body: some View {
    let today = DeliveryCalendar.today(zone: store.timeZone, now: store.now())
    let month = displayedMonth ?? String(today.prefix(7))
    let day = selectedDay ?? today
    let dated = store.shipments.compactMap { shipment -> (Shipment, ClosedRange<String>)? in
      guard let span = DeliveryCalendar.span(shipment, householdZone: store.timeZone) else {
        return nil
      }
      return (shipment, span)
    }
    let shipments = dated.filter { $0.1.contains(day) }.map { $0.0 }
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        HStack(alignment: .center) {
          VStack(alignment: .leading, spacing: 3) {
            Text(monthTitle(month)).font(.title3.bold())
            Text("Delivery estimates").font(.caption).foregroundStyle(.secondary)
          }
          Spacer(minLength: 8)
          Button("Today") {
            displayedMonth = String(today.prefix(7))
            selectedDay = today
          }
          .font(.subheadline.weight(.semibold))
          .accessibilityIdentifier("calendarToday")
          Button("Previous month", systemImage: "chevron.left") {
            changeMonth(month, by: -1)
          }
          .labelStyle(.iconOnly)
          .accessibilityIdentifier("calendarPreviousMonth")
          Button("Next month", systemImage: "chevron.right") {
            changeMonth(month, by: 1)
          }
          .labelStyle(.iconOnly)
          .accessibilityIdentifier("calendarNextMonth")
        }
        VStack(spacing: 0) {
          LazyVGrid(columns: columns, spacing: 4) {
            ForEach(Array(weekdays.enumerated()), id: \.offset) { _, name in
              Text(name).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity).padding(.bottom, 7)
            }
            ForEach(DeliveryCalendar.days(in: month), id: \.self) { date in
              let entries = dated.filter { $0.1.contains(date) }.map { $0.0 }
              Button {
                selectedDay = date
                if !date.hasPrefix(month) { displayedMonth = String(date.prefix(7)) }
              } label: {
                VStack(spacing: 5) {
                  Text(String(Int(date.suffix(2)) ?? 1))
                    .font(.subheadline.weight(date == day ? .bold : .regular))
                  HStack(spacing: 3) {
                    ForEach(0..<min(entries.count, 3), id: \.self) { index in
                      Circle().fill(
                        date == day ? Color(uiColor: .systemBackground)
                          : entries[index].status == "delivered" ? Color.green : Color.porchPong
                      )
                        .frame(width: 5, height: 5)
                    }
                  }.frame(height: 5)
                }
                .frame(maxWidth: .infinity, minHeight: 49)
                .foregroundStyle(
                  date == day ? Color(uiColor: .systemBackground)
                    : date.hasPrefix(month) ? Color.primary : Color.secondary
                )
                .background(date == day ? Color.porchPong : Color.clear, in: RoundedRectangle(cornerRadius: 10))
              }
              .buttonStyle(.plain)
              .accessibilityLabel(
                "\(Dates.day(date, zone: store.timeZone)), \(entries.count) \(entries.count == 1 ? "delivery" : "deliveries")"
              )
              .accessibilityAddTraits(date == day ? .isSelected : [])
              .accessibilityIdentifier("calendarDay-\(date)")
            }
          }
          .padding(12)
        }
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))

        VStack(alignment: .leading, spacing: 12) {
          Text(Dates.day(day, zone: store.timeZone)).font(.headline)
          if shipments.isEmpty {
            ContentUnavailableView(
              "No deliveries expected", systemImage: "calendar",
              description: Text("Choose another day, or check List for packages without dates."))
          } else {
            ForEach(shipments) { shipment in
              NavigationLink {
                PackageDetailView(id: shipment.id)
              } label: {
                HStack {
                  PackageRow(shipment: shipment)
                  Spacer(minLength: 4)
                  Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                }
              }
              .buttonStyle(.plain)
              if shipment.id != shipments.last?.id { Divider() }
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))

        Text("Packages without a delivery date remain in List. Estimate dates follow each delivery’s time zone.")
          .font(.footnote).foregroundStyle(.secondary)
      }
      .padding(16)
    }
    .background(Color.canvas)
    .refreshable { await store.refresh() }
    .accessibilityIdentifier("packageCalendar")
  }

  private func changeMonth(_ month: String, by offset: Int) {
    let next = DeliveryCalendar.moveMonth(month, by: offset)
    displayedMonth = next
    selectedDay = next + "-01"
  }

  private func monthTitle(_ month: String) -> String {
    guard let date = Dates.dateOnly(month + "-01", zone: "UTC") else { return month }
    return Dates.formatter("LLLL yyyy", zone: "UTC").string(from: date)
  }
}
