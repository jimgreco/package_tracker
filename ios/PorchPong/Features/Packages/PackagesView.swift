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
              : "Newest orders first."
          )
            .font(.caption).foregroundStyle(.secondary)
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
          search.isEmpty ? "No packages here" : "No matching packages",
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
      text: $search, prompt: "Merchant, note, item, order or tracking"
    )
    .refreshable { await store.refresh() }
  }

  private func packageLink(_ shipment: Shipment) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      NavigationLink {
        PackageDetailView(id: shipment.id)
      } label: {
        PackageRow(shipment: shipment, showNote: false)
      }
      PackageHomeNote(id: shipment.id, note: shipment.note)
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

private struct PackageHomeNote: View {
  @Environment(AppStore.self) private var store
  let id: String
  let note: String?
  @State private var draft: String
  @State private var saved: String
  @State private var saving = false
  @State private var error: String?
  @FocusState private var focused: Bool

  init(id: String, note: String?) {
    self.id = id
    self.note = note
    _draft = State(initialValue: note ?? "")
    _saved = State(initialValue: note ?? "")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("Your note").font(.caption.weight(.semibold))
      TextField("Tap to add a note", text: $draft, axis: .vertical)
        .lineLimit(1...4)
        .focused($focused)
        .accessibilityIdentifier("quickNoteField-\(id)")
        .disabled(store.offline || store.session == nil)
      if saving { Text("Saving…").font(.caption).foregroundStyle(.secondary) }
      if let error {
        HStack {
          Text(error).font(.caption).foregroundStyle(.red)
          Button("Retry") { Task { await save() } }.disabled(!store.canWrite)
        }
      }
    }
    .padding(9)
    .background(Color.yellow.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    .onChange(of: draft) { _, next in
      if next.count > 1000 { draft = String(next.prefix(1000)) }
      error = nil
    }
    .onChange(of: focused) { wasFocused, isFocused in
      if wasFocused && !isFocused { Task { await save() } }
    }
    .onChange(of: note) { _, current in
      if !focused && !saving && draft == saved {
        draft = current ?? ""
        saved = current ?? ""
      }
    }
    .onChange(of: store.canWrite) { _, available in
      if available && error == nil { Task { await save() } }
    }
    .task(id: draft) {
      do { try await Task.sleep(for: .milliseconds(800)) } catch { return }
      if !Task.isCancelled && error == nil { Task { await save() } }
    }
  }

  private func save() async {
    guard !saving else { return }
    guard store.canWrite else { return }
    let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed != saved else { return }
    saving = true
    defer { saving = false }
    while true {
      let next = draft.trimmingCharacters(in: .whitespacesAndNewlines)
      if next == saved { return }
      do {
        let body = try JSONEncoder().encode(QuickNoteRequest(note: next.isEmpty ? nil : next))
        try await store.mutate("shipments/\(id)/note", method: "PATCH", body: body)
        saved = next
        error = nil
      } catch {
        self.error = store.friendly(error)
        return
      }
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
