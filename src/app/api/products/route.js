import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/db/connect";
import Product from "@/lib/db/models/product";
import Brand from "@/lib/db/models/brand";
import Supplier from "@/lib/db/models/supplier";
import CustomerProductMapping from "@/lib/db/models/customerProductMapping";
import Order from "@/lib/db/models/order";
import { logger } from "@/lib/logger";
import { getUserFromRequest } from "@/lib/serverAuth";

/**
 * Helper: basic ObjectId shape check to avoid Mongoose cast errors early
 */
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

export const DEFAULT_LIMIT = 20;

export async function GET(request) {
  await dbConnect();

  try {
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(1000, parseInt(url.searchParams.get("limit") || String(DEFAULT_LIMIT), 10));
    const q = url.searchParams.get("q");
    const brandId = url.searchParams.get("brandId");
    const branchId = url.searchParams.get("branchId");
    const categoryId = url.searchParams.get("categoryId") || url.searchParams.get("category");
    const supplierId = url.searchParams.get("supplierId");
    const supplierBrand = url.searchParams.get("supplierBrand");
    const isActive = url.searchParams.get("isActive");
    const sort = url.searchParams.get("sort") || "-createdAt";
    const sku = url.searchParams.get("sku");

    const filter = {};

    const user = await getUserFromRequest(request);
    const explicitCustomerId = url.searchParams.get("customerId");
    const showAll = url.searchParams.get("showAll") === "true";

    let userId = null;
    if (explicitCustomerId) {
      userId = explicitCustomerId;
    } else if (!showAll && user && (!user.role || user.role === "customer" || user.role === "user")) {
      userId = user.id;
    }

    if (userId) {
      // Fetch customer category dynamically (Default to C for safety)
      const CustomerModel = mongoose.models.Customer || mongoose.model('Customer', new mongoose.Schema({}, { strict: false }));
      const customerDoc = await CustomerModel.findById(userId).lean();
      const customerCategory = customerDoc?.category || "C";

      // ONLY enforce mapping restrictions for Category C customers
      if (customerCategory === "C") {
        // 1. Get mapped products
        const mapping = await CustomerProductMapping.findOne({ customer: userId }).lean();
        const mappedProductIds = mapping ? (mapping.products || []) : [];

        const combinedIds = Array.from(new Set([
          ...mappedProductIds.map(id => String(id))
        ])).filter(isValidObjectIdString).map(id => new mongoose.Types.ObjectId(id));

        filter._id = { $in: combinedIds };
      }
    }

    if (q) {
      // Log search activity
      await logger({ level: 'info', message: `User searched for: ${q}`, action: 'PRODUCT_SEARCH', metadata: { query: q }, req: request });

      // Search in name OR description OR SKU (case-insensitive)
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
        { sku: { $regex: q, $options: "i" } },
        { "variations.sku": { $regex: q, $options: "i" } }
      ];
    }

    // If brandId is provided, expand parent → children so clicking a parent
    // brand returns products from ALL its subbrands too.
    if (brandId) {
      let resolvedId = null;

      if (isValidObjectIdString(brandId)) {
        resolvedId = brandId;
      } else {
        const brnd = await Brand.findOne({ $or: [{ slug: brandId }, { name: { $regex: `^${brandId}$`, $options: "i" } }] }).lean();
        if (brnd) {
          resolvedId = String(brnd._id);
        } else {
          return NextResponse.json({
            success: true,
            data: { items: [], pagination: { total: 0, page, limit, pages: 0 } }
          });
        }
      }

      // Fetch all children of this brand
      const children = await Brand.find({ parent: resolvedId }).select('_id').lean();
      const childIds = children.map(c => String(c._id));

      // Filter by the brand itself AND all its children
      const allBrandIds = [resolvedId, ...childIds];
      filter.brandId = { $in: allBrandIds };
    }


    if (supplierId) filter.supplierId = supplierId;

    if (supplierBrand) {
      const matchingSuppliers = await Supplier.find({
        $or: [
          { brand: supplierBrand },
          { businessName: supplierBrand },
          { brandName: supplierBrand }
        ]
      }).select('_id').lean();
      const supIds = matchingSuppliers.map(s => String(s._id));
      if (supIds.length > 0) {
        if (filter.supplierId) {
          // Intersection if supplierId is also provided
          const currentId = String(filter.supplierId);
          filter.supplierId = supIds.includes(currentId) ? currentId : null;
        } else {
          filter.supplierId = { $in: supIds };
        }
      } else {
        return NextResponse.json({
          success: true,
          data: { items: [], pagination: { total: 0, page, limit, pages: 0 } }
        });
      }
    }

    if (isActive === "true") filter.isActive = true;
    if (isActive === "false") filter.isActive = false;
    if (branchId) filter.branchId = branchId;
    if (categoryId) filter.categoryId = categoryId;

    if (sku) {
      filter.$or = [{ sku }, { "variations.sku": sku }];
    }

    const skip = (page - 1) * limit;

    const [total, items] = await Promise.all([
      Product.countDocuments(filter),
      Product.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    // populate brand info client-side friendly (map)
    const brandIds = Array.from(new Set(items.map(i => i.brandId).filter(id => id && isValidObjectIdString(String(id)))));
    const brands = brandIds.length ? await Brand.find({ _id: { $in: brandIds } }).select('_id name image slug').lean() : [];
    const brandMap = new Map(brands.map(c => [String(c._id), c]));

    const itemsWithBrand = items.map(item => {
      const bId = item.brandId ? String(item.brandId) : null;
      const b = bId ? brandMap.get(bId) : null;

      return {
        ...item,
        price: item.price,
        originalPrice: item.price,
        brand: b ? { id: String(b._id), name: b.name, image: b.image ?? null, slug: b.slug ?? null } : null
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        items: itemsWithBrand,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error("GET /api/products error:", err);
    if (err && err.stack) console.error(err.stack);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  await dbConnect();

  try {
    const body = await request.json();
    console.log(`[POST PRODUCT] Incoming Category Prices:`, body.categoryPrices);

    // Basic server-side validation
    if (!body.name || body.price == null || body.stockQuantity == null || !body.images || !Array.isArray(body.images) || body.images.length === 0) {
      return NextResponse.json({ success: false, error: "Missing required fields (name, price, stockQuantity, images[])." }, { status: 400 });
    }

    // Ensure brand exists and set brandId properly
    let resolvedBrandId = null;
    if (body.brandId) {
      if (isValidObjectIdString(String(body.brandId))) {
        const brnd = await Brand.findById(String(body.brandId)).lean();
        if (!brnd) {
          return NextResponse.json({ success: false, error: "brandId not found" }, { status: 400 });
        }
        resolvedBrandId = String(brnd._id);
      } else {
        // try slug or exact name match
        const maybe = String(body.brandId).trim();
        const brnd = await Brand.findOne({ $or: [{ slug: maybe }, { name: { $regex: `^${maybe}$`, $options: "i" } }] }).lean();
        if (!brnd) {
          return NextResponse.json({ success: false, error: "brand not found by slug/name" }, { status: 400 });
        }
        resolvedBrandId = String(brnd._id);
      }
    } else if (body.brand) {
      // Accept "brand" (name/slug) as fallback
      const maybe = String(body.brand).trim();
      const brnd = await Brand.findOne({ $or: [{ slug: maybe }, { name: { $regex: `^${maybe}$`, $options: "i" } }] }).lean();
      if (brnd) resolvedBrandId = String(brnd._id);
    }

    if (!resolvedBrandId) {
      return NextResponse.json({ success: false, error: "Product must include a valid brandId (or brand slug/name)" }, { status: 400 });
    }

    // Optional: if client supplied SKUs, check for conflicts before attempting to save
    const skusToCheck = [];
    if (body.sku) skusToCheck.push(body.sku);
    if (Array.isArray(body.variations)) {
      body.variations.forEach(v => {
        if (v && v.sku) skusToCheck.push(v.sku);
      });
    }

    if (skusToCheck.length) {
      const conflict = await Product.findOne({
        $or: [{ sku: { $in: skusToCheck } }, { "variations.sku": { $in: skusToCheck } }]
      }).lean();
      if (conflict) {
        return NextResponse.json({ success: false, error: "SKU conflict", details: { conflictProductId: conflict._id } }, { status: 409 });
      }
    }

    // Build payload (ensure brandId is set)
    const payload = {
      ...body,
      brandId: resolvedBrandId,
    };

    // Create product; Product model's pre-save hook will auto-generate SKUs if missing
    console.log('Incoming POST /api/products body:', JSON.stringify(body, null, 2));
    const product = new Product(payload);
    await product.save();

    // populate brand basic info for response
    const brnd = await Brand.findById(resolvedBrandId).select('_id name image slug').lean();

    const result = {
      ...product.toObject(),
      brand: brnd ? { id: String(brnd._id), name: brnd.name, image: brnd.image ?? null, slug: brnd.slug ?? null } : null
    };

    await logger({
      level: 'info',
      message: `Product created: ${product.name}`,
      action: 'PRODUCT_CREATED',
      userId: body.userId || null,
      metadata: {
        productId: product._id,
        sku: product.sku,
        name: product.name,
        brandId: resolvedBrandId,
        branchId: product.branchId || null
      },
      req: request
    });

    return NextResponse.json({ success: true, data: result }, { status: 201 });
  } catch (err) {
    console.error("POST /api/products error:", err);
    if (err && err.stack) console.error(err.stack);

    if (err.name === "ValidationError") {
      const errors = Object.values(err.errors).map(e => e.message);
      return NextResponse.json({ success: false, error: "Validation failed", details: errors }, { status: 400 });
    }
    if (err.code === 11000) {
      return NextResponse.json({ success: false, error: "Duplicate key error", details: err.keyValue }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
