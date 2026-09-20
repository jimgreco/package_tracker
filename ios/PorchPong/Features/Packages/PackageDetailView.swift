import SwiftUI

struct PackageDetailView: View {
  @Environment(AppStore.self) private var store
  let id: String
  @State private var detail: PackageDetail?
  @State private var editing = false
  @State private var merging = false
  @State private var loading = true
  var body: some View {
    List {
      ServiceBanner()
      if let detail {
        let s = detail.shipment
        Section {
          Text(s.merchant).font(.title2.bold())
          StatusLabel(status: s.status)
          Text(Dates.delivery(s, zone: store.timeZone, now: store.now())).font(.headline)
          ForEach(s.attentionReasons ?? (s.reviewReason.map { [$0] } ?? []), id: \.self) { reason in
            Label(reason, systemImage: "exclamationmark.triangle").font(.callout)
          }
          if s.status == "delivered" {
            VStack(alignment: .leading, spacing: 5) {
              if let collected = s.collectedAt {
                Label(
                  "Collected by \(s.collectedByName ?? "a household member")",
                  systemImage: "checkmark.circle.fill")
                Text(Dates.timestamp(collected, zone: store.timeZone)).font(.footnote)
              } else {
                Text("Not yet marked collected").font(.footnote)
              }
            }
          }
          ForEach(Array(s.items.enumerated()), id: \.offset) { _, item in
            HStack(alignment: .top) {
              AuthenticatedThumbnail(path: item.imageUrl)
              VStack(alignment: .leading) {
                Text(item.name)
                Text("Quantity \(item.quantity)").font(.caption).foregroundStyle(.secondary)
              }
            }
          }
        }
        Section("Package details") {
          if let order = s.orderNumber { copyRow("Order number", order) }
          LabeledContent("Order date", value: Dates.day(s.orderedAt, zone: store.timeZone))
          LabeledContent(
            "Initial email", value: Dates.timestamp(s.firstEmailAt, zone: store.timeZone))
          LabeledContent("Carrier", value: s.carrier ?? "Not provided")
          if let tracking = s.trackingNumber { copyRow("Tracking number", tracking) }
          LabeledContent(
            "Last tracking check", value: Dates.timestamp(s.lastCheckedAt, zone: store.timeZone))
          if let event = detail.events.first {
            LabeledContent("Latest update source", value: event.source)
          }
          if s.manualOverride {
            Label("Status and estimate protected from automatic updates", systemImage: "lock").font(
              .footnote)
          }
          Text(
            "Times shown in \(store.timeZone.replacingOccurrences(of: "_", with: " ")). Delivery estimates use their destination time zone."
          ).font(.caption).foregroundStyle(.secondary)
        }
        Section("Actions") {
          if let raw = s.trackingUrl, let url = URL(string: raw), url.scheme == "https",
            url.user == nil, url.password == nil
          {
            Link("Open tracking website", destination: url)
          }
          Button(
            store.trackingRequested.contains(id)
              ? "Tracking check requested · check again" : "Check tracking"
          ) {
            Task {
              await store.action(s, "refresh")
              await load()
            }
          }.disabled(!store.canWrite || s.trackingNumber == nil)
          if s.status == "delivered" && s.dismissedAt == nil {
            Button(s.collectedAt == nil ? "Mark collected" : "Undo collection") {
              Task {
                await store.action(s, s.collectedAt == nil ? "collect" : "uncollect")
                await load()
              }
            }.disabled(!store.canWrite)
          }
          if s.canDeliver {
            Button("Mark delivered") {
              Task {
                await store.action(s, "deliver")
                await load()
              }
            }.disabled(!store.canWrite)
          }
          Button(s.dismissedAt == nil ? "Dismiss package" : "Restore package") {
            Task {
              await store.action(s, s.dismissedAt == nil ? "dismiss" : "restore")
              await load()
            }
          }.disabled(!store.canWrite)
          Button("Edit details") { editing = true }.disabled(!store.canWrite)
          Button("Merge duplicate entries") { merging = true }.disabled(
            !store.canWrite || store.shipments.count < 2)
        }
        Section("Tracking history") {
          if detail.events.isEmpty { Text("No updates yet.").foregroundStyle(.secondary) }
          ForEach(detail.events) { event in
            VStack(alignment: .leading, spacing: 5) {
              StatusLabel(status: event.status)
              Text(event.message)
              if let location = event.location { Text(location).font(.caption) }
              Text("\(Dates.timestamp(event.occurredAt, zone: store.timeZone)) · \(event.source)")
                .font(.caption).foregroundStyle(.secondary)
            }
          }
        }
        Section("Source emails") {
          if store.offline {
            Text("Connect to read original emails.")
          } else if detail.emails.isEmpty {
            Text("Added manually. No source emails.").foregroundStyle(.secondary)
          } else {
            ForEach(detail.emails) { email in
              NavigationLink {
                SourceEmailView(email: email)
              } label: {
                VStack(alignment: .leading, spacing: 5) {
                  Text(email.subject)
                  Text(email.from).font(.caption).foregroundStyle(.secondary)
                  Text(
                    "\(email.sentAt == nil ? "Imported" : "Sent") \(Dates.timestamp(email.sentAt ?? email.receivedAt, zone: store.timeZone))"
                  ).font(.caption)
                }
              }
            }
          }
        }
      } else if !loading {
        ContentUnavailableView(
          "Package unavailable", systemImage: "shippingbox",
          description: Text("Refresh to try again."))
      }
    }.navigationTitle("Package").navigationBarTitleDisplayMode(.inline)
      .overlay { if loading && detail == nil { ProgressView() } }
      .task { await load() }.refreshable {
        await store.refresh()
        await load()
      }
      .sheet(isPresented: $editing, onDismiss: { Task { await load() } }) {
        if let detail { PackageForm(shipment: detail.shipment) }
      }
      .sheet(isPresented: $merging, onDismiss: { Task { await load() } }) {
        if let detail { MergeView(source: detail.shipment) }
      }
  }
  func load() async {
    loading = true
    detail = await store.loadDetail(id)
    loading = false
  }
  func copyRow(_ title: String, _ value: String) -> some View {
    VStack(alignment: .leading) {
      Text(title).font(.caption).foregroundStyle(.secondary)
      Text(value).textSelection(.enabled)
      Button("Copy \(title.lowercased())", systemImage: "doc.on.doc") {
        UIPasteboard.general.string = value
      }.font(.footnote).frame(minHeight: 44)
    }
  }
}
struct SourceEmailView: View {
  @Environment(AppStore.self) private var store
  let email: SourceEmail
  var body: some View {
    List {
      Section {
        Text(email.subject).font(.headline)
        Text(email.from)
        LabeledContent(
          "Original sent date", value: Dates.timestamp(email.sentAt, zone: store.timeZone))
        LabeledContent("Imported", value: Dates.timestamp(email.receivedAt, zone: store.timeZone))
      }
      Section("Original email") {
        Text(email.text ?? "No readable text is available.").textSelection(.enabled)
      }
    }.navigationTitle("Source email").navigationBarTitleDisplayMode(.inline)
  }
}
struct MergeView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  let source: Shipment
  @State private var target: Shipment?
  @State private var confirming = false
  var body: some View {
    NavigationStack {
      List {
        Section("Entry to archive") { PackageRow(shipment: source) }
        Section("Choose the entry to keep") {
          ForEach(store.shipments.filter { $0.id != source.id && $0.archivedAt == nil }) { s in
            Button {
              target = s
            } label: {
              VStack(alignment: .leading) {
                PackageRow(shipment: s)
                if target?.id == s.id {
                  Label("Keep this package", systemImage: "checkmark.circle.fill")
                }
              }
            }.foregroundStyle(.primary)
          }
        }
        if let target {
          Section("Confirm merge") {
            Text(
              "Keep \(target.merchant), order \(target.orderNumber ?? "not specified"), tracking \(target.trackingNumber ?? "not specified"). Archive \(source.merchant), order \(source.orderNumber ?? "not specified"), tracking \(source.trackingNumber ?? "not specified"). All source emails and history move to the retained entry. Its status and details stay as shown."
            )
            Button("Merge into selected package", role: .destructive) { confirming = true }
              .disabled(!store.canWrite)
          }
        }
        ServiceBanner()
      }.navigationTitle("Merge duplicates").toolbar { Button("Cancel") { dismiss() } }
        .confirmationDialog(
          "Merge these two packages?", isPresented: $confirming, titleVisibility: .visible
        ) {
          Button("Merge packages", role: .destructive) {
            Task {
              guard let target else { return }
              do {
                try await store.mutate(
                  "shipments/\(source.id)/merge",
                  body: JSONEncoder().encode(["targetId": target.id]))
                dismiss()
              } catch {}
            }
          }
        } message: {
          Text("The selected entry will be kept. The other entry will be archived.")
        }
    }
  }
}
