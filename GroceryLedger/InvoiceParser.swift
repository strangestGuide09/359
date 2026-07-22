import Foundation
import PDFKit

struct ParsedInvoiceItem: Identifiable {
    let id = UUID()
    var name: String
    var amount: Decimal
    var quantity: Decimal
    var isPersonal: Bool = false
    var isTrackedForRestock: Bool = false
    var estimatedUseBy: Date?
}

struct ParsedInvoice {
    var merchant: String
    var category: ExpenseCategory
    var invoiceNumber: String?
    var date: Date
    var buyer: LedgerPerson?
    var suggestedTotal: Decimal?
    var items: [ParsedInvoiceItem]
    var note: String
}

enum InvoiceReviewPolicy {
    static func itemTotal(_ items: [ParsedInvoiceItem]) -> Decimal {
        items.reduce(0) { $0 + $1.amount }
    }

    static func reconciliationDifference(items: [ParsedInvoiceItem], invoiceTotal: Decimal?) -> Decimal? {
        invoiceTotal.map { itemTotal(items) - $0 }
    }

    static func shouldTrackForRestock(item: ParsedInvoiceItem, category: ExpenseCategory) -> Bool {
        let supportedCategory = category == .groceries || category == .household
        return supportedCategory && !item.isPersonal && item.isTrackedForRestock
    }
}

enum InvoiceParser {
    static func parse(url: URL) throws -> ParsedInvoice {
        guard let document = PDFDocument(url: url) else { throw ParserError.unreadablePDF }
        let text = (0..<document.pageCount).compactMap { document.page(at: $0)?.string }.joined(separator: "\n")
        return try parse(text: text, instamartDocument: document)
    }

    /// Exposed internally for regression tests using sanitised invoice text.
    /// PDF contents are deliberately not stored by the parser.
    static func parse(text: String) throws -> ParsedInvoice {
        try parse(text: text, instamartDocument: nil)
    }

    private static func parse(text: String, instamartDocument: PDFDocument?) throws -> ParsedInvoice {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ParserError.noSelectableText }

        let merchant: String
        let category: ExpenseCategory
        if text.localizedCaseInsensitiveContains("Zomato Food Order") {
            merchant = capture("Restaurant\\s+Name\\s*:\\s*([^\\n]+)", in: text) ?? "Zomato food order"
            category = .food
        } else if text.localizedCaseInsensitiveContains("BLINK COMMERCE") || text.localizedCaseInsensitiveContains("Zomato Hyperpure") {
            merchant = "Blinkit"; category = .groceries
        } else if text.localizedCaseInsensitiveContains("Instamaxx") || text.localizedCaseInsensitiveContains("Greenmania") {
            merchant = "Instamart"; category = .groceries
        } else {
            merchant = "Imported invoice"; category = .other
        }

