// src/app/api/order/route.js
/**
 *
 * Notes:
 *  - For POST, preferred body is items array.
 *  - Shortcut supported:
 *      { userId, productId, quantity, price, ... }
 */

import mongoose from "mongoose";
import dbConnect from "@/lib/db/connect";
import Order from "@/lib/db/models/order";
import Product from "@/lib/db/models/product";
import Supplier from "@/lib/db/models/supplier";
import User from "@/lib/db/models/User";
import Customer from "@/lib/db/models/customer";
import Department from "@/lib/db/models/Department";
import Claim from "@/lib/db/models/Claim";
import PriceNegotiation from "@/lib/db/models/PriceNegotiation";
import Notification from "@/lib/db/models/notification";
import { getUserFromRequest } from "@/lib/serverAuth";
import { logger } from "@/lib/logger";
import { detectAndGroupOrder } from "@/lib/services/duplicateOrderService";
import { MOV_AMOUNT, MOV_DELIVERY_CHARGE } from "@/lib/utils/mov";

// (json helper assumed already in file)
const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Safe populate helper:
 * - path: populate path string (e.g. "supplier", "user", "items.product")
 * - select: projection string
 * Uses Order.schema to determine the ref model name(s) and only populates if registered.
 */
function safePopulateQuery(query, path, select = "") {
  // get list of registered model names
  const registered = mongoose.modelNames();

  // helper to resolve ref model for a path (support nested like items.product)
  function resolveRefForPath(p) {
    // direct path e.g. 'supplier' or 'user' on Order schema
    const sp = Order.schema.path(p);
    if (!sp) return null;
    if (sp.options && sp.options.ref) return sp.options.ref;
    if (sp.options && sp.options.refPath) return "POLYMORPHIC"; // indicator

    // handle nested path like 'items.product'
    if (p.includes(".")) {
      const [arrPath, subPath] = p.split(".", 2); // items, product
      const arrSchemaPath = Order.schema.path(arrPath);
      if (arrSchemaPath && arrSchemaPath.caster) {
        // When items is an array of subdocs, subdoc schema might be at caster.schema
        const casterSchema =
          arrSchemaPath.caster.schema || arrSchemaPath.caster;
        if (
          casterSchema &&
          casterSchema.path(subPath) &&
          casterSchema.path(subPath).options
        ) {
          const osp = casterSchema.path(subPath).options;
          if (osp.ref) return osp.ref;
          if (osp.refPath) return "POLYMORPHIC";
        }
      }
    }

    return null;
  }

  const refModel = resolveRefForPath(path);

  if (!refModel) {
    // no ref defined in schema for this path -> don't populate
    console.warn(
      `[safePopulate] No ref or refPath found in Order.schema for path "${path}" — skipping populate.`
    );
    return query;
  }

  // If polymorphic, we just trust Mongoose to handle it if the models are registered.
  // Standard non-polymorphic check
  if (refModel !== "POLYMORPHIC" && !registered.includes(refModel)) {
    console.warn(
      `[safePopulate] Model "${refModel}" for path "${path}" is NOT registered. Skipping populate. Registered models: ${registered.join(
        ", "
      )}`
    );
    return query;
  }

  // safe to populate
  return query.populate(path, select);
}

/**
 * Manual Population Helper:
 * Handles cases where 'department' might be a string ("others") or an ObjectId.
 * Prevents CastError in standard Mongoose population.
 */
async function manualPopulateDepartments(orders) {
  if (!orders) return;
  const docs = Array.isArray(orders) ? orders : [orders];
  if (docs.length === 0) return;

  const Department = (await import("@/lib/db/models/Department")).default;

  // 1. Collect all unique valid ObjectIds
  const deptIds = new Set();
  docs.forEach(o => {
    if (mongoose.Types.ObjectId.isValid(o.department)) deptIds.add(o.department.toString());
    (o.departmentHistory || []).forEach(h => {
      if (mongoose.Types.ObjectId.isValid(h.from)) deptIds.add(h.from.toString());
      if (mongoose.Types.ObjectId.isValid(h.to)) deptIds.add(h.to.toString());
    });
  });

  if (deptIds.size === 0) return;

  // 2. Fetch all unique departments in one query
  const departments = await Department.find({
    _id: { $in: Array.from(deptIds).map(id => new mongoose.Types.ObjectId(id)) }
  }).select("departmentName").lean();

  const deptMap = {};
  departments.forEach(d => { deptMap[d._id.toString()] = d; });

  // 3. Map back to documents
  docs.forEach(o => {
    if (o.department && deptMap[o.department.toString()]) {
      o.department = deptMap[o.department.toString()];
    }
    (o.departmentHistory || []).forEach(h => {
      if (h.from && deptMap[h.from.toString()]) h.from = deptMap[h.from.toString()];
      if (h.to && deptMap[h.to.toString()]) h.to = deptMap[h.to.toString()];
    });
  });
}
/* ------------------------------------------------------------------
   POST  -> PLACE ORDER
   Body formats supported:
   1) Preferred (items array):
   {
      userId | user,
      items: [{ product, quantity, unitPrice?, attributes? }],
      supplierId?,
      shippingCharges?, tax?, discounts?, currency?, b2b?, notes?,
      payment: { method, status?, transactionId? },
      decrementStock?: true
   }
   2) Shortcut single-item:
   {
      userId | user,
      productId,
      quantity,
      price,             // treated as unitPrice
      supplierId?, ...
   }
------------------------------------------------------------------ */

async function normalizeDept(name) {
  if (!name) return 'others';

  try {
    const isObjectId = mongoose.Types.ObjectId.isValid(name);
    if (isObjectId) return new mongoose.Types.ObjectId(name);

    // Standardize search (case-insensitive for name)
    const normName = name.toString().trim().toUpperCase();

    // Look for ODT/ART abbreviations if names are longer, or match directly
    const dept = await Department.findOne({
      departmentName: { $regex: new RegExp(`^${normName}$`, 'i') }
    }).lean();

    if (dept) return new mongoose.Types.ObjectId(dept._id);

    // Fallback logic for legacy strings if no match found
    if (['odt', 'odt management'].includes(normName.toLowerCase())) {
      const odt = await Department.findOne({ departmentName: 'ODT' }).lean();
      if (odt) return new mongoose.Types.ObjectId(odt._id);
    }
    if (['art', 'art reporting'].includes(normName.toLowerCase())) {
      const art = await Department.findOne({ departmentName: 'ART' }).lean();
      if (art) return new mongoose.Types.ObjectId(art._id);
    }

    return name.toLowerCase(); // Return original lowercase as ID if no DB match
  } catch (e) {
    const isObjectId = mongoose.Types.ObjectId.isValid(name);
    return isObjectId ? new mongoose.Types.ObjectId(name) : name.toString();
  }
}








// Helper to escape XML characters
const escapeXML = (str) => {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
};

// Helper to map units to Tally active unit name
const mapMongooseUnitToTally = (mongooseUnit) => {
  if (!mongooseUnit) return "Nos";
  const normalized = String(mongooseUnit).trim().toLowerCase();
  switch (normalized) {
    case "kg":
    case "kilogram":
    case "kilograms":
      return "Kg";
    case "g":
    case "gram":
    case "grams":
      return "Kg";
    case "liters":
    case "liter":
    case "ml":
    case "milliliter":
    case "ltr":
      return "Ltr";
    case "pcs":
    case "piece":
    case "pieces":
    case "nos":
    case "box":
    case "dozen":
    case "pack":
    case "ton":
    default:
      return "Nos";
  }
};

// Helper to format Date as YYYYMMDD with educational mode support
const formatTallyDate = (dateVal) => {
  const d = dateVal ? new Date(dateVal) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  let dd = String(d.getDate()).padStart(2, '0');

  // Normalization for Tally Educational Mode in Dev/Testing
  const tallyUrl = process.env.TALLY_URL || '';
  const isDevTally = !tallyUrl || tallyUrl.includes('ngrok') || tallyUrl.includes('localhost') || process.env.NODE_ENV !== 'production';
  if (isDevTally && dd !== '01' && dd !== '02' && dd !== '31') {
    dd = '01'; // Force to 1st of the month
  }

  return `${yyyy}${mm}${dd}`;
};

// Helper to parse Tally responses
function parseTallyResponse(xmlString) {
  if (!xmlString) return { success: false, error: "Empty response from Tally" };

  const createdMatch = xmlString.match(/<CREATED>(\d+)<\/CREATED>/);
  const alteredMatch = xmlString.match(/<ALTERED>(\d+)<\/ALTERED>/);

  const createdCount = createdMatch ? parseInt(createdMatch[1], 10) : 0;
  const alteredCount = alteredMatch ? parseInt(alteredMatch[1], 10) : 0;

  if (createdCount > 0 || alteredCount > 0) {
    return { success: true };
  }

  const errorMatch = xmlString.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/);
  if (errorMatch && errorMatch[1]) {
    return { success: false, error: errorMatch[1].trim() };
  }

  return { success: false, error: "Failed to parse Tally response", raw: xmlString };
}

