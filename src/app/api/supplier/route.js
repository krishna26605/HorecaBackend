// app/api/suppliers/route.js
import { NextResponse } from "next/server";
import dbConnect from "@/lib/db/connect";
import Supplier from "@/lib/db/models/supplier";
import Product from "@/lib/db/models/product";
import Brand from "@/lib/db/models/brand";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import Category from "@/lib/db/models/category";
import { sendSupplierWelcomeEmail } from "@/lib/mail";

const TALLY_CONFIG = {
  company: process.env.TALLY_SALES_COMPANY || 'Unifoods'
};

// cloudinary server-side config - available if you want to process images server-side later
import cloudinary from "cloudinary";
cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const ACCESS_SECRET = process.env.ACCESS_TOKEN_SECRET || "fallback_access_token_secret";
const TOKEN_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

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

// Helper to map mongoose unit to Tally active unit name
// const mapMongooseUnitToTally = (mongooseUnit) => {
//   if (!mongooseUnit) return "Nos";
//   const normalized = String(mongooseUnit).trim().toLowerCase();
//   switch (normalized) {
//     case "kg":
//       return "Kg";
//     case "g":
//       return "Kg";
//     case "liters":
//     case "ml":
//       return "Ltr";
//     case "pcs":
//     case "box":
//     case "dozen":
//     case "pack":
//     case "ton":
//     default:
//       return "Nos";
//   }
// };

const mapMongooseUnitToTally = (mongooseUnit) => {
  return mongooseUnit ? String(mongooseUnit).trim() : "Nos";
};


