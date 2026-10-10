export function syncOverlayHidden(element, visible, { activeClass = "", display = "" } = {}) {
  if (!element || typeof element !== "object") return false;
  const isVisible = Boolean(visible);
  if (activeClass && element.classList) {
    if (isVisible) element.classList.add(activeClass);
    else element.classList.remove(activeClass);
  }
  if (display && element.style) {
    element.style.display = isVisible ? display : "none";
  }
  element.hidden = !isVisible;
  if (typeof element.setAttribute === "function") {
    element.setAttribute("aria-hidden", isVisible ? "false" : "true");
  }
  return isVisible;
}

export function syncModalOpen(modal, open) {
  return syncOverlayHidden(modal, open, { activeClass: "open" });
}

export function syncDropdownOpen(dropdown, open) {
  return syncOverlayHidden(dropdown, open, { activeClass: "show" });
}

export function syncToolbarVisible(toolbar, visible, display = "flex") {
  return syncOverlayHidden(toolbar, visible, { display });
}
