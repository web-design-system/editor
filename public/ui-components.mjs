const componentTags = ["wds-icon", "wds-team-item", "wds-repository-card", "wds-sidebar-panel", "wds-dashboard-layout"];

export async function initializeUiComponents() {
  try {
    const { load } = await import("@li3/web");
    await load("/components/ui.html");
    await Promise.all(componentTags.map((tag) => customElements.whenDefined(tag)));
    return componentTags.every((tag) => customElements.get(tag));
  } catch {
    return false;
  }
}

function setAttributes(element, attributes) {
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) {
      element.setAttribute(name, String(value));
    }
  }
  return element;
}

export function createTeamItem({ id, label, count, selected } = {}) {
  const element = setAttributes(document.createElement("wds-team-item"), {
    "team-id": id,
    label,
    count,
    selected: String(Boolean(selected)),
  });
  element.classList.add("block");
  if (id !== undefined && id !== null) {
    element.dataset.team = String(id);
  }
  return element;
}

export function createRepositoryCard({
  href,
  name,
  description,
  team,
  icon,
  kind,
  accessibleName,
  className,
  status,
} = {}) {
  const element = setAttributes(document.createElement("wds-repository-card"), {
    href,
    name,
    description,
    team,
    icon,
    kind,
    "accessible-name": accessibleName,
  });
  if (className !== undefined && className !== null) {
    element.className = String(className);
  }
  element.classList.add("block");
  element.dataset.search = [name, description, team].filter(Boolean).join(" ").toLowerCase();
  if (status) {
    status.setAttribute("slot", "status");
    element.append(status);
  }
  return element;
}

export class WdsDataList extends HTMLElement {
  connectedCallback() {
    this.setAttribute("role", this.getAttribute("role") || "list");
    this.classList.add("flex", "flex-col", "gap-3");
  }

  set loading(value) {
    this.toggleAttribute("aria-busy", Boolean(value));
    if (value) {
      this.replaceChildren(document.createTextNode("Loading…"));
    }
  }

  render(items, renderItem, emptyMessage = "No items.") {
    this.removeAttribute("aria-busy");
    this.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("p");
      empty.textContent = emptyMessage;
      empty.setAttribute("role", "status");
      this.append(empty);
      return;
    }
    for (const item of items) {
      const node = renderItem(item);
      if (!(node instanceof Node)) {
        throw new TypeError("wds-data-list renderItem must return a DOM Node");
      }
      const listItem = document.createElement("div");
      listItem.setAttribute("role", "listitem");
      listItem.className = "contents";
      listItem.append(node);
      this.append(listItem);
    }
  }
}

if (!customElements.get("wds-data-list")) {
  customElements.define("wds-data-list", WdsDataList);
}