        let buyerName = capture("(?:Invoice To:\\s*|Customer Name:\\s*|Name\\s*:\\s*)(Ekta(?:\\s+Dhan)?|Ritesh(?:\\s+Kumar)?)", in: text)
        let buyer = buyerName?.localizedCaseInsensitiveContains("Ritesh") == true ? LedgerPerson.ritesh : buyerName == nil ? nil : .ekta
        let invoice = capture("(?:Invoice No|Invoice Number|Order ID)\\s*:?\\s*([A-Z0-9]+)", in: text)
        let total = decimalCapture("(?m)(?:Invoice Value|Grand Total|^Total)\\s*:?\\s*₹?\\s*([0-9]+(?:\\.[0-9]{1,2})?)", in: text)
        let parsedDate = foodOrderDate(in: text) ?? dateCapture("(?:Date\\s+of\\s+Invoice|Invoice\\s+Date|Date)\\s*:?\\s*([0-9]{2}[-/][A-Za-z0-9]{2,3}[-/][0-9]{2,4})", in: text) ?? .now
        let items: [ParsedInvoiceItem]
        if category == .food {
            items = foodItems(in: text)
        } else if merchant == "Instamart", let instamartDocument {
            items = instamartItems(from: instamartDocument)
        } else {
            items = blinkitItems(in: text)
        }
        let note = items.isEmpty
            ? "No product lines were read. Review the draft item and total before saving."
            : "Product lines and invoice buyer were read from the PDF. Review the items and choose which ones to track for restock."
        return ParsedInvoice(merchant: merchant, category: category, invoiceNumber: invoice, date: parsedDate, buyer: buyer, suggestedTotal: total, items: items, note: note)
    }

    private static func foodItems(in text: String) -> [ParsedInvoiceItem] {
        let pattern = "(?m)^(.+?)\\s+([0-9]+)\\s+₹([0-9]+(?:\\.[0-9]+)?)\\s+₹([0-9]+(?:\\.[0-9]+)?)$"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).compactMap { match in
            guard let nameRange = Range(match.range(at: 1), in: text),
                  let quantityRange = Range(match.range(at: 2), in: text),
                  let totalRange = Range(match.range(at: 4), in: text),
                  let quantity = Decimal(string: String(text[quantityRange])),
                  let amount = Decimal(string: String(text[totalRange]), locale: Locale(identifier: "en_US_POSIX")) else { return nil }
            return ParsedInvoiceItem(name: cleanName(String(text[nameRange])), amount: amount, quantity: quantity)
        }
    }

    private static func blinkitItems(in text: String) -> [ParsedInvoiceItem] {
        // Blinkit often wraps the UPC across several lines before the product name.
        // Capture from the serial number through the HSN marker so we do not retain
        // only the final word (for example, "Powder(Pack)").
        let descriptions = captures("(?m)(?:^|\\n)\\d+\\s+(?:\\d+\\s*\\n)*([A-Za-z][\\s\\S]*?)\\s*\\(HSN[-\\s]*[0-9]+\\)", in: text)
            .map { value in
                value.components(separatedBy: .newlines)
                    .filter { !$0.trimmingCharacters(in: .whitespaces).allSatisfy { $0.isNumber } }
                    .joined(separator: " ")
            }
            .map(cleanName)
            .filter { !$0.localizedCaseInsensitiveContains("delivery") && !$0.localizedCaseInsensitiveContains("item description") }
        let amounts = text.components(separatedBy: .newlines).compactMap { line -> Decimal? in
            let values = line.split(whereSeparator: { $0.isWhitespace }).compactMap { Decimal(string: String($0), locale: Locale(identifier: "en_US_POSIX")) }
            guard values.count >= 7, line.first?.isNumber == true else { return nil }
            return values.last
        }
        guard !descriptions.isEmpty, !amounts.isEmpty else { return [] }
        let matched: [Decimal]
        if amounts.count >= descriptions.count * 2 {
            matched = stride(from: 0, to: descriptions.count * 2, by: 2).map { amounts[$0] + amounts[$0 + 1] }
        } else {
            matched = Array(amounts.prefix(descriptions.count))
        }
        return zip(descriptions, matched).map { ParsedInvoiceItem(name: $0.0, amount: $0.1, quantity: 1) }
    }

    private static func instamartItems(from document: PDFDocument) -> [ParsedInvoiceItem] {
        struct VisualLine { let y: CGFloat; let text: String }
        let ignored = ["description of goods", "taxable", "discount", "amount", "value", "cgst", "sgst", "cess", "hsn", "invoice", "quantity"]
        var result: [ParsedInvoiceItem] = []
        for pageIndex in 0..<document.pageCount {
            guard let page = document.page(at: pageIndex), let selection = page.selection(for: page.bounds(for: .mediaBox)) else { continue }
            let lines = selection.selectionsByLine().compactMap { selection -> VisualLine? in
                guard let text = selection.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
                return VisualLine(y: selection.bounds(for: page).minY, text: text)
            }
            let prices = lines.compactMap { line -> (y: CGFloat, amount: Decimal)? in
                guard line.text.range(of: "^[0-9]+\\s+NOS\\s+[0-9]+.*\\s+([0-9]+(?:\\.[0-9]+)?)$", options: .regularExpression) != nil,
                      let amount = Decimal(string: line.text.split(separator: " ").last.map(String.init) ?? "", locale: Locale(identifier: "en_US_POSIX")) else { return nil }
                return (line.y, amount)
            }.sorted { $0.y > $1.y }
            for (index, price) in prices.enumerated() {
                let upper = index == 0 && prices.count > 1
                    ? price.y + (price.y - prices[index + 1].y) / 2
                    : index == 0 ? price.y + 30 : (prices[index - 1].y + price.y) / 2
                let lower = index == prices.count - 1 && prices.count > 1
                    ? price.y - (prices[index - 1].y - price.y) / 2
                    : index == prices.count - 1 ? price.y - 30 : (price.y + prices[index + 1].y) / 2
                let name = lines.filter { line in
                    let lowercased = line.text.lowercased()
                    return line.y <= upper && line.y >= lower && line.text.rangeOfCharacter(from: .letters) != nil &&
                        !line.text.localizedCaseInsensitiveContains("NOS") && !ignored.contains(where: lowercased.contains)
                }.sorted { $0.y > $1.y }.map(\.text).joined(separator: " ")
                result.append(ParsedInvoiceItem(name: name.isEmpty ? "Invoice item \(result.count + 1)" : cleanName(name), amount: price.amount, quantity: 1))
            }
        }
        return result
    }

    private static func cleanName(_ value: String) -> String {
        value.components(separatedBy: .newlines)
            .filter { !$0.trimmingCharacters(in: .whitespaces).allSatisfy { $0.isNumber } }
            .joined(separator: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func capture(_ pattern: String, in text: String) -> String? { captures(pattern, in: text).first }
    private static func captures(_ pattern: String, in text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).compactMap { match in
            guard let outputRange = Range(match.range(at: 1), in: text) else { return nil }
            return String(text[outputRange])
        }
    }
    private static func decimalCapture(_ pattern: String, in text: String) -> Decimal? { capture(pattern, in: text).flatMap { Decimal(string: $0, locale: Locale(identifier: "en_US_POSIX")) } }
    private static func dateCapture(_ pattern: String, in text: String) -> Date? {
        guard let value = capture(pattern, in: text) else { return nil }
        for format in ["dd-MM-yyyy", "dd-MMM-yyyy", "dd/MM/yyyy"] {
            let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = format
            if let date = formatter.date(from: value) { return date }
        }
        return nil
    }

    private static func foodOrderDate(in text: String) -> Date? {
        guard let value = capture("Order\\s+Time\\s*:\\s*([0-9]{1,2}\\s+[A-Za-z]+\\s+[0-9]{4},\\s+[0-9]{1,2}:[0-9]{2}\\s+[AP]M)", in: text) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "dd MMMM yyyy, hh:mm a"
        return formatter.date(from: value)
    }

    enum ParserError: LocalizedError {
        case unreadablePDF, noSelectableText
        var errorDescription: String? { self == .unreadablePDF ? "The selected file is not a readable PDF." : "This PDF has no selectable text. Camera/scanned invoices are a later v0 feature." }
    }
}
