const http = require('http');
const { XMLParser } = require('fast-xml-parser');
const mongoose = require('mongoose');

const TALLY_CONFIG = {
  company: process.env.TALLY_SALES_COMPANY || 'Unifoods'
};


// Need to dynamically import models since they might be ES modules or require Babel.
// In HorecaBackend/src/lib/db/models, the models are ES modules (import/export).
// I will just define raw Mongoose schemas here to avoid module system conflicts for this one-off script,
// or I can try requiring them if babel-register is set up. Let's use raw schemas to be safe and fast.

const MONGO_URI = 'mongodb://sameergaikwaddelxn_db_user:sameer1234@ac-eearv9b-shard-00-00.beh8ogg.mongodb.net:27017,ac-eearv9b-shard-00-01.beh8ogg.mongodb.net:27017,ac-eearv9b-shard-00-02.beh8ogg.mongodb.net:27017/?ssl=true&replicaSet=atlas-dxxsdl-shard-0&authSource=admin&appName=Cluster0';

const CustomerSchema = new mongoose.Schema({
  name: String,
  businessName: String,
  phone: String,
  email: String,
  tallyId: String,
  category: { type: String, default: "C" },
  poMandatory: { type: Boolean, default: false },
  isVerified: { type: Boolean, default: false }
}, { strict: false });
const Customer = mongoose.model('Customer', CustomerSchema, 'customers');

const SupplierSchema = new mongoose.Schema({
  businessName: String,
  email: String,
  password: { type: String, default: "Migration@123" },
  tallyId: String,
  status: { type: String, default: "active" },
  role: { type: String, default: "supplier" }
}, { strict: false });
const Supplier = mongoose.model('Supplier', SupplierSchema, 'suppliers');

const ProductSchema = new mongoose.Schema({
  name: String,
  tallyId: String,
  sku: String,
  unit: String,
  stockQuantity: { type: Number, default: 0 },
  price: { type: Number, default: 0 },
  basePrice: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  categoryId: { type: mongoose.Schema.Types.ObjectId }
}, { strict: false });
const Product = mongoose.model('Product', ProductSchema, 'products');

async function fetchFromTally(collectionType) {
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
                <TYPE>${collectionType}</TYPE>
                <FETCH>NAME,PARENT,BASEUNITS</FETCH>
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

  console.log("Fetching Ledgers from Tally...");
  const ledgerXml = await fetchFromTally("Ledger");
  const ledgerData = parser.parse(ledgerXml);

  let ledgers = [];
  try {
    ledgers = ledgerData.ENVELOPE.BODY.DATA.COLLECTION.LEDGER;
    if (!Array.isArray(ledgers)) ledgers = [ledgers];
  } catch (e) {
    console.log("No ledgers found or bad XML format.");
  }

  let custCount = 0, suppCount = 0;
  for (let i = 0; i < ledgers.length; i++) {
    if (!ledgers[i]) continue;
    const name = ledgers[i].NAME;
    let parent = ledgers[i].PARENT;
    if (!name || !parent) continue;

    if (typeof parent === 'object') parent = parent['#text'] || '';
    const parentUpper = parent.toUpperCase();
    if (parentUpper.includes("CREDITOR") || parentUpper.includes("SUPPLIER")) {
      // It's a Supplier
      const exists = await Supplier.findOne({ tallyId: name });
      if (!exists) {
        await Supplier.create({
          businessName: name,
          tallyId: name,
          email: `${name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}@placeholder.com`
        });
        suppCount++;
      }
    } else {
      // Treat as Customer
      const exists = await Customer.findOne({ tallyId: name });
      if (!exists) {
        await Customer.create({
          name: name,
          businessName: name,
          tallyId: name,
          phone: `99000${Math.floor(10000 + Math.random() * 90000)}`, // 10 digit random
          email: `${name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}${Math.floor(Math.random() * 1000)}@placeholder.com`
        });
        custCount++;
      }
    }
  }

  console.log(`Processed Ledgers. New Customers: ${custCount}, New Suppliers: ${suppCount}`);

  console.log("Fetching Stock Items from Tally...");
  const itemXml = await fetchFromTally("StockItem");
  const itemData = parser.parse(itemXml);

  let items = [];
  try {
    items = itemData.ENVELOPE.BODY.DATA.COLLECTION.STOCKITEM;
    if (!Array.isArray(items)) items = [items];
  } catch (e) {
    console.log("No items found or bad XML format.");
  }

  let itemCount = 0;
  for (let i = 0; i < items.length; i++) {
    if (!items[i]) continue;
    const name = items[i].NAME;
    let unit = items[i].BASEUNITS || "Kg";
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

  console.log(`Processed Stock Items. New Products: ${itemCount}`);
  console.log("Migration finished.");
  process.exit(0);
}

run().catch(console.error);
