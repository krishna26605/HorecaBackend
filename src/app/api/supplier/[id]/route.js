// app/api/suppliers/[id]/route.js
import { NextResponse } from "next/server";
import dbConnect from "@/lib/db/connect";
import Supplier from "@/lib/db/models/supplier";
import Product from "@/lib/db/models/product";
import Brand from "@/lib/db/models/brand";
import Category from "@/lib/db/models/category";
import mongoose from "mongoose";

const TALLY_CONFIG = {
  company: process.env.TALLY_SALES_COMPANY || 'Unifoods'
};


// cloudinary setup (server-side)
import cloudinary from "cloudinary";
cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// DEBUG (runs when module is loaded)
(() => {
  try {
    console.log("🔧 suppliers/[id] route loaded");
    console.log("  • NODE_ENV:", process.env.NODE_ENV);
    console.log("  • Cloudinary env present:",
      {
        CLOUDINARY_CLOUD_NAME: !!(process.env.CLOUDINARY_CLOUD_NAME || process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME),
        CLOUDINARY_API_KEY: !!process.env.CLOUDINARY_API_KEY,
        CLOUDINARY_API_SECRET: !!process.env.CLOUDINARY_API_SECRET
      }
    );
    // show cloudinary config summary (do NOT print secrets)
    const conf = cloudinary.v2.config();
    console.log("  • Cloudinary config cloud_name:", conf && conf.cloud_name ? conf.cloud_name : "(not configured)");
  } catch (e) {
    console.warn("Failed to log Cloudinary debug info:", e?.message || e);
  }
})();

// Helper to escape XML entities
const escapeXML = (str) => {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
};

// Helper to map mongoose unit to Tally active unit name
const mapMongooseUnitToTally = (mongooseUnit) => {
  if (!mongooseUnit) return "Nos";
  const normalized = String(mongooseUnit).trim().toLowerCase();
  switch (normalized) {
    case "kg": case "kilogram": return "Kg";
    case "g": case "gram": return "Kg";
    case "liters": case "liter": case "ml": case "milliliter": return "Ltr";
    case "pcs": case "box": case "dozen": case "pack": case "ton":
    default: return "Nos";
  }
};

// Helper to build Product XML for Tally
function buildProductXML(product, parentCategoryName, action = "Create") {
  const name = escapeXML(product.name);
  const mongoId = escapeXML(product._id.toString());
  const parent = escapeXML(parentCategoryName || "Primary");
  const unit = escapeXML(mapMongooseUnitToTally(product.unit));

  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${TALLY_CONFIG.company}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM NAME="${name}" ACTION="${escapeXML(action)}">
            <NAME>${name}</NAME>
            <PARENT>${parent}</PARENT>
            <BASEUNITS>${unit}</BASEUNITS>
            <GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>
            <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
            <HSNCODE>0401</HSNCODE>
            <OPENINGBALANCE>0 ${unit}</OPENINGBALANCE>
            <OPENINGVALUE>0</OPENINGVALUE>
          </STOCKITEM>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// Helper to parse Tally responses
function parseTallyResponse(xmlString) {
  if (!xmlString) return { success: false, error: "Empty response from Tally" };

  const createdMatch = xmlString.match(/<CREATED>(\d+)<\/CREATED>/);
  const alteredMatch = xmlString.match(/<ALTERED>(\d+)<\/ALTERED>/);
  const deletedMatch = xmlString.match(/<DELETED>(\d+)<\/DELETED>/);

  const createdCount = createdMatch ? parseInt(createdMatch[1], 10) : 0;
  const alteredCount = alteredMatch ? parseInt(alteredMatch[1], 10) : 0;
  const deletedCount = deletedMatch ? parseInt(deletedMatch[1], 10) : 0;

  if (createdCount > 0 || alteredCount > 0 || deletedCount > 0) {
    return { success: true };
  }

  const errorMatch = xmlString.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/);
  if (errorMatch && errorMatch[1]) {
    return { success: false, error: errorMatch[1].trim() };
  }

  return { success: false, error: "Failed to parse Tally response", raw: xmlString };
}

function isValidObjectIdString(id) {
  return typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id);
}