// Helper to build Supplier XML for Tally
function buildSupplierXML(supplier) {
  const name = escapeXML(supplier.businessName || supplier.shopName || supplier.ownerName);
  const mongoId = escapeXML(supplier._id.toString());
  const mailingName = escapeXML(supplier.shopName || supplier.businessName);

  const street = supplier.address?.street ? escapeXML(supplier.address.street) : "";
  const city = supplier.address?.city ? escapeXML(supplier.address.city) : "";
  const state = supplier.address?.state ? escapeXML(supplier.address.state) : "Maharashtra";
  const postalCode = supplier.address?.postalCode ? escapeXML(supplier.address.postalCode) : "";

  const phone = supplier.phone ? escapeXML(supplier.phone) : "";
  const email = supplier.email ? escapeXML(supplier.email) : "";

  const gstNumber = supplier.gstNumber ? escapeXML(supplier.gstNumber) : "";
  const panNumber = supplier.panNumber ? escapeXML(supplier.panNumber) : "";

  const bankName = supplier.bankDetails?.bankName ? escapeXML(supplier.bankDetails.bankName) : "";
  const accountNumber = supplier.bankDetails?.accountNumber ? escapeXML(supplier.bankDetails.accountNumber) : "";
  const accountHolderName = supplier.bankDetails?.accountHolderName ? escapeXML(supplier.bankDetails.accountHolderName) : "";
  const ifscCode = supplier.bankDetails?.ifscCode ? escapeXML(supplier.bankDetails.ifscCode) : "";

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
          <LEDGER NAME="${name}" ACTION="Create">
            <NAME>${name}</NAME>
            <PARENT>Sundry Creditors</PARENT>
            <ISBILLWISEON>Yes</ISBILLWISEON>
            <MAILINGNAME>${mailingName}</MAILINGNAME>
            <ADDRESS.LIST TYPE="String">
              <ADDRESS>${street}</ADDRESS>
              <ADDRESS>${city}</ADDRESS>
            </ADDRESS.LIST>
            <STATENAME>${state}</STATENAME>
            <COUNTRYNAME>India</COUNTRYNAME>
            <PINCODE>${postalCode}</PINCODE>
            <MOBILE>${phone}</MOBILE>
            <EMAIL>${email}</EMAIL>
            <GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>
            <PARTYGSTIN>${gstNumber}</PARTYGSTIN>
            <INCOMETAXNUMBER>${panNumber}</INCOMETAXNUMBER>
            <BANKDETAILS.LIST>
              <BANKNAME>${bankName}</BANKNAME>
              <ACCOUNTNUMBER>${accountNumber}</ACCOUNTNUMBER>
              <ACCOUNTNAME>${accountHolderName}</ACCOUNTNAME>
              <IFSCCODE>${ifscCode}</IFSCCODE>
            </BANKDETAILS.LIST>
            <OPENINGBALANCE>0</OPENINGBALANCE>
          </LEDGER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// Helper to build Product XML for Tally (Create)
function buildProductXML(product, stockGroupName, categoryName) {
  const name = escapeXML(product.name);
  const mongoId = escapeXML(product._id.toString());
  const parent = escapeXML(stockGroupName || "");
  const category = escapeXML(categoryName || "");
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
          <STOCKITEM NAME="${name}" ACTION="Create">
            <NAME>${name}</NAME>
            <LANGUAGENAME.LIST>
              <NAME.LIST TYPE="String">
                <NAME>${name}</NAME>
                <NAME>${mongoId}</NAME>
              </NAME.LIST>
            </LANGUAGENAME.LIST>
            <PARENT>${parent}</PARENT>
            <CATEGORY>${category}</CATEGORY>
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

// Helper to build Stock Group XML for Tally (Create)
function buildStockGroupXML(name) {
  const safeName = escapeXML(name);
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
          <STOCKGROUP NAME="${safeName}" ACTION="Create">
            <NAME>${safeName}</NAME>
          </STOCKGROUP>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// Helper to build Product XML for Tally (Alter)
function buildProductAlterXML(product, stockGroupName, categoryName) {
  const name = escapeXML(product.name);
  const mongoId = escapeXML(product._id.toString());
  const parent = escapeXML(stockGroupName || "");
  const category = escapeXML(categoryName || "");
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
          <STOCKITEM NAME="${name}" ACTION="Alter">
            <NAME>${name}</NAME>
            <LANGUAGENAME.LIST>
              <NAME.LIST TYPE="String">
                <NAME>${name}</NAME>
                <NAME>${mongoId}</NAME>
              </NAME.LIST>
            </LANGUAGENAME.LIST>
            <PARENT>${parent}</PARENT>
            <CATEGORY>${category}</CATEGORY>
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

export async function POST(request) {
  await dbConnect();

  try {
    const body = await request.json();
    if (!body.email || !body.password) {
      return NextResponse.json({ success: false, error: "Email and password required" }, { status: 400 });
    }

    const { email, phone, gstNumber, panNumber } = body;

    // Improved conflict check: only search for truthy values to avoid matching empty strings
    const conflictQuery = [];
    if (email) conflictQuery.push({ email: email.toLowerCase().trim() });
    if (phone) conflictQuery.push({ phone });
    if (gstNumber) conflictQuery.push({ gstNumber });
    if (panNumber) conflictQuery.push({ panNumber });

    if (conflictQuery.length > 0) {
      const existing = await Supplier.findOne({ $or: conflictQuery });
      if (existing) {
        let conflictField = "Credential";
        if (existing.email === email?.toLowerCase().trim()) conflictField = "Email";
        else if (existing.phone === phone) conflictField = "Phone Number";
        else if (existing.gstNumber === gstNumber) conflictField = "GST Number";
        else if (existing.panNumber === panNumber) conflictField = "PAN ID";

        return NextResponse.json({
          success: false,
          error: `${conflictField} is already registered in the central system.`
        }, { status: 400 });
      }
    }

    const supplierPayload = { ...body };
    delete supplierPayload.products;
    const objectIdFields = ["poTemplateId", "claimTemplateId", "godownIncharge", "verifiedBy"];
    for (const field of objectIdFields) {
      if (field in supplierPayload) {
        if (!supplierPayload[field] || !mongoose.Types.ObjectId.isValid(supplierPayload[field])) {
          delete supplierPayload[field];
        }
      }
    }

    // Handle multiple brands
    const resolvedBrandIds = [];
    const brandsToProcess = supplierPayload.brandNames && supplierPayload.brandNames.length > 0
      ? supplierPayload.brandNames
      : (supplierPayload.brandName ? [supplierPayload.brandName] : []);

    for (const bName of brandsToProcess) {
      if (!bName) continue;
      let brnd = await Brand.findOne({ name: new RegExp(`^${bName}$`, "i") });
      if (!brnd) {
        brnd = await Brand.create({ name: bName });
      }
      resolvedBrandIds.push(brnd._id);
    }
    supplierPayload.brandIds = resolvedBrandIds;

    const supplier = new Supplier(supplierPayload);
    await supplier.save();

    // 📧 Send Automated Welcome Email to Supplier
    try {
      if (supplier.email) {
        await sendSupplierWelcomeEmail({
          email: supplier.email,
          name: supplier.ownerName || supplier.shopName,
          businessName: supplier.businessName || supplier.shopName,
          password: body.password,
          gstNumber: supplier.gstNumber || "URG",
          supplierId: supplier._id.toString()
        });
        console.log(`[Email Notification] Welcome email sent to supplier: ${supplier.email}`);
      }
    } catch (mailErr) {
      console.error("[Email Notification Error] Failed to send supplier welcome email:", mailErr);
    }

    // Sync Supplier Ledger to Tally Prime 9
    const tallyUrl = 'https://yummy-freebee-circular.ngrok-free.dev';
    let tallySupplierSynced = false;
    let tallySupplierError = null;

    try {
      const xmlPayload = buildSupplierXML(supplier);
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
          tallySupplierSynced = true;
        } else {
          tallySupplierError = parsed.error;
        }
      } else {
        tallySupplierError = `Tally server responded with status ${tallyResponse.status}`;
      }
    } catch (err) {
      tallySupplierError = err.message || String(err);
    }

    // Process and Save Nested Products
    const createdProducts = [];
    const tallyProductSyncResults = [];

    if (Array.isArray(body.products) && body.products.length > 0) {
      for (const prodData of body.products) {
        try {
          // Find category name to pass to Tally as <PARENT>
          let categoryName = "Primary";
          let categoryObjectId = null;

          if (prodData.category) {
            // Check if it's a valid MongoDB ObjectId
            if (mongoose.Types.ObjectId.isValid(prodData.category) && String(new mongoose.Types.ObjectId(prodData.category)) === String(prodData.category)) {
              // It's an ObjectId — look up the category doc
              const categoryDoc = await Category.findById(prodData.category).lean();
              if (categoryDoc) {
                categoryName = categoryDoc.name;
                categoryObjectId = categoryDoc._id;
              }
            } else {
              categoryName = prodData.category;
            }
          }

          let stockGroupName = prodData.stockGroupName || "";

          // Calculate Selling Price with Base Price + GST + Selling Margin
          const basePriceNum = Number(prodData.basePrice) || 0;
          const gstNum = Number(prodData.gst ?? 18) || 0;
          const marginNum = Number(prodData.assuredMargin ?? supplierPayload.sellingMargin ?? 0) || 0;
          const costWithGst = basePriceNum + (basePriceNum * gstNum / 100);
          const computedSellingPrice = costWithGst + (costWithGst * marginNum / 100);

          // Map and save to MongoDB
          const productPayload = {
            supplierId: supplier._id,
            categoryId: categoryObjectId || undefined,
            categoryName: categoryName,
            name: prodData.productName,
            sku: prodData.productCode,
            unit: mapUOM(prodData.uom || prodData.primaryUnit),
            standardUnit: prodData.standardUnit || null,
            alternateUnit: prodData.alternateUnit || null,
            price: Number(computedSellingPrice.toFixed(2)),
            basePrice: basePriceNum,
            gst: gstNum,
            gstEffectiveDate: prodData.gstEffectiveDate || null,
            assuredMargin: marginNum,
            claimMargin: Number(prodData.claimMargin ?? supplierPayload.claimMargin ?? 0) || 0,
            hsnCode: prodData.hsnCode || undefined,
            hsnEffectiveDate: prodData.hsnEffectiveDate || null,
            brandId: prodData.brand || undefined,
            stockGroup: stockGroupName || undefined,
            stockGroupId: mongoose.Types.ObjectId.isValid(prodData.stockGroup) ? prodData.stockGroup : undefined,
            shelfLife: prodData.shelfLife || null,
            categoryPrices: {
              A: Number(prodData.brandPrices?.A) || 0,
              B: Number(prodData.brandPrices?.B) || 0,
              C: Number(prodData.brandPrices?.C) || 0
            },
            reorderLevel: Number(prodData.reorderLevel) || 0,
            images: prodData.image
              ? [{ url: prodData.image, publicId: `prod_${Date.now()}` }]
              : [{ url: "https://res.cloudinary.com/dqfum2awz/image/upload/v1717900000/placeholder.png", publicId: "placeholder" }],
            isColdStorage: prodData.isColdStorage === true || prodData.isColdStorage === 'Yes',
            temperature: prodData.temperature || null,
            shipperDryIce: prodData.shipperDryIce === true || prodData.shipperDryIce === 'Yes',
            reeferVehicleReq: prodData.reeferVehicleReq === true || prodData.reeferVehicleReq === 'Yes',
            isActive: true
          };

          const product = await Product.findOneAndUpdate(
            { sku: productPayload.sku },
            { $set: productPayload },
            { new: true, upsert: true }
          );
          createdProducts.push(product);

          // Sync Product Stock Item to Tally
          let prodSynced = false;
          let prodError = null;

          try {
            const prodXml = buildProductXML(product, stockGroupName, categoryName);
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
                if (parsed.error && (parsed.error.toLowerCase().includes('already exists') || parsed.error.toLowerCase().includes('duplicate'))) {
                  console.log(`[Tally API] Create failed for ${product.name} (exists), auto-retrying with ALTER...`);
                  const alterXml = buildProductAlterXML(product, stockGroupName, categoryName);
                  const alterResponse = await fetch(tallyUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/xml', 'ngrok-skip-browser-warning': 'true' },
                    body: alterXml
                  });
                  if (alterResponse.ok) {
                    const alterText = await alterResponse.text();
                    const alterParsed = parseTallyResponse(alterText);
                    if (alterParsed.success) {
                      prodSynced = true;
                      prodError = null;
                    } else {
                      prodError = alterParsed.error;
                      console.error(`[Tally API] Alter failed for ${product.name}:`, prodError);
                    }
                  } else {
                    prodError = `Tally server responded with status ${alterResponse.status} on Alter`;
                  }
                } else if (parsed.error && parsed.error.toLowerCase().includes('stock group') && parsed.error.toLowerCase().includes('does not exist')) {
                  console.log(`[Tally API] Stock Group '${stockGroupName}' does not exist, creating it...`);
                  const groupXml = buildStockGroupXML(stockGroupName);
                  const groupResponse = await fetch(tallyUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/xml', 'ngrok-skip-browser-warning': 'true' },
                    body: groupXml
                  });

                  if (groupResponse.ok) {
                    const retryResponse = await fetch(tallyUrl, {
                      method: 'POST',
                      headers: { 'Content-Type': 'text/xml', 'ngrok-skip-browser-warning': 'true' },
                      body: prodXml
                    });
                    if (retryResponse.ok) {
                      const retryText = await retryResponse.text();
                      const retryParsed = parseTallyResponse(retryText);
                      if (retryParsed.success) {
                        prodSynced = true;
                        prodError = null;
                      } else {
                        prodError = retryParsed.error;
                        console.error(`[Tally API] Create failed after group creation for ${product.name}:`, prodError);
                      }
                    } else {
                      prodError = `Tally server responded with status ${retryResponse.status} on retry`;
                    }
                  } else {
                    prodError = `Failed to create Stock Group. Tally server responded with status ${groupResponse.status}`;
                  }
                } else {
                  prodError = parsed.error;
                  console.error(`[Tally API] Create failed for ${product.name}:`, prodError);
                }
              }
            } else {
              prodError = `Tally server responded with status ${prodResponse.status}`;
            }
          } catch (err) {
            prodError = err.message || String(err);
            console.error(`[Tally API] Network/Parse Error for ${product.name}:`, prodError);
          }

          tallyProductSyncResults.push({
            productId: product._id,
            name: product.name,
            tallySynced: prodSynced,
            tallyError: prodError
          });

        } catch (err) {
          console.error("Error creating/syncing product inside supplier onboard:", err);
          tallyProductSyncResults.push({
            name: prodData.productName,
            tallySynced: false,
            tallyError: `Failed to save product in DB: ${err.message}`
          });
        }
      }
    }

    if (createdProducts.length > 0) {
      supplier.products = createdProducts.map((p) => p._id);
      await supplier.save();
    }

    const safeObj = supplier.toObject();
    delete safeObj.password;

    const token = jwt.sign({ id: supplier._id.toString(), role: supplier.role || "supplier" }, ACCESS_SECRET, { expiresIn: `${TOKEN_MAX_AGE}s` });

    console.log("Token from central register:", token);

    const cookie = `authToken=${token}; Path=/; HttpOnly; Max-Age=${TOKEN_MAX_AGE}; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;

    return NextResponse.json(
      {
        success: true,
        data: safeObj,
        token,
        tallySupplierSynced,
        tallySupplierError,
        createdProducts,
        tallyProductSyncResults
      },
      {
        status: 201,
        headers: { "Set-Cookie": cookie }
      }
    );
  } catch (err) {
    console.error("POST /api/suppliers error", err);

    // Handle Duplicate Key Errors (Mongo Code 11000)
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      return NextResponse.json({
        success: false,
        error: `The ${field} you provided is already in use.`
      }, { status: 400 });
    }

    if (err.name === "ValidationError") {
      const errors = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json({ success: false, error: "Validation failed", details: errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: err.message, details: err.details || [] }, { status: 500 });
  }
}



export async function GET() {
  await dbConnect();
  try {
    const suppliers = await Supplier.find().limit(100).lean();
    return NextResponse.json({ success: true, data: suppliers });
  } catch (err) {
    console.error("GET /api/suppliers error", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
