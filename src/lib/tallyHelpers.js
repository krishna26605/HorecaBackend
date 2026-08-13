// Helper to escape XML characters
export const escapeXML = (str) => {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
};

// Helper to map units to Tally active unit name
export const mapMongooseUnitToTally = (mongooseUnit) => {
  if (!mongooseUnit) return "Nos";
  const normalized = String(mongooseUnit).trim().toLowerCase();
  switch (normalized) {
    case "kg":
    case "kilogram":
    case "kilograms":
      return "Kg";
    case "g":
    case "gram":
    case "grams":
      return "Kg";
    case "liters":
    case "liter":
    case "ml":
    case "milliliter":
    case "ltr":
      return "Ltr";
    case "pcs":
    case "piece":
    case "pieces":
    case "nos":
    case "box":
    case "dozen":
    case "pack":
    case "ton":
    default:
      return "Nos";
  }
};

// Helper to format Date as YYYYMMDD with educational mode support
export const formatTallyDate = (dateVal) => {
  const d = dateVal ? new Date(dateVal) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  let dd = String(d.getDate()).padStart(2, '0');

  // Normalization for Tally Educational Mode in Dev/Testing
  const tallyUrl = process.env.TALLY_URL || '';
  const isDevTally = !tallyUrl || tallyUrl.includes('ngrok') || tallyUrl.includes('localhost') || process.env.NODE_ENV !== 'production';
  if (isDevTally && dd !== '01' && dd !== '02' && dd !== '31') {
    dd = '01'; // Force to 1st of the month
  }

  return `${yyyy}${mm}${dd}`;
};

