import Foundation
import PDFKit

for path in CommandLine.arguments.dropFirst() {
    guard let document = PDFDocument(url: URL(fileURLWithPath: path)) else {
        print("UNREADABLE: \(path)")
        continue
    }
    print("\n===== \(URL(fileURLWithPath: path).lastPathComponent) =====")
    for pageIndex in 0..<document.pageCount {
        print(document.page(at: pageIndex)?.string ?? "")
    }
}
