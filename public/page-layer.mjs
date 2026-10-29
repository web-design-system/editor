class WdsPageDeck extends HTMLElement {}

class WdsPageLayer extends HTMLElement {
  connectedCallback() {
    this.setAttribute("data-page-layer", "");
  }
}

if (!customElements.get("wds-page-deck")) {
  customElements.define("wds-page-deck", WdsPageDeck);
}

if (!customElements.get("wds-page-layer")) {
  customElements.define("wds-page-layer", WdsPageLayer);
}
