import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let statusLabel = UILabel()
    private let prepareButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)
    private var pdfProvider: NSItemProvider?

    override func viewDidLoad() {
        super.viewDidLoad()
        configureView()
        pdfProvider = extensionContext?.inputItems
            .compactMap { $0 as? NSExtensionItem }
            .flatMap { $0.attachments ?? [] }
            .first { $0.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) }
        if pdfProvider == nil {
            statusLabel.text = "Grocery Ledger needs one PDF invoice."
            prepareButton.isEnabled = false
        }
    }

    private func configureView() {
        view.backgroundColor = .systemBackground
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center
        statusLabel.text = "The invoice will stay on this iPhone and open as an unsaved draft in Grocery Ledger."

        var configuration = UIButton.Configuration.filled()
        configuration.title = "Prepare for review"
        prepareButton.configuration = configuration
        prepareButton.addTarget(self, action: #selector(prepareSharedPDF), for: .touchUpInside)

        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [statusLabel, prepareButton, cancelButton])
        stack.axis = .vertical
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }

    @objc private func prepareSharedPDF() {
        guard let pdfProvider else { return }
        prepareButton.isEnabled = false
        cancelButton.isEnabled = false
        statusLabel.text = "Preparing a local draft…"
        pdfProvider.loadFileRepresentation(forTypeIdentifier: UTType.pdf.identifier) { [weak self] url, error in
            guard let self else { return }
            do {
                if let error { throw error }
                guard let url else { throw PendingInvoiceDraftError.invalidPDF }
                let store = try PendingInvoiceDraftStore.appGroupStore()
                _ = try store.stagePDF(from: url)
                DispatchQueue.main.async {
                    self.statusLabel.text = "Ready. Open Grocery Ledger to review and save—or discard—the invoice."
                    self.cancelButton.isEnabled = true
                    self.cancelButton.setTitle("Done", for: .normal)
                    self.cancelButton.removeTarget(self, action: #selector(self.cancel), for: .touchUpInside)
                    self.cancelButton.addTarget(self, action: #selector(self.finish), for: .touchUpInside)
                }
            } catch {
                DispatchQueue.main.async {
                    self.statusLabel.text = error.localizedDescription
                    self.prepareButton.isEnabled = true
                    self.cancelButton.isEnabled = true
                }
            }
        }
    }

    @objc private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }

    @objc private func cancel() {
        extensionContext?.cancelRequest(withError: NSError(
            domain: NSCocoaErrorDomain,
            code: NSUserCancelledError
        ))
    }
}
