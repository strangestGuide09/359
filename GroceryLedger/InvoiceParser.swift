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
    var date: Date
    var buyer: LedgerPerson?
    var suggestedTotal: Decimal?
    var items: [ParsedInvoiceItem]
    var note: String
}

struct PositionedInvoiceToken {
    var text: String
    var x: CGFloat
    var y: CGFloat
    var width: CGFloat
    var page: Int = 0
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
        let positionedPages = (0..<document.pageCount).compactMap { index in
            document.page(at: index).map { positionedTokens(from: $0, page: index) }
        }
        return try parse(text: text, positionedPages: positionedPages, instamartDocument: document)
    }

    /// Exposed internally for regression tests using sanitised invoice text.
    /// PDF contents are deliberately not stored by the parser.
    static func parse(text: String) throws -> ParsedInvoice {
        try parse(text: text, positionedPages: [], instamartDocument: nil)
    }

    static func parse(text: String, positionedPages: [[PositionedInvoiceToken]]) throws -> ParsedInvoice {
        try parse(text: text, positionedPages: positionedPages, instamartDocument: nil)
    }

    private static func parse(text: String, positionedPages: [[PositionedInvoiceToken]], instamartDocument: PDFDocument?) throws -> ParsedInvoice {
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
        let parsedDate = foodOrderDate(in: text) ?? dateCapture("(?:Date\\s+of\\s+Invoice|Invoice\\s+Date|Date)\\s*:?\\s*([0-9]{2}[-/][A-Za-z0-9]{2,3}[-/][0-9]{2,4})", in: text) ?? .now
        let items: [ParsedInvoiceItem]
        let structured = positionedTableItems(from: positionedPages)
        if category == .food {
            items = foodItems(in: text)
        } else if let structured, !structured.items.isEmpty {
            items = structured.items
        } else if merchant == "Instamart", let instamartDocument {
            items = instamartItems(from: instamartDocument)
        } else {
            items = blinkitItems(in: text)
        }
        let itemTotal = InvoiceReviewPolicy.itemTotal(items)
        let labelledTotal = confidentlyLabelledTotal(in: text, itemTotal: itemTotal)
        let total = labelledTotal ?? (structured?.isComplete == true ? itemTotal : nil)
        let note = items.isEmpty
            ? "No product lines were read and the payable total needs confirmation. Review the draft item and total before saving."
            : labelledTotal == nil && structured?.isComplete == true
                ? "Receipt total was calculated from a complete labelled Total column. Verify it against the invoice before saving."
                : total == nil
                    ? "The payable total needs confirmation. Verify every item and enter or correct the receipt total before saving."
                    : "Product lines and invoice buyer were read from the PDF. Review the items and choose which ones to track for restock."
        return ParsedInvoice(merchant: merchant, category: category, date: parsedDate, buyer: buyer, suggestedTotal: total, items: items, note: note)
    }

    private struct PositionedTableResult {
        var items: [ParsedInvoiceItem]
        var isComplete: Bool
    }

    private struct TableSchema {
        var headerY: CGFloat
        var serialX: CGFloat
        var descriptionX: CGFloat
        var quantityX: CGFloat
        var totalX: CGFloat
        var totalRight: CGFloat
    }

    private static func positionedTableItems(from pages: [[PositionedInvoiceToken]]) -> PositionedTableResult? {
        var rows: [(serial: Int, page: Int, item: ParsedInvoiceItem)] = []
        var sawSchema = false
        for page in pages {
            guard let schema = tableSchema(in: page) else { continue }
            sawSchema = true
            let serials = page.compactMap { token -> (token: PositionedInvoiceToken, serial: Int)? in
                let value = token.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard token.y < schema.headerY - 2, abs(token.x - schema.serialX) <= 22,
                      value.range(of: "^[0-9]{1,3}$", options: .regularExpression) != nil,
                      let serial = Int(value) else { return nil }
                return (token, serial)
            }.sorted { $0.token.y > $1.token.y }
            let typicalGap: CGFloat = {
                guard serials.count > 1 else { return 44 }
                let gaps = zip(serials, serials.dropFirst()).map { $0.token.y - $1.token.y }
                return min(70, max(22, gaps.reduce(0, +) / CGFloat(gaps.count)))
            }()
            for index in serials.indices {
                let serial = serials[index]
                let upper = index > 0 ? (serials[index - 1].token.y + serial.token.y) / 2 : schema.headerY - 2
                let lower = index + 1 < serials.count ? (serial.token.y + serials[index + 1].token.y) / 2 : serial.token.y - typicalGap * 0.8
                let row = page.filter { $0.y <= upper && $0.y > lower }
                let description = row.filter {
                    $0.x >= schema.descriptionX - 10 && $0.x < schema.quantityX - 4 &&
                    $0.text.rangeOfCharacter(from: .letters) != nil
                }.sorted { $0.y == $1.y ? $0.x < $1.x : $0.y > $1.y }
                    .map(\.text).joined(separator: " ")
                let quantityToken = row.filter {
                    abs($0.x - schema.quantityX) <= 38 && decimal(in: $0.text) != nil
                }.min { abs($0.x - schema.quantityX) < abs($1.x - schema.quantityX) }
                let totalToken = row.filter {
                    $0.x >= schema.totalX - 45 && decimal(in: $0.text) != nil
                }.min { abs(($0.x + $0.width) - schema.totalRight) < abs(($1.x + $1.width) - schema.totalRight) }
                let name = cleanName(description)
                guard !name.isEmpty, let quantityToken, let quantity = decimal(in: quantityToken.text), quantity > 0,
                      let totalToken, let amount = decimal(in: totalToken.text), amount >= 0 else { continue }
                rows.append((serial.serial, serial.token.page, ParsedInvoiceItem(name: name, amount: amount, quantity: quantity)))
            }
        }
        guard sawSchema, !rows.isEmpty else { return nil }
        rows.sort { $0.serial == $1.serial ? $0.page < $1.page : $0.serial < $1.serial }
        let serials = rows.map(\.serial)
        let complete = Set(serials).count == serials.count && serials.enumerated().allSatisfy { index, serial in
            index == 0 || serial == serials[index - 1] + 1
        } && rows.count >= 2
        return PositionedTableResult(items: rows.map(\.item), isComplete: complete)
    }

    private static func tableSchema(in tokens: [PositionedInvoiceToken]) -> TableSchema? {
        for description in tokens where description.text.range(of: "description", options: [.caseInsensitive]) != nil {
            let band = tokens.filter { abs($0.y - description.y) <= 20 }
            let serial = band.filter { $0.text.range(of: "^(?:sr\\.?|s\\.?|sr\\.?\\s*no\\.?)$", options: [.caseInsensitive, .regularExpression]) != nil }.min { $0.x < $1.x }
            let quantity = band.filter { $0.text.range(of: "^(?:qty|quantity)(?:\\s*/\\s*uqc)?$", options: [.caseInsensitive, .regularExpression]) != nil }.min { $0.x < $1.x }
            let total = band.filter { $0.text.range(of: "^total(?:\\s+amount)?(?:\\s*\\(\\s*rs\\.?\\s*\\))?\\.?$", options: [.caseInsensitive, .regularExpression]) != nil }.max { $0.x < $1.x }
            if let serial, let quantity, let total, serial.x < description.x, description.x < quantity.x, quantity.x < total.x {
                return TableSchema(headerY: description.y, serialX: serial.x, descriptionX: description.x, quantityX: quantity.x, totalX: total.x, totalRight: total.x + total.width)
            }
        }
        return nil
    }

    private static func positionedTokens(from page: PDFPage, page pageIndex: Int) -> [PositionedInvoiceToken] {
        guard let value = page.string else { return [] }
        let source = value as NSString
        var result: [PositionedInvoiceToken] = []
        var start: Int?
        func appendToken(endingAt end: Int) {
            guard let tokenStart = start, end > tokenStart else { start = nil; return }
            var bounds = CGRect.null
            for index in tokenStart..<end { bounds = bounds.union(page.characterBounds(at: index)) }
            let text = source.substring(with: NSRange(location: tokenStart, length: end - tokenStart))
            if !bounds.isNull { result.append(PositionedInvoiceToken(text: text, x: bounds.minX, y: bounds.minY, width: bounds.width, page: pageIndex)) }
            start = nil
        }
        for index in 0..<source.length {
            if CharacterSet.whitespacesAndNewlines.contains(UnicodeScalar(source.character(at: index))!) { appendToken(endingAt: index) }
            else if start == nil { start = index }
        }
        appendToken(endingAt: source.length)
        return result
    }

    private static func confidentlyLabelledTotal(in text: String, itemTotal: Decimal) -> Decimal? {
        let label = "(?:Final Amount Payable|Total Payable|Amount Payable|Amount Paid|Total Paid|You Paid|Grand Total|Invoice Value|Net Amount)"
        guard let regex = try? NSRegularExpression(pattern: "(?im)\\b\(label)\\b[^\\n]*", options: [.caseInsensitive]) else { return nil }
        let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
        for match in matches.reversed() {
            guard let range = Range(match.range, in: text) else { continue }
            let values = decimalValues(in: String(text[range]))
            guard !values.isEmpty else { continue }
            let chosen = itemTotal > 0 ? values.min(by: { abs($0 - itemTotal) < abs($1 - itemTotal) })! : values.last!
            if itemTotal == 0 || abs(chosen - itemTotal) <= Decimal(string: "0.01")! { return chosen }
        }
        return nil
    }

    private static func decimalValues(in value: String) -> [Decimal] {
        guard let regex = try? NSRegularExpression(pattern: "[0-9][0-9,]*(?:\\.[0-9]{1,2})?") else { return [] }
        return regex.matches(in: value, range: NSRange(value.startIndex..., in: value)).compactMap { match in
            Range(match.range, in: value).flatMap { decimal(in: String(value[$0])) }
        }
    }

    private static func decimal(in value: String) -> Decimal? {
        Decimal(string: value.replacingOccurrences(of: ",", with: ""), locale: Locale(identifier: "en_US_POSIX"))
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
            let prices = lines.compactMap { line -> (y: CGFloat, amount: Decimal, quantity: Decimal)? in
                guard line.text.range(of: "^[0-9]+\\s+NOS\\s+[0-9]+.*\\s+([0-9]+(?:\\.[0-9]+)?)$", options: .regularExpression) != nil,
                      let quantity = Decimal(string: line.text.split(separator: " ").first.map(String.init) ?? ""),
                      let amount = Decimal(string: line.text.split(separator: " ").last.map(String.init) ?? "", locale: Locale(identifier: "en_US_POSIX")) else { return nil }
                return (line.y, amount, quantity)
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
                result.append(ParsedInvoiceItem(name: name.isEmpty ? "Invoice item \(result.count + 1)" : cleanName(name), amount: price.amount, quantity: price.quantity))
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
