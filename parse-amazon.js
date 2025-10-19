javascript:(function(){
  function getPurchasedItems() {
  const FIELDS = ["itemTitle", "orderedMerchant", "unitPrice"]

  function getDeepestText(el) {
    // Find all text-containing descendants
    const textNodes = Array.from(el.querySelectorAll("*"))
      .filter(e => e.children.length === 0 && e.textContent.trim());
    // Fallback: use the element itself if no deeper text nodes
    const target = textNodes[0] || el;
    return target.innerHTML.trim();
  }

  let nodes = document.querySelectorAll('div[data-component="purchasedItemsRightGrid"]')

  const data = Array.from(nodes).map(node => {
    const obj = {};
    for (const field of FIELDS) {
      const el = node.querySelector(`[data-component="${field}"]`);
      obj[field] = el ? getDeepestText(el) : null;
    }
    return obj;
  });

  console.log(data);
  return data;
}

function getChargeSummary() {
  function getDeepestText(el) {
    const textNodes = Array.from(el.querySelectorAll("*"))
      .filter(e => e.children.length === 0 && e.textContent.trim());
    const target = textNodes[0] || el;
    return target.textContent.trim();
  }

  const node = document.querySelectorAll('div[data-component="chargeSummary"]')[0]
  const ul = node.querySelector("ul");
  const items = Array.from(ul.querySelectorAll("li")).map(li => {
    const labelEl = li.querySelector(".od-line-item-row-label");
    const contentEl = li.querySelector(".od-line-item-row-content");

    return {
      label: labelEl ? getDeepestText(labelEl) : null,
      content: contentEl ? getDeepestText(contentEl) : null
    };
  });

  console.log(items);
  return items;
}

function getOrderDetails() {
  const data = getPurchasedItems();
  const summary = getChargeSummary();

  const orderDetails = {
    items: data,
    summary: summary
  };

  console.log(orderDetails);
  return orderDetails;
}

  const orderDetails = getOrderDetails();
  alert(JSON.stringify(orderDetails));
})();
