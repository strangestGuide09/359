import SwiftUI

enum GroceryBrand {
    static let ink = Color(red: 23 / 255, green: 47 / 255, blue: 34 / 255)
    static let pine = Color(red: 18 / 255, green: 60 / 255, blue: 43 / 255)
    static let cream = Color(red: 250 / 255, green: 244 / 255, blue: 230 / 255)
    static let paper = Color(red: 1, green: 253 / 255, blue: 247 / 255)
    static let orange = Color(red: 185 / 255, green: 78 / 255, blue: 9 / 255)
    static let line = Color(red: 222 / 255, green: 212 / 255, blue: 194 / 255)
    static let muted = Color(red: 89 / 255, green: 97 / 255, blue: 89 / 255)
    static let warmShadow = Color(red: 231 / 255, green: 200 / 255, blue: 157 / 255)
}

struct BrandCardModifier: ViewModifier {
    var accent: Color?

    func body(content: Content) -> some View {
        content
            .padding(18)
            .background(GroceryBrand.paper, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(alignment: .leading) {
                if let accent {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(accent)
                        .frame(width: 4)
                        .padding(.vertical, 12)
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(GroceryBrand.line, lineWidth: 1)
            }
    }
}

extension View {
    func brandCard(accent: Color? = nil) -> some View {
        modifier(BrandCardModifier(accent: accent))
    }

    func brandScreen() -> some View {
        scrollContentBackground(.hidden)
            .background(GroceryBrand.cream.ignoresSafeArea())
            .tint(GroceryBrand.pine)
            .foregroundStyle(GroceryBrand.ink)
    }
}

struct BrandEyebrow: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.caption2.weight(.bold))
            .tracking(1.6)
            .foregroundStyle(GroceryBrand.orange)
    }
}

struct BrandEmptyState: View {
    let icon: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(GroceryBrand.orange)
            Text(title).font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(GroceryBrand.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
    }
}
