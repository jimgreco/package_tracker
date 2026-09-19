import SwiftUI

struct InboxView: View {
  @Environment(AppStore.self) private var store
  @State private var pasting = false
  var body: some View {
    List {
      Section {
        ServiceBanner()
        Text(
          "Original emails, in the order they were sent. Digital purchases and unrelated messages are not packages."
        ).font(.footnote).foregroundStyle(.secondary)
      }
      if let emails = store.dashboard?.emails {
        if emails.isEmpty {
          ContentUnavailableView(
            "No emails yet", systemImage: "tray",
            description: Text("Forward a delivery email or paste one here."))
        }
        ForEach(emails) { email in
          NavigationLink {
            EmailDetailView(id: email.id)
          } label: {
            VStack(alignment: .leading, spacing: 6) {
              Text(email.subject).font(.headline)
              Text(email.from).font(.subheadline).foregroundStyle(.secondary)
              Text(email.stateLabel).font(.caption.weight(.semibold)).foregroundStyle(
                Color.doorstep)
              Text(
                "\(email.sentAt == nil ? "Imported" : "Sent") \(Dates.timestamp(email.sentAt ?? email.receivedAt, zone: store.timeZone))"
              ).font(.caption).foregroundStyle(.secondary)
            }.padding(.vertical, 5)
          }
        }
      } else {
        ContentUnavailableView(
          "Connect to view your inbox", systemImage: "wifi.slash",
          description: Text("Original email text is not saved on this iPhone."))
      }
    }.navigationTitle("Inbox").refreshable { await store.refresh() }
      .toolbar {
        Button("Paste email", systemImage: "square.and.pencil") { pasting = true }.disabled(
          !store.canWrite
        ).accessibilityIdentifier("pasteEmail")
      }
      .sheet(isPresented: $pasting) { PasteEmailView() }
  }
}
struct EmailDetailView: View {
  @Environment(AppStore.self) private var store
  let id: String
  @State private var email: InboxEmail?
  @State private var loading = true
  var body: some View {
    List {
      ServiceBanner()
      if let email {
        Section {
          Text(email.subject).font(.headline)
          Text(email.from)
          Text(email.stateLabel).foregroundStyle(Color.doorstep)
          LabeledContent(
            "Original sent date", value: Dates.timestamp(email.sentAt, zone: store.timeZone))
          LabeledContent("Imported", value: Dates.timestamp(email.receivedAt, zone: store.timeZone))
        }
        if email.status == "ignored" || email.extraction?.relevant == false {
          Section {
            Text(
              "This message was not identified as a physical delivery. Digital purchases and unrelated emails do not become packages."
            )
          }
        }
        if let reason = email.extraction?.reviewReason {
          Section("Extraction review") { Text(reason) }
        }
        if let error = email.error { Section("Processing problem") { Text(error) } }
        if let references = email.shipments, !references.isEmpty {
          Section("Associated packages") {
            ForEach(references) { reference in
              NavigationLink(reference.merchant) { PackageDetailView(id: reference.id) }
            }
          }
        }
        Section("Original email") {
          Text(email.text ?? "No readable text available.").textSelection(.enabled)
        }
        if email.status != "processed" {
          Section {
            Button("Retry processing") {
              Task {
                do {
                  try await store.mutate("emails/\(id)/retry")
                  store.message = "Email processing requested."
                  store.scheduleFollowUp()
                  self.email = await store.loadEmail(id)
                } catch {}
              }
            }.disabled(!store.canWrite)
          }
        }
      } else if !loading {
        ContentUnavailableView(
          "Email unavailable", systemImage: "envelope",
          description: Text("Reconnect and refresh to read this message."))
      }
    }.navigationTitle("Email").navigationBarTitleDisplayMode(.inline)
      .task {
        email = await store.loadEmail(id)
        loading = false
      }
      .refreshable { email = await store.loadEmail(id) }
      .overlay { if loading { ProgressView() } }
  }
}
struct PasteEmailView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var subject = ""
  @State private var text = ""
  @State private var error: String?
  var body: some View {
    NavigationStack {
      Form {
        Section("Original email") {
          TextField("Subject", text: $subject)
          TextField("Paste the email text", text: $text, axis: .vertical).lineLimit(10...30)
          Text(
            "Paste the original message, including item and delivery details. Only physical purchases become packages."
          ).font(.caption).foregroundStyle(.secondary)
        }
        if let error { Text(error).foregroundStyle(.red) }
      }.navigationTitle("Paste email").toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.disabled(store.writing)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Import") {
            Task {
              guard !subject.isEmpty, text.count >= 20 else {
                error = "Enter a subject and at least 20 characters of original text."
                return
              }
              do {
                try await store.mutate(
                  "emails", body: JSONEncoder().encode(["subject": subject, "text": text]))
                store.message = "Email queued for processing."
                store.scheduleFollowUp()
                dismiss()
              } catch { self.error = store.friendly(error) }
            }
          }.disabled(!store.canWrite)
        }
      }.interactiveDismissDisabled(store.writing)
    }
  }
}
