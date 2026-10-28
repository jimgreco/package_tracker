import SwiftUI

private enum PackageDisplay: String, CaseIterable {
  case list = "List"
  case calendar = "Calendar"
}

struct PackagesView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @State private var display = PackageDisplay.list
  private var filter: PackageFilter { store.listPreferences.filter }
  private var search: String { store.listPreferences.search }
  private var filterBinding: Binding<PackageFilter> {
    Binding(get: { filter }, set: { store.updateListPreferences(filter: $0) })
  }
  private var searchBinding: Binding<String> {
    Binding(get: { search }, set: { store.updateListPreferences(search: $0) })
  }
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
    let sections = PackageHomeSections(
      shipments: store.shipments, filter: filter, search: search, zone: store.timeZone,
      now: store.now())
    return List {
      Section {
        ServiceBanner()
        VStack(alignment: .leading, spacing: 8) {
          Text(store.householdName).font(.subheadline.weight(.semibold))
          Text(
            filter == .onTheWay
              ? "Today's deliveries first. Future packages are newest first."
              : filter == .noEstimate ? "Active packages without a delivery estimate." : filter == .toCollect ? "Delivered packages not yet marked collected." : "Newest orders first."
          )
            .font(.caption).foregroundStyle(.secondary)
          Menu {
            Picker("Package filter", selection: filterBinding) {
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
          preferencesLayout {
            Text("Remembers your search and filter on this device.")
              .font(.caption).foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
            if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }
            Button("Reset list") { store.resetListPreferences() }
              .font(.caption).frame(minHeight: 44)
              .fixedSize(horizontal: true, vertical: false)
              .buttonStyle(.borderless)
              .disabled(store.listPreferences.isDefault)
              .accessibilityIdentifier("resetPackageList")
          }
        }
      }.listRowBackground(Color.clear)
      if filter == .onTheWay {
        if !sections.deliveredToday.isEmpty {
          Section("Delivered today") {
            ForEach(sections.deliveredToday) { shipment in packageLink(shipment) }
          }
        }
        if !sections.expectedToday.isEmpty {
          Section("Expected today") {
            ForEach(sections.expectedToday) { shipment in packageLink(shipment) }
          }
        }
        if !sections.attention.isEmpty {
          Section("Needs attention") {
            Text("Review these packages and their source emails.")
              .font(.footnote).foregroundStyle(.secondary)
            ForEach(sections.attention) { shipment in packageLink(shipment) }
          }
        }
      }
      if !sections.remaining.isEmpty {
        Section(filter == .onTheWay ? "Future Packages" : filter.rawValue) {
          ForEach(sections.remaining) { shipment in packageLink(shipment) }
        }
      }
      if sections.deliveredToday.isEmpty && sections.expectedToday.isEmpty
        && sections.attention.isEmpty && sections.remaining.isEmpty && sections.snoozed.isEmpty
      {
        ContentUnavailableView(
          search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "No packages here" : "No matching packages",
          systemImage: "shippingbox",
          description: Text(
            store.loading ? "Loading your household…"
              : store.shipments.contains(where: { $0.snoozedAt != nil })
                ? "Check Snoozed below or try another filter."
                : "Try another filter or add a package."))
      }
      if !sections.snoozed.isEmpty {
        Section("Snoozed") {
          Text("Hidden from the main list until a new email or tracking update arrives.")
            .font(.footnote).foregroundStyle(.secondary)
          ForEach(sections.snoozed) { shipment in packageLink(shipment) }
        }
      }
    }
    .scrollContentBackground(.hidden).background(Color.canvas)
    .searchable(
      text: searchBinding,
      prompt: dynamicTypeSize.isAccessibilitySize
        ? "Search" : "Shop, carrier, note, item, order or tracking"
    )
    .refreshable { await store.refresh() }
  }

  private var preferencesLayout: AnyLayout {
    dynamicTypeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
      : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
  }

  private func packageLink(_ shipment: Shipment) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      packageNavigationLink(shipment)
      if let note = shipment.note, !note.isEmpty {
        Text(note)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.bottom, 8)
      }
      preferencesLayout {
        PackageHomeNote(id: shipment.id, merchant: shipment.merchant, note: shipment.note)
        if shipment.status == "delivered" && shipment.dismissedAt == nil
          && shipment.snoozedAt == nil && shipment.archivedAt == nil
        {
          if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }
          PackageHomeCollection(shipment: shipment)
        }
      }
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      if shipment.snoozedAt != nil {
        Button("Show now") { Task { await store.action(shipment, "unsnooze") } }
          .tint(.porchPong).disabled(!store.canWrite)
      } else if shipment.dismissedAt != nil {
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
      if shipment.status == "delivered" && shipment.dismissedAt == nil {
        Button(shipment.collectedAt == nil ? "Collect" : "Undo collection") {
          Task { await store.action(shipment, shipment.collectedAt == nil ? "collect" : "uncollect") }
        }.tint(.green)
          .disabled(!store.canWrite)
      }
      if shipment.canDeliver {
        Button("Mark delivered") { Task { await store.action(shipment, "deliver") } }.tint(
          .green
        ).disabled(!store.canWrite)
      }
    }
  }

  private func packageNavigationLink(_ shipment: Shipment) -> some View {
    NavigationLink {
      PackageDetailView(id: shipment.id)
    } label: {
      PackageRow(shipment: shipment, showNote: false)
    }
  }
}
struct PackageRow: View {
  @Environment(AppStore.self) private var store
  let shipment: Shipment
  var showNote = true
  var body: some View {
    HStack(alignment: .top, spacing: 13) {
      AuthenticatedThumbnail(path: shipment.items.first?.imageUrl)
      VStack(alignment: .leading, spacing: 4) {
        Text(shipment.merchant).font(.headline)
        Text(shipment.summary).font(.subheadline).foregroundStyle(.secondary)
        if showNote, let note = shipment.note, !note.isEmpty {
          Text("Your note: \(note)")
            .font(.subheadline)
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(8)
            .background(Color.yellow.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
        }
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

private struct PackageHomeCollection: View {
  @Environment(AppStore.self) private var store
  let shipment: Shipment
  @State private var saving = false
  @State private var error: String?
  private var label: String { shipment.collectedAt == nil ? "Mark collected" : "Undo collection" }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button {
        guard !saving, store.canWrite else { return }
        saving = true
        error = nil
        Task { await save() }
      } label: {
        HStack(spacing: 5) {
          if saving { ProgressView().controlSize(.small) }
          Text(saving ? "Saving…" : label)
            .fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.borderless)
      .disabled(saving || !store.canWrite)
      .accessibilityLabel("\(saving ? "Saving collection" : label) for \(shipment.merchant)")
      .accessibilityIdentifier("collectionButton-\(shipment.id)")
      if let error {
        Text(error).font(.caption).foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func save() async {
    let captured = store.epoch
    let collecting = shipment.collectedAt == nil
    defer { saving = false }
    do {
      try await store.mutate("shipments/\(shipment.id)/\(collecting ? "collect" : "uncollect")")
      guard store.epoch == captured else { return }
      store.message = collecting ? "Package marked collected." : "Collection undone."
    } catch {
      guard store.epoch == captured else { return }
      self.error = store.friendly(error)
    }
  }
}

private struct PackageHomeNote: View {
  let id: String
  let merchant: String
  let note: String?
  @State private var editing = false

  var body: some View {
    Button { editing = true } label: {
      Label(note == nil ? "Add note" : "Edit note", systemImage: "pencil")
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.borderless)
    .accessibilityLabel("\(note == nil ? "Add" : "Edit") note for \(merchant)")
    .accessibilityIdentifier("quickNoteButton-\(id)")
    .sheet(isPresented: $editing) {
      PackageHomeNoteEditor(id: id, merchant: merchant, note: note)
    }
  }
}

private struct PackageHomeNoteEditor: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  let id: String
  let merchant: String
  let note: String?
  @State private var draft: String
  @State private var saving = false
  @State private var error: String?
  @FocusState private var focused: Bool

  init(id: String, merchant: String, note: String?) {
    self.id = id
    self.merchant = merchant
    self.note = note
    _draft = State(initialValue: note ?? "")
  }

  var body: some View {
    NavigationStack {
      Form {
        Section("Your note") {
          TextField("How you'll recognize this package", text: $draft, axis: .vertical)
            .lineLimit(3...8)
            .focused($focused)
            .accessibilityIdentifier("quickNoteField-\(id)")
            .task {
              try? await Task.sleep(for: .milliseconds(300))
              if !Task.isCancelled { focused = true }
            }
          Text("Optional, up to 1,000 characters.")
            .font(.caption).foregroundStyle(.secondary)
        }
        if let error {
          Section { Text(error).foregroundStyle(.red) }
        }
      }
      .navigationTitle("Note for \(merchant)")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.disabled(saving)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(saving ? "Saving…" : "Save") { Task { await save() } }
            .disabled(saving || !store.canWrite)
            .accessibilityIdentifier("saveQuickNote")
        }
      }
    }
    .onChange(of: draft) { _, next in
      if next.count > 1000 { draft = String(next.prefix(1000)) }
      error = nil
    }
  }

  private func save() async {
    guard store.canWrite else { return }
    let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed != (note ?? "") else {
      dismiss()
      return
    }
    saving = true
    defer { saving = false }
    do {
      let body = try JSONEncoder().encode(QuickNoteRequest(note: trimmed.isEmpty ? nil : trimmed))
      try await store.mutate("shipments/\(id)/note", method: "PATCH", body: body)
      dismiss()
    } catch {
      self.error = store.friendly(error)
    }
  }
}

private struct QuickNoteRequest: Encodable {
  let note: String?
  private enum CodingKeys: String, CodingKey { case note }
  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    if let note {
      try container.encode(note, forKey: .note)
    } else {
      try container.encodeNil(forKey: .note)
    }
  }
}
