const feedbackTimers = new WeakMap();

function cancelFeedbackTimer(document) {
  const scheduled = feedbackTimers.get(document);
  if (scheduled) scheduled.cancel(scheduled.id);
  feedbackTimers.delete(document);
}

export function clearImportFeedback(document) {
  cancelFeedbackTimer(document);
  document.getElementById("import-feedback")?.remove();
}

export function showImportFeedback(document, message, kind = "info", options = {}) {
  const {
    durationMs = 10000,
    schedule = setTimeout,
    cancel = clearTimeout,
    action
  } = options;

  cancelFeedbackTimer(document);
  let feedback = document.getElementById("import-feedback");
  if (!feedback) {
    const actions = document.querySelector(".primary-actions");
    if (!actions) return null;
    feedback = document.createElement("div");
    feedback.id = "import-feedback";
    feedback.setAttribute("aria-live", "polite");
    feedback.setAttribute("aria-atomic", "true");
    feedback.tabIndex = -1;
    actions.insertAdjacentElement("afterend", feedback);
  }

  feedback.setAttribute("role", kind === "error" ? "alert" : "status");
  feedback.className = `import-feedback ${kind}`;
  const copy = document.createElement("span");
  copy.textContent = message;
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "plain feedback-dismiss";
  dismiss.setAttribute("aria-label", "Dismiss notification");
  dismiss.textContent = "×";
  dismiss.onclick = () => clearImportFeedback(document);
  const children = [copy];
  if (action?.label && typeof action.onClick === "function") {
    const actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.className = "secondary feedback-action";
    actionButton.textContent = action.label;
    if (action.ariaLabel) actionButton.setAttribute("aria-label", action.ariaLabel);
    actionButton.onclick = action.onClick;
    children.push(actionButton);
  }
  children.push(dismiss);
  feedback.replaceChildren(...children);

  const globalStatus = document.getElementById("status");
  if (globalStatus) globalStatus.textContent = "";
  feedback.focus({ preventScroll: false });

  if (durationMs > 0) {
    const id = schedule(() => {
      if (document.getElementById("import-feedback") === feedback) feedback.remove();
      feedbackTimers.delete(document);
    }, durationMs);
    feedbackTimers.set(document, { id, cancel });
  }
  return feedback;
}
