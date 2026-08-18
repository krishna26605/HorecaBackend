import { NextResponse } from "next/server";
import dbConnect from "@/lib/db/connect";
import PurchaseOrder from "@/lib/db/models/inventory/PurchaseOrder";
import Product from "@/lib/db/models/product";
import { logger } from "@/lib/logger";
const TALLY_CONFIG = {
  company: process.env.TALLY_SALES_COMPANY || 'Unifoods'
};

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

// Helper to format Date as YYYYMMDD
const formatTallyDate = (dateVal) => {
  const d = dateVal ? new Date(dateVal) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  let dd = String(d.getDate()).padStart(2, '0');

  // Normalization for Tally Educational Mode in Dev/Testing (e.g. ngrok or localhost URLs, or custom env flag)
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

// Function to construct the Tally Voucher XML
// Function to construct the Tally Voucher XML
async function buildTallyPOVoucherXML(po, productMap) {
  const dateStr = formatTallyDate(po.createdAt || new Date());
  const supplierName = escapeXML(po.supplier?.name || "Unknown Vendor");
  const poNumber = escapeXML(po.poNumber);
  const mongoId = escapeXML(po._id.toString());

  // Resolve active godown name dynamically from database
  let godownName = "Main Location";
  try {
    const WarehouseLocation = mongoose.models.WarehouseLocation || (await import("@/lib/db/models/warehouse/WarehouseLocation")).default;
    const activeWarehouse = await WarehouseLocation.findOne({ type: "WAREHOUSE", status: "active" }).lean();
    if (activeWarehouse) {
      godownName = activeWarehouse.name;
    }
  } catch (e) {
    console.warn("Failed to fetch active godown:", e);
  }

  let computedTotal = 0;

  const itemsXml = po.items.map(item => {
    const itemName = escapeXML(item.productName);
    const qty = parseFloat(item.quantity) || parseFloat(item.orderedQty) || 0;
    const unitPrice = parseFloat(item.unitPrice) || 0;
    const itemTotal = qty * unitPrice;
    computedTotal += itemTotal;

    // Resolve unit from database Product document
    const productDoc = productMap[item.productId];
    const tallyUnit = escapeXML(mapMongooseUnitToTally(productDoc?.unit || 'pcs'));

    const qtyStr = `${qty} ${tallyUnit}`;
    const rateStr = `${unitPrice}/${tallyUnit}`;
    // const amountStr = (-itemTotal).toFixed(2);
    const amountStr = itemTotal.toFixed(2);


    return `<ALLINVENTORYENTRIES.LIST>
       <STOCKITEMNAME>${itemName}</STOCKITEMNAME>
       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
       <RATE>${rateStr}</RATE>
       <AMOUNT>${amountStr}</AMOUNT>
       <ACTUALQTY>${qtyStr}</ACTUALQTY>
       <BILLEDQTY>${qtyStr}</BILLEDQTY>

      <BATCHALLOCATIONS.LIST>
        <GODOWNNAME>${escapeXML(godownName)}</GODOWNNAME>
        <BATCHNAME>Batch1</BATCHNAME>
        <AMOUNT>${amountStr}</AMOUNT>
        <ACTUALQTY>${qtyStr}</ACTUALQTY>
        <BILLEDQTY>${qtyStr}</BILLEDQTY>
      </BATCHALLOCATIONS.LIST>

      </ALLINVENTORYENTRIES.LIST>`;
  }).join("\n");


  const totalAmountStr = computedTotal.toFixed(2);

  return `<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Vouchers</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${TALLY_CONFIG.company}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="Purchase Order" ACTION="Create" OBJVIEW="Inventory Voucher View">
      <DATE>${dateStr}</DATE>
      <VCHSTATUSDATE>${dateStr}</VCHSTATUSDATE>
      <EFFECTIVEDATE>${dateStr}</EFFECTIVEDATE>
      <VOUCHERTYPENAME>Purchase Order</VOUCHERTYPENAME>
      <VOUCHERNUMBER>${poNumber}</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${supplierName}</PARTYLEDGERNAME>
      <PARTYNAME>${supplierName}</PARTYNAME>
      <PERSISTEDVIEW>Inventory Voucher View</PERSISTEDVIEW>
      <DIFFACTUALQTY>Yes</DIFFACTUALQTY>

      ${itemsXml}
     </VOUCHER>
    </TALLYMESSAGE>
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;


}

// GET - List purchase orders
export async function GET(request) {
  try {
    await dbConnect();

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const supplier = searchParams.get("supplier");
    const search = searchParams.get("search");

    let query = {};
    if (status && status !== "All") query.status = status;
    if (supplier) query["supplier.name"] = { $regex: supplier, $options: "i" };
    if (search) {
      query.$or = [
        { poNumber: { $regex: search, $options: "i" } },
        { "supplier.name": { $regex: search, $options: "i" } },
        { "items.productName": { $regex: search, $options: "i" } },
      ];
    }

    const orders = await PurchaseOrder.find(query)
      .sort({ createdAt: -1 })
      .lean();

    const allOrders = await PurchaseOrder.find({}).lean();
    const stats = {
      total: allOrders.length,
      draft: allOrders.filter((o) => o.status === "Draft").length,
      sent: allOrders.filter((o) => o.status === "Sent").length,
      partiallyReceived: allOrders.filter(
        (o) => o.status === "Partially Received"
      ).length,
      completed: allOrders.filter((o) => o.status === "Completed").length,
      totalValue: allOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0),
    };

    await logger({
      action: "read",
      message: `Fetched purchase orders (count: ${orders.length})`,
      metadata: { entity: "PurchaseOrder", count: orders.length },
      req: request,
    });

    return NextResponse.json({
      success: true,
      data: orders,
      stats,
      count: orders.length,
    });
  } catch (error) {
    console.error("Error in PO GET:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch POs" },
      { status: 500 }
    );
  }
}

// POST - Create a new purchase order
export async function POST(request) {
  try {
    await dbConnect();
    const body = await request.json();

    const po = new PurchaseOrder(body);
    await po.save();

    // Fetch products to map UOMs
    let productMap = {};
    try {
      const productIds = po.items.map(item => item.productId).filter(Boolean);
      const products = await Product.find({ _id: { $in: productIds } }).lean();
      products.forEach(p => {
        productMap[p._id.toString()] = p;
      });
    } catch (err) {
      console.error("Error fetching product UOMs for Tally PO sync:", err);
    }

    // Sync to Tally Prime 9 (after PO is saved so poNumber is populated)
    let tallySynced = false;
    let tallyError = null;

    try {
      const tallyUrl = process.env.TALLY_URL || 'https://yummy-freebee-circular.ngrok-free.dev';
      const xmlPayload = await buildTallyPOVoucherXML(po, productMap);


      console.log(`[Tally Sync] Syncing PO "${po.poNumber}" to Tally at ${tallyUrl}`);
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
          tallySynced = true;
          console.log(`[Tally Sync] PO "${po.poNumber}" synced successfully to Tally.`);
        } else {
          tallyError = parsed.error;
          console.error(`[Tally Sync] Tally error syncing PO "${po.poNumber}":`, tallyError);
        }
      } else {
        tallyError = `Tally server responded with status ${tallyResponse.status}`;
        console.error(`[Tally Sync] HTTP error syncing PO "${po.poNumber}":`, tallyError);
      }
    } catch (err) {
      tallyError = err.message || String(err);
      console.error(`[Tally Sync] Exception syncing PO "${po.poNumber}":`, err);
    }

    if (tallySynced || tallyError) {
      await PurchaseOrder.updateOne(
        { _id: po._id },
        { $set: { tallySynced, tallyError } }
      );
      po.tallySynced = tallySynced;
      po.tallyError = tallyError;
    }

    await logger({
      action: "created",
      message: `Created PO: ${po.poNumber} for ${po.supplier?.name}`,
      metadata: {
        entity: "PurchaseOrder",
        entityId: po.poNumber,
        supplier: po.supplier?.name,
        items: po.items.length,
        total: po.totalAmount,
        tallySynced,
        tallyError
      },
      req: request,
    });

    return NextResponse.json({ success: true, data: po, tallySynced, tallyError }, { status: 201 });
  } catch (error) {
    console.error("Error in PO POST:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to create PO" },
      { status: 500 }
    );
  }
}

// PATCH - Update PO status
export async function PATCH(request) {
  try {
    await dbConnect();
    const body = await request.json();

    if (!body.poId) {
      return NextResponse.json(
        { success: false, error: "poId is required" },
        { status: 400 }
      );
    }

    const update = {};
    if (body.status) update.status = body.status;
    if (body.notes) update.notes = body.notes;

    const updated = await PurchaseOrder.findByIdAndUpdate(
      body.poId,
      { $set: update },
      { new: true }
    );

    await logger({
      action: "updated",
      message: `Updated PO ${updated?.poNumber} status to ${body.status}`,
      metadata: { entity: "PurchaseOrder", entityId: updated?.poNumber },
      req: request,
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    console.error("Error in PO PATCH:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to update PO" },
      { status: 500 }
    );
  }
}