// Build Tally XML to DELETE a Ledger (Supplier) by name
function buildDeleteLedgerXML(ledgerName) {
  const name = escapeXML(ledgerName);
  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${TALLY_CONFIG.company}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${name}" ACTION="Delete">
            <NAME>${name}</NAME>
          </LEDGER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// Build Tally XML to DELETE a Stock Item (Product) by name
function buildDeleteStockItemXML(stockItemName) {
  const name = escapeXML(stockItemName);
  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${TALLY_CONFIG.company}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM NAME="${name}" ACTION="Delete">
            <NAME>${name}</NAME>
          </STOCKITEM>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

export async function GET(request, { params }) {
  await dbConnect();
  try {
    // MUST await params in App Router
    const { id } = await params;
    console.log("[GET /api/suppliers/[id]] supplierId:", id);

    if (!isValidObjectIdString(id)) return NextResponse.json({ success: false, error: "Invalid supplier id" }, { status: 400 });

    const sup = await Supplier.findById(id).populate({ path: "brandIds", select: "name slug", strictPopulate: false }).select("-password").lean();
    if (!sup) return NextResponse.json({ success: false, error: "Supplier not found" }, { status: 404 });

    return NextResponse.json({ success: true, data: sup });
  } catch (err) {
    console.error("GET /api/suppliers/[id] error", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  await dbConnect();
  try {
    const { id } = await params;
    console.log("[PATCH /api/suppliers/[id]] supplierId:", id);

    if (!isValidObjectIdString(id)) return NextResponse.json({ success: false, error: "Invalid supplier id" }, { status: 400 });

    const body = await request.json();

    // Do not update password here (pre-save hooks won't run). Use a dedicated password-change route if needed.
    if (body.password !== undefined) {
      delete body.password;
    }

    if (body.email) {
      const exists = await Supplier.findOne({ email: body.email.toLowerCase().trim(), _id: { $ne: id } });
      if (exists) return NextResponse.json({ success: false, error: "Email already in use" }, { status: 400 });
      body.email = body.email.toLowerCase().trim();
    }

    // Handle multiple brands
    if (body.brandNames !== undefined || body.brandName !== undefined) {
      const resolvedBrandIds = [];
      const brandsToProcess = body.brandNames && body.brandNames.length > 0
        ? body.brandNames
        : (body.brandName ? [body.brandName] : []);

      for (const bName of brandsToProcess) {
        if (!bName) continue;
        let brnd = await Brand.findOne({ name: new RegExp(`^${bName}$`, "i") });
        if (!brnd) {
          brnd = await Brand.create({ name: bName });
        }
        resolvedBrandIds.push(brnd._id);
      }
      body.brandIds = resolvedBrandIds;
    }

    // Sanitize ObjectId fields to null if empty or invalid to prevent BSONError / CastError
    const objectIdFields = ["claimTemplateId", "poTemplateId", "godownIncharge", "verifiedBy"];
    for (const field of objectIdFields) {
      if (field in body) {
        if (!body[field] || !mongoose.Types.ObjectId.isValid(body[field])) {
          body[field] = null;
        }
      }
    }

    const productsToProcess = body.products;
    delete body.products;

    const updated = await Supplier.findByIdAndUpdate(id, { $set: body }, { new: true, runValidators: true, context: "query" }).select("-password");
    if (!updated) return NextResponse.json({ success: false, error: "Supplier not found" }, { status: 404 });

    // Update or Create products in the global Product collection + Tally Sync
    const tallyProductSyncResults = [];
    if (productsToProcess && Array.isArray(productsToProcess) && productsToProcess.length > 0) {
      const tallyUrl = process.env.TALLY_URL || 'https://yummy-freebee-circular.ngrok-free.dev';

      for (const p of productsToProcess) {
        if (!p.productName || !p.productCode) continue;

        let finalBrandId = undefined;
        if (p.brand) {
          if (mongoose.Types.ObjectId.isValid(p.brand)) {
            finalBrandId = p.brand;
          } else {
            let brnd = await Brand.findOne({ name: new RegExp(`^${p.brand}$`, "i") });
            if (!brnd) {
              brnd = await Brand.create({ name: p.brand });
            }
            finalBrandId = brnd._id;
          }
        }

        const basePriceNum = Number(p.basePrice) || 0;
        const gstNum = Number(p.gst ?? 18) || 0;
        const marginNum = Number(p.assuredMargin ?? body.sellingMargin ?? 0) || 0;
        const costWithGst = basePriceNum + (basePriceNum * gstNum / 100);
        const computedSellingPrice = costWithGst + (costWithGst * marginNum / 100);

        const productData = {
          supplierId: id,
          name: p.productName,
          sku: p.productCode,
          brandId: finalBrandId,
          unit: p.uom || p.primaryUnit || "Kg",
          standardUnit: p.standardUnit || null,
          alternateUnit: p.alternateUnit || null,
          basePrice: basePriceNum,
          gst: gstNum,
          gstEffectiveDate: p.gstEffectiveDate || null,
          assuredMargin: marginNum,
          claimMargin: Number(p.claimMargin ?? body.claimMargin ?? 0) || 0,
          hsnCode: p.hsnCode || undefined,
          hsnEffectiveDate: p.hsnEffectiveDate || null,
          stockGroup: p.stockGroupName || undefined,
          stockGroupId: mongoose.Types.ObjectId.isValid(p.stockGroup) ? p.stockGroup : undefined,
          shelfLife: p.shelfLife || null,
          categoryPrices: {
            A: Number(p.brandPrices?.A) || 0,
            B: Number(p.brandPrices?.B) || 0,
            C: Number(p.brandPrices?.C) || 0
          },
          reorderLevel: Number(p.reorderLevel || 0),
          price: Number(computedSellingPrice.toFixed(2)),
          isColdStorage: p.isColdStorage === 'Yes' || p.isColdStorage === true,
          temperature: p.temperature || null,
          shipperDryIce: p.shipperDryIce === true || p.shipperDryIce === 'Yes',
          reeferVehicleReq: p.reeferVehicleReq === true || p.reeferVehicleReq === 'Yes',
        };

        if (p.image) {
          productData.images = [{ url: p.image, publicId: `sup_${id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, isMain: true }];
        }

        const savedProduct = await Product.findOneAndUpdate(
          { sku: p.productCode },
          { $set: productData },
          { upsert: true, new: true }
        );

        // Sync product to Tally Prime 9
        let prodSynced = false;
        let prodError = null;

        try {
          // Find category name to pass to Tally as <PARENT>
          let categoryName = "Primary";
          if (p.category) {
            const categoryDoc = await Category.findById(p.category).lean();
            if (categoryDoc) categoryName = categoryDoc.name;
          }

          const prodXml = buildProductXML(savedProduct, categoryName, "Create");
          const prodResponse = await fetch(tallyUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'text/xml',
              'ngrok-skip-browser-warning': 'true'
            },
            body: prodXml
          });

          if (prodResponse.ok) {
            const responseText = await prodResponse.text();
            const parsed = parseTallyResponse(responseText);
            if (parsed.success) {
              prodSynced = true;
            } else {
              // If Create failed because item already exists, auto-retry with Alter
              if (parsed.error && (parsed.error.includes('already exists') || parsed.error.includes('Duplicate'))) {
                console.log(`[Tally Sync] Create failed for "${savedProduct.name}" (item exists), retrying with Alter...`);
                const alterXml = buildProductXML(savedProduct, categoryName, "Alter");
                const alterResponse = await fetch(tallyUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'text/xml', 'ngrok-skip-browser-warning': 'true' },
                  body: alterXml
                });
                if (alterResponse.ok) {
                  const alterText = await alterResponse.text();
                  const alterResult = parseTallyResponse(alterText);
                  if (alterResult.success) {
                    prodSynced = true;
                  } else {
                    prodError = alterResult.error;
                  }
                }
              } else {
                prodError = parsed.error;
              }
            }
          } else {
            prodError = `Tally server responded with status ${prodResponse.status}`;
          }
        } catch (err) {
          prodError = err.message || String(err);
        }

        tallyProductSyncResults.push({
          productId: savedProduct._id,
          name: savedProduct.name,
          tallySynced: prodSynced,
          tallyError: prodError
        });
      }
    }

    if (tallyProductSyncResults.length > 0) {
      const createdProductIds = tallyProductSyncResults.map(p => p.productId).filter(Boolean);
      if (createdProductIds.length > 0) {
        await Supplier.updateOne({ _id: id }, { $set: { products: createdProductIds } });
        updated.products = createdProductIds;
      }
    }

    console.log("Updated supplier data:", updated);


    return NextResponse.json({ success: true, data: updated, tallyProductSyncResults });
  } catch (err) {
    console.error("PATCH /api/suppliers/[id] error", err);
    if (err.name === "ValidationError") {
      const errors = Object.values(err.errors).map(e => e.message);
      return NextResponse.json({ success: false, error: "Validation failed", details: errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  await dbConnect();
  try {
    const { id } = await params;
    console.log("[DELETE /api/suppliers/[id]] supplierId:", id);

    if (!isValidObjectIdString(id)) return NextResponse.json({ success: false, error: "Invalid supplier id" }, { status: 400 });

    const tallyUrl = process.env.TALLY_URL || 'https://yummy-freebee-circular.ngrok-free.dev';
    let tallyLedgerDeleted = false;
    let tallyLedgerError = null;
    const tallyProductDeleteResults = [];

    // Try to find the supplier first
    const supplier = await Supplier.findById(id).select("-password").lean();

    // Delete supplier ledger from Tally (even if not in MongoDB, try by name from request)
    if (supplier) {
      const ledgerName = supplier.businessName || supplier.shopName || supplier.ownerName;
      if (ledgerName) {
        try {
          const deleteXml = buildDeleteLedgerXML(ledgerName);
          console.log(`[Tally DELETE] Deleting ledger "${ledgerName}" from Tally...`);
          const tallyRes = await fetch(tallyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml', 'ngrok-skip-browser-warning': 'true' },
            body: deleteXml
          });
          if (tallyRes.ok) {
            const responseText = await tallyRes.text();
            const parsed = parseTallyResponse(responseText);
            if (parsed.success) {
              tallyLedgerDeleted = true;
              console.log(`[Tally DELETE] Ledger "${ledgerName}" deleted successfully`);
            } else {
              tallyLedgerError = parsed.error;
              console.warn(`[Tally DELETE] Ledger "${ledgerName}" delete failed:`, parsed.error);
            }
          } else {
            tallyLedgerError = `Tally server responded with status ${tallyRes.status}`;
          }
        } catch (err) {
          tallyLedgerError = err.message || String(err);
          console.warn("[Tally DELETE] Ledger delete error:", tallyLedgerError);
        }
      }

      // Delete associated products from Tally + MongoDB
      const products = await Product.find({ supplierId: id }).lean();
      if (products.length > 0) {
        console.log(`[DELETE] Found ${products.length} products for supplier — deleting from Tally & MongoDB`);
        for (const product of products) {
          // Delete stock item from Tally
          try {
            const productDeleteXml = buildDeleteStockItemXML(product.name);
            const prodRes = await fetch(tallyUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'text/xml', 'ngrok-skip-browser-warning': 'true' },
              body: productDeleteXml
            });
            if (prodRes.ok) {
              const responseText = await prodRes.text();
              const parsed = parseTallyResponse(responseText);
              tallyProductDeleteResults.push({
                name: product.name,
                deleted: parsed.success,
                error: parsed.success ? null : parsed.error
              });
            } else {
              tallyProductDeleteResults.push({ name: product.name, deleted: false, error: `HTTP ${prodRes.status}` });
            }
          } catch (err) {
            tallyProductDeleteResults.push({ name: product.name, deleted: false, error: err.message });
          }
        }
        // Delete all products from MongoDB
        await Product.deleteMany({ supplierId: id });
      }

      // If supplier has documents with cloudinary public ids, attempt to delete them
      if (Array.isArray(supplier.documents) && supplier.documents.length > 0) {
        console.log(`[DELETE] supplier has ${supplier.documents.length} document(s) — attempting cloudinary cleanup (if configured)`);
        for (const doc of supplier.documents) {
          const publicId = doc.publicId || doc.cloudinaryId || doc.id;
          if (publicId && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
            try {
              await cloudinary.v2.uploader.destroy(publicId, { resource_type: 'auto' });
              console.log(`Deleted cloudinary asset ${publicId}`);
            } catch (err) {
              console.warn(`Failed to delete cloudinary asset ${publicId}:`, err?.message || err);
            }
          }
        }
      }

      // Delete supplier from MongoDB
      const deleted = await Supplier.findByIdAndDelete(id).select("-password");
      if (!deleted) return NextResponse.json({ success: false, error: "Supplier not found" }, { status: 404 });

      return NextResponse.json({
        success: true,
        data: deleted,
        tallyLedgerDeleted,
        tallyLedgerError,
        tallyProductDeleteResults
      });
    } else {
      // Supplier not in MongoDB — still return success (may be Tally-only)
      return NextResponse.json({ success: true, message: "Supplier not found in database (may be Tally-only)" });
    }
  } catch (err) {
    console.error("DELETE /api/suppliers/[id] error", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
