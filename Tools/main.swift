import Foundation

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let invoice = try InvoiceParser.parse(url: url)
print("MERCHANT: \(invoice.merchant)")
print("CATEGORY: \(invoice.category.rawValue)")
print("DATE: \(invoice.date)")
let total = invoice.suggestedTotal.map { String(describing: $0) } ?? "none"
print("TOTAL: \(total)")
for item in invoice.items {
    print("\(item.name) | \(item.amount)")
}
