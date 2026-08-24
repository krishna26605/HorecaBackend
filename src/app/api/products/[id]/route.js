import { NextResponse } from "next/server";
import dbConnect from "@/lib/db/connect";
import Product from "@/lib/db/models/product";
import Brand from "@/lib/db/models/brand";
import Branch from "@/lib/db/models/Branch";
import Subscription from "@/lib/db/models/subscription";
import RestockRequest from "@/lib/db/models/RestockRequest";
import Notification from "@/lib/db/models/notification";
import { logger } from "@/lib/logger";

/** Validate ObjectId */
function isValidObjectIdString(id) {
  return typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id);
}

// Helper to map SCM units to mongoose schema enums
const mapUOM = (uom) => {
  if (!uom) return "pcs";
  const normalized = String(uom).trim().toLowerCase();
  switch (normalized) {
    case "kg":
    case "kilogram":
      return "kg";
    case "gram":
    case "g":
      return "g";
    case "liter":
    case "liters":
    case "l":
      return "liters";
    case "ml":
    case "milliliter":
      return "ml";
    case "piece":
    case "pieces":
    case "pcs":
    case "pc":
      return "pcs";
    case "box":
    case "boxes":
      return "box";
    case "dozen":
      return "dozen";
    case "pack":
    case "packs":
    case "pkt":
    case "packet":
      return "pack";
    case "ton":
    case "tons":
      return "ton";
    default:
      return "pcs";
  }
};

/** Helper: Process Restock Notifications */
async function processRestockNotifications(product) {
  if (product.stockQuantity > 0 || product.inStock === true) {
    try {
      const pendingRequests = await RestockRequest.find({
        product: product._id,
        status: 'pending'
      });

      if (pendingRequests.length > 0) {
        console.log(`[RESTOCK] Found ${pendingRequests.length} pending requests for Product ${product.name}. Notifying users...`);
        for (const req of pendingRequests) {
          await Notification.create({
            user: req.user,
            title: "Product Back In Stock",
            message: `Good news! ${product.name || "A product you wanted"} is now back in stock. Grab it before it sells out again.`,
            type: "success",
            metadata: { productId: product._id }
          });
          req.status = 'notified';
          await req.save();
        }
      }
    } catch (err) {
      console.error("Error processing restock notifications:", err);
    }
  }
}

/** -------------------------------------------------------
 * GET /api/products/:id
 * Returns product + category info
 ------------------------------------------------------- */
export async function GET(request, { params }) {
  await dbConnect();

  try {
    // ✅ IMPORTANT: params is a Promise in Next.js 15+
    const { id } = await params;

    if (!id) {
      return NextResponse.json(
        { success: false, error: "Product id missing" },
        { status: 400 }
      );
    }

    let product = null;

    // 1️⃣ Try Mongo ObjectId
    if (isValidObjectIdString(id)) {
      product = await Product.findById(id)
        .lean({ virtuals: true });
    }

    // 2️⃣ Fallback to slug / sku
    if (!product) {
      product = await Product.findOne({
        $or: [{ slug: id }, { sku: id }],
      })
        .lean({ virtuals: true });
    }

    if (!product) {
      return NextResponse.json(
        { success: false, error: "Product not found" },
        { status: 404 }
      );
    }

    // Fetch brand (optional)
    let brand = null;
    if (product.brandId && isValidObjectIdString(String(product.brandId))) {
      const b = await Brand.findById(product.brandId)
        .select("_id name slug image parent")
        .lean();

      if (b) {
        brand = {
          id: String(b._id),
          name: b.name,
          slug: b.slug ?? null,
          image: b.image ?? null,
          parent: b.parent ?? null,
        };
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        ...product,
        brand,
      },
    });
  } catch (err) {
    console.error("GET /api/products/[id] error:", err);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 }
    );
  }
}


/** -------------------------------------------------------
 * PUT /api/products/:id
 * Fully replace product document
 ------------------------------------------------------- */
