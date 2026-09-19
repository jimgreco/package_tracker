import SwiftUI

struct PackageForm: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  let shipment: Shipment?
  @State private var value: ManualPackage
  @State private var attempt = SaveAttempt()
  @State private var error: String?
  init(shipment: Shipment? = nil) {
    self.shipment = shipment
    _value = State(initialValue: ManualPackage(shipment))
  }
  var body: some View {
    NavigationStack {
      ScrollViewReader { scroll in
        Form {
          if let error {
            Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("formError") }.id(
              "form-error")
          }
          Section("Package") {
            TextField("Merchant", text: $value.merchant).textContentType(.organizationName)
              .accessibilityIdentifier("merchantField")
            if value.merchant.trimmingCharacters(in: .whitespaces).isEmpty {
              Text("Merchant is required.").font(.caption).foregroundStyle(.secondary)
            }
            FormChoice(
              title: "Status", selection: $value.status,
              choices: PackageStatus.values
                + (PackageStatus.values.contains(value.status) ? [] : [value.status]),
              label: PackageStatus.label)

          }
          Section("Items") {
            ForEach(value.items.indices, id: \.self) { index in
              VStack(alignment: .leading) {
                TextField("Item name", text: $value.items[index].name).accessibilityIdentifier(
                  "itemField\(index)")
                Stepper(
                  "Quantity: \(value.items[index].quantity)", value: $value.items[index].quantity,
                  in: 1...10000)
                if value.items.count > 1 {
                  Button("Remove item", role: .destructive) { value.items.remove(at: index) }
                }
              }
            }
            Button("Add another item", systemImage: "plus") {
              value.items.append(PackageItem(name: "", quantity: 1))
            }.disabled(value.items.count >= 100)
          }
          Section {
            DisclosureGroup("Order and tracking") {
              TextField("Order number", text: optional(\.orderNumber))
              TextField("Order date (YYYY-MM-DD)", text: optional(\.orderedAt))
                .autocorrectionDisabled().textInputAutocapitalization(.never)
              TextField("Carrier", text: optional(\.carrier))
              TextField("Tracking number", text: optional(\.trackingNumber))
                .textInputAutocapitalization(.never).autocorrectionDisabled()
              TextField("Tracking URL (https://…)", text: optional(\.trackingUrl), axis: .vertical)
                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
              Text("Use the original tracking link from your retailer or carrier.").font(.caption)
                .foregroundStyle(.secondary)
            }
          }
          Section("Delivery estimate") {
            FormChoice(
              title: "Precision",
              selection: Binding(
                get: { value.estimate?.kind ?? "none" },
                set: { kind in
                  if kind == "none" {
                    value.estimate = nil
                  } else if value.estimate == nil {
                    value.estimate = Estimate(kind: kind, start: "", timeZone: store.timeZone)
                  } else {
                    value.estimate?.kind = kind
                  }
                }), choices: ["none", "date", "date_range", "window", "point", "deadline"],
              label: {
                [
                  "none": "Unknown", "date": "Date", "date_range": "Date range",
                  "window": "Time window", "point": "Exact time", "deadline": "Deadline",
                ][$0] ?? $0
              })
            if let estimate = value.estimate {
              let dateOnly = ["date", "date_range"].contains(estimate.kind)
              TextField(
                dateOnly ? "Start date (YYYY-MM-DD)" : "Start (YYYY-MM-DDTHH:mm)",
                text: Binding(
                  get: { value.estimate?.start ?? "" }, set: { value.estimate?.start = $0 })
              ).autocorrectionDisabled().textInputAutocapitalization(.never)
              if ["date_range", "window"].contains(estimate.kind) {
                TextField(
                  dateOnly ? "Last date, inclusive (YYYY-MM-DD)" : "End (YYYY-MM-DDTHH:mm)",
                  text: Binding(
                    get: { value.estimate?.end ?? "" },
                    set: { value.estimate?.end = $0.isEmpty ? nil : $0 })
                ).autocorrectionDisabled().textInputAutocapitalization(.never)
              }
              TextField(
                "Destination time zone",
                text: Binding(
                  get: { value.estimate?.timeZone ?? store.timeZone },
                  set: { value.estimate?.timeZone = $0 })
              ).autocorrectionDisabled().textInputAutocapitalization(.never)
              Text(
                "Use a destination zone such as America/New_York. Repeated or missing daylight-saving times need review."
              ).font(.caption).foregroundStyle(.secondary)
            }
          }
          Section {
            DisclosureGroup("Shipped and delivered times") {
              timestamp("Shipped time", keyPath: \.shippedAt)
              timestamp("Actual delivery time", keyPath: \.deliveredAt)
              Text("Leave times unknown unless the source or your household confirms them.").font(
                .caption
              ).foregroundStyle(.secondary)
            }
          }
          Section {
            Toggle("Protect status and estimate", isOn: $value.manualOverride)
          } footer: {
            Text(
              "Keeps your household’s status and delivery estimate when automatic tracking updates arrive. Other edits do not change this setting."
            )
          }
        }.onChange(of: error) { _, _ in scroll.scrollTo("form-error", anchor: .top) }
      }.navigationTitle(shipment == nil ? "Add package" : "Edit details")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { dismiss() }.disabled(attempt.saving)
          }
          ToolbarItem(placement: .confirmationAction) {
            Button(attempt.saving ? "Saving…" : "Save") {
              Task {
                do {
                  try await attempt.save(value, id: shipment?.id, store: store)
                  dismiss()
                } catch {
                  UIApplication.shared.sendAction(
                    #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                  self.error = store.friendly(error)
                }
              }
            }.disabled(attempt.saving || !store.canWrite).accessibilityIdentifier("savePackage")
          }
        }.interactiveDismissDisabled(attempt.saving)
    }
  }
  func optional(_ path: WritableKeyPath<ManualPackage, String?>) -> Binding<String> {
    Binding(
      get: { value[keyPath: path] ?? "" }, set: { value[keyPath: path] = $0.isEmpty ? nil : $0 })
  }
  func timestamp(_ title: String, keyPath: WritableKeyPath<ManualPackage, String?>) -> some View {
    VStack(alignment: .leading) {
      Toggle(
        "\(title) known",
        isOn: Binding(
          get: { value[keyPath: keyPath] != nil },
          set: { value[keyPath: keyPath] = $0 ? store.now().ISO8601Format() : nil }))
      if value[keyPath: keyPath] != nil {
        DatePicker(
          title,
          selection: Binding(
            get: { Dates.instant(value[keyPath: keyPath]) ?? store.now() },
            set: { value[keyPath: keyPath] = $0.ISO8601Format() })
        ).environment(\.timeZone, TimeZone(identifier: store.timeZone) ?? .current)
        Text("Time zone: \(store.timeZone)").font(.caption).foregroundStyle(.secondary)
      }
    }
  }
}

struct FormChoice: View {
  let title: String
  @Binding var selection: String
  let choices: [String]
  let label: (String) -> String
  var body: some View {
    Menu {
      ForEach(choices, id: \.self) { choice in
        Button {
          selection = choice
        } label: {
          if choice == selection {
            Label(label(choice), systemImage: "checkmark")
          } else {
            Text(label(choice))
          }
        }
      }
    } label: {
      VStack(alignment: .leading, spacing: 6) {
        Text(title).font(.caption).foregroundStyle(.secondary)
        Text(label(selection)).fixedSize(horizontal: false, vertical: true)
      }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).multilineTextAlignment(
        .leading)
    }.accessibilityLabel(title).accessibilityValue(label(selection)).accessibilityHint(
      "Choose an option")
  }
}
