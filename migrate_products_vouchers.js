const http = require('http');
const { XMLParser } = require('fast-xml-parser');
const mongoose = require('mongoose');

const MONGO_URI = 'mongodb://sameergaikwaddelxn_db_user:sameer1234@ac-eearv9b-shard-00-00.beh8ogg.mongodb.net:27017,ac-eearv9b-shard-00-01.beh8ogg.mongodb.net:27017,ac-eearv9b-shard-00-02.beh8ogg.mongodb.net:27017/?ssl=true&replicaSet=atlas-dxxsdl-shard-0&authSource=admin&appName=Cluster0';
const TALLY_CONFIG = {
  company: process.env.TALLY_SALES_COMPANY || 'Unifoods'
};

const CustomerSchema = new mongoose.Schema({
  name: String,
  tallyId: String
}, { strict: false });
const Customer = mongoose.models.Customer || mongoose.model('Customer', CustomerSchema, 'customers');

const ProductSchema = new mongoose.Schema({
  name: String,
  tallyId: String,
  sku: String,
  unit: String
}, { strict: false });
const Product = mongoose.models.Product || mongoose.model('Product', ProductSchema, 'products');

// Simplified Order Schema for bulk insert
const OrderSchema = new mongoose.Schema({
  orderNumber: String,
  user: mongoose.Schema.Types.ObjectId,
  userModel: String,
  items: Array,
  subtotal: Number,
  total: Number,
  status: String,
  placedAt: Date,
  orderSource: String
}, { strict: false });
const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema, 'orders');

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

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB.");

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

  // 1. Fetch & Insert Products (Stock Item)
  console.log("Fetching Stock Items from Tally...");
  const itemXml = await fetchFromTally("StockItem", "Stock Item", "NAME,BASEUNITS");
  const itemData = parser.parse(itemXml);

  let items = [];
  try {
    items = itemData.ENVELOPE.BODY.DATA.COLLECTION.STOCKITEM;
    if (!Array.isArray(items)) items = [items];
  } catch (e) {
    console.log("No items found.");
  }

  let itemCount = 0;
  for (let i = 0; i < items.length; i++) {
    if (!items[i]) continue;
    const name = items[i].NAME;
    let unit = items[i].BASEUNITS || "Kg";
    if (typeof unit === 'object') unit = unit['#text'] || "Kg";
    if (!name) continue;

    const exists = await Product.findOne({ tallyId: name });
    if (!exists) {
      await Product.create({
        name: name,
        tallyId: name,
        sku: "PRD-" + Math.floor(100000 + Math.random() * 900000),
        unit: unit
      });
      itemCount++;
    }
  }
  console.log(`Inserted ${itemCount} new Products.`);

  // Build in-memory maps for fast voucher linking
  console.log("Loading Customers and Products into memory for mapping...");
  const customers = await Customer.find({}, { _id: 1, tallyId: 1 }).lean();
  const customerMap = {};
  customers.forEach(c => { if (c.tallyId) customerMap[c.tallyId] = c._id; });

  const products = await Product.find({}, { _id: 1, tallyId: 1 }).lean();
  const productMap = {};
  products.forEach(p => { if (p.tallyId) productMap[p.tallyId] = p._id; });

  // 2. Fetch Vouchers (Orders)
  console.log("Fetching Vouchers from Tally...");
  const voucherXml = await fetchFromTally("Voucher", "Voucher", "VOUCHERTYPENAME,DATE,PARTYLEDGERNAME,ALLINVENTORYENTRIES.LIST,VOUCHERNUMBER");
  const voucherData = parser.parse(voucherXml);

  let vouchers = [];
  try {
    vouchers = voucherData.ENVELOPE.BODY.DATA.COLLECTION.VOUCHER;
    if (!Array.isArray(vouchers)) vouchers = [vouchers];
  } catch (e) {
    console.log("No vouchers found.");
  }

  const ordersToInsert = [];

  for (let v of vouchers) {
    if (!v) continue;
    let typeName = v.VOUCHERTYPENAME;
    if (typeof typeName === 'object') typeName = typeName['#text'] || "";

    // As requested: "use only now sales voucher"
    if (!typeName || !typeName.toLowerCase().includes("sales")) continue;

    let partyName = v.PARTYLEDGERNAME;
    if (typeof partyName === 'object') partyName = partyName['#text'] || "";

    const customerId = customerMap[partyName];
    if (!customerId) continue; // Skip if we don't know the customer

    let vchNumber = v.VOUCHERNUMBER || `VCH-${Math.floor(Math.random() * 999999)}`;
    if (typeof vchNumber === 'object') vchNumber = vchNumber['#text'] || `VCH-${Math.floor(Math.random() * 999999)}`;

    let vchDate = v.DATE; // YYYYMMDD
    if (typeof vchDate === 'object') vchDate = vchDate['#text'];
    let placedAt = new Date();
    if (vchDate && typeof vchDate === 'string' && vchDate.length >= 8) {
      const y = vchDate.substring(0, 4), m = vchDate.substring(4, 6), d = vchDate.substring(6, 8);
      placedAt = new Date(`${y}-${m}-${d}`);
    }

    let inventory = v['ALLINVENTORYENTRIES.LIST'];
    if (!inventory) continue;
    if (!Array.isArray(inventory)) inventory = [inventory];

    const orderItems = [];
    let orderTotal = 0;

    for (let inv of inventory) {
      if (!inv) continue;
      let itemName = inv.STOCKITEMNAME;
      if (typeof itemName === 'object') itemName = itemName['#text'] || "";

      const productId = productMap[itemName];
      if (!productId) continue;

      let qtyStr = inv.BILLEDQTY;
      if (typeof qtyStr === 'object') qtyStr = qtyStr['#text'] || "";
      let qty = parseFloat(qtyStr) || 1;

      let rateStr = inv.RATE;
      if (typeof rateStr === 'object') rateStr = rateStr['#text'] || "";
      let rate = parseFloat(rateStr) || 0;

      let amountStr = inv.AMOUNT;
      if (typeof amountStr === 'object') amountStr = amountStr['#text'] || "";
      let amount = Math.abs(parseFloat(amountStr) || 0);

      orderItems.push({
        product: productId,
        name: itemName,
        quantity: Math.abs(qty),
        unitPrice: Math.abs(rate) || (amount / Math.abs(qty) || 0),
        totalPrice: amount
      });
      orderTotal += amount;
    }

    if (orderItems.length === 0) continue;

    ordersToInsert.push({
      orderNumber: vchNumber + "-" + Math.floor(Math.random() * 1000), // Ensure unique
      user: customerId,
      userModel: "Customer",
      items: orderItems,
      subtotal: orderTotal,
      total: orderTotal,
      status: "delivered", // Historical orders are delivered
      placedAt: placedAt,
      orderSource: "Customer" // Required by schema
    });
  }

  console.log(`Parsed ${ordersToInsert.length} Sales Vouchers.`);

  if (ordersToInsert.length > 0) {
    console.log("Inserting Vouchers into MongoDB (bypassing Mongoose hooks)...");
    // insertMany avoids firing the 'save' hook which sends notifications!
    try {
      await Order.insertMany(ordersToInsert, { ordered: false });
      console.log("✅ Successfully inserted all historical Vouchers!");
    } catch (e) {
      if (e.code === 11000) {
        console.log("Insertion completed with some duplicate key errors (ignored).");
      } else {
        console.error("Error inserting vouchers:", e.message);
      }
    }
  }

  console.log("Phase 2 Migration finished.");
  process.exit(0);
}

run().catch(console.error);
