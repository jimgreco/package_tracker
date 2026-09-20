import SwiftUI

struct SettingsView: View {
  @Environment(AppStore.self) private var store
  @State private var addingMember = false
  @State private var editingHousehold = false
  @State private var removing: Member?
  @State private var rotate = false
  @State private var signingOut = false
  @State private var sharingFeed = false
  @State private var exportURL: URL?
  @State private var exporting = false
  @State private var calendar = GoogleCalendarConnection()
  @State private var disconnectingCalendar = false
  var body: some View {
    List {
      ServiceBanner()
      if let settings = store.dashboard?.settings {
        Section("Getting started") {
          Button("Show app walkthrough") { store.showWalkthrough = true }
        }
        Section("Account") {
          Text(settings.userName).font(.headline)
          Text(settings.account.email).textSelection(.enabled)
        }
        Section("Household") {
          LabeledContent("Name", value: settings.householdName)
          LabeledContent("Time zone", value: settings.timeZone)
          if settings.households.count > 1 {
            Menu("Switch household") {
              ForEach(settings.households) { household in
                Button(household.name) { Task { await store.switchHousehold(household.id) } }
                  .disabled(household.id == settings.householdId)
              }
            }.disabled(!store.canWrite)
          }
          Button("Edit household") { editingHousehold = true }.disabled(!store.canWrite)
        }
        NotificationSettingsSection()
        Section("Members") {
          ForEach(settings.members) { member in
            VStack(alignment: .leading, spacing: 5) {
              Text(member.name ?? member.email).font(.headline)
              if member.name != nil {
                Text(member.email).font(.subheadline).foregroundStyle(.secondary)
              }
              Text(
                member.pending
                  ? "Pending · joins with their own Google account" : member.role.capitalized
              ).font(.caption).foregroundStyle(.secondary)
              if settings.role == "owner" && member.role != "owner" {
                Button("Remove member", role: .destructive) { removing = member }.frame(
                  minHeight: 44
                ).disabled(!store.canWrite)
              }
            }
          }
          if settings.role == "owner" {
            Button("Add by Google email", systemImage: "person.badge.plus") { addingMember = true }
              .disabled(!store.canWrite)
          }
        }
        Section("Forwarding") {
          Text(
            "Forward order and shipping emails to your household’s private address. Doorstep checks for physical deliveries."
          ).font(.footnote)
          if let address = settings.forwardingAddress {
            Button("Copy forwarding address", systemImage: "doc.on.doc") {
              copySecret(address)
              store.message = "Forwarding address copied."
            }
          } else {
            Text("Forwarding is currently unavailable.").foregroundStyle(.secondary)
          }
        }
        Section("Gmail import") {
          LabeledContent(
            "Status",
            value: settings.gmail.connected
              ? (settings.gmail.enabled ? "Enabled" : "Paused") : "Not connected")
          if let email = settings.gmail.email { Text(email) }
          if let other = settings.gmail.otherHouseholdName {
            Text("Your inbox is connected to \(other).")
          }
          LabeledContent("Imported messages", value: "\(settings.gmail.importedCount)")
          if settings.gmail.importing && settings.gmail.connected {
            Label("Import in progress", systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
          }
          LabeledContent(
            "Last sync", value: Dates.timestamp(settings.gmail.lastSyncedAt, zone: store.timeZone))
          if settings.gmail.needsReconnect {
            Label("Reconnect Gmail on the website", systemImage: "exclamationmark.triangle")
          }
          if settings.gmail.error != nil {
            Text("Gmail needs attention. Check its connection on the website.").foregroundStyle(
              .secondary)
          }
        }
        Section("Gmail setup") {
          Link("Manage connections on website", destination: Configuration.websiteSettings)
          Text("Gmail import is managed on the website. Safari may ask you to sign in separately.")
            .font(.caption).foregroundStyle(.secondary)
        }
        Section("Google Calendar") {
          LabeledContent("Status", value: settings.google.connected ? "Connected" : "Not connected")
          LabeledContent(
            "Last sync", value: Dates.timestamp(settings.google.lastSyncedAt, zone: store.timeZone))
          if settings.google.error != nil {
            Text("Calendar sync needs attention. Reconnect Google Calendar below.")
              .foregroundStyle(.secondary)
          }
          Text(
            "Doorstep creates a Package Deliveries calendar for this household. It can only manage calendars it creates, not your unrelated calendars."
          ).font(.footnote)
          Button(
            calendar.busy
              ? "Connecting…"
              : settings.google.connected ? "Reconnect Google Calendar" : "Connect Google Calendar"
          ) {
            let household = settings.householdId
            let epoch = store.epoch
            Task {
              do {
                let connected = try await calendar.connect(api: store.api, household: household)
                guard store.epoch == epoch else { return }
                await store.refresh()
                if connected && store.dashboard?.settings.google.connected == true {
                  store.message = "Google Calendar connected. Delivery sync is queued."
                  store.scheduleFollowUp()
                } else if !connected {
                  store.message = "Calendar connection cancelled."
                }
              } catch {
                guard store.epoch == epoch else { return }
                store.errorMessage = store.friendly(error)
              }
            }
          }.disabled(!store.canWrite || calendar.busy).accessibilityIdentifier(
            "connectGoogleCalendar")
          if settings.google.connected {
            Button("Sync deliveries now") {
              Task {
                do {
                  try await store.mutate("native/calendar/sync")
                  store.message = "Calendar sync queued."
                  store.scheduleFollowUp()
                } catch {}
              }
            }.disabled(!store.canWrite || calendar.busy).accessibilityIdentifier(
              "syncGoogleCalendar")
            Button("Disconnect Google Calendar", role: .destructive) {
              disconnectingCalendar = true
            }
            .disabled(!store.canWrite || calendar.busy)
          }
          Text(
            "To see deliveries in Apple Calendar, add your Google account in iPhone Settings → Apps → Calendar → Calendar Accounts. Enable Calendars, then select the Doorstep calendar in the Calendar app."
          ).font(.footnote)
          Text("Imports and calendar updates continue while Doorstep is closed.").font(.caption)
            .foregroundStyle(.secondary)
        }
        Section("Calendar subscription") {
          Text(
            "An ICS subscription is an alternative to Google Calendar. Anyone with this private link can read your package calendar."
          ).font(.footnote)
          Button("Copy private calendar link", systemImage: "doc.on.doc") {
            copySecret(settings.calendarFeedUrl)
            store.message = "Private calendar link copied."
          }
          Button("Share private calendar link", systemImage: "square.and.arrow.up") {
            sharingFeed = true
          }
          Button("Rotate private calendar link", role: .destructive) { rotate = true }.disabled(
            !store.canWrite)
        }
        Section("Your data") {
          Button(
            exporting ? "Preparing export…" : "Export household JSON",
            systemImage: "square.and.arrow.up"
          ) {
            Task {
              exporting = true
              defer { exporting = false }
              do { exportURL = try await store.export() } catch {
                store.errorMessage = store.friendly(error)
              }
            }
          }.disabled(!store.canWrite || exporting)
        }
        Section("Diagnostics") {
          LabeledContent("Pending failed jobs", value: "\(settings.worker.failedJobs)")
          Button("Retry failed jobs") {
            Task {
              do {
                try await store.mutate("settings/retry-jobs")
                store.message = "Failed jobs queued for another attempt."
                store.scheduleFollowUp()
              } catch {}
            }
          }.disabled(!store.canWrite)
        }
      } else {
        Text(
          "Connect to load household settings. Your saved packages remain available in Packages."
        ).foregroundStyle(.secondary)
      }
      Section { Button("Sign out", role: .destructive) { signingOut = true } }
    }.navigationTitle("Settings").refreshable { await store.refresh() }
      .onChange(of: store.epoch) { _, _ in calendar.cancel() }
      .confirmationDialog(
        "Disconnect Google Calendar?", isPresented: $disconnectingCalendar,
        titleVisibility: .visible
      ) {
        Button("Disconnect", role: .destructive) {
          Task {
            do {
              try await store.mutate("native/calendar/disconnect")
              store.message = "Google Calendar disconnected."
            } catch {}
          }
        }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text(
          "Stops future updates for this household. Your Google calendar and its existing events remain in Google."
        )
      }
      .sheet(isPresented: $addingMember) { MemberForm() }
      .sheet(isPresented: $editingHousehold) {
        if let settings = store.dashboard?.settings { HouseholdForm(settings: settings) }
      }
      .sheet(isPresented: $sharingFeed) {
        if let url = store.dashboard?.settings.calendarFeedUrl { ShareSheet(items: [url]) }
      }
      .sheet(
        isPresented: Binding(get: { exportURL != nil }, set: { if !$0 { cleanupExport() } }),
        onDismiss: cleanupExport
      ) {
        if let url = exportURL {
          ShareSheet(items: [url], cleanup: { try? FileManager.default.removeItem(at: url) })
        }
      }
      .confirmationDialog(
        "Remove this household member?",
        isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
        titleVisibility: .visible
      ) {
        if let member = removing {
          Button("Remove \(member.name ?? member.email)", role: .destructive) {
            Task {
              do {
                let body = try JSONEncoder().encode(
                  member.userId.map { ["userId": $0] } ?? ["email": member.email])
                try await store.mutate("settings/members/remove", body: body)
              } catch {}
              removing = nil
            }
          }
        }
      }
      .confirmationDialog(
        "Replace the calendar subscription link?", isPresented: $rotate, titleVisibility: .visible
      ) {
        Button("Rotate link", role: .destructive) {
          Task {
            do {
              try await store.mutate("settings/rotate-feed")
              store.message = "Link replaced. Update your calendar subscription with the new link."
            } catch {}
          }
        }
      } message: {
        Text("The previous link will stop working for everyone using it.")
      }
      .confirmationDialog(
        "Sign out of this iPhone?", isPresented: $signingOut, titleVisibility: .visible
      ) {
        Button("Sign out", role: .destructive) { Task { await store.signOut() } }
      } message: {
        Text(
          "Saved package data will be removed. Your household’s Gmail and Calendar connections will keep working."
        )
      }
  }
  func copySecret(_ value: String) {
    UIPasteboard.general.setItems(
      [[UIPasteboard.typeAutomatic: value]],
      options: [.localOnly: true, .expirationDate: store.now().addingTimeInterval(300)])
  }
  func cleanupExport() {
    if let url = exportURL { try? FileManager.default.removeItem(at: url) }
    exportURL = nil
  }
}
struct MemberForm: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var email = ""
  @State private var error: String?
  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Google email", text: $email).textContentType(.emailAddress).keyboardType(
            .emailAddress
          ).autocorrectionDisabled().textInputAutocapitalization(.never)
          Text(
            "They join this household when they sign in with their own verified Google account. No invitation code or email is sent."
          ).font(.footnote)
        }
        if let error { Text(error).foregroundStyle(.red) }
      }.navigationTitle("Add member").toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Add") {
            Task {
              do {
                try await store.mutate(
                  "settings/members",
                  body: JSONEncoder().encode([
                    "email": email.trimmingCharacters(in: .whitespacesAndNewlines)
                  ]))
                dismiss()
              } catch { self.error = store.friendly(error) }
            }
          }.disabled(!store.canWrite || email.isEmpty)
        }
      }
    }
  }
}
struct HouseholdForm: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var name: String
  @State private var zone: String
  @State private var error: String?
  init(settings: Settings) {
    _name = State(initialValue: settings.householdName)
    _zone = State(initialValue: settings.timeZone)
  }
  var body: some View {
    NavigationStack {
      Form {
        TextField("Household name", text: $name)
        TextField("Time zone", text: $zone).autocorrectionDisabled().textInputAutocapitalization(
          .never)
        Text("Use an IANA zone such as America/New_York.").font(.caption)
        if let error { Text(error).foregroundStyle(.red) }
      }.navigationTitle("Household").toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            Task {
              do {
                try await store.mutate(
                  "settings", method: "PATCH",
                  body: JSONEncoder().encode(["name": name, "timeZone": zone]))
                dismiss()
              } catch { self.error = store.friendly(error) }
            }
          }.disabled(!store.canWrite)
        }
      }
    }
  }
}
