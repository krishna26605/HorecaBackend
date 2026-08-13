import mongoose from "mongoose";
import dbConnect from "@/lib/db/connect";
import Order from "@/lib/db/models/order";
import Product from "@/lib/db/models/product";
import Customer from "@/lib/db/models/customer";
import User from "@/lib/db/models/User";
import Department from "@/lib/db/models/Department";
import { 
  buildTallyDeleteVoucherXML, 
  buildTallySalesVoucherXML,
  fetchTallyDebtors,
  findMatchingTallyLedger
} from "@/lib/tallyHelpers";

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function POST(request) {
  try {
    await dbConnect();
    const body = await request.json();
    const { orderIds } = body;

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length < 2) {
      return json({ success: false, error: "Please provide at least two order IDs to merge." }, 400);
    }

    // Fetch all requested orders
    const objectIds = orderIds.map(id => new mongoose.Types.ObjectId(id));
    const orders = await Order.find({ _id: { $in: objectIds } }).sort({ placedAt: 1 });

    if (orders.length !== orderIds.length) {
      return json({ success: false, error: "One or more orders could not be found." }, 404);
    }

    // Check if any order is already cancelled
    if (orders.some(o => ["cancelled", "canceled", "rejected"].includes(o.status?.toLowerCase()))) {
      return json({ success: false, error: "Cannot merge cancelled or rejected orders." }, 400);
    }

    // Designate the first (oldest) order as the master
    const masterOrder = orders[0];
    const subOrders = orders.slice(1);

    // Merge items
    const mergedItemsMap = new Map();

    orders.forEach(o => {
      (o.items || []).forEach(item => {
        const prodId = item.product?.toString() || item.productId?.toString();
        if (!prodId) return;

        if (mergedItemsMap.has(prodId)) {
          const existing = mergedItemsMap.get(prodId);
          existing.quantity += Number(item.quantity || 0);
          existing.totalPrice = existing.quantity * Number(item.unitPrice || item.price || 0);
        } else {
          mergedItemsMap.set(prodId, {
            ...item.toObject ? item.toObject() : item,
            quantity: Number(item.quantity || 0),
            totalPrice: Number(item.quantity || 0) * Number(item.unitPrice || item.price || 0)
          });
        }
      });
    });

    const finalItems = Array.from(mergedItemsMap.values());

    // Recalculate totals
    const subtotal = finalItems.reduce((acc, it) => acc + (it.quantity * (it.unitPrice || it.price || 0)), 0);
    const gstAmount = finalItems.reduce((acc, it) => acc + ((it.quantity * (it.unitPrice || it.price || 0)) * ((it.gst || 0) / 100)), 0);
    const discounts = masterOrder.discounts || 0;
    const grandTotalBeforeMOV = subtotal + gstAmount - discounts;
    
    // MOV Calculation (Using 3500 as standard MOV)
    const MOV_AMOUNT = 3500;
    const MOV_DELIVERY_CHARGE = 250;
    let movDeliveryCharge = 0;
    if (grandTotalBeforeMOV < MOV_AMOUNT && subtotal > 0) {
      movDeliveryCharge = MOV_DELIVERY_CHARGE;
    }
    const grandTotal = grandTotalBeforeMOV + movDeliveryCharge;

    // Build timeline note
    const mergedOrderNumbers = subOrders.map(o => o.orderNumber).join(", ");
    const historyEntry = {
      updatedAt: new Date(),
      notes: `Order merged with: ${mergedOrderNumbers}. Items and quantities were consolidated.`,
    };

    // Update master order
    masterOrder.items = finalItems;
    masterOrder.totalAmount = subtotal;
    masterOrder.subtotal = subtotal;
    masterOrder.gstAmount = gstAmount;
    masterOrder.shippingCharges = movDeliveryCharge;
    masterOrder.total = grandTotal;
    masterOrder.departmentNotes = (masterOrder.departmentNotes || "") + `\nMerged with: ${mergedOrderNumbers}. Status reset to pending for re-approval.`;
    
    // Reset status and department to pending/ODT so the merged order can be approved again
    masterOrder.status = "pending";
    try {
      let odtDept = await Department.findOne({ departmentName: { $regex: /^ODT$/i } }).lean();
      if (!odtDept) odtDept = await Department.findOne({ departmentName: 'ODT' }).lean();
      if (odtDept) {
        masterOrder.department = odtDept._id;
      }
    } catch (deptErr) {
      console.error("Failed to fetch ODT department for merge reset:", deptErr);
    }

    if (!masterOrder.departmentHistory) masterOrder.departmentHistory = [];
    masterOrder.departmentHistory.push(historyEntry);

    // Save master
    await masterOrder.save();

    // Cancel sub-orders
    for (const sub of subOrders) {
      await Order.updateOne(
        { _id: sub._id },
        { 
          $set: { 
            status: "cancelled", 
            cancellationReason: `Merged into order ${masterOrder.orderNumber}`
          }
        }
      );
    }

    // --- Tally Sync (Asynchronous) ---
    (async () => {
      try {
        const tallyUrl = process.env.TALLY_URL;
        const tallyCompany = process.env.TALLY_SALES_COMPANY || 'Unifoods';
        if (!tallyUrl) return;

        // 1. Delete Sub-Orders in Tally
        for (const sub of subOrders) {
          if (sub.tallySynced) {
            const deleteXml = buildTallyDeleteVoucherXML(tallyCompany, sub._id.toString());
            try {
              const delRes = await fetch(tallyUrl, {
                method: "POST",
                headers: { 
                  "Content-Type": "text/xml",
                  "ngrok-skip-browser-warning": "true"
                },
                body: deleteXml,
              });
              const delText = await delRes.text();
              console.log(`[Tally Sync] Merge: Deleted sub-order ${sub.orderNumber}`, delText);
            } catch (e) {
              console.error(`[Tally Sync] Merge: Failed to delete sub-order ${sub.orderNumber} in Tally`, e);
            }
          }
        }

        // 2. Sync Master Order to Tally (Alter if existed, Create if it didn't)
        // Fetch a fresh copy from DB to ensure all merged items are perfectly present
        const freshMaster = await Order.findById(masterOrder._id);
        const productIds = freshMaster.items.map(i => i.product || i.productId).filter(Boolean);
        const products = await Product.find({ _id: { $in: productIds } });
        const productMap = {};
        products.forEach(p => { productMap[p._id.toString()] = p; });

        let userDoc = await Customer.findById(freshMaster.user);
        if (!userDoc) userDoc = await User.findById(freshMaster.user);

        const tallyLedgers = await fetchTallyDebtors(tallyUrl, tallyCompany, "Sundry Debtors");
        const matchedLedger = findMatchingTallyLedger(tallyLedgers, userDoc, freshMaster);

        // During a merge, the master order has definitely been placed on the dashboard.
        // Even if tallySynced flag is false, it's safer to treat it as an Alter to overwrite it
        // since passing ACTION="Create" with a REMOTEID that exists causes Tally to throw an error.
        const isAlter = true;

        const alterXml = buildTallySalesVoucherXML(freshMaster, productMap, tallyCompany, userDoc, matchedLedger, {
          isOptional: true,
          isAlter: isAlter,
          remoteId: freshMaster._id.toString()
        });

        const alterRes = await fetch(tallyUrl, {
          method: "POST",
          headers: { 
            "Content-Type": "text/xml",
            "ngrok-skip-browser-warning": "true" 
          },
          body: alterXml,
        });
        const alterText = await alterRes.text();
        console.log(`[Tally Sync] Merge: Altered master order ${masterOrder.orderNumber}`, alterText);

        if (!masterOrder.tallySynced) {
          await Order.updateOne({ _id: masterOrder._id }, { $set: { tallySynced: true } });
        }
      } catch (err) {
        console.error("[Tally Sync] Merge Sync Error:", err);
      }
    })();

    return json({ 
      success: true, 
      message: "Orders merged successfully.", 
      orderNumber: masterOrder.orderNumber 
    });

  } catch (err) {
    console.error("POST /api/order/merge/execute error:", err);
    return json({ success: false, error: err.message }, 500);
  }
}
