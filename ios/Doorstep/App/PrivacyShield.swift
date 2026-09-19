import SwiftUI

// A separate window covers presented forms and share sheets as well as the root view.
@MainActor final class PrivacyShield {
  private var window: UIWindow?
  func setHiddenContent(_ hidden: Bool) {
    if !hidden {
      window?.isHidden = true
      window = nil
      return
    }
    guard window == nil,
      let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
    else { return }
    let cover = UIWindow(windowScene: scene)
    cover.windowLevel = .alert + 1
    cover.rootViewController = UIHostingController(
      rootView: ZStack {
        Color(uiColor: .systemBackground).ignoresSafeArea()
        Label("Doorstep", systemImage: "shippingbox.fill").font(.largeTitle.bold()).foregroundStyle(
          Color.doorstep)
      })
    cover.isHidden = false
    window = cover
  }
}