export async function PUT(request, { params }) {
  await dbConnect();
  try {
    const { id } = await params;

    if (!isValidObjectIdString(id)) {
      return NextResponse.json({ success: false, error: "Invalid product id" }, { status: 400 });
    }

    const body = await request.json();
    if (body.unit) body.unit = mapUOM(body.unit);

    // Sanitize optional ObjectId fields to prevent Mongoose cast errors
    const fieldsToClean = ['categoryId', 'subcategoryId', 'brandId', 'stockGroupId', 'locationId'];
    fieldsToClean.forEach(field => {
      if (body[field] !== undefined && body[field] !== null) {
        if (!isValidObjectIdString(String(body[field]))) {
          delete body[field];
        }
      }
    });

    const updated = await Product.findByIdAndUpdate(id, body, {
      new: true,
      overwrite: true,
      runValidators: true,
    });

    if (!updated) {
      return NextResponse.json({ success: false, error: "Product not found" }, { status: 404 });
    }

    // --- AUTO-PROCESS RESTOCK NOTIFICATIONS ---
    await processRestockNotifications(updated);

    await logger({
      level: 'info',
      message: `Product updated (PUT): ${updated.name}`,
      action: 'PRODUCT_UPDATED',
      metadata: { productId: updated._id, name: updated.name, branchId: updated.branchId || null },
      req: request
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error("PUT /api/products/[id] error:", err);

    if (err.name === "ValidationError") {
      const errors = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json(
        { success: false, error: "Validation failed", details: errors },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** -------------------------------------------------------
 * PATCH /api/products/:id
 * Partial update
 ------------------------------------------------------- */
export async function PATCH(request, { params }) {
  await dbConnect();
  try {
    const { id } = await params; // Fix: Await params

    if (!isValidObjectIdString(id)) {
      return NextResponse.json({ success: false, error: "Invalid product id" }, { status: 400 });
    }

    const body = await request.json();
    if (body.unit) body.unit = mapUOM(body.unit);

    // Sanitize optional ObjectId fields to prevent Mongoose cast errors
    const fieldsToClean = ['categoryId', 'subcategoryId', 'brandId', 'stockGroupId', 'locationId'];
    fieldsToClean.forEach(field => {
      if (body[field] !== undefined && body[field] !== null) {
        if (!isValidObjectIdString(String(body[field]))) {
          delete body[field];
        }
      }
    });

    console.log(`[PATCH PRODUCT ${id}] Incoming Body:`, JSON.stringify(body, null, 2));

    const product = await Product.findById(id);
    if (!product) {
      return NextResponse.json({ success: false, error: "Product not found" }, { status: 404 });
    }

    // Apply remaining updates
    Object.assign(product, body);

    const updated = await product.save();

    if (!updated) {
      return NextResponse.json({ success: false, error: "Product not found" }, { status: 404 });
    }

    // --- AUTO-RESUME PAUSED SUBSCRIPTIONS ---
    if (updated.stockQuantity > 0) {
      try {
        // Explicitly cast ID
        const mongoose = require('mongoose');
        const productIdObj = new mongoose.Types.ObjectId(id);

        const pausedSubs = await Subscription.find({
          product: productIdObj,
          status: 'Paused',
          quantity: { $lte: updated.stockQuantity }
        });

        if (pausedSubs.length > 0) {
          console.log(`[PRODUCT UPDATE] Found ${pausedSubs.length} paused subscriptions for Product ${id}. Reactivating...`);
          for (const sub of pausedSubs) {
            sub.status = 'Active';
            await sub.save();
            console.log(`[PRODUCT UPDATE] Reactivated Subscription ${sub._id}`);
          }
        }
      } catch (subErr) {
        console.error("Error reactivating subscriptions:", subErr);
      }
    }

    // --- AUTO-PROCESS RESTOCK NOTIFICATIONS ---
    await processRestockNotifications(updated);

    await logger({
      level: 'info',
      message: `Product updated (PATCH): ${updated.name}`,
      action: 'PRODUCT_UPDATED',
      metadata: { productId: updated._id, name: updated.name, branchId: updated.branchId || null },
      req: request
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error("PATCH /api/products/[id] error:", err);

    if (err.name === "ValidationError") {
      const errors = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json(
        { success: false, error: "Validation failed", details: errors },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** -------------------------------------------------------
 * DELETE /api/products/:id
 ------------------------------------------------------- */
export async function DELETE(request, { params }) {
  await dbConnect();
  try {
    const { id } = await params;

    if (!isValidObjectIdString(id)) {
      return NextResponse.json({ success: false, error: "Invalid product id" }, { status: 400 });
    }

    const deleted = await Product.findByIdAndDelete(id);

    if (!deleted) {
      return NextResponse.json({ success: false, error: "Product not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: deleted });
  } catch (err) {
    console.error("DELETE /api/products/[id] error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
