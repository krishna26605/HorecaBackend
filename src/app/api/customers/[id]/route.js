import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/db/connect";
import Customer from "@/lib/db/models/customer";
import CustomerProductMapping from "@/lib/db/models/customerProductMapping";

/**
 * PATCH /api/customers/[id]
 * Update customer details: isVerified, category.
 */
export async function PATCH(req, { params }) {
  try {
    await dbConnect();
    const resolvedParams = await params;
    const { id } = resolvedParams;
    const body = await req.json();

    const { mappedProducts, ...customerUpdates } = body;

    const allowedUpdates = ["isVerified", "category", "customerGroup", "customerType", "department", "hasMultipleOutlets", "outlets", "locations", "poMandatory", "isContractBased", "contract", "address", "city", "state", "pincode", "name", "phone", "email", "businessName", "gstNumber", "gstEffectiveDate", "gstDocUrl", "panNumber", "licenseImage", "creditTerm", "creditLimit", "urcDocUrl", "hasFssai", "fssaiNumber", "fssaiExpiryDate", "fssaiDocUrl", "fssaiUndertakingDocUrl", "licenseExpiryDate", "assignedRoute", "routeName", "routeCode", "advanceBalance", "advancePaymentMode", "advancePaymentProofUrl", "departmentContacts", "vehicleRequired", "shipperDryIce", "source"];
    const updates = {};

    Object.keys(customerUpdates).forEach((key) => {
      if (allowedUpdates.includes(key)) {
        updates[key] = customerUpdates[key];
      }
    });

    if (Object.keys(updates).length === 0 && mappedProducts === undefined) {
      return NextResponse.json(
        { success: false, error: "No valid update fields provided" },
        { status: 400 }
      );
    }

    if (mappedProducts !== undefined) {
      let currentCategory = updates.category;
      if (!currentCategory) {
        const existingCustomer = await Customer.findById(id).lean();
        if (!existingCustomer) {
          return NextResponse.json({ success: false, error: "Customer not found" }, { status: 404 });
        }
        currentCategory = existingCustomer.category || "C";
      }

      if (currentCategory === "C") {
        await CustomerProductMapping.findOneAndUpdate(
          { customer: id },
          { products: mappedProducts },
          { upsert: true, new: true }
        );
      } else {
        await CustomerProductMapping.findOneAndDelete({ customer: id });
      }
    }

    let customer;
    if (Object.keys(updates).length > 0) {
      customer = await Customer.findByIdAndUpdate(id, updates, {
        new: true,
        runValidators: true,
      }).lean();

      if (!customer) {
        return NextResponse.json(
          { success: false, error: "Customer not found" },
          { status: 404 }
        );
      }
    } else {
      customer = await Customer.findById(id).lean();
    }

    const mapping = await CustomerProductMapping.findOne({ customer: id }).lean();
    customer.mappedProducts = mapping ? (mapping.products || []) : [];

    return NextResponse.json({
      success: true,
      data: customer,
    });
  } catch (err) {
    console.error(`🔥 ERROR in PATCH /api/customers/${params.id}:`, err);
    return NextResponse.json(
      { success: false, error: err.message || "Server Error" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/customers/[id]
 */
export async function GET(req, { params }) {
  try {
    await dbConnect();
    const resolvedParams = await params;
    const { id } = resolvedParams;
    console.log(`🔎 [BACKEND] GET /api/customers/${id} - Searching for customer...`);

    const customer = await Customer.findById(id).lean();
    console.log(`📦 [BACKEND] Customer found:`, customer ? "YES" : "NO");

    if (!customer) {
      const dbName = mongoose.connection.db?.databaseName || "UNKNOWN";
      const registeredModels = mongoose.modelNames();
      console.error(`[CUSTOMER ERROR] Customer not found for ID: ${id} | DB: ${dbName} | Models: ${registeredModels.join(', ')}`);

      return NextResponse.json(
        {
          success: false,
          error: "Customer not found",
          debugId: id,
          debugDb: dbName
        },
        { status: 404 }
      );
    }

    const mapping = await CustomerProductMapping.findOne({ customer: id }).lean();
    customer.mappedProducts = mapping ? (mapping.products || []) : [];

    // Ensure customer.cnBalance is initialized if it's undefined or null
    if (typeof customer.cnBalance !== 'number') {
      try {
        const CustomerCreditNote = (await import("@/lib/db/models/art/CustomerCreditNote")).default || (await import("@/lib/db/models/art/CustomerCreditNote"));
        const Order = (await import("@/lib/db/models/order")).default || (await import("@/lib/db/models/order"));
        
        const custCNs = await CustomerCreditNote.find({ customer: id });
        const totalCnSum = custCNs.reduce((sum, cn) => sum + Number(cn.amount || 0), 0);

        const cnOrders = await Order.find({ 
          $or: [{ user: id }, { customer: id }], 
          "payment.method": { $in: ["cn", "credit_note"] },
          status: { $ne: "cancelled" }
        });
        const totalUsedCN = cnOrders.reduce((sum, ord) => sum + Number(ord.total || 0), 0);

        const netCnBalance = Math.max(0, totalCnSum - totalUsedCN);
        customer.cnBalance = netCnBalance;
        await Customer.findByIdAndUpdate(id, { $set: { cnBalance: netCnBalance } });
      } catch (reconcileErr) {
        console.error("Failed to initialize cnBalance in customer profile GET:", reconcileErr);
      }
    }

    return NextResponse.json({
      success: true,
      data: customer,
    });
  } catch (err) {
    console.error(`🔥 ERROR in GET /api/customers/id:`, err);
    return NextResponse.json(
      { success: false, error: err.message || "Server Error" },
      { status: 500 }
    );
  }
}
