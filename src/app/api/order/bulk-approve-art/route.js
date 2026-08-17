import { NextResponse } from 'next/server';
import dbConnect from '@/lib/db/connect';
import Order from '@/lib/db/models/order';
import Department from '@/lib/db/models/Department';
import mongoose from 'mongoose';

export async function POST(request) {
  try {
    await dbConnect();
    
    // Find ART department
    const artDept = await Department.findOne({ departmentName: { $regex: new RegExp('^ART$', 'i') } }).lean();
    // Find SCM department
    const scmDept = await Department.findOne({ departmentName: { $regex: new RegExp('^SCM$', 'i') } }).lean();

    if (!artDept || !scmDept) {
      return NextResponse.json({ success: false, error: 'ART or SCM department not found in database' }, { status: 400 });
    }

    const artId = new mongoose.Types.ObjectId(artDept._id);
    const scmId = new mongoose.Types.ObjectId(scmDept._id);

    // Parse request body for optional changedBy userId
    let changedBy = 'System (Bulk ART Transfer)';
    try {
      const body = await request.json();
      if (body.changedBy) changedBy = body.changedBy;
    } catch (e) {
      // Body is optional
    }

    // Find all orders currently in ART department
    // Note: status might be 'verified' or similar when arriving at ART
    // We fetch them first to append to their departmentHistory properly.
    const orders = await Order.find({ department: artId, status: { $nin: ['Cancelled', 'failed', 'returned', 'Delivered', 'delivered'] } });
    
    if (orders.length === 0) {
      return NextResponse.json({ success: true, message: 'No pending orders in ART to transfer', count: 0 });
    }

    const historyEntry = {
      from: artId,
      to: scmId,
      updatedAt: new Date(),
      notes: 'Bulk approved by ART, moved to SCM for Packaging',
      updatedBy: changedBy
    };

    // Perform bulk update
    const updateResult = await Order.updateMany(
      { department: artId, status: { $nin: ['Cancelled', 'failed', 'returned', 'Delivered', 'delivered'] } },
      { 
        $set: { department: scmId, status: 'Packaging' },
        $push: { departmentHistory: historyEntry }
      }
    );

    // --- TALLY INTEGRATION FOR ART BULK APPROVAL ---
    // Convert Optional vouchers to Regular for ODT orders
    try {
      const tallyUrl = process.env.TALLY_URL;
      const tallyCompany = process.env.TALLY_SALES_COMPANY || 'Unifoods';
      
      if (tallyUrl) {
        const { buildTallySalesVoucherXML, fetchTallyDebtors, findMatchingTallyLedger, parseTallyResponse } = await import("@/lib/tallyHelpers");
        const Product = (await import("@/lib/db/models/product")).default;
        const CustomerModel = (await import("@/lib/db/models/customer")).default;

        // Fetch ODT orders that were just approved
        const odtOrdersToSync = orders.filter(o => o.orderSource === 'ODT' && (o.tallySynced === true || o.tallySynced === false));
        
        if (odtOrdersToSync.length > 0) {
          console.log(`[Tally Sync - Bulk ART] Found ${odtOrdersToSync.length} ODT orders to accept.`);
          
          for (const finalState of odtOrdersToSync) {
            try {
              const identifiedUser = await CustomerModel.findById(finalState.user).lean();
              
              let partyLedgerName = null;
              if (identifiedUser) {
                try {
                  const tallyDebtors = await fetchTallyDebtors(tallyUrl, tallyCompany, identifiedUser?.customerGroup);
                  partyLedgerName = findMatchingTallyLedger(tallyDebtors, identifiedUser, finalState);
                } catch (matchErr) {
                  console.warn("[Tally Sync] Dynamic customer matching warning:", matchErr.message);
                }
              }

              const productIds = (finalState.items || []).map(it => it.product?._id || it.product);
              const productDocs = await Product.find({ _id: { $in: productIds } }).lean();
              const productMap = {};
              productDocs.forEach(p => { productMap[p._id.toString()] = p; });

              // Alter voucher to make it Regular (isOptional: false)
              const isAlter = finalState.tallySynced === true; // Usually true, if it failed initially, we still try to Alter or Create? Tally allows Alter with REMOTEID even if not present, but actually if not synced we can just pass isAlter: false
              
              const xmlPayload = buildTallySalesVoucherXML(finalState, productMap, tallyCompany, identifiedUser || {}, partyLedgerName, {
                isOptional: false,
                isAlter: isAlter,
                remoteId: finalState._id.toString()
              });
              
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
                  console.log(`[Tally Sync - Bulk ART] Sales Voucher "${finalState.orderNumber}" synced successfully to Tally.`);
                  await Order.updateOne({ _id: finalState._id }, { $set: { tallySynced: true, tallyError: null } });
                } else {
                  console.error(`[Tally Sync - Bulk ART] Tally error:`, parsed.error);
                  await Order.updateOne({ _id: finalState._id }, { $set: { tallySynced: false, tallyError: parsed.error } });
                }
              } else {
                const tallyError = `Tally server responded with status ${tallyResponse.status}`;
                console.error(`[Tally Sync - Bulk ART] HTTP error:`, tallyError);
                await Order.updateOne({ _id: finalState._id }, { $set: { tallySynced: false, tallyError } });
              }
            } catch (err) {
              console.error(`[Tally Sync - Bulk ART] Failed for order ${finalState.orderNumber}:`, err);
            }
          }
        }
      }
    } catch (tallyErr) {
      console.error("[Tally Sync - Bulk ART] Overall sync error:", tallyErr);
    }

    return NextResponse.json({ 
      success: true, 
      message: `Successfully transferred ${updateResult.modifiedCount} orders to SCM`,
      count: updateResult.modifiedCount
    });

  } catch (error) {
    console.error('Bulk ART to SCM transfer error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}