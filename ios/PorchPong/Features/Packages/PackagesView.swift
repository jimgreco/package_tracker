import SwiftUI

private enum PackageDisplay: String, CaseIterable {
  case list = "List"
  case calendar = "Calendar"
}

struct PackagesView: View {
  @Environment(AppStore.self) private var store
  @State private var display = PackageDisplay.list
  @State private var filter = PackageFilter.onTheWay
  @State private var search = ""
  @State private var adding = false
  var body: some View {
    VStack(spacing: 0) {
      Picker("Package view", selection: $display) {
        ForEach(PackageDisplay.allCases, id: \.self) { option in
          Text(option.rawValue).tag(option)
        }
      }
      .pickerStyle(.segmented)
      .accessibilityIdentifier("packageView")
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
      if display == .list {
        packageList
      } else {
        PackageCalendarView()
      }
    }
    .background(Color.canvas)
    .navigationTitle("Packages")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button("Add package", systemImage: "plus") { adding = true }.disabled(!store.canWrite)
          .accessibilityIdentifier("addPackage")
      }
    }
    .sheet(isPresented: $adding) { PackageForm() }
    .overlay { if store.loading && store.shipments.isEmpty { ProgressView("Loading packages") } }
  }

  private var packageList: some View {
    List {
      Section {
        ServiceBanner()
        VStack(alignment: .leading, spacing: 8) {
          Text(store.householdName).font(.subheadline.weight(.semibold))
          Text("Newest orders first.").font(.caption).foregroundStyle(.secondary)
          Menu {
            Picker("Package filter", selection: $filter) {
              ForEach(PackageFilter.allCases) { option in
                Text("\(option.rawValue) (\(option.results(store.shipments).count))").tag(option)
              }
            }
          } label: {
            Label(
              "\(filter.rawValue) · \(filter.results(store.shipments).count)",
              systemImage: "line.3.horizontal.decrease"
            ).font(.subheadline).frame(minHeight: 44)
          }.accessibilityIdentifier("packageFilter")
        }
        if filter == .attention {
          Text("Missed estimates, stalled orders, tracking problems, or details that need review.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        let today = store.shipments.filter {
          $0.snoozedAt == nil && $0.dismissedAt == nil
            && Dates.arrivingToday($0, zone: store.timeZone, now: store.now())
        }.count
        if today > 0 {
          Label(
            "\(today) \(today == 1 ? "package" : "packages") expected today", systemImage: "sun.max"
          ).font(.subheadline).foregroundStyle(Color.porchPong)
        }
      }.listRowBackground(Color.clear)
      Section {
        let rows = filter.results(store.shipments, search: search)
        if rows.isEmpty {
          ContentUnavailableView(
            search.isEmpty ? "No packages here" : "No matching packages",
            systemImage: "shippingbox",
            description: Text(
              store.loading ? "Loading your household…"
                : store.shipments.contains(where: { $0.snoozedAt != nil })
                  ? "Check Snoozed below or try another filter."
                  : "Try another filter or add a package."))
        }
        ForEach(rows) { shipment in
          NavigationLink {
            PackageDetailView(id: shipment.id)
          } label: {
            PackageRow(shipment: shipment)
          }
          .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if shipment.dismissedAt != nil {
              Button("Restore") { Task { await store.action(shipment, "restore") } }.tint(.porchPong)
                .disabled(!store.canWrite)
            } else {
              Button("Snooze") { Task { await store.action(shipment, "snooze") } }
                .tint(.indigo).disabled(!store.canWrite)
              Button("Dismiss", role: .destructive) {
                Task { await store.action(shipment, "dismiss") }
              }.disabled(!store.canWrite)
            }
          }
          .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if shipment.status == "delivered" && shipment.dismissedAt == nil
              && shipment.collectedAt == nil
            {
              Button("Collect") { Task { await store.action(shipment, "collect") } }.tint(.green)
                .disabled(!store.canWrite)
            }
            if shipment.canDeliver {
              Button("Mark delivered") { Task { await store.action(shipment, "deliver") } }.tint(
                .green
              ).disabled(!store.canWrite)
            }
          }
        }
      }
      let snoozed = store.shipments.filter { shipment in
        shipment.archivedAt == nil && shipment.dismissedAt == nil && shipment.snoozedAt != nil
          && (search.isEmpty
            || [shipment.merchant, shipment.summary, shipment.orderNumber ?? "",
                shipment.trackingNumber ?? ""].contains {
              $0.localizedCaseInsensitiveContains(search)
            })
      }
      if !snoozed.isEmpty {
        Section("Snoozed") {
          Text("Hidden from the main list until a new email or tracking update arrives.")
            .font(.footnote).foregroundStyle(.secondary)
          ForEach(snoozed) { shipment in
            NavigationLink {
              PackageDetailView(id: shipment.id)
            } label: {
              PackageRow(shipment: shipment)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
              Button("Show now") { Task { await store.action(shipment, "unsnooze") } }
                .tint(.porchPong).disabled(!store.canWrite)
            }
          }
        }
      }
    }
    .scrollContentBackground(.hidden).background(Color.canvas)
    .searchable(
      text: $search, prompt: "Merchant, item, order or tracking"
    )
    .refreshable { await store.refresh() }
  }
}
struct PackageRow: View {
  @Environment(AppStore.self) private var store
  let shipment: Shipment
  var body: some View {
    HStack(alignment: .top, spacing: 13) {
      AuthenticatedThumbnail(path: shipment.items.first?.imageUrl)
      VStack(alignment: .leading, spacing: 4) {
        Text(shipment.merchant).font(.headline)
        Text(shipment.summary).font(.subheadline).foregroundStyle(.secondary)
        StatusLabel(status: shipment.status)
        Text(Dates.delivery(shipment, zone: store.timeZone, now: store.now())).font(.footnote)
        if let number = shipment.orderNumber {
          Text("Order \(number)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
        }
        if shipment.collectedAt != nil {
          Text("Collected by \(shipment.collectedByName ?? "a household member")").font(.caption)
        }
        if let reason = shipment.attentionReasons?.first ?? shipment.reviewReason {
          Text(reason).font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    }.padding(.vertical, 8).accessibilityElement(children: .combine)
  }
}
