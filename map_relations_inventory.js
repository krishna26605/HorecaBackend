const http = require('http');
const { XMLParser } = require('fast-xml-parser');
const mongoose = require('mongoose');

const MONGO_URI = 'mongodb://sameergaikwaddelxn_db_user:sameer1234@ac-eearv9b-shard-00-00.beh8ogg.mongodb.net:27017,ac-eearv9b-shard-00-01.beh8ogg.mongodb.net:27017,ac-eearv9b-shard-00-02.beh8ogg.mongodb.net:27017/?ssl=true&replicaSet=atlas-dxxsdl-shard-0&authSource=admin&appName=Cluster0';

const TALLY_CONFIG = {
  company: process.env.TALLY_SALES_COMPANY || 'Unifoods'
};

// Schemas
const BrandSchema = new mongoose.Schema({
  name: String,
  isActive: { type: Boolean, default: true }
}, { strict: false });
const Brand = mongoose.models.Brand || mongoose.model('Brand', BrandSchema, 'brands');

const SupplierSchema = new mongoose.Schema({
  tallyId: String
}, { strict: false });
const Supplier = mongoose.models.Supplier || mongoose.model('Supplier', SupplierSchema, 'suppliers');

const ProductSchema = new mongoose.Schema({
  tallyId: String,
  stockQuantity: Number,
  price: Number,
  basePrice: Number,
  categoryId: mongoose.Schema.Types.ObjectId,
  supplierId: mongoose.Schema.Types.ObjectId
}, { strict: false });
const Product = mongoose.models.Product || mongoose.model('Product', ProductSchema, 'products');

async function fetchFromTally(collectionType, typeName, fetchFields) {
  return new Promise((resolve, reject) => {
    const payload = `<ENVELOPE>
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>EXPORT</TALLYREQUEST>
        <TYPE>COLLECTION</TYPE>
        <ID>${collectionType}Collection</ID>
      </HEADER>
      <BODY>
        <DESC>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            <SVCURRENTCOMPANY>${TALLY_CONFIG.company}</SVCURRENTCOMPANY>
          </STATICVARIABLES>
          <TDL>
            <TDLMESSAGE>
              <COLLECTION NAME="${collectionType}Collection">
                <TYPE>${typeName}</TYPE>
                <FETCH>${fetchFields}</FETCH>
              </COLLECTION>
            </TDLMESSAGE>
          </TDL>
        </DESC>
      </BODY>
    </ENVELOPE>`;

    const req = http.request('http://localhost:9000', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let xmlText = '';
      res.on('data', d => xmlText += d);
      res.on('end', () => resolve(xmlText));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function parseNumber(str) {
  if (!str) return 0;
  if (typeof str === 'object') str = str['#text'] || "";
  if (typeof str !== 'string') return 0;
  // Tally sends " 1.000 Kg" or "100.00/Kg" or "-1000.00"
  const match = str.match(/-?\d+(\.\d+)?/);
  return match ? Math.abs(parseFloat(match[0])) : 0;
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB for Phase 3 Mapping.");

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

  // 1. Fetch & Update Products with Inventory, Pricing, and Category
  console.log("Fetching Stock Items for Inventory/Pricing updates...");
  const itemXml = await fetchFromTally("StockItem", "Stock Item", "NAME,PARENT,CLOSINGBALANCE,STANDARDCOST,STANDARDPRICE");
  const itemData = parser.parse(itemXml);

  let items = [];
  try {
    items = itemData.ENVELOPE.BODY.DATA.COLLECTION.STOCKITEM;
    if (!Array.isArray(items)) items = [items];
  } catch (e) {
    console.log("No items found.");
  }

  let updateCount = 0;
  const brandCache = {}; // Cache to avoid duplicate DB calls for Brands

  for (let item of items) {
    if (!item) continue;
    let name = item.NAME;
    if (typeof name === 'object') name = name['#text'];
    if (!name) continue;

    let parent = item.PARENT;
    if (typeof parent === 'object') parent = parent['#text'] || "Uncategorized";
    if (!parent) parent = "Uncategorized";

    let stockQty = parseNumber(item.CLOSINGBALANCE);
    let basePrice = parseNumber(item.STANDARDCOST);
    let price = parseNumber(item.STANDARDPRICE);

    // Get or Create Brand
    if (!brandCache[parent]) {
      let brandDoc = await Brand.findOne({ name: parent });
      if (!brandDoc) {
        brandDoc = await Brand.create({ name: parent });
      }
      brandCache[parent] = brandDoc._id;
    }
    const categoryId = brandCache[parent];

    // Update Product
    const result = await Product.updateOne(
      { tallyId: name },
      {
        $set: {
          stockQuantity: stockQty,
          basePrice: basePrice,
          price: price,
          categoryId: categoryId
        }
      }
    );

    if (result.modifiedCount > 0) updateCount++;
  }
  console.log(`Updated inventory, pricing, and category for ${updateCount} Products.`);

  // 2. Fetch Purchase Vouchers to infer Supplier relationships
  console.log("Fetching Purchase Vouchers to map Suppliers...");
  const voucherXml = await fetchFromTally("Voucher", "Voucher", "VOUCHERTYPENAME,PARTYLEDGERNAME,ALLINVENTORYENTRIES.LIST");
  const voucherData = parser.parse(voucherXml);

  let vouchers = [];
  try {
    vouchers = voucherData.ENVELOPE.BODY.DATA.COLLECTION.VOUCHER;
    if (!Array.isArray(vouchers)) vouchers = [vouchers];
  } catch (e) {
    console.log("No vouchers found.");
  }

  console.log("Loading Suppliers into memory...");
  const suppliers = await Supplier.find({}, { _id: 1, tallyId: 1 }).lean();
  const supplierMap = {};
  suppliers.forEach(s => { if (s.tallyId) supplierMap[s.tallyId] = s._id; });

  const productSupplierUpdates = {}; // { "ProductTallyId": "SupplierObjectId" }

  for (let v of vouchers) {
    if (!v) continue;
    let typeName = v.VOUCHERTYPENAME;
    if (typeof typeName === 'object') typeName = typeName['#text'] || "";

    if (!typeName || !typeName.toLowerCase().includes("purchase")) continue;

    let partyName = v.PARTYLEDGERNAME;
    if (typeof partyName === 'object') partyName = partyName['#text'] || "";

    const supplierId = supplierMap[partyName];
    if (!supplierId) continue; // Skip if we don't know the supplier

    let inventory = v['ALLINVENTORYENTRIES.LIST'];
    if (!inventory) continue;
    if (!Array.isArray(inventory)) inventory = [inventory];

    for (let inv of inventory) {
      if (!inv) continue;
      let itemName = inv.STOCKITEMNAME;
      if (typeof itemName === 'object') itemName = itemName['#text'] || "";
      if (!itemName) continue;

      // Overwrite with the latest supplier seen for this product
      productSupplierUpdates[itemName] = supplierId;
    }
  }

  const mappedProductsCount = Object.keys(productSupplierUpdates).length;
  console.log(`Inferred supplier relationships for ${mappedProductsCount} distinct Products.`);

  if (mappedProductsCount > 0) {
    console.log("Updating Products with mapped supplierIds...");
    const bulkOps = Object.keys(productSupplierUpdates).map(productName => ({
      updateOne: {
        filter: { tallyId: productName },
        update: { $set: { supplierId: productSupplierUpdates[productName] } }
      }
    }));

    await Product.bulkWrite(bulkOps);
    console.log("✅ Successfully linked Suppliers to Products!");
  }

  console.log("Phase 3 Migration finished.");
  process.exit(0);
}

run().catch(console.error);
