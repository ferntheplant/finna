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
}

/**
 * Example Purchased Items:
[
  {
    "itemTitle": "Dr. Bronner's Magic Soap-Pure-Castile Liquid Soap (2 Ounce, Variety Gift Pack)- Regenerative Organic Certified Oils, 18-in-1 Uses: Body, Hair, Laundry, Pets &amp; Dishes, Concentrated, Vegan, Non-GMO",
    "orderedMerchant": "Dr. Bronner's",
    "unitPrice": "$24.99"
  },
  {
    "itemTitle": "Arcade Belts A2 Atlas Slim Adventure Belt: Heavy Duty Stretch, Metal Free Buckle, Black",
    "orderedMerchant": "Arcade Belts",
    "unitPrice": "$39.95"
  },
  {
    "itemTitle": "GEAR AID HEROCLIP Carabiner Clip and Hook (Small) for Purse, Stroller, and Backpack, Forest Green",
    "orderedMerchant": "Sold by: Amazon.com",
    "unitPrice": "$20.95"
  },
  {
    "itemTitle": "Anker Flat Plug Power Strip(300J) with 20W USB-C, 10-in-1 Ultra Thin Power Strip with 6 AC, 2 USB-A/2 USB-C,5feet Extension Cord, Desk Charging Station,Home Office College Dorm Essentials",
    "orderedMerchant": "AnkerDirect",
    "unitPrice": "$19.99"
  },
  {
    "itemTitle": "Anker Surge Protector Flat Plug Power Strip(2100J), 12 AC Outlets, 5feet Flat Extension Cord, 1USB C and 2 USB Ports for Multiple Devices, 20W Fast Charging for Home, Office, Dorm Essential, TUV",
    "orderedMerchant": "AnkerDirect",
    "unitPrice": "$23.99"
  },
  {
    "itemTitle": "Flat Plug Power Strip, Ultra Thin Flat Extension Cord - Addtam 12 Widely AC 3 Sides Multiple Outlets, 5Ft, 1050J Surge Protector, Wall Mount, Desk Charging Station for Home Office Dorm Room Essentials",
    "orderedMerchant": "ADDTAM US",
    "unitPrice": "$9.98"
  },
  {
    "itemTitle": "EASYFUN Mesh Pouch, Make up Bag with Zipper Cosmetic Organizer Pouch for Daily or Travel to Keep Small Items, 4 PCS Black",
    "orderedMerchant": "JXSY-US",
    "unitPrice": "$9.99"
  }
]
 */

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
}

/**
 * Example Charge Summary:
[
  {
    "label": "Item(s) Subtotal:",
    "content": "$149.84"
  },
  {
    "label": "Shipping & Handling:",
    "content": "$0.00"
  },
  {
    "label": "Total before tax:",
    "content": "$149.84"
  },
  {
    "label": "Estimated tax to be collected:",
    "content": "$9.76"
  },
  {
    "label": "Grand Total:",
    "content": "$159.60"
  }
]
 */
