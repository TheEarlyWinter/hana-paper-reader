// Browser confirm() can be suppressed by an embedded App surface. Keep
// destructive actions behind explicit consent rendered inside this document.
let sequence = 0;
let queue = Promise.resolve();
let pageGeneration = 0;

export function confirmAction(message, options = {}) {
  const generation = pageGeneration;
  const result = queue.then(() => generation === pageGeneration
    ? showConfirmation(message, options)
    : false);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function showConfirmation(message, { document: doc = globalThis.document, title = "确认操作", confirmText = "确认", cancelText = "取消" } = {}) {
  if (!doc?.body) return Promise.resolve(false);
  return new Promise((resolve) => {
    const dialog = doc.createElement("dialog");
    dialog.className = "hpr-confirm-dialog";
    const heading = doc.createElement("h2");
    heading.id = `hpr-confirm-title-${++sequence}`;
    heading.textContent = title;
    const description = doc.createElement("p");
    description.id = `hpr-confirm-description-${sequence}`;
    description.textContent = String(message || "");
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.setAttribute("aria-describedby", description.id);
    const actions = doc.createElement("div");
    actions.className = "hpr-confirm-actions";
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.className = "btn small";
    cancel.textContent = cancelText;
    const accept = doc.createElement("button");
    accept.type = "button";
    accept.className = "btn small danger";
    accept.textContent = confirmText;
    actions.append(cancel, accept);
    dialog.append(heading, description, actions);
    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      doc.defaultView?.removeEventListener("pagehide", onPageHide);
      dialog.remove();
      resolve(accepted);
    };
    const onPageHide = () => { pageGeneration++; finish(false); };
    cancel.addEventListener("click", () => finish(false));
    accept.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); });
    dialog.addEventListener("close", () => finish(false));
    doc.defaultView?.addEventListener("pagehide", onPageHide, { once: true });
    doc.body.append(dialog);
    try {
      dialog.showModal();
      cancel.focus();
    } catch {
      // Missing dialog support must never grant consent.
      finish(false);
    }
  });
}