// Helper to fetch all Debtors from Tally (including custom customerGroup parents)
async function fetchTallyDebtors(tallyUrl, companyName, customerGroup) {
  const payload = `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>EXPORT</TALLYREQUEST>
    <TYPE>COLLECTION</TYPE>
    <ID>LedgerCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${escapeXML(companyName)}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="LedgerCollection">
            <TYPE>Ledger</TYPE>
            <FETCH>NAME,PARENT</FETCH>
            <FILTER>DebtorsFilter</FILTER>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="DebtorsFilter">
            $Parent = "Sundry Debtors"${customerGroup ? ` or $Parent = "${escapeXML(customerGroup)}"` : ""}
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

  try {
    const res = await fetch(tallyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: payload
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const matches = [...xml.matchAll(/<LEDGER NAME="([^"]+)"[^>]*>/g)];
    const ledgers = matches.map(m => m[1]);
    return ledgers;
  } catch (err) {
    console.error("[Tally Sync] Failed to fetch debtors from Tally:", err);
    return [];
  }
}

// Helper to match customer info to Tally debtors
function findMatchingTallyLedger(tallyLedgers, customerDoc, orderDoc) {
  const searchTerms = [
    customerDoc?.businessName,
    customerDoc?.name,
    customerDoc?.shopName,
    orderDoc?.shippingAddress?.fullName
  ].filter(Boolean).map(s => s.toLowerCase().trim());

  if (searchTerms.length === 0) return "Anup and Co";

  // 1. Exact match first
  for (const term of searchTerms) {
    const exact = tallyLedgers.find(l => l.toLowerCase().trim() === term);
    if (exact) return exact;
  }

  // 2. Starts with / contains match
  for (const term of searchTerms) {
    const match = tallyLedgers.find(l => {
      const normalizedL = l.toLowerCase().trim();
      return normalizedL.startsWith(term) || term.startsWith(normalizedL) || normalizedL.includes(term) || term.includes(normalizedL);
    });
    if (match) return match;
  }

  // Default fallback to prevent 'Ledger does not exist' error for new customers
  return "Anup and Co";
}

// Function to construct the Tally Sales Voucher XML
function buildTallySalesVoucherXML(order, productMap, companyName, userObject, partyLedgerName) {
  const dateStr = formatTallyDate(order.placedAt || order.createdAt || new Date());

  // Resolve customer/party name
  const rawPartyName = partyLedgerName || "Anup and Co";
  const partyName = escapeXML(rawPartyName);

  const orderNumber = escapeXML(order.orderNumber);
  const mongoId = escapeXML(order._id.toString());

  let computedTotal = 0;

  const itemsXml = order.items.map(item => {
    const itemName = escapeXML(item.name);
    const qty = parseFloat(item.quantity) || 0;
    const unitPrice = parseFloat(item.unitPrice) || 0;
    const itemTotal = qty * unitPrice;
    computedTotal += itemTotal;

    // Resolve unit
    const productIdStr = (item.product?._id || item.product || "").toString();
    const productDoc = productMap[productIdStr];
    const tallyUnit = escapeXML(mapMongooseUnitToTally(productDoc?.unit || 'pcs'));

    // Just send the number without the unit string. Tally will automatically use the base unit configured for the item.
    // This prevents Tally from dropping the quantity to 0 if "Nos" doesn't match the item's configured unit.
    const qtyStr = `${qty}`;
    const rateStr = `${unitPrice}`;
    const amountStr = itemTotal.toFixed(2); // Positive for Sales

    // Resolve godown (warehouse) name from locationPath
    const rootWarehouse = productDoc?.locationPath 
      ? productDoc.locationPath.split(' > ')[0] 
      : 'Unifoods Warehouse';

    return `<ALLINVENTORYENTRIES.LIST>
       <STOCKITEMNAME>${itemName}</STOCKITEMNAME>
       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
       <RATE>${rateStr}</RATE>
       <AMOUNT>${amountStr}</AMOUNT>
       <ACTUALQTY>${qtyStr}</ACTUALQTY>
       <BILLEDQTY>${qtyStr}</BILLEDQTY>

       <BATCHALLOCATIONS.LIST>
        <GODOWNNAME>${escapeXML(rootWarehouse)}</GODOWNNAME>
        <BATCHNAME>Batch1</BATCHNAME>
        <AMOUNT>${amountStr}</AMOUNT>
        <ACTUALQTY>${qtyStr}</ACTUALQTY>
        <BILLEDQTY>${qtyStr}</BILLEDQTY>
       </BATCHALLOCATIONS.LIST>

       <ACCOUNTINGALLOCATIONS.LIST>
        <LEDGERNAME>Sales</LEDGERNAME>
        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
        <AMOUNT>${amountStr}</AMOUNT>
       </ACCOUNTINGALLOCATIONS.LIST>
      </ALLINVENTORYENTRIES.LIST>`;
  }).join("\n");

  const totalAmountStr = (-computedTotal).toFixed(2); // Negative for Sales

  const xmlStr = `<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Vouchers</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${escapeXML(companyName)}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View">
      <DATE>${dateStr}</DATE>
      <VCHSTATUSDATE>${dateStr}</VCHSTATUSDATE>
      <EFFECTIVEDATE>${dateStr}</EFFECTIVEDATE>
      <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
      <PARTYLEDGERNAME>${userObject && userObject._id ? escapeXML(userObject._id.toString()) : partyName}</PARTYLEDGERNAME>
      <PARTYNAME>${partyName}</PARTYNAME>
      <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
      <VCHENTRYMODE>Item Invoice</VCHENTRYMODE>
      <DIFFACTUALQTY>Yes</DIFFACTUALQTY>
      <ISINVOICE>Yes</ISINVOICE>

      ${itemsXml}

      <LEDGERENTRIES.LIST>
       <LEDGERNAME>${userObject && userObject._id ? escapeXML(userObject._id.toString()) : partyName}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
       <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
       <AMOUNT>${totalAmountStr}</AMOUNT>
       <BILLALLOCATIONS.LIST>
        <NAME>${orderNumber}</NAME>
        <BILLTYPE>New Ref</BILLTYPE>
        <AMOUNT>${totalAmountStr}</AMOUNT>
       </BILLALLOCATIONS.LIST>
      </LEDGERENTRIES.LIST>
     </VOUCHER>
    </TALLYMESSAGE>
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;

  console.log("[Tally Sync] Generated XML Payload:\n", xmlStr);
  return xmlStr;
}