// Helper to parse Tally responses
export function parseTallyResponse(xmlString) {
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

// Helper to fetch all Debtors from Tally (including custom customerGroup parents)
export async function fetchTallyDebtors(tallyUrl, companyName, customerGroup) {
  const payload = `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>EXPORT</TALLYREQUEST>
    <TYPE>COLLECTION</TYPE>
    <ID>LedgerCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${escapeXML(companyName)}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="LedgerCollection">
            <TYPE>Ledger</TYPE>
            <FETCH>NAME,PARENT</FETCH>
            <FILTER>DebtorsFilter</FILTER>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="DebtorsFilter">
            $Parent = "Sundry Debtors"${customerGroup ? ` or $Parent = "${escapeXML(customerGroup)}"` : ""}
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

  try {
    const res = await fetch(tallyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: payload
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const matches = [...xml.matchAll(/<LEDGER NAME="([^"]+)"[^>]*>/g)];
    const ledgers = matches.map(m => m[1]);
    return ledgers;
  } catch (err) {
    console.error("[Tally Sync] Failed to fetch debtors from Tally:", err);
    return [];
  }
}

// Helper to match customer info to Tally debtors
export function findMatchingTallyLedger(tallyLedgers, customerDoc, orderDoc) {
  const searchTerms = [
    customerDoc?.businessName,
    customerDoc?.name,
    customerDoc?.shopName,
    orderDoc?.shippingAddress?.fullName
  ].filter(Boolean).map(s => s.toLowerCase().trim());

  if (searchTerms.length === 0) return "Anup and Co";

  for (const term of searchTerms) {
    const exact = tallyLedgers.find(l => l.toLowerCase().trim() === term);
    if (exact) return exact;
  }

  for (const term of searchTerms) {
    const match = tallyLedgers.find(l => {
      const normalizedL = l.toLowerCase().trim();
      return normalizedL.startsWith(term) || term.startsWith(normalizedL) || normalizedL.includes(term) || term.includes(normalizedL);
    });
    if (match) return match;
  }

  return "Anup and Co";
}

// Function to construct the Tally Sales Voucher XML
export function buildTallySalesVoucherXML(order, productMap, companyName, userObject, partyLedgerName, options = {}) {
  const { isOptional = false, isAlter = false, remoteId = null } = options;
  const dateStr = formatTallyDate(order.placedAt || order.createdAt || new Date());

  const rawPartyName = partyLedgerName || "Anup and Co";
  const partyName = escapeXML(rawPartyName);

  const orderNumber = escapeXML(order.orderNumber);

  let computedTotal = 0;

  const itemsXml = order.items.map(item => {
    const itemName = escapeXML(item.name);
    const qty = parseFloat(item.quantity) || 0;
    const unitPrice = parseFloat(item.unitPrice) || 0;
    const itemTotal = qty * unitPrice;
    computedTotal += itemTotal;

    const productIdStr = (item.product?._id || item.product || "").toString();
    const productDoc = productMap[productIdStr];

    const qtyStr = `${qty}`;
    const rateStr = `${unitPrice}`;
    const amountStr = itemTotal.toFixed(2);

    const rootWarehouse = productDoc?.locationPath 
      ? productDoc.locationPath.split(' > ')[0] 
      : 'Unifoods Warehouse';

    return `<ALLINVENTORYENTRIES.LIST>
       <STOCKITEMNAME>${itemName}</STOCKITEMNAME>
       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
       <RATE>${rateStr}</RATE>
       <AMOUNT>${amountStr}</AMOUNT>
       <ACTUALQTY>${qtyStr}</ACTUALQTY>
       <BILLEDQTY>${qtyStr}</BILLEDQTY>

       <BATCHALLOCATIONS.LIST>
        <GODOWNNAME>${escapeXML(rootWarehouse)}</GODOWNNAME>
        <BATCHNAME>Batch1</BATCHNAME>
        <AMOUNT>${amountStr}</AMOUNT>
        <ACTUALQTY>${qtyStr}</ACTUALQTY>
        <BILLEDQTY>${qtyStr}</BILLEDQTY>
       </BATCHALLOCATIONS.LIST>

       <ACCOUNTINGALLOCATIONS.LIST>
        <LEDGERNAME>Sales</LEDGERNAME>
        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
        <AMOUNT>${amountStr}</AMOUNT>
       </ACCOUNTINGALLOCATIONS.LIST>
      </ALLINVENTORYENTRIES.LIST>`;
  }).join("\n");

  const totalAmountStr = (-computedTotal).toFixed(2);

  const xmlStr = `<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Vouchers</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${escapeXML(companyName)}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER ${remoteId ? `REMOTEID="${escapeXML(remoteId)}"` : ''} VCHTYPE="Sales" ACTION="${isAlter ? 'Alter' : 'Create'}" OBJVIEW="Invoice Voucher View">
      <DATE>${dateStr}</DATE>
      <VCHSTATUSDATE>${dateStr}</VCHSTATUSDATE>
      <EFFECTIVEDATE>${dateStr}</EFFECTIVEDATE>
      <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
      <PARTYLEDGERNAME>${userObject && userObject._id ? escapeXML(userObject._id.toString()) : partyName}</PARTYLEDGERNAME>
      <PARTYNAME>${partyName}</PARTYNAME>
      <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
      <VCHENTRYMODE>Item Invoice</VCHENTRYMODE>
      <DIFFACTUALQTY>Yes</DIFFACTUALQTY>
      <ISINVOICE>Yes</ISINVOICE>
      ${isOptional ? '<ISOPTIONAL>Yes</ISOPTIONAL>' : '<ISOPTIONAL>No</ISOPTIONAL>'}

      ${itemsXml}

      <LEDGERENTRIES.LIST>
       <LEDGERNAME>${userObject && userObject._id ? escapeXML(userObject._id.toString()) : partyName}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
       <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
       <AMOUNT>${totalAmountStr}</AMOUNT>
       <BILLALLOCATIONS.LIST>
        <NAME>${orderNumber}</NAME>
        <BILLTYPE>New Ref</BILLTYPE>
        <AMOUNT>${totalAmountStr}</AMOUNT>
       </BILLALLOCATIONS.LIST>
      </LEDGERENTRIES.LIST>
     </VOUCHER>
    </TALLYMESSAGE>
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;

  return xmlStr;
}

// Function to construct the Tally Payment Voucher XML
export function buildTallyPaymentVoucherXML(order, companyName, userObject, partyLedgerName) {
  const dateStr = formatTallyDate(order.placedAt || order.createdAt || new Date());
  
  const rawPartyName = partyLedgerName || "Anup and Co";
  const partyName = escapeXML(rawPartyName);
  
  const orderNumber = escapeXML(order.orderNumber);
  const totalAmountStr = parseFloat(order.total || 0).toFixed(2);

  const xmlStr = `<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Vouchers</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${escapeXML(companyName)}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="Payment" ACTION="Create" OBJVIEW="Accounting Voucher View">
      <DATE>${dateStr}</DATE>
      <VCHSTATUSDATE>${dateStr}</VCHSTATUSDATE>
      <EFFECTIVEDATE>${dateStr}</EFFECTIVEDATE>
      <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
      <PARTYLEDGERNAME>${userObject && userObject._id ? escapeXML(userObject._id.toString()) : partyName}</PARTYLEDGERNAME>
      <PARTYNAME>${partyName}</PARTYNAME>
      <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>

      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>${userObject && userObject._id ? escapeXML(userObject._id.toString()) : partyName}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
       <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
       <AMOUNT>-${totalAmountStr}</AMOUNT>
       <BILLALLOCATIONS.LIST>
        <NAME>${orderNumber}</NAME>
        <BILLTYPE>New Ref</BILLTYPE>
        <AMOUNT>-${totalAmountStr}</AMOUNT>
       </BILLALLOCATIONS.LIST>
      </ALLLEDGERENTRIES.LIST>

      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>Cash</LEDGERNAME>
       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
       <AMOUNT>${totalAmountStr}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
     </VOUCHER>
    </TALLYMESSAGE>
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;

  return xmlStr;
}

export function buildTallyDeleteVoucherXML(companyName, remoteId) {
  return `<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Vouchers</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${escapeXML(companyName)}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER REMOTEID="${escapeXML(remoteId)}" ACTION="Delete" VCHTYPE="Sales">
     </VOUCHER>
    </TALLYMESSAGE>
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;
}
