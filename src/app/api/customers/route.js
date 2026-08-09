import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/db/connect";
import Customer from "@/lib/db/models/customer";
import Product from "@/lib/db/models/product";
import CustomerProductMapping from "@/lib/db/models/customerProductMapping";
import Order from "@/lib/db/models/order";
import VendorOrder from "@/lib/db/models/VendorOrder";

/**
 * GET /api/customers
 * Fetch all customers with vendor mapping, searching, and pagination.
 */
export async function GET(req) {
  try {
    await dbConnect();

    const url = new URL(req.url);
    const searchParams = url.searchParams;

    const andConditions = [];

    // ── Search Filters ──────────────────────────────────────────
    const phone = searchParams.get("phone");
    const name = searchParams.get("name");
    const email = searchParams.get("email");
    const search = searchParams.get("search");
    const isVerified = searchParams.get("isVerified");
    const category = searchParams.get("category");
    const supplierId = searchParams.get("supplierId");

    // ── Vendor / Supplier Mapping Filter ────────────────────────
    if (supplierId) {
      const sIdStr = supplierId.toString().trim();
      const sObjectId = mongoose.Types.ObjectId.isValid(sIdStr) ? new mongoose.Types.ObjectId(sIdStr) : null;

      const candidateCustomerIds = new Set();

      // 1. Direct match on Customer documents
      const directOr = [
        { supplierId: sIdStr },
        { supplier: sIdStr },
        { assignedSupplier: sIdStr },
        { assignedVendor: sIdStr },
        { address: { $regex: `\\[SUPPLIER_ID:${sIdStr}\\]`, $options: "i" } },
        { "locations.address": { $regex: `\\[SUPPLIER_ID:${sIdStr}\\]`, $options: "i" } }
      ];
      if (sObjectId) {
        directOr.push(
          { supplierId: sObjectId },
          { supplier: sObjectId },
          { assignedSupplier: sObjectId },
          { assignedVendor: sObjectId }
        );
      }

      try {
        const directCustomers = await Customer.find({ $or: directOr }, { _id: 1 }).lean();
        directCustomers.forEach((c) => candidateCustomerIds.add(c._id.toString()));
      } catch (dErr) {
        console.warn("Direct customer query notice:", dErr.message);
      }

      // 2. Customers who have placed Orders with this supplier
      const orderSupplierOr = [
        { supplier: sIdStr },
        { supplierId: sIdStr },
        { vendor: sIdStr },
        { vendorId: sIdStr }
      ];
      if (sObjectId) {
        orderSupplierOr.push(
          { supplier: sObjectId },
          { supplierId: sObjectId },
          { vendor: sObjectId },
          { vendorId: sObjectId }
        );
      }

      try {
        const orders = await Order.find({ $or: orderSupplierOr }, { customer: 1, user: 1 }).lean();
        orders.forEach((o) => {
          const cId = o.customer || o.user;
          if (cId) candidateCustomerIds.add(cId.toString());
        });
      } catch (oErr) {
        console.warn("Order find error in customer mapping:", oErr.message);
      }

      // 3. Customers in VendorOrders
      try {
        const vendorOrders = await VendorOrder.find({ $or: orderSupplierOr }, { customer: 1, user: 1 }).lean();
        vendorOrders.forEach((vo) => {
          const cId = vo.customer || vo.user;
          if (cId) candidateCustomerIds.add(cId.toString());
        });
      } catch (voErr) {
        // VendorOrder fallback
      }

      // 4. Customers mapped to this supplier's products in CustomerProductMapping
      try {
        const prodQuery = sObjectId
          ? { $or: [{ supplierId: sObjectId }, { supplierId: sIdStr }, { supplier: sObjectId }, { supplier: sIdStr }] }
          : { $or: [{ supplierId: sIdStr }, { supplier: sIdStr }] };
        const supplierProducts = await Product.find(prodQuery, { _id: 1 }).lean();
        const prodIds = supplierProducts.map((p) => p._id);

        if (prodIds.length > 0) {
          const mappings = await CustomerProductMapping.find({
            products: { $elemMatch: { $in: prodIds } }
          }, { customer: 1 }).lean();
          mappings.forEach((m) => {
            if (m.customer) candidateCustomerIds.add(m.customer.toString());
          });
        }
      } catch (mapErr) {
        console.warn("Customer product mapping error:", mapErr.message);
      }

      // 5. Check customervendormappings collection if exists
      try {
        if (mongoose.connection?.db) {
          const cvmCollection = mongoose.connection.db.collection("customervendormappings");
          const cvmOr = [{ vendorId: sIdStr }, { vendor: sIdStr }, { supplierId: sIdStr }, { supplier: sIdStr }];
          if (sObjectId) {
            cvmOr.push({ vendorId: sObjectId }, { vendor: sObjectId }, { supplierId: sObjectId }, { supplier: sObjectId });
          }
          const cvmMappings = await cvmCollection.find({ $or: cvmOr }).toArray();
          cvmMappings.forEach((m) => {
            const cId = m.customerId || m.customer;
            if (cId) candidateCustomerIds.add(cId.toString());
          });
        }
      } catch (cvmErr) {
        // Optional collection
      }

      const validObjectIds = [];
      const validStrIds = [];
      candidateCustomerIds.forEach((id) => {
        validStrIds.push(id);
        if (mongoose.Types.ObjectId.isValid(id)) {
          validObjectIds.push(new mongoose.Types.ObjectId(id));
        }
      });

      const supplierOrConditions = [...directOr];
      if (validObjectIds.length > 0) {
        supplierOrConditions.push({ _id: { $in: validObjectIds } });
      }
      if (validStrIds.length > 0) {
        supplierOrConditions.push({ _id: { $in: validStrIds } });
      }

      // Strictly restrict query to only customers belonging to this vendor
      andConditions.push({ $or: supplierOrConditions });
    }

    if (phone) {
      const numeric = phone.replace(/\D/g, "");
      andConditions.push({ phone: { $regex: numeric, $options: "i" } });
    }

    const searchStr = name || search;
    if (searchStr) {
      andConditions.push({
        $or: [
          { name: { $regex: searchStr, $options: "i" } },
          { businessName: { $regex: searchStr, $options: "i" } },
          { email: { $regex: searchStr, $options: "i" } },
          { phone: { $regex: searchStr, $options: "i" } }
        ]
      });
    }

    if (email) {
      andConditions.push({ email: { $regex: email, $options: "i" } });
    }

    if (isVerified !== null && isVerified !== undefined && isVerified !== "" && isVerified !== "all") {
      andConditions.push({ isVerified: isVerified === "true" || isVerified === true });
    }

    if (category && category !== "all") {
      andConditions.push({ category: category.toUpperCase() });
    }

    const query = andConditions.length > 0 ? { $and: andConditions } : {};

    // ── Pagination ──────────────────────────────────────────────
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "100");
    const skip = (page - 1) * limit;

    // ── Fetch Results ───────────────────────────────────────────
    const [customers, total] = await Promise.all([
      Customer.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Customer.countDocuments(query),
    ]);

    return NextResponse.json({
      success: true,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
      },
      data: customers,
    });

  } catch (err) {
    console.error("🔥 ERROR in GET /api/customers:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Server Error" },
      { status: 500 }
    );
  }
}