// Function to construct the Tally Payment Voucher XML
function buildTallyPaymentVoucherXML(order, companyName, userObject, partyLedgerName) {
  const dateStr = formatTallyDate(order.placedAt || order.createdAt || new Date());
  
  // Resolve customer/party name
  const rawPartyName = partyLedgerName || "Anup and Co";
  const partyName = escapeXML(rawPartyName);
  
  const orderNumber = escapeXML(order.orderNumber);
  const totalAmountStr = parseFloat(order.total || 0).toFixed(2); // Positive

  // VCHTYPE="Payment" means WE pay SOMEONE. But the user asked for Payment Voucher explicitly. 
  // In a Tally Payment Voucher (F5), we debit Receiver, credit Cash.
  
  const xmlStr = `<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Vouchers</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${escapeXML(companyName)}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="Payment" ACTION="Create" OBJVIEW="Accounting Voucher View">
      <DATE>${dateStr}</DATE>
      <VCHSTATUSDATE>${dateStr}</VCHSTATUSDATE>
      <EFFECTIVEDATE>${dateStr}</EFFECTIVEDATE>
      <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
      <PARTYLEDGERNAME>${userObject && userObject._id ? escapeXML(userObject._id.toString()) : partyName}</PARTYLEDGERNAME>
      <PARTYNAME>${partyName}</PARTYNAME>
      <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>

      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>${userObject && userObject._id ? escapeXML(userObject._id.toString()) : partyName}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
       <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
       <AMOUNT>-${totalAmountStr}</AMOUNT>
       <BILLALLOCATIONS.LIST>
        <NAME>${orderNumber}</NAME>
        <BILLTYPE>New Ref</BILLTYPE>
        <AMOUNT>-${totalAmountStr}</AMOUNT>
       </BILLALLOCATIONS.LIST>
      </ALLLEDGERENTRIES.LIST>

      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>Cash</LEDGERNAME>
       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
       <AMOUNT>${totalAmountStr}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
     </VOUCHER>
    </TALLYMESSAGE>
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;

  console.log("[Tally Sync] Generated Payment XML Payload:\n", xmlStr);
  return xmlStr;
}

export async function POST(request) {

  try {
    await dbConnect();
    const body = await request.json();

    const shippingAddress = body.shippingAddress || null; // ⭐ REQUIRED

    // 1) Identify Who is Placing the Order (User, Customer, or Supplier)
    const placerId = body.userId || body.user || body.supplierId;
    if (!placerId) {
      return json({ success: false, error: "Identification (userId or supplierId) is required" }, 400);
    }

    // 🛑 DEBUG: Ensure it's a valid ID
    if (!mongoose.Types.ObjectId.isValid(placerId)) {
      return json({ success: false, error: `Invalid ID format provided: ${placerId}` }, 400);
    }

    let identifiedUser = null;
    let userModel = "User";

    // Try finding in all three collections
    identifiedUser = await User.findById(placerId);
    if (!identifiedUser) {
      identifiedUser = await Customer.findById(placerId);
      userModel = "Customer";
    }
    if (!identifiedUser) {
      identifiedUser = await Supplier.findById(placerId);
      userModel = "Supplier";
    }

    if (!identifiedUser) {
      // 🕵️ FALLBACK 1: Try finding by phone number from shipping address
      const phone = shippingAddress?.phone;
      const email = shippingAddress?.email || body.email;

      if (phone || email) {
        const query = [];
        if (phone) {
          const numericPhone = phone.replace(/\D/g, "");
          query.push({ phone: { $regex: numericPhone } });
          query.push({ phone: phone });
        }
        if (email) {
          query.push({ email: email.toLowerCase() });
        }

        identifiedUser = await Customer.findOne({ $or: query });

        if (identifiedUser) {
          userModel = "Customer";
          console.log(`[ORDER INFO] User auto-linked via PHONE/EMAIL fallback: ${phone || email} (Original ID ${placerId} not found)`);
        }
      }
    }

    if (!identifiedUser) {
      // 🕵️ FALLBACK 2: Try finding in ALL collections (raw)
      const dbName = mongoose.connection.db?.databaseName || "UNKNOWN";

      // Try to find where this ID actually exists
      let foundInCollection = null;
      try {
        const collections = await mongoose.connection.db.listCollections().toArray();
        for (const coll of collections) {
          const doc = await mongoose.connection.db.collection(coll.name).findOne({
            _id: mongoose.Types.ObjectId.isValid(placerId) ? new mongoose.Types.ObjectId(placerId) : placerId
          });
          if (doc) {
            foundInCollection = coll.name;
            break;
          }
        }
      } catch (e) {
        console.error("Global search failed:", e);
      }

      // Sample a few IDs from Customers to verify connectivity
      const sample = await Customer.find().limit(3).select('_id').lean();
      const sampleIds = sample.map(s => s._id.toString()).join(', ');

      console.error(`[ORDER ERROR] User not found for ID: ${placerId} | DB: ${dbName} | Found in: ${foundInCollection || 'NONE'}`);

      return json({
        success: false,
        error: "Customer/User/Supplier not found with the provided ID",
        debugId: placerId,
        debugDb: dbName,
        debugFoundIn: foundInCollection || "NONE",
        debugSamples: sampleIds
      }, 404);
    }

    // 1.5) License & FSSAI Expiry Validation Check for Customer Orders
    if (userModel === "Customer" || identifiedUser?.fssaiExpiryDate || identifiedUser?.licenseExpiryDate) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Check FSSAI License Expiry
      if (identifiedUser.hasFssai !== false && identifiedUser.fssaiExpiryDate) {
        const fssaiExp = new Date(identifiedUser.fssaiExpiryDate);
        fssaiExp.setHours(23, 59, 59, 999);
        if (fssaiExp < today) {
          const expDateStr = new Date(identifiedUser.fssaiExpiryDate).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
          console.warn(`[ORDER BLOCKED] Customer ${identifiedUser._id} FSSAI License expired on ${expDateStr}`);
          return json({
            success: false,
            code: "FSSAI_EXPIRED",
            error: `Your FSSAI License expired on ${expDateStr}. Order creation and billing are suspended until updated FSSAI license details are provided.`
          }, 400);
        }
      }

      // Check Business / Trade License Expiry
      if (identifiedUser.licenseExpiryDate) {
        const tradeExp = new Date(identifiedUser.licenseExpiryDate);
        tradeExp.setHours(23, 59, 59, 999);
        if (tradeExp < today) {
          const expDateStr = new Date(identifiedUser.licenseExpiryDate).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
          console.warn(`[ORDER BLOCKED] Customer ${identifiedUser._id} Business License expired on ${expDateStr}`);
          return json({
            success: false,
            code: "LICENSE_EXPIRED",
            error: `Your Business License expired on ${expDateStr}. Order creation and billing are suspended until updated Business License details are provided.`
          }, 400);
        }
      }
    }

    // 2) items array or single-item shortcut
    let itemsInput = body.items;
    if (
      (!Array.isArray(itemsInput) || itemsInput.length === 0) &&
      body.productId
    ) {
      itemsInput = [
        {
          product: body.productId,
          quantity: body.quantity ?? 1,
          unitPrice: body.price,
          attributes: body.attributes || null,
        },
      ];
    }

    if (!Array.isArray(itemsInput) || itemsInput.length === 0) {
      return json(
        {
          success: false,
          error:
            "items array is required (or provide productId/quantity/price)",
        },
        400
      );
    }

    // 2.2) PO Mandatory Validation for Customers
    let providedPoNumber = body.b2b?.purchaseOrderNumber || body.poNumber || body.purchaseOrderNumber || null;
    
    if (userModel === "Customer" && identifiedUser.poMandatory) {
      if (!providedPoNumber || String(providedPoNumber).trim() === "") {
        return json(
          {
            success: false,
            error: "Purchase Order (PO) is mandatory for this customer. Please provide a PO number to proceed with the order.",
          },
          400
        );
      }

      // Rule-based validation: Verify PO against the PurchaseOrder system
      try {
        const PurchaseOrder = (await import("@/lib/db/models/inventory/PurchaseOrder")).default;
        const validPO = await PurchaseOrder.findOne({ poNumber: providedPoNumber });
        
        if (!validPO) {
          return json(
            {
              success: false,
              error: `Invalid Purchase Order: PO '${providedPoNumber}' does not exist in the system.`,
            },
            400
          );
        }

        // Verify the PO belongs to this customer (stored in supplier.id)
        if (validPO.supplier?.id && validPO.supplier.id !== identifiedUser._id.toString()) {
          return json(
            {
              success: false,
              error: `Purchase Order '${providedPoNumber}' does not belong to this customer.`,
            },
            400
          );
        }

        // Ensure PO is not in a restricted status
        if (["Cancelled", "Rejected"].includes(validPO.status)) {
          return json(
            {
              success: false,
              error: `Purchase Order '${providedPoNumber}' is ${validPO.status} and cannot be used for this order.`,
            },
            400
          );
        }
      } catch (err) {
        console.error("Error validating PurchaseOrder against DB:", err);
        // Continue order creation if we can't fetch the model for some reason, or we can choose to block it.
        // Let's block it for strict validation.
        return json(
          {
            success: false,
            error: "Internal error occurred while verifying Purchase Order.",
          },
          500
        );
      }

      // Rule-based validation: Prevent duplicate PO numbers for the same customer
      const existingOrderWithPO = await Order.findOne({
        user: identifiedUser._id,
        $or: [
          { "b2b.purchaseOrderNumber": providedPoNumber },
          { poNumber: providedPoNumber },
          { metadata: { poNumber: providedPoNumber } }
        ],
        status: { $nin: ["cancelled", "canceled", "failed"] }
      });

      if (existingOrderWithPO) {
        return json(
          {
            success: false,
            error: `Rule-based validation failed: An active order (${existingOrderWithPO.orderNumber}) already exists for PO number '${providedPoNumber}'. Duplicate POs are not allowed.`,
          },
          400
        );
      }
    }

    // 2.5) Price Negotiation Validation
    let validNegotiation = null;
    if (body.priceNegotiationId) {
      validNegotiation = await PriceNegotiation.findById(body.priceNegotiationId);
      if (!validNegotiation) {
        return json({ success: false, error: "Price negotiation not found" }, 404);
      }
      if (validNegotiation.status !== "approved") {
        return json({ success: false, error: "Price negotiation is not approved" }, 400);
      }
      if (validNegotiation.orderId) {
        return json({ success: false, error: "An order has already been placed for this negotiation" }, 400);
      }
      if (validNegotiation.customer.toString() !== placerId.toString()) {
        return json({ success: false, error: "Unauthorized: Negotiation belongs to a different customer" }, 403);
      }
      // If we are placing an order from a negotiation, force the items array to match the negotiation exactly
      if (itemsInput.length > 1 || itemsInput[0].product.toString() !== validNegotiation.product.toString()) {
        return json({ success: false, error: "Order items do not match the approved negotiation" }, 400);
      }
    }

    // 3) Build items + totals
    const builtItems = [];
    let subtotal = 0;
    let detectedSupplier = body.supplierId || body.supplier || null;
    const stockErrors = [];

    for (const it of itemsInput) {
      const productId = it.product || it.productId;
      if (!productId) {
        return json(
          {
            success: false,
            error: "Each item must include product (or productId)",
          },
          400
        );
      }

      const product = await Product.findById(productId);
      if (!product) {
        return json(
          { success: false, error: `Product not found: ${productId}` },
          404
        );
      }

      const qty = Number(it.quantity ?? 1);
      if (Number.isNaN(qty) || qty < 1) {
        return json(
          { success: false, error: "Quantity must be a positive number" },
          400
        );
      }

      const customerCategory = identifiedUser?.category || "D";
      let displayPrice = product.price;

      if (customerCategory && product.categoryPrices && product.categoryPrices[customerCategory]) {
        displayPrice = product.categoryPrices[customerCategory];
      }

      // Use the unitPrice sent by the client (what the customer saw in cart/checkout).
      // If the client price is LOWER than the resolved DB price (possible price manipulation),
      // enforce the DB price. This ensures the invoice always matches the checkout display.
      const clientUnitPrice = Number(it.unitPrice ?? it.price ?? 0);
      let unitPrice = (clientUnitPrice > 0 && clientUnitPrice <= displayPrice)
        ? clientUnitPrice  // honour what the customer was shown
        : displayPrice;   // fallback to DB-resolved price (and protects against inflation)

      // 🔥 Price Negotiation Override
      if (validNegotiation && validNegotiation.product.toString() === product._id.toString()) {
        unitPrice = validNegotiation.requestedPrice;
      }

      const totalPrice = unitPrice * qty;
      subtotal += totalPrice;

      // 🔹 FIX THIS LATER TO USE product.supplierId IF YOU HAVE IT
      if (!detectedSupplier && (product.supplierId || product.supplier)) {
        detectedSupplier = product.supplierId || product.supplier;
      }

      if (typeof product.stockQuantity === "number" && product.stockQuantity < qty) {
        stockErrors.push({
          product: product._id,
          available: product.stockQuantity,
          requested: qty,
        });
      }

      builtItems.push({
        product: product._id,
        name: product.name || product.title || "Unnamed Product",
        sku: product.sku || String(product._id),
        quantity: qty,
        unitPrice,
        totalPrice,
        gst: product.gst || 0, // Persist GST from product model
        supplier: product.supplierId || product.supplier || null,
        image: it.image || product.image || null, // ✅ Added image persistence
        attributes: it.attributes || null,
      });
    }

    if (stockErrors.length > 0 && body.decrementStock !== false) {
      return json(
        { success: false, error: "Insufficient stock", details: stockErrors },
        409
      );
    }

    // 4) Totals mapped to your schema - Recalculate GST dynamically on backend
    const calculatedGst = builtItems.reduce((sum, item) => sum + (item.totalPrice * ((item.gst || 0) / 100)), 0);
    const gstAmount = Number(calculatedGst.toFixed(2));
    const platformFee = 0;    // Removed - no platform fee
    const discounts = Number(body.discounts ?? 0);

    // --- 🛍️ MOV (Minimum Order Value) VALIDATION ---
    // MOV is checked against Grand Total = subtotal + GST (before any delivery charge)
    const grandTotalBeforeMOV = subtotal + gstAmount - discounts;
    const movApplied = body.movApplied === true;
    let movDeliveryCharge = 0;
    let shippingCharges = 0;

    if (grandTotalBeforeMOV < MOV_AMOUNT) {
      if (!movApplied) {
        // Client did NOT acknowledge delivery charge — block order creation
        return json({
          success: false,
          error: "MOV_NOT_MET",
          message: `Minimum Order Value (MOV) is ₹${MOV_AMOUNT}. Orders below MOV require an additional ₹${MOV_DELIVERY_CHARGE} delivery charge.`,
          movAmount: MOV_AMOUNT,
          movDeliveryCharge: MOV_DELIVERY_CHARGE,
          currentTotal: grandTotalBeforeMOV,
        }, 422);
      }
      // Client agreed to pay delivery charge
      movDeliveryCharge = MOV_DELIVERY_CHARGE;
      shippingCharges = MOV_DELIVERY_CHARGE;
    }

    const total = Number((grandTotalBeforeMOV + movDeliveryCharge).toFixed(2));

    // 💳 CREDIT TERMS & CREDIT LIMIT VALIDATION (for Customers)
    if (userModel === "Customer" && identifiedUser && identifiedUser._id) {
      const customerDoc = await Customer.findById(identifiedUser._id).lean();
      if (customerDoc) {
        const creditTerm = Number(customerDoc.creditTerm || 0); // 0, 7, 15, 30, 45, 60 days
        const creditLimit = Number(customerDoc.creditLimit || 0); // amount in ₹

        // 1. Calculate Customer's Current Outstanding Balance (Unpaid / Pending orders)
        const unpaidOrders = await Order.find({
          user: identifiedUser._id,
          status: { $nin: ["cancelled", "refunded"] },
          "payment.status": { $in: ["pending", "partially_paid"] }
        }).lean();

        const outstandingBalance = unpaidOrders.reduce((sum, ord) => sum + Number(ord.total || 0), 0);

        // 2. Validate Overdue Invoices / Orders against Credit Term
        if (creditTerm > 0) {
          const now = new Date();
          const overdueOrders = unpaidOrders.filter(ord => {
            const createdAt = new Date(ord.createdAt || ord.created_at || now);
            const diffTime = Math.abs(now.getTime() - createdAt.getTime());
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            return diffDays > creditTerm;
          });

          if (overdueOrders.length > 0) {
            const oldestOrderDate = new Date(Math.min(...overdueOrders.map(o => new Date(o.createdAt || now).getTime())));
            const oldestDays = Math.ceil(Math.abs(now.getTime() - oldestOrderDate.getTime()) / (1000 * 60 * 60 * 24));

            return json({
              success: false,
              error: "OVERDUE_INVOICES",
              message: `Order blocked: You have ${overdueOrders.length} unpaid order(s) exceeding your credit term of ${creditTerm} days (oldest is ${oldestDays} days old). Please clear overdue invoices to place new orders.`,
              creditTerm,
              overdueCount: overdueOrders.length,
              oldestDays,
              outstandingBalance
            }, 422);
          }
        }

        // 3. Validate Outstanding + Current Order Amount against Credit Limit
        if (creditLimit > 0) {
          const totalExposure = outstandingBalance + total;
          if (totalExposure > creditLimit) {
            const excess = totalExposure - creditLimit;
            return json({
              success: false,
              error: "CREDIT_LIMIT_EXCEEDED",
              message: `Order blocked: Total exposure (₹${totalExposure.toLocaleString('en-IN')}) exceeds your approved credit limit of ₹${creditLimit.toLocaleString('en-IN')} by ₹${excess.toLocaleString('en-IN')}. Please clear outstanding dues (₹${outstandingBalance.toLocaleString('en-IN')}) or request credit limit increase.`,
              creditLimit,
              outstandingBalance,
              currentOrderAmount: total,
              totalExposure,
              excessAmount: excess
            }, 422);
          }
        }
      }
    }

    // Calculate aggregated GST percentage
    const orderGst = subtotal > 0 ? (gstAmount / subtotal) * 100 : 0;

    // 5) Supplier ref
    let supplierRef = null;
    if (detectedSupplier || body.supplierId || body.supplier) {
      const supplierToCheck =
        detectedSupplier || body.supplierId || body.supplier;
      const sup = await Supplier.findById(supplierToCheck);
      if (sup) supplierRef = sup._id;
    }

    // 6) Notes + metadata (schema expects String for notes)
    const notes = typeof body.notes === "string" ? body.notes.trim() : "";

    // 7) 🔥 PAYMENT VALIDATION & NORMALIZATION

    // Normalize method
    const rawMethod = (body.paymentMethod || body.payment?.method || "")
      .toString()
      .trim()
      .toLowerCase();

    if (!rawMethod) {
      return json(
        {
          success: false,
          error: "paymentMethod is required (e.g. 'cod', 'upi', 'card')",
        },
        400
      );
    }

    let paymentMethod = rawMethod;
    let transactionId =
      body.transactionId || body.payment?.transactionId || undefined;
    let paymentStatus = body.paymentStatus || body.payment?.status;
    let paidAt;

    const isCOD =
      paymentMethod === "cod" ||
      paymentMethod === "cash_on_delivery" ||
      paymentMethod === "cash";

    const isCN =
      paymentMethod === "cn" ||
      paymentMethod === "credit_note";

    if (isCOD) {
      // 🔹 COD rules:
      //  - method normalized to "cod"
      //  - status = "pending" at order creation
      paymentMethod = "cod";
      if (!paymentStatus) paymentStatus = "pending";
      // no transactionId required, no paidAt at creation
    } else if (isCN) {
      // 🔹 CN rules:
      //  - method normalized to "cn"
      //  - status = "pending" at order creation
      paymentMethod = "cn";
      if (!paymentStatus) paymentStatus = "pending";
      // no transactionId required, no paidAt at creation

    } else if (paymentMethod === "wallet") {
      // 🔹 Wallet/Points payment
      // DO NOT DEDUCT HERE. The 'Final Debit' at the end of the function handles it securely.
      paymentStatus = "paid";
      paidAt = new Date();
      // transactionId will be set after debit is confirmed at the finish line
    } else {
      // 🔹 Online payment (UPI, card, netbanking, etc.)
      //  - transactionId is required
      if (!transactionId) {
        return json(
          {
            success: false,
            error: "transactionId is required for non-COD payments",
          },
          400
        );
      }

      // If status not provided, assume paid
      if (!paymentStatus) paymentStatus = "paid";

      // If status is paid at creation, set paidAt now
      if (paymentStatus === "paid") {
        paidAt = new Date();
      } else if (paymentStatus === "failed") {
        await logger({
          level: 'warn',
          message: 'Payment failed during order creation',
          action: 'PAYMENT_FAILED',
          userId: identifiedUser._id,
          metadata: { transactionId, bodyPaymentStatus: paymentStatus },
          req: request
        });
      }
    }

    // 8) Build orderDoc according to your OrderSchema
    const orderDoc = new Order({
      user: identifiedUser._id,
      userModel: userModel,
      supplier: supplierRef,
      orderSource: body.orderSource || (body.supplierId ? "Vendor" : "Customer"),
      items: builtItems,

      shippingAddress: shippingAddress,

      subtotal,
      gst: Math.round(orderGst), // Store percentage (branded as GST in db)
      gstAmount,
      shippingCharges,
      platformFee,
      discounts,
      total,
      currency: body.currency || "INR",

      // MOV tracking fields
      movApplied,
      movDeliveryCharge,

      status: body.status || "pending",
      placedAt: new Date(),

      payment: {
        method: paymentMethod,
        status: paymentStatus,
        transactionId,
        paidAt,
        meta: body.payment?.meta || undefined,
      },

      delivery: body.delivery || {},
      b2b: {
        ...(body.b2b || {}),
        purchaseOrderNumber: providedPoNumber || body.b2b?.purchaseOrderNumber
      },

      notes,
      cancellationReason: "",
      department: await normalizeDept(body.department || "odt"),

      orderSource: body.orderSource || "Customer",

      metadata: body.metadata || null,

      priceNegotiationId: validNegotiation ? validNegotiation._id : undefined,
    });


    // 9) AUTO-INVOICE (using your InvoiceSchema)
    const now = new Date();
    const invoiceNumber =
      body.invoiceNumber ||
      `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(
        2,
        "0"
      )}${String(now.getDate()).padStart(2, "0")}-${orderDoc._id
        .toString()
        .slice(-6)}`;

    orderDoc.invoice = {
      invoiceNumber,
      generatedAt: now,
      url: body.invoiceUrl || "",
      status: "optional",
      meta: {
        user: orderDoc.user,
        supplier: orderDoc.supplier,
        subtotal,
        gst: Math.round(orderGst),
        gstAmount,
        shippingCharges,
        platformFee,
        discounts,
        total,
        currency: orderDoc.currency,
        notes: body.invoiceNotes || "",
        paymentMethod,
        paymentStatus: orderDoc.payment.status, // Use live status
        paidAt: orderDoc.payment.paidAt || null,
        // MOV audit fields
        movApplied,
        movDeliveryCharge,
      },
    };


    // 9.5) 🔥 MARKETPLACE AUTO-SETTLEMENT: Settle for ALL unique suppliers in items
    const isNowDelivered = (orderDoc.status || "").toLowerCase() === "delivered" || (orderDoc.delivery?.status || "").toLowerCase() === "delivered";
    const isPaidAtCreation = (orderDoc.payment?.status || "").toLowerCase() === "paid";

    console.log(`[ORDER LOG] Flow: Auto-Settlement Check | Del: ${isNowDelivered} | Paid: ${isPaidAtCreation}`);

    try {
      const Wallet = (await import("@/lib/db/models/wallet")).default;
      const Transaction = (await import("@/lib/db/models/transaction")).default;

      // 🟢 IDENTIFY UNIQUE SUPPLIERS
      const suppliers = new Set();
      if (orderDoc.supplier) suppliers.add(orderDoc.supplier.toString());
      (orderDoc.items || []).forEach(item => {
        if (item.supplier) suppliers.add(item.supplier.toString());
      });
      console.log(`[ORDER LOG] Marketplace Detected Suppliers: ${[...suppliers].join(', ')}`);

      for (const sId of suppliers) {
        const supplierId = new mongoose.Types.ObjectId(sId);

        let wallet = await Wallet.findOne({ userId: supplierId });
        if (!wallet) {
          wallet = new Wallet({ userId: supplierId, balance: 0, userType: 'supplier' });
        }

        // 1) Auto-Settle items if order is already Delivered + Paid
        const supplierTotal = (orderDoc.items || [])
          .filter(item => item.supplier?.toString() === sId)
          .reduce((sum, item) => sum + (item.totalPrice || 0), 0);

        if (isNowDelivered && isPaidAtCreation && supplierTotal > 0) {
          console.log(`[ORDER LOG] Triggering AUTO-SETTLEMENT for Vendor: ${sId} | Amount: ₹${supplierTotal}`);
          const settlementTx = new Transaction({
            userId: supplierId,
            walletId: wallet._id,
            amount: supplierTotal,
            type: "order_settlement",
            method: "wallet",
            status: "completed",
            description: `Auto-Settlement for Order Items: ${orderDoc.orderNumber}`,
            metadata: { orderId: orderDoc._id, orderNumber: orderDoc.orderNumber }
          });
          await settlementTx.save();
        }

        // 2) Force Sync Snapshot for EVERY involved supplier (Marketplace Aware)
        const summary = await Order.aggregate([
          {
            $match: {
              $or: [
                { supplier: supplierId },
                { "items.supplier": supplierId }
              ]
            }
          },
          { $unwind: "$items" },
          {
            $group: {
              _id: null,
              realized: { $sum: { $cond: [{ $and: [{ $eq: ["$items.supplier", supplierId] }, { $eq: ["$status", "delivered"] }, { $eq: ["$payment.status", "paid"] }] }, "$items.totalPrice", 0] } },
              escrowed: { $sum: { $cond: [{ $and: [{ $eq: ["$items.supplier", supplierId] }, { $in: ["$status", ["pending", "confirmed", "packed", "shipped", "out_for_delivery"]] }] }, "$items.totalPrice", 0] } }
            }
          }
        ]);

        const snap = summary[0] || { realized: 0, escrowed: 0 };

        const ledgerTruth = await Transaction.aggregate([
          { $match: { userId: supplierId, status: 'completed' } },
          {
            $group: {
              _id: null,
              balance: { $sum: { $cond: [{ $in: ["$type", ["deposit", "refund", "transfer", "order_settlement", "adjustment"]] }, "$amount", { $multiply: ["$amount", -1] }] } }
            }
          }
        ]);

        wallet.balance = ledgerTruth[0]?.balance || 0;
        wallet.realizedSavings = snap.realized;
        wallet.escrowedPoints = snap.escrowed;
        await wallet.save();
        console.log(`[ORDER LOG] COMPLETED Sync for Vendor ${sId} | Balance: ₹${wallet.balance} | Escrow: ₹${wallet.escrowedPoints}`);
      }
    } catch (e) {
      console.error("[ORDER LOG] Marketplace Settlement Error:", e);
    }

    // 10) Save
    await orderDoc.save();

    // 10.25) 🔥 Update Price Negotiation if applicable
    if (validNegotiation) {
      validNegotiation.orderId = orderDoc._id;
      validNegotiation.orderPlacedBy = "Customer";
      validNegotiation.orderPlacementTimestamp = new Date();
      validNegotiation.status = "closed"; // Update status to 'closed' so Sales sees 'Order Placed'
      await validNegotiation.save();

      // Notify the Sales Representative
      if (validNegotiation.salesRepresentative) {
        try {
          await Notification.create({
            user: validNegotiation.salesRepresentative,
            title: "Negotiated Order Placed",
            message: `Customer ${identifiedUser?.name || 'A customer'} has placed an order from your approved price negotiation.`,
            type: "success",
            metadata: { priceNegotiationId: validNegotiation._id, orderId: orderDoc._id }
          });
        } catch (notifErr) {
          console.error("Failed to notify sales representative:", notifErr);
        }
      }
    }

    // 10.5) Trigger duplicate order detection inline
    try {
      console.log(`[ORDER LOG] Running duplicate detection for order ${orderDoc._id}...`);
      const dupRes = await detectAndGroupOrder(orderDoc);
      if (dupRes.success && dupRes.duplicateDetected) {
        console.log(`[ORDER LOG] Duplicate detected! Group ID: ${dupRes.duplicateGroupId}, Master ID: ${dupRes.masterOrderId}`);
        // Fetch updated order doc to reflect duplicate grouping fields in response
        const updatedDoc = await Order.findById(orderDoc._id);
        if (updatedDoc) {
          orderDoc.isDuplicateOrder = updatedDoc.isDuplicateOrder;
          orderDoc.duplicateGroupId = updatedDoc.duplicateGroupId;
          orderDoc.duplicateStatus = updatedDoc.duplicateStatus;
          orderDoc.masterOrderId = updatedDoc.masterOrderId;
          orderDoc.duplicateOf = updatedDoc.duplicateOf;
        }
      }
    } catch (dupErr) {
      console.error("[ORDER LOG] Error during duplicate order detection:", dupErr);
    }

    // 11) Optional stock decrement (Default to TRUE unless explicitly false)
    if (body.decrementStock !== false) {
      console.log("Starting stock decrement for order:", orderDoc._id);
      for (const it of builtItems) {
        if (typeof it.quantity === "number" && it.quantity > 0) {
          console.log(`Decrementing stock for product ${it.product} by ${it.quantity}`);
          const updateRes = await Product.updateOne(
            { _id: it.product },
            { $inc: { stockQuantity: -it.quantity } }
          );
          console.log(`Stock update result for ${it.product}:`, updateRes);
        }
      }
    } else {
      console.log("Stock decrement skipped (decrementStock === false)");
    }

    await logger({
      level: 'info',
      message: `Order created successfully: ${orderDoc._id}`,
      action: 'ORDER_CREATED',
      userId: identifiedUser._id,
      metadata: {
        orderId: orderDoc._id,
        orderNumber: orderDoc.orderNumber,
        subtotal,
        total,
        status: orderDoc.status,
        paymentMethod: body.paymentMethod || "COD"
      },
      req: request
    });

    // --- 🏆 FINAL STEP: AUTOMATIC WALLET DEBIT (Secure Point Deduction) --- 🏆
    // Only deduct points IF EVERYTHING above passed (Order saved, Stock checked)
    const isWalletPay = (body.paymentMethod || "").toLowerCase() === "wallet";
    if (isWalletPay) {
      try {
        const Wallet = (await import("@/lib/db/models/wallet")).default;
        const Transaction = (await import("@/lib/db/models/transaction")).default;

        // JIT Audit: Recalculate Truth Balance from ledger
        const ledger = await Transaction.aggregate([
          { $match: { userId: new mongoose.Types.ObjectId(identifiedUser._id), status: 'completed' } },
          {
            $group: {
              _id: null,
              in: { $sum: { $cond: [{ $in: ["$type", ["deposit", "refund", "transfer", "order_settlement", "adjustment"]] }, { $abs: "$amount" }, 0] } },
              out: { $sum: { $cond: [{ $in: ["$type", ["withdrawal", "order_payment"]] }, { $abs: "$amount" }, 0] } }
            }
          }
        ]);
        const truth = ledger[0] || { in: 0, out: 0 };
        const realBalance = Math.max(0, truth.in - truth.out);

        if (realBalance < total) {
          throw new Error(`Insufficient wallet balance. Audited Truth: ₹${realBalance} | Total: ₹${total}`);
        }

        let buyerWallet = await Wallet.findOne({ userId: identifiedUser._id });
        if (!buyerWallet) {
          buyerWallet = new Wallet({ userId: identifiedUser._id, balance: realBalance, userType: 'supplier' });
        }

        // Create Debit Transaction
        const debitTx = new Transaction({
          userId: new mongoose.Types.ObjectId(identifiedUser._id),
          walletId: new mongoose.Types.ObjectId(buyerWallet._id),
          amount: total,
          type: "order_payment",
          method: "wallet",
          status: "completed",
          description: `Internal Procurement: ${orderDoc.orderNumber}`,
          metadata: { orderId: orderDoc._id, orderNumber: orderDoc.orderNumber, type: "wallet_debit" }
        });
        await debitTx.save();

        // Update Balance
        buyerWallet.balance = (realBalance - total);
        await buyerWallet.save();
        console.log(`[FINANCE LOG] 🔒 Point Deduction Finalized for Buyer ${identifiedUser._id} | New Balance: ₹${buyerWallet.balance}`);
      } catch (e) {
        console.error("[CRITICAL FINANCE ERROR]: Order placed but debit failed:", e);
        // We throw here to fail the order if the debit cannot be secured
        throw new Error(`Payment processing failed. ${e.message}`);
      }
    }

    // Sync to Tally Prime 9 as a Sales Voucher if created from ODT Dashboard
    // [DISABLED] - User requested to sync Payment Voucher when verified and sent to ART instead.
    /*
    if (body.orderSource === "ODT") {
      try {
        const tallyUrl = process.env.TALLY_URL || 'https://yummy-freebee-circular.ngrok-free.dev';
        const tallyCompany = process.env.TALLY_SALES_COMPANY || 'Unifoods';

        // Dynamic Customer matching
        let partyLedgerName = null;
        try {
          const tallyDebtors = await fetchTallyDebtors(tallyUrl, tallyCompany);
          partyLedgerName = findMatchingTallyLedger(tallyDebtors, identifiedUser, orderDoc);
          console.log(`[Tally Sync] Resolved Customer party ledger: "${partyLedgerName}"`);
        } catch (matchErr) {
          console.warn("[Tally Sync] Dynamic customer matching warning:", matchErr.message);
        }

        // Fetch product documents to resolve units
        const productIds = orderDoc.items.map(it => it.product);
        const productDocs = await Product.find({ _id: { $in: productIds } }).lean();
        const productMap = {};
        productDocs.forEach(p => { productMap[p._id.toString()] = p; });

        const xmlPayload = buildTallySalesVoucherXML(orderDoc, productMap, tallyCompany, identifiedUser, partyLedgerName);
        console.log(`[Tally Sync] Syncing Sales Voucher for Order "${orderDoc.orderNumber}" to Tally at ${tallyUrl}`);
        const tallyResponse = await fetch(tallyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml',
            'ngrok-skip-browser-warning': 'true'
          },
          body: xmlPayload
        });

        if (tallyResponse.ok) {
          const responseText = await tallyResponse.text();
          const parsed = parseTallyResponse(responseText);
          if (parsed.success) {
            console.log(`[Tally Sync] Sales Voucher "${orderDoc.orderNumber}" synced successfully to Tally.`);
            await Order.updateOne({ _id: orderDoc._id }, { $set: { tallySynced: true, tallyError: null } });
          } else {
            console.error(`[Tally Sync] Tally error syncing Sales Voucher "${orderDoc.orderNumber}":`, parsed.error);
            await Order.updateOne({ _id: orderDoc._id }, { $set: { tallySynced: false, tallyError: parsed.error } });
          }
        } else {
          const tallyError = `Tally server responded with status ${tallyResponse.status}`;
          console.error(`[Tally Sync] HTTP error syncing Sales Voucher "${orderDoc.orderNumber}":`, tallyError);
          await Order.updateOne({ _id: orderDoc._id }, { $set: { tallySynced: false, tallyError } });
        }
      } catch (tallyErr) {
        console.error(`[Tally Sync] Exception during Sales Voucher sync for Order "${orderDoc.orderNumber}":`, tallyErr.message);
        try {
          await Order.updateOne({ _id: orderDoc._id }, { $set: { tallySynced: false, tallyError: tallyErr.message } });
        } catch (dbErr) {
          console.error("[Tally Sync] Failed to update Tally error on Order document:", dbErr);
        }
      }
    }
    */

    return json({
      success: true,
      order: orderDoc,
      message: "Marketplace order placed & points audited"
    }, 201);
  } catch (err) {
    console.error("POST /api/order error:", err);
    await logger({
      level: 'error',
      message: 'Error during order creation',
      action: 'ORDER_CREATE_ERROR',
      metadata: { error: err.message, stack: err.stack },
      req: request
    });
    if (err.name === "ValidationError") {
      return json(
        {
          success: false,
          error: "Order validation failed",
          details: err.errors,
        },
        400
      );
    }
    return json({ success: false, error: err.message || "Server error" }, 500);
  }
}

/* ------------------------------------------------------------------
   GET  -> LIST ORDERS
   Query params:
     - userId OR user
     - supplierId
     - status
     - page
     - limit
     - q (search text)
------------------------------------------------------------------ */
/* ------------------------------------------------------------------
   GET  -> FETCH SINGLE ORDER or FETCH ALL ORDERS BY USER ID
------------------------------------------------------------------ */
export async function GET(request) {
  try {
    await dbConnect();

    const url = new URL(request.url);
    const idParam =
      url.searchParams.get("id") || url.searchParams.get("orderId");

    const orderNumberParam = url.searchParams.get("orderNumber");
    if (orderNumberParam) {
      const order = await Order.findOne({ orderNumber: orderNumberParam })
        .populate("user", "name email phone")
        .populate("supplier", "name")
        .populate("items.product", "name price sku")
        .lean();
      if (!order) {
        return json({ success: false, error: "Order not found" }, 404);
      }
      return json({ success: true, order }, 200);
    }

    /* -----------------------------
       FETCH SINGLE ORDER BY ID
    ------------------------------*/
    if (idParam) {
      if (!mongoose.Types.ObjectId.isValid(idParam)) {
        return json({ success: false, error: "Invalid orderId" }, 400);
      }

      let query = Order.findById(idParam);

      query = safePopulateQuery(query, "user", "name email phone");
      query = safePopulateQuery(query, "supplier", "name");
      query = safePopulateQuery(query, "items.product", "name price sku");
      // query = safePopulateQuery(query, "department", "departmentName"); // Manual instead
      // query = safePopulateQuery(query, "departmentHistory.from", "departmentName"); // Manual instead
      // query = safePopulateQuery(query, "departmentHistory.to", "departmentName"); // Manual instead

      const order = await query.lean();

      // Manual population for departments to avoid CastError with "others"
      await manualPopulateDepartments(order);


      if (!order) {
        return json({ success: false, error: "Order not found" }, 404);
      }

      // ✅ FIXED: Return "order" instead of "data"
      return json({ success: true, order }, 200);
    }

    const userId =
      url.searchParams.get("userId") || url.searchParams.get("user");
    const status = url.searchParams.get("status");
    const supplierId = url.searchParams.get("supplierId");
    const department = url.searchParams.get("department");
    const fromDepartment = url.searchParams.get("fromDepartment");


    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const limit = Math.min(100, Number(url.searchParams.get("limit") || 20));
    const skip = (page - 1) * limit;

    // RAW DATABASE QUERY: Bypassing Mongoose to handle variations in ObjectID storage
    const collection = Order.collection;
    const rawQ = {};
    if (userId) rawQ.user = new mongoose.Types.ObjectId(userId);
    if (status) rawQ.status = status;
    if (supplierId) rawQ.supplier = new mongoose.Types.ObjectId(supplierId);

    if (department) {
      const resolvedDept = await normalizeDept(department);
      if (mongoose.Types.ObjectId.isValid(resolvedDept)) {
        const oid = new mongoose.Types.ObjectId(resolvedDept);
        rawQ.$or = [
          { department: resolvedDept },
          { department: oid },
          { "department.$oid": resolvedDept.toString() }
        ];
      } else {
        rawQ.department = resolvedDept;
      }
    }

    if (fromDepartment) {
      const resolvedFromDept = await normalizeDept(fromDepartment);
      const isOid = mongoose.Types.ObjectId.isValid(resolvedFromDept);
      const fromOid = isOid ? new mongoose.Types.ObjectId(resolvedFromDept) : null;

      const historyMatchOr = [
        { from: resolvedFromDept }
      ];
      if (isOid) {
        historyMatchOr.push({ from: fromOid });
        historyMatchOr.push({ "from.$oid": resolvedFromDept.toString() });
      }

      const historyMatch = {
        $elemMatch: {
          $or: historyMatchOr
        }
      };

      if (rawQ.$or) {
        rawQ.$and = [{ $or: rawQ.$or }, { departmentHistory: historyMatch }];
        delete rawQ.$or;
      } else {
        rawQ.departmentHistory = historyMatch;
      }
    }

    console.log("FINAL RAW QUERY:", JSON.stringify(rawQ, null, 2));

    // Phase 1: Find matching IDs using raw query (bypassing Mongoose casting)
    const matchingDocs = await collection
      .find(rawQ, { projection: { _id: 1 } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const ids = matchingDocs.map(d => d._id);
    const total = await collection.countDocuments(rawQ);

    // Phase 2: Fetch full documents through Mongoose using those IDs
    let query = Order.find({ _id: { $in: ids } }).sort({ createdAt: -1 });

    query = safePopulateQuery(query, "user", "name email phone");
    query = safePopulateQuery(query, "supplier", "name");
    query = safePopulateQuery(query, "items.product", "name price sku");
    // query = safePopulateQuery(query, "department", "departmentName"); // Manual instead
    // query = safePopulateQuery(query, "departmentHistory.from", "departmentName"); // Manual instead
    // query = safePopulateQuery(query, "departmentHistory.to", "departmentName"); // Manual instead

    const orders = await query.lean();

    // Manual population for departments to avoid CastError with "others"
    await manualPopulateDepartments(orders);

    return json(
      {
        success: true,
        orders,
        meta: { total, page, limit },
      },
      200
    );

  } catch (err) {
    console.error("GET /api/order error:", err);
    return json({
      success: false,
      error: err.message || "Server error",
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    }, 500);
  }
}

export async function PATCH(request) {
  try {
    await dbConnect();

    const url = new URL(request.url);
    const idParam =
      url.searchParams.get("id") || url.searchParams.get("orderId");

    if (!idParam || !mongoose.Types.ObjectId.isValid(idParam)) {
      return json({ success: false, error: "Invalid orderId" }, 400);
    }

    const body = await request.json();

    // fetch current order
    const order = await Order.findById(idParam);
    if (!order) return json({ success: false, error: "Order not found" }, 404);

    // Block operations on shadow duplicate orders (pending review or merged)
    const isDuplicateBlocked = order.isDuplicateOrder && !["ignored", "separate_valid"].includes(order.duplicateStatus);
    if (isDuplicateBlocked) {
      // Allow cancellation or updating duplicate properties
      const allowedKeys = ["duplicateStatus", "duplicateGroupId", "masterOrderId", "duplicateOf", "cancellationReason"];
      const requestedKeys = Object.keys(body);
      const tryingToCancel = body.status === "cancelled" || body.status === "canceled";

      const hasRestrictedUpdates = requestedKeys.some(key => {
        if (key === "status" && tryingToCancel) return false;
        return !allowedKeys.includes(key);
      });

      if (hasRestrictedUpdates) {
        return json({
          success: false,
          error: "Action blocked: This order is marked as a duplicate and is pending review or merged."
        }, 400);
      }
    }

    const curStatus = String(order.status || "").toLowerCase();
    const requestedStatus = body.status
      ? String(body.status).toLowerCase()
      : null;
    console.log(body);

    const setData = {};
    const update = { $currentDate: { updatedAt: true } };

    // Helper: compute refundable amount according to policy + request override
    function computeRefundAmount({
      orderDoc,
      cancellationFee = 0,
      cancellationFeePercent = 0,
      restockingFee = 0,
      restockingFeePercent = 0,
      nonRefundableShipping = false,
    } = {}) {
      // Prefer explicit payment.amount if present
      const paidAmount =
        (orderDoc.payment && typeof orderDoc.payment.amount === "number"
          ? orderDoc.payment.amount
          : null) ?? (typeof orderDoc.total === "number" ? orderDoc.total : 0);

      const shippingCharge =
        typeof orderDoc.shippingCharge === "number"
          ? orderDoc.shippingCharge
          : orderDoc.shippingCharges &&
            typeof orderDoc.shippingCharges === "number"
            ? orderDoc.shippingCharges
            : (orderDoc.invoice &&
              orderDoc.invoice.meta &&
              orderDoc.invoice.meta.shippingCharges) ||
            0;

      const cancelFeeFromPercent =
        (Number(cancellationFeePercent || 0) / 100) * paidAmount;
      const restockFeeFromPercent =
        (Number(restockingFeePercent || 0) / 100) * paidAmount;

      const totalFees =
        Number(cancellationFee || 0) +
        Number(cancelFeeFromPercent || 0) +
        Number(restockingFee || 0) +
        Number(restockFeeFromPercent || 0) +
        (nonRefundableShipping ? Number(shippingCharge || 0) : 0);

      const refundable = Math.max(0, Number(paidAmount || 0) - totalFees);

      // round to 2 decimals
      return Math.round(refundable * 100) / 100;
    }

    // Convenience: original payment info
    const originalPaymentStatus =
      order.payment && order.payment.status
        ? String(order.payment.status).toLowerCase()
        : null;
    const originalPaymentMethod =
      order.payment && order.payment.method
        ? String(order.payment.method).toLowerCase()
        : null;

    // -----------------------
    // CANCELLATION (allowed only in allowed statuses)
    // -----------------------
    if (requestedStatus === "cancelled" || requestedStatus === "canceled") {
      // if already cancelled, return success
      if (curStatus === "cancelled" || curStatus === "canceled") {
        return json(
          { success: true, message: "Order already cancelled", data: order },
          200
        );
      }

      // Allowed statuses for cancellation
      const allowedAutoCancel = [
        "pending",
        "pending",
        "confirmed",
        "processing",
        "packed",
      ];

      if (!allowedAutoCancel.includes(curStatus)) {
        // Disallow cancellation from out_for_delivery, shipped, delivered, etc.
        return json(
          {
            success: false,
            error: `Order cannot be cancelled from status "${order.status
              }". Allowed statuses: ${allowedAutoCancel.join(", ")}.`,
          },
          400
        );
      }

      // Build cancellation metadata
      const cancellationReason =
        body.cancellationReason || body.reason || "Cancelled by user";
      setData.status = "cancelled";
      setData.cancellationReason = cancellationReason;
      setData["invoice.meta.orderStatus"] = "cancelled";
      setData["invoice.meta.cancellationReason"] = cancellationReason;
      setData["invoice.meta.cancellationAt"] = new Date();

      // Persist notes, department, and departmentNotes if present
      if ("department" in body) {
        setData.department = body.department;
      }
      if ("notes" in body && typeof body.notes === "string") {
        setData.notes = body.notes.trim();
        setData["invoice.meta.notes"] = body.notes.trim();
      }
      if ("departmentNotes" in body && typeof body.departmentNotes === "string") {
        setData.departmentNotes = body.departmentNotes.trim();
      }
      if ("departmentHistory" in body && Array.isArray(body.departmentHistory)) {
        setData.departmentHistory = body.departmentHistory;
      } else {
        const historyEntry = {
          updatedAt: new Date(),
          notes: body.departmentNotes || body.notes || cancellationReason,
          updatedBy: body.changedBy || "System"
        };
        update.$push = update.$push || {};
        update.$push.departmentHistory = historyEntry;
      }

      // --- REFUND AMOUNT LOGIC ---
      const cancellationFee = Number(body.cancellationFee ?? 0);
      const cancellationFeePercent = Number(body.cancellationFeePercent ?? 0);
      const restockingFee = Number(body.restockingFee ?? 0);
      const restockingFeePercent = Number(body.restockingFeePercent ?? 0);
      const nonRefundableShipping = !!body.nonRefundableShipping;

      // Refund only if original order.payment.status === 'paid'
      let refundAmount = 0;
      if (originalPaymentStatus === "paid") {
        refundAmount = computeRefundAmount({
          orderDoc: order,
          cancellationFee,
          cancellationFeePercent,
          restockingFee,
          restockingFeePercent,
          nonRefundableShipping,
        });

        // If client provided refundAmount, ensure it matches server's computed amount (prevent tampering)
        const clientRefundAmount =
          body.refundAmount ?? (body.payment && body.payment.refundAmount);
        if (
          typeof clientRefundAmount === "number" &&
          Math.abs(clientRefundAmount - refundAmount) > 0.01
        ) {
          return json(
            {
              success: false,
              error: `Invalid refundAmount. Expected ${refundAmount} based on order totals and fees.`,
              expectedRefundAmount: refundAmount,
              provided: clientRefundAmount,
            },
            400
          );
        }

        setData["payment.refundAmount"] = refundAmount;
        setData["invoice.meta.refundAmount"] = refundAmount;
        setData["invoice.meta.refundDeductions"] = {
          cancellationFee,
          cancellationFeePercent,
          restockingFee,
          restockingFeePercent,
          nonRefundableShipping,
        };

        if (body.forceImmediateRefund) {
          // Simulated refund — replace with real gateway call
          const simulatedRefundTx =
            body.refundTransactionId || `RFND-${Date.now()}`;
          setData["payment.status"] = "refunded";
          setData["payment.refundTransactionId"] = simulatedRefundTx;
          setData["payment.refundAt"] = new Date();
          setData["payment.refundAmount"] = refundAmount;
          setData["invoice.meta.paymentStatus"] = "refunded";
          setData["invoice.meta.refundTransactionId"] = simulatedRefundTx;
        } else {
          setData["payment.status"] = "refund_pending";
          setData["payment.refundAmount"] = refundAmount;
          setData["invoice.meta.paymentStatus"] = "refund_pending";
        }
      } else {
        // Payment not paid (includes COD) -> explicit: no refund
        setData["payment.refundAmount"] = 0;
        // preserve existing payment.status (don't override to refunded)
        setData["payment.status"] =
          order.payment && order.payment.status
            ? order.payment.status
            : "not_paid";
      }

      // Restock behavior (default true)
      const doRestock = body.restock === false ? false : true;

      if (Object.keys(setData).length > 0) update.$set = setData;

      const res = await Order.collection.updateOne({ _id: order._id }, update);
      if (res.matchedCount === 0)
        return json({ success: false, error: "Order not found" }, 404);

      // perform restock after DB update
      if (doRestock) {
        const restockPromises = (order.items || [])
          .map((it) => {
            if (it.product && it.quantity) {
              return Product.updateOne(
                { _id: it.product },
                { $inc: { stockQuantity: Number(it.quantity) } }
              );
            }
            return null;
          })
          .filter(Boolean);
        if (restockPromises.length) await Promise.all(restockPromises);
      }

      // trigger refund worker / gateway asynchronously if needed
      const updated = await Order.findById(order._id).lean();

      await logger({
        level: 'info',
        message: `Order cancelled successfully: ${order._id}`,
        action: 'ORDER_CANCELLED',
        userId: body.userId || order.user,
        metadata: {
          orderId: order._id,
          reason: cancellationReason,
          refundAmount: updated.payment?.refundAmount || 0,
          paymentMethod: originalPaymentMethod,
          paymentStatus: originalPaymentStatus
        },
        req: request
      });

      return json(
        { success: true, message: "Order cancelled", data: updated },
        200
      );
    }

    // -----------------------
    // RETURNS (request and finalize)
    // -----------------------
    if (
      requestedStatus === "return_requested" ||
      requestedStatus === "returned"
    ) {
      // return_requested allowed only when current status is 'delivered'
      if (requestedStatus === "return_requested") {
        if (curStatus !== "delivered") {
          return json(
            {
              success: false,
              error: `Return requests are allowed only when order status is "delivered". Current status: "${order.status}".`,
            },
            400
          );
        }

        // mark request
        setData.status = "return_requested";
        setData["invoice.meta.returnRequestedAt"] = new Date();
        setData.returnReason = body.returnReason || null;
        setData["invoice.meta.orderStatus"] = "return_requested";

        // set returnRequest flags for audit / frontend
        setData["returnRequest.isRequested"] = true;
        setData["returnRequest.requestedAt"] = new Date();
        if (body.requestedBy)
          setData["returnRequest.requestedBy"] = body.requestedBy;
        if (body.requestMetadata)
          setData["returnRequest.requestMetadata"] = body.requestMetadata;

        if (Object.keys(setData).length > 0) update.$set = setData;
        const r = await Order.collection.updateOne({ _id: order._id }, update);
        if (r.matchedCount === 0)
          return json({ success: false, error: "Order not found" }, 404);

        const updated = await Order.findById(order._id).lean();

        await logger({
          level: 'info',
          message: `Return requested for order: ${order._id}`,
          action: 'ORDER_RETURN_REQUESTED',
          userId: body.userId || order.user,
          metadata: {
            orderId: order._id,
            reason: setData.returnReason || null,
            paymentMethod: originalPaymentMethod,
            paymentStatus: originalPaymentStatus
          },
          req: request
        });

        return json(
          { success: true, message: "Return requested", data: updated },
          200
        );
      }

      // requestedStatus === 'returned' — finalize return
      // Accept finalization only if current status is 'delivered' or already 'return_requested'
      if (!(curStatus === "delivered" || curStatus === "return_requested")) {
        return json(
          {
            success: false,
            error: `Cannot finalize return when order status is "${order.status}". Allowed: "delivered" or "return_requested".`,
          },
          400
        );
      }

      // finalize return metadata
      setData.status = "returned";
      setData["invoice.meta.returnedAt"] = new Date();
      setData.returnReason =
        body.returnReason || body.returnResolution?.reason || null;
      setData["invoice.meta.orderStatus"] = "returned";

      // clear/resolve returnRequest
      setData["returnRequest.isRequested"] = false;
      setData["returnRequest.resolvedAt"] = new Date();

      // record resolution if provided
      if (body.returnResolution) {
        setData["returnRequest.resolution"] = {
          status: body.returnResolution.status || "completed",
          refundAmount:
            typeof body.returnResolution.refundAmount === "number"
              ? Number(body.returnResolution.refundAmount)
              : undefined,
          resolutionNote:
            body.returnResolution.resolutionNote ||
            body.returnResolution.note ||
            null,
          resolvedBy:
            body.returnResolution.resolvedBy || body.changedBy || null,
          meta: body.returnResolution.meta || null,
          resolvedAt: new Date(),
        };
      } else if (body.changedBy) {
        setData["returnRequest.resolution"] = {
          status: "completed",
          refundAmount: undefined,
          resolutionNote: null,
          resolvedBy: body.changedBy,
          meta: null,
          resolvedAt: new Date(),
        };
      }

      // --- REFUND logic only if original payment was 'paid' ---
      const cancellationFee = Number(body.cancellationFee ?? 0);
      const cancellationFeePercent = Number(body.cancellationFeePercent ?? 0);
      const restockingFee = Number(body.restockingFee ?? 0);
      const restockingFeePercent = Number(body.restockingFeePercent ?? 0);
      const nonRefundableShipping = !!body.nonRefundableShipping;

      if (originalPaymentStatus === "paid") {
        const refundAmount = computeRefundAmount({
          orderDoc: order,
          cancellationFee,
          cancellationFeePercent,
          restockingFee,
          restockingFeePercent,
          nonRefundableShipping,
        });

        // If client-provided refund amount in returnResolution, validate match
        const clientRefundAmount =
          body.returnResolution &&
            typeof body.returnResolution.refundAmount === "number"
            ? body.returnResolution.refundAmount
            : typeof body.refundAmount === "number"
              ? body.refundAmount
              : undefined;

        if (
          typeof clientRefundAmount === "number" &&
          Math.abs(clientRefundAmount - refundAmount) > 0.01
        ) {
          return json(
            {
              success: false,
              error: `Invalid refundAmount for return. Expected ${refundAmount} based on order totals and fees.`,
              expectedRefundAmount: refundAmount,
              provided: clientRefundAmount,
            },
            400
          );
        }

        setData["payment.refundAmount"] = refundAmount;
        setData["invoice.meta.refundAmount"] = refundAmount;
        setData["invoice.meta.refundDeductions"] = {
          cancellationFee,
          cancellationFeePercent,
          restockingFee,
          restockingFeePercent,
          nonRefundableShipping,
        };

        if (
          body.forceImmediateRefund ||
          (body.returnResolution && body.returnResolution.forceImmediateRefund)
        ) {
          const simulatedRefundTx =
            body.refundTransactionId || `RFND-${Date.now()}`;
          setData["payment.status"] = "refunded";
          setData["payment.refundTransactionId"] = simulatedRefundTx;
          setData["payment.refundAt"] = new Date();
          setData["payment.refundAmount"] = refundAmount;
          setData["invoice.meta.paymentStatus"] = "refunded";
          setData["invoice.meta.refundTransactionId"] = simulatedRefundTx;
        } else {
          setData["payment.status"] = "refund_pending";
          setData["payment.refundAmount"] = refundAmount;
          setData["invoice.meta.paymentStatus"] = "refund_pending";
        }
      } else {
        // COD/unpaid -> no refund
        setData["payment.refundAmount"] = 0;
        setData["payment.status"] =
          order.payment && order.payment.status
            ? order.payment.status
            : "not_paid";
      }

      // Restock default behavior
      const doRestock = body.restock === false ? false : true;
      if (Object.keys(setData).length > 0) update.$set = setData;

      const res = await Order.collection.updateOne({ _id: order._id }, update);
      if (res.matchedCount === 0)
        return json({ success: false, error: "Order not found" }, 404);

      if (doRestock) {
        const restockPromises = (order.items || [])
          .map((it) => {
            if (it.product && it.quantity) {
              return Product.updateOne(
                { _id: it.product },
                { $inc: { stock: Number(it.quantity) } }
              );
            }
            return null;
          })
          .filter(Boolean);
        if (restockPromises.length) await Promise.all(restockPromises);
      }

      const updated = await Order.findById(order._id).lean();

      await logger({
        level: 'info',
        message: `Order returned successfully: ${order._id}`,
        action: 'ORDER_RETURNED',
        userId: body.userId || order.user,
        metadata: {
          orderId: order._id,
          reason: setData.returnReason || null,
          refundAmount: updated.payment?.refundAmount || 0,
          paymentMethod: originalPaymentMethod,
          paymentStatus: originalPaymentStatus
        },
        req: request
      });

      return json(
        { success: true, message: "Order returned", data: updated },
        200
      );
    }

    // -----------------------
    // FALLBACK: other updates (payment, delivery, notes, generic status changes)
    // -----------------------

    // Prevent direct setting of cancellation/return statuses via fallback path
    if ("status" in body) {
      const prohibitedDirect = [
        "cancelled",
        "canceled",
        "returned",
        "return_requested",
      ];
      if (prohibitedDirect.includes(String(body.status).toLowerCase())) {
        return json(
          {
            success: false,
            error: `Please use the designated cancellation/return flow to set status "${body.status}".`,
          },
          400
        );
      }
      setData.status = body.status;
      setData["invoice.meta.orderStatus"] = body.status;
    }

    // --- INVOICE VERIFICATION & WORKFLOW TRANSITION ---
    const isVerifyingInvoice = body.action === "verify_invoice" ||
      body.invoiceStatus === "verified" ||
      (body.invoice && body.invoice.status === "verified") ||
      body["invoice.status"] === "verified";

    if (isVerifyingInvoice) {
      // 🚨 NEW: Block verification if there are pending claims
      const pendingClaims = await Claim.findOne({
        orderId: order._id,
        status: { $in: ["REQUESTED", "PENDING"] }
      });

      if (pendingClaims) {
        return json(
          {
            success: false,
            error: "Order verification blocked: There are pending claims that require Sales approval first."
          },
          400
        );
      }

      setData["invoice.status"] = "verified";

      // Auto-transition to ART department
      const artDept = await normalizeDept("art");
      const oldDept = await normalizeDept(order.department);

      if (artDept && String(artDept) !== String(oldDept)) {
        setData.department = artDept;

        const historyEntry = {
          from: oldDept,
          to: artDept,
          updatedBy: (body.changedBy || body.userId) ? new mongoose.Types.ObjectId(body.changedBy || body.userId) : null,
          updatedAt: new Date(),
          notes: body.notes || body.departmentNotes || "Invoice verified by ODT - Automatically transitioned to ART"
        };

        if (!update.$push) update.$push = {};
        update.$push.departmentHistory = historyEntry;
      }

      // --- Tally Payment Voucher Sync on ART transition ---
      try {
        const tallyUrl = process.env.TALLY_URL || 'https://yummy-freebee-circular.ngrok-free.dev';
        const tallyCompany = process.env.TALLY_SALES_COMPANY || 'Unifoods';

        let partyLedgerName = null;
        try {
          const tallyDebtors = await fetchTallyDebtors(tallyUrl, tallyCompany);
          // Try to get user details if populated, else pass raw reference
          const userObj = typeof order.user === "object" ? order.user : { _id: order.user };
          partyLedgerName = findMatchingTallyLedger(tallyDebtors, userObj, order);
        } catch (matchErr) {
          console.warn("[Tally Sync] Dynamic customer matching warning:", matchErr.message);
        }

        const xmlPayload = buildTallyPaymentVoucherXML(order, tallyCompany, typeof order.user === "object" ? order.user : { _id: order.user }, partyLedgerName);
        console.log(`[Tally Sync] Syncing Payment Voucher for Order "${order.orderNumber}" to Tally at ${tallyUrl}`);
        
        fetch(tallyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml',
            'ngrok-skip-browser-warning': 'true'
          },
          body: xmlPayload
        }).then(async tallyResponse => {
           if (tallyResponse.ok) {
             const responseText = await tallyResponse.text();
             const parsed = parseTallyResponse(responseText);
             if (parsed.success) {
               console.log(`[Tally Sync] Payment Voucher "${order.orderNumber}" synced successfully to Tally.`);
               await Order.updateOne({ _id: order._id }, { $set: { tallySynced: true, tallyError: null } });
             } else {
               console.error(`[Tally Sync] Tally error syncing Payment Voucher "${order.orderNumber}":`, parsed.error);
             }
           } else {
             console.error(`[Tally Sync] HTTP error syncing Payment Voucher "${order.orderNumber}"`);
           }
        }).catch(err => {
           console.error(`[Tally Sync] Fetch error syncing Payment Voucher:`, err);
        });
      } catch(tallyErr) {
        console.error(`[Tally Sync] Exception during Payment Voucher sync:`, tallyErr);
      }
    }

    // --- DEPARTMENT UPDATES ---
    if ("department" in body && !isVerifyingInvoice) {
      const newDept = await normalizeDept(body.department);
      const oldDept = await normalizeDept(order.department);




      if (newDept !== oldDept) {
        setData.department = newDept;

        // Push to departmentHistory
        const historyEntry = {
          from: oldDept,
          to: newDept,
          updatedBy: (body.changedBy || body.userId) ? new mongoose.Types.ObjectId(body.changedBy || body.userId) : null,
          updatedAt: new Date(),
          notes: body.departmentNotes || body.notes || ""
        };


        if (!update.$push) update.$push = {};
        update.$push.departmentHistory = historyEntry;
      }
    }


    // --- IMPORTANT PAYMENT SANITY CHECKS ---
    // Prevent clients from arbitrarily writing payment.status = 'refunded' or 'refund_pending'
    // unless this request was processed by the above cancel/return flows.
    if ("paymentStatus" in body || (body.payment && typeof body.payment === "object")) {
      const attempted = (body.paymentStatus ?? (body.payment?.status || ""))
        .toString()
        .toLowerCase();

      if (attempted === "refunded" || attempted === "refund_pending") {
        return json({ success: false, error: 'Direct status set to "refunded" or "refund_pending" not allowed.' }, 400);
      }

      // Safe to process payments
      if (body.payment && typeof body.payment === "object") {
        if ("status" in body.payment) {
          setData["payment.status"] = body.payment.status;
          setData["invoice.meta.paymentStatus"] = body.payment.status;

          if (body.payment.status === "paid" || body.payment.status === "partially_paid") {
            setData["payment.paidAt"] = new Date();
            setData["invoice.meta.paidAt"] = new Date();
          }
        }

        if ("method" in body.payment)
          setData["payment.method"] = body.payment.method;

        if ("paidAmount" in body.payment) {
          const paidAmount = Number(body.payment.paidAmount);
          setData["payment.paidAmount"] = paidAmount;

          // If order total available, calculate balance
          const currentOrder = await Order.findById(idParam).lean();
          if (currentOrder && currentOrder.total) {
            const balance = Math.max(0, currentOrder.total - paidAmount);
            setData["payment.balanceAmount"] = balance;

            if (paidAmount >= currentOrder.total) {
              setData["payment.status"] = "paid";
            } else if (paidAmount > 0) {
              setData["payment.status"] = "partially_paid";
            }
          }
        }

        if ("meta" in body.payment) {
          setData["payment.meta"] = {
            ...(body.payment.meta || {})
          };
        }
      }
    }

    if ("paymentMethod" in body) {
      setData["payment.method"] = body.paymentMethod;
      setData["invoice.meta.paymentMethod"] = body.paymentMethod;
    }

    if (body.delivery && typeof body.delivery === "object") {
      if ("status" in body.delivery) {
        setData["delivery.status"] = body.delivery.status;
        setData["invoice.meta.deliveryStatus"] = body.delivery.status;

        if (body.delivery.status === "delivered") {
          const deliveredAt = body.delivery.deliveredAt
            ? new Date(body.delivery.deliveredAt)
            : new Date();
          setData["invoice.meta.deliveredAt"] = deliveredAt;
          setData["delivery.meta"] = {
            ...(body.delivery.meta || {}),
            deliveredAt,
          };
        }
      }
      if ("trackingNumber" in body.delivery)
        setData["delivery.trackingNumber"] = body.delivery.trackingNumber;
      if ("eta" in body.delivery)
        setData["delivery.eta"] = body.delivery.eta
          ? new Date(body.delivery.eta)
          : null;
    }

    if ("cancellationReason" in body) {
      setData.cancellationReason = body.cancellationReason;
      setData["invoice.meta.cancellationReason"] = body.cancellationReason;
    }

    if ("notes" in body && typeof body.notes === "string") {
      setData.notes = body.notes.trim();
      setData["invoice.meta.notes"] = body.notes.trim();
    }

    // Support saving items, subtotal, tax, total, department, departmentNotes, and departmentHistory in fallback path
    if ("items" in body && Array.isArray(body.items)) {
      setData.items = body.items;
    }
    if ("subtotal" in body) {
      setData.subtotal = Number(body.subtotal);
    }
    if ("tax" in body) {
      setData.tax = Number(body.tax);
    }
    if ("shippingCharges" in body) {
      setData.shippingCharges = Number(body.shippingCharges);
    }
    if ("movDeliveryCharge" in body) {
      setData.movDeliveryCharge = Number(body.movDeliveryCharge);
    }
    if ("movApplied" in body) {
      setData.movApplied = Boolean(body.movApplied);
    }
    if ("total" in body) {
      setData.total = Number(body.total);
    }
    if ("department" in body) {
      setData.department = body.department;
    }
    if ("departmentNotes" in body && typeof body.departmentNotes === "string") {
      setData.departmentNotes = body.departmentNotes.trim();
    }
    if ("departmentHistory" in body && Array.isArray(body.departmentHistory)) {
      setData.departmentHistory = body.departmentHistory;
    } else if (body.departmentNotes || body.notes || body.cancellationReason || body.status || "department" in body) {
      const historyEntry = {
        updatedAt: new Date(),
        notes: body.departmentNotes || body.notes || body.cancellationReason || `Status updated to ${body.status || order.status}`,
        updatedBy: body.changedBy || "System"
      };
      update.$push = update.$push || {};
      update.$push.departmentHistory = historyEntry;
    }

    if (Object.keys(setData).length > 0) update.$set = setData;
    if (!update.$set) {
      return json(
        { success: false, error: "No updatable fields in request body" },
        400
      );
    }

    // --- CRITICAL: EXECUTE THE UPDATE ---
    const result = await Order.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(idParam) },
      update
    );

    if (result.matchedCount === 0) {
      return json({ success: false, error: "Order not found" }, 404);
    }

    // 💰 RECORD TRANSACTION FOR DOORSTEP COLLECTION
    if (body.payment?.paidAmount && Number(body.payment.paidAmount) > 0) {
      try {
        const Transaction = (await import("@/lib/db/models/transaction")).default;
        const Wallet = (await import("@/lib/db/models/wallet")).default;

        const orderDoc = await Order.findById(idParam).lean();
        if (orderDoc) {
          const cash = Number(body.payment.meta?.cash || 0);
          const online = Number(body.payment.meta?.online || 0);
          const totalCollected = cash + online || Number(body.payment.paidAmount);

          const tx = new Transaction({
            userId: orderDoc.user,
            amount: totalCollected,
            type: "order_payment",
            method: cash > 0 && online > 0 ? "mixed" : (cash > 0 ? "cash" : "online"),
            status: "completed",
            description: `Payment for Order ${orderDoc.orderNumber} collected at delivery`,
            metadata: {
              orderId: orderDoc._id,
              orderNumber: orderDoc.orderNumber,
              cashAmount: cash,
              onlineAmount: online,
              collectedBy: body.payment.meta?.capturedVia || "Delivery Partner"
            }
          });
          await tx.save();
          console.log(`[TRANSACTION] Recorded ₹${totalCollected} collection for Order ${orderDoc.orderNumber}`);
        }
      } catch (txErr) {
        console.error("[TRANSACTION ERROR] Failed to record doorstep collection:", txErr);
      }
    }

    // 🔥 THE MARKETPLACE SETTLEMENT ENGINE: Settle for EVERY Supplier in the order
    const finalState = await Order.findById(idParam).lean();
    if (!finalState) return json({ success: false, error: "Order lost" }, 404);

    // --- TALLY INTEGRATION FOR ART APPROVAL ---
    // Trigger Tally sync only when ART approves the order (status transitions to "Packaging")
    // and only if it hasn't been successfully synced already.
    const normalizedStatus = (body.status || "").toLowerCase();
    const combinedNotes = `${body.departmentNotes || ""} ${body.notes || ""}`;
    const isArtApproval = combinedNotes.includes("Order moved to SCM for Packaging") ||
      combinedNotes.includes("Order approved by ART") ||
      combinedNotes.includes("moved to SCM for Packaging") ||
      combinedNotes.includes("approved by ART");

    console.log(`[Tally Sync - Condition Check] status="${body.status}", normalizedStatus="${normalizedStatus}", isArtApproval=${isArtApproval}, tallySynced=${finalState.tallySynced}, departmentNotes="${(body.departmentNotes || "").substring(0, 100)}", notes="${(body.notes || "").substring(0, 100)}"`);

    if (normalizedStatus === "packaging" && isArtApproval && finalState.tallySynced !== true) {
      try {
        const tallyUrl = process.env.TALLY_URL || 'https://yummy-freebee-circular.ngrok-free.dev';
        const tallyCompany = process.env.TALLY_SALES_COMPANY || 'Unifoods';

        const CustomerModel = (await import("@/lib/db/models/customer")).default;
        const identifiedUser = await CustomerModel.findById(finalState.user).lean();

        let partyLedgerName = null;
        if (identifiedUser) {
          try {
            const tallyDebtors = await fetchTallyDebtors(tallyUrl, tallyCompany, identifiedUser?.customerGroup);
            partyLedgerName = findMatchingTallyLedger(tallyDebtors, identifiedUser, finalState);
            console.log(`[Tally Sync] Resolved Customer party ledger: "${partyLedgerName}"`);
          } catch (matchErr) {
            console.warn("[Tally Sync] Dynamic customer matching warning:", matchErr.message);
          }
        }

        const productIds = finalState.items.map(it => it.product?._id || it.product);
        const productDocs = await Product.find({ _id: { $in: productIds } }).lean();
        const productMap = {};
        productDocs.forEach(p => { productMap[p._id.toString()] = p; });

        const xmlPayload = buildTallySalesVoucherXML(finalState, productMap, tallyCompany, identifiedUser || {}, partyLedgerName);
        console.log(`[Tally Sync - ART] Syncing Sales Voucher for Order "${finalState.orderNumber}" to Tally`);
        
        const tallyResponse = await fetch(tallyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml',
            'ngrok-skip-browser-warning': 'true'
          },
          body: xmlPayload
        });

        if (tallyResponse.ok) {
          const responseText = await tallyResponse.text();
          const parsed = parseTallyResponse(responseText);
          if (parsed.success) {
            console.log(`[Tally Sync - ART] Sales Voucher "${finalState.orderNumber}" synced successfully to Tally.`);
            await Order.updateOne({ _id: finalState._id }, { $set: { tallySynced: true, tallyError: null } });
            finalState.tallySynced = true; // update memory state
          } else {
            console.error(`[Tally Sync - ART] Tally error:`, parsed.error);
            await Order.updateOne({ _id: finalState._id }, { $set: { tallySynced: false, tallyError: parsed.error } });
          }
        } else {
          const tallyError = `Tally server responded with status ${tallyResponse.status}`;
          console.error(`[Tally Sync - ART] HTTP error:`, tallyError);
          await Order.updateOne({ _id: finalState._id }, { $set: { tallySynced: false, tallyError } });
        }
      } catch (tallyErr) {
        console.error(`[Tally Sync - ART] Exception:`, tallyErr.message);
        try {
          await Order.updateOne({ _id: finalState._id }, { $set: { tallySynced: false, tallyError: tallyErr.message } });
        } catch (dbErr) {
          console.error("[Tally Sync - ART] Failed to update Tally error:", dbErr);
        }
      }
    }

    const isDelivered = (finalState.status || "").toLowerCase() === "delivered" || (finalState.delivery?.status || "").toLowerCase() === "delivered";
    const isPaid = (finalState.payment?.status || "").toLowerCase() === "paid";

    console.log(`[PATCH SETTLEMENT] Flow: Update Trigger | Del: ${isDelivered} | Paid: ${isPaid}`);

    await logger({
      level: 'info',
      message: `Order updated successfully: ${finalState._id}`,
      action: 'ORDER_UPDATED',
      userId: body.userId || body.changedBy || null,
      metadata: {
        orderId: finalState._id,
        orderNumber: finalState.orderNumber,
        updates: setData,
        newStatus: finalState.status,
        newDepartment: finalState.department
      },
      req: request
    });

    if (isDelivered && isPaid) {
      try {
        const Wallet = (await import("@/lib/db/models/wallet")).default;
        const Transaction = (await import("@/lib/db/models/transaction")).default;

        // 🟢 IDENTIFY UNIQUE SUPPLIERS
        const suppliers = new Set();
        if (finalState.supplier) suppliers.add(finalState.supplier.toString());
        (finalState.items || []).forEach(item => {
          if (item.supplier) suppliers.add(item.supplier.toString());
        });
        console.log(`[PATCH SETTLEMENT] Marketplace Suppliers in Order: ${[...suppliers].join(', ')}`);

        for (const sId of suppliers) {
          const supplierId = new mongoose.Types.ObjectId(sId);

          let wallet = await Wallet.findOne({ userId: supplierId });
          if (!wallet) {
            wallet = new Wallet({ userId: supplierId, balance: 0, userType: 'supplier' });
          }

          // 1) Settle items belonging to this specific supplier
          const supplierTotal = (finalState.items || [])
            .filter(item => item.supplier?.toString() === sId)
            .reduce((sum, item) => sum + (item.totalPrice || 0), 0);

          if (supplierTotal > 0) {
            const existingTx = await Transaction.findOne({
              "metadata.orderId": finalState._id,
              userId: supplierId,
              type: "order_settlement"
            });

            if (!existingTx) {
              console.log(`[PATCH SETTLEMENT] AWARDING ₹${supplierTotal} to Vendor ${sId}`);
              const settlementTx = new Transaction({
                userId: supplierId,
                walletId: wallet._id,
                amount: supplierTotal,
                type: "order_settlement",
                method: "wallet",
                status: "completed",
                description: `Settlement for Order Items: ${finalState.orderNumber}`,
                metadata: { orderId: finalState._id, orderNumber: finalState.orderNumber }
              });
              await settlementTx.save();
            } else {
              console.log(`[PATCH SETTLEMENT] Vendor ${sId} already credited. Skipping.`);
            }
          }

          // 2) Force Live Sync for this supplier (Marketplace Aware)
          const metrics = await Order.aggregate([
            {
              $match: {
                $or: [
                  { supplier: supplierId },
                  { "items.supplier": supplierId }
                ]
              }
            },
            { $unwind: "$items" },
            {
              $group: {
                _id: null,
                realized: { $sum: { $cond: [{ $and: [{ $eq: ["$items.supplier", supplierId] }, { $eq: ["$status", "delivered"] }, { $eq: ["$payment.status", "paid"] }] }, "$items.totalPrice", 0] } },
                escrowed: { $sum: { $cond: [{ $and: [{ $eq: ["$items.supplier", supplierId] }, { $in: ["$status", ["pending", "confirmed", "packed", "shipped", "out_for_delivery"]] }] }, "$items.totalPrice", 0] } }
              }
            }
          ]);

          const snap = metrics[0] || { realized: 0, escrowed: 0 };

          const ledgerTruth = await Transaction.aggregate([
            { $match: { userId: supplierId, status: 'completed' } },
            {
              $group: {
                _id: null,
                balance: {
                  $sum: {
                    $cond: [
                      { $in: ["$type", ["deposit", "refund", "transfer", "order_settlement", "adjustment"]] },
                      { $abs: "$amount" },
                      { $multiply: [{ $abs: "$amount" }, -1] } // Always subtract debits
                    ]
                  }
                }
              }
            }
          ]);

          wallet.balance = ledgerTruth[0]?.balance || 0;
          wallet.realizedSavings = snap.realized;
          wallet.escrowedPoints = snap.escrowed;
          await wallet.save();
          console.log(`[PATCH SETTLEMENT] SYNC COMPLETE for Vendor ${sId} | Balance: ₹${wallet.balance} | Escrow: ₹${wallet.escrowedPoints}`);
        }
      } catch (e) {
        console.error("[PATCH SETTLEMENT] Marketplace Loop Failure:", e);
      }
    }

    // --- FINAL RESPONSE ---
    try {
      const finalStatePopulated = await Order.findById(idParam)
        .populate("department", "departmentName")
        .populate("departmentHistory.from", "departmentName")
        .populate("departmentHistory.to", "departmentName")
        .lean();

      return json({
        success: true,
        message: "Order updated and settlement processed",
        data: finalStatePopulated || finalState,
        tallySynced: (finalStatePopulated || finalState)?.tallySynced || false,
        tallyError: (finalStatePopulated || finalState)?.tallyError || null
      });
    } catch (finalErr) {
      console.error("[PATCH] Final population error:", finalErr);
      return json({ success: true, message: "Order updated but response population failed", data: finalState });
    }

  } catch (err) {
    console.error("PATCH /api/order overall error:", err);
    return json({ success: false, error: err.message || "Server error" }, 500);
  }
}

export async function DELETE(request) {
  try {
    await dbConnect();
    const url = new URL(request.url);
    const idParam = url.searchParams.get("id") || url.searchParams.get("orderId");
    if (!idParam || !mongoose.Types.ObjectId.isValid(idParam)) {
      return json({ success: false, error: "Invalid orderId" }, 400);
    }
    const order = await Order.findByIdAndDelete(idParam);
    if (!order) return json({ success: false, error: "Order not found" }, 404);
    return json({ success: true, message: "Order deleted successfully" }, 200);
  } catch (err) {
    console.error("DELETE /api/order error:", err);
    return json({ success: false, error: err.message || "Server error" }, 500);
  }
}

