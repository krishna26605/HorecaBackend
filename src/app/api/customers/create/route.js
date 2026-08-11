import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import dbConnect from "@/lib/db/connect";
import Customer from "@/lib/db/models/customer";
import { sendCustomerWelcomeEmail } from "@/lib/mail";

// Helper to geocode address to lat/lng using Nominatim OSM
async function geocodeAddress(addressStr) {
  if (!addressStr || addressStr.trim().length < 5) return null;
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(addressStr)}&format=json&addressdetails=1&countrycodes=in&limit=1`;
    const res = await fetch(url, { headers: { "User-Agent": "SCM-Logistics-App/1.0" } });
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon)
      };
    }
  } catch (err) {
    console.error("[geocodeAddress] Geocoding fallback error:", err);
  }
  return null;
}

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

// Helper to format Date for Tally (YYYYMMDD)
const formatTallyDate = (dateVal) => {
  if (!dateVal) return "";
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
};

// Helper to build Customer XML for Tally
function buildCustomerXML(customer) {
  const name = escapeXML(customer.name || customer.businessName || customer.phone || "Unknown Customer");
  const mongoId = escapeXML(customer._id.toString());
  const mailingName = escapeXML(customer.businessName || customer.name || customer.phone || "Unknown Customer");
  
  const address = escapeXML(customer.address || "");
  const city = escapeXML(customer.city || "");
  const state = escapeXML(customer.state || "Maharashtra");
  const pincode = escapeXML(customer.pincode || "");
  
  const phone = escapeXML(customer.phone || "");
  const email = escapeXML(customer.email || "");
  const gstNumber = escapeXML(customer.gstNumber || ""); 

  let addressXml = "";
  if (address || city) {
    addressXml = `<ADDRESS.LIST TYPE="String">
              ${address ? `<ADDRESS>${address}</ADDRESS>` : ''}
              ${city ? `<ADDRESS>${city}</ADDRESS>` : ''}
            </ADDRESS.LIST>`;
  }

  return `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES><SVCURRENTCOMPANY>Unifoods</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${name}" ACTION="Create">
            <NAME>${name}</NAME>
            <LANGUAGENAME.LIST>
              <NAME.LIST TYPE="String">
                <NAME>${name}</NAME>
                <NAME>${mongoId}</NAME>
              </NAME.LIST>
              <LANGUAGECODE> 1033</LANGUAGECODE>
            </LANGUAGENAME.LIST>
            <PARENT>${escapeXML(customer.customerGroup || "Sundry Debtors")}</PARENT>
            <ISBILLWISEON>Yes</ISBILLWISEON>
            <MAILINGNAME>${mailingName}</MAILINGNAME>
            ${addressXml}
            <STATENAME>${state}</STATENAME>
            <COUNTRYNAME>India</COUNTRYNAME>
            ${pincode ? `<PINCODE>${pincode}</PINCODE>` : ''}
            ${phone ? `<MOBILE>${phone}</MOBILE>` : ''}
            ${email ? `<EMAIL>${email}</EMAIL>` : ''}
            <GSTREGISTRATIONTYPE>${gstNumber ? 'Regular' : 'Unregistered'}</GSTREGISTRATIONTYPE>
            ${gstNumber ? `<PARTYGSTIN>${gstNumber}</PARTYGSTIN>` : ''}
            ${customer.gstEffectiveDate ? `<GSTAPPLICABLEDATE>${formatTallyDate(customer.gstEffectiveDate)}</GSTAPPLICABLEDATE>` : ''}
          </LEDGER>
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
  console.log("🔥 HIT /api/customers/create");

  try {
    await dbConnect();
    console.log("🟢 MongoDB Connected");

    const body = await request.json().catch(() => ({}));
    console.log("📩 Request Body:", body);

    const { phone, name, email, address, city, state, pincode, lat, lng, customerType, department, hasMultipleOutlets, outlets, isContractBased, contract, contractType, contractDocumentUrl, contractStartDate, contractExpiryDate, contractNotes, contracts } = body;

    if (!phone) {
      console.log("❌ Missing phone");
      return NextResponse.json(
        { success: false, error: "Phone is required" },
        { status: 400 }
      );
    }

    console.log("➡️ Phone:", phone);

    // Normalize: strip non-digits
    const numericPhone = phone.replace(/\D/g, "");
    // Standardize: ensure +91 for 10-digit Indian numbers
    const standardizedPhone = (numericPhone.length === 10) ? `+91${numericPhone}` : 
                              (numericPhone.length === 12 && numericPhone.startsWith("91")) ? `+${numericPhone}` :
                              phone.trim();

    // Look for variations to match existing users
    const variations = [phone.trim(), standardizedPhone, numericPhone];
    if (numericPhone.length === 12 && numericPhone.startsWith("91")) {
        variations.push(numericPhone.slice(2)); // handle without 91
    } else if (numericPhone.length === 10) {
        variations.push("91" + numericPhone); // handle with 91
    }

    // Does customer already exist?
    let customer = await Customer.findOne({ phone: { $in: variations } });

    if (customer) {
      console.log("🟡 Existing customer found:", customer._id);

      // Update lastLoginAt
      customer.lastLoginAt = new Date();
      await customer.save();

      return NextResponse.json({
        success: true,
        message: "Customer already exists. Returning record.",
        data: customer,
      });
    }

    // Create new customer
    console.log("🆕 Creating new customer…");

    const generateSystemPassword = () => {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
      let randomStr = "";
      for (let i = 0; i < 6; i++) {
        randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return `Unifoods@${randomStr}`;
    };

    const rawPassword = body.password ? body.password.trim() : generateSystemPassword();
    const generatedUsername = email ? email.toLowerCase().trim() : (body.username ? body.username.trim() : (name ? name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) : numericPhone));

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(rawPassword, salt);

    // Geocode additional outlets and primary address if coordinates are missing
    let finalLat = lat ?? null;
    let finalLng = lng ?? null;
    if (finalLat == null || finalLng == null) {
      const fullAddr = `${address || ""}, ${city || ""}, ${state || ""}, ${pincode || ""}`;
      const coords = await geocodeAddress(fullAddr);
      if (coords) {
        finalLat = coords.lat;
        finalLng = coords.lng;
      }
    }

    const formattedOutlets = [];
    if (Array.isArray(outlets)) {
      for (let i = 0; i < outlets.length; i++) {
        const o = outlets[i];
        let oLat = o.lat != null ? o.lat : null;
        let oLng = o.lng != null ? o.lng : null;
        if (oLat == null || oLng == null) {
          const fullAddr = `${o.address || ""}, ${o.city || ""}, ${o.state || ""}, ${o.pincode || ""}`;
          const coords = await geocodeAddress(fullAddr);
          if (coords) {
            oLat = coords.lat;
            oLng = coords.lng;
          }
        }
        formattedOutlets.push({
          outletName: o.outletName?.trim() || "",
          address: o.address?.trim() || "",
          city: o.city?.trim() || "",
          state: o.state?.trim() || "",
          pincode: o.pincode?.trim() || "",
          contactPerson: o.contactPerson?.trim() || null,
          contactPhone: o.contactPhone?.trim() || null,
          contactEmail: o.contactEmail?.trim() || null,
          assignedRoute: o.assignedRoute || null,
          routeName: o.routeName || null,
          routeCode: o.routeCode || null,
          lat: oLat,
          lng: oLng,
          hasFssai: o.hasFssai !== undefined ? Boolean(o.hasFssai) : true,
          fssaiNumber: o.fssaiNumber?.trim() || null,
          fssaiExpiryDate: o.fssaiExpiryDate ? new Date(o.fssaiExpiryDate) : null,
          fssaiDocUrl: o.fssaiDocUrl?.trim() || null,
          fssaiUndertakingDocUrl: o.fssaiUndertakingDocUrl?.trim() || null,
          password: o.password || null
        });
      }
    }

    // Check duplicates for outlets in manual creation
    if (Array.isArray(formattedOutlets)) {
      for (let i = 0; i < formattedOutlets.length; i++) {
        const o = formattedOutlets[i];
        if (!o.contactEmail || !o.contactPhone) {
          return NextResponse.json({ success: false, error: `Outlet #${i + 1} is missing required Contact Email or Phone number` }, { status: 400 });
        }

        const existingOutletUser = await Customer.findOne({
          $or: [
            { username: o.contactEmail.toLowerCase().trim() },
            { email: o.contactEmail.toLowerCase().trim() },
            { phone: o.contactPhone.trim() }
          ]
        });

        if (existingOutletUser) {
          return NextResponse.json({
            success: false,
            error: `Outlet #${i + 1} contact details (${o.contactEmail} / ${o.contactPhone}) already registered to another user`
          }, { status: 409 });
        }
      }
    }

    const newCustomer = await Customer.create({
      username: generatedUsername,
      password: hashedPassword,
      phone: standardizedPhone,
      name: name ?? null,
      email: email ?? null,
      address: address ?? null,
      city: city ?? null,
      state: state ?? null,
      pincode: pincode ?? null,
      lat: finalLat,
      lng: finalLng,
      location: finalLat != null && finalLng != null ? { type: "Point", coordinates: [finalLng, finalLat] } : undefined,
      businessName: body.businessName?.trim() || name?.trim() || null,
      gstNumber: body.gstNumber?.trim() || null,
      gstEffectiveDate: body.gstEffectiveDate || null,
      gstDocUrl: body.gstDocUrl || null,
      category: body.category || "C",
      customerGroup: body.customerGroup || body.tallyGroup || "Sundry Debtors",
      advanceBalance: Number(body.advanceAmount || 0),
      hasPaidAdvance: body.hasPaidAdvance !== undefined ? Boolean(body.hasPaidAdvance) : false,
      advancePaymentMode: body.advancePaymentMode || null,
      advancePaymentProofUrl: body.advancePaymentProofUrl || null,
      poMandatory: Boolean(body.poMandatory),
      licenseImage: body.licenseImage || null,
      customerType: customerType ?? null,
      department: department ?? null,
      panNumber: body.panNumber ? body.panNumber.trim().toUpperCase() : null,
      assignedRoute: body.assignedRoute || null,
      routeName: body.routeName || null,
      routeCode: body.routeCode || null,
      creditTerm: Number(body.creditTerm || 0),
      creditLimit: Number(body.creditLimit || 0),
      hasMultipleOutlets: Boolean(hasMultipleOutlets),
      source: body.source || "SCM Onboarding",
      departmentContacts: {
        art: {
          name: body.departmentContacts?.art?.name?.trim() || null,
          phone: body.departmentContacts?.art?.phone?.trim() || null,
          email: body.departmentContacts?.art?.email?.trim() || null
        },
        act: {
          name: body.departmentContacts?.act?.name?.trim() || null,
          phone: body.departmentContacts?.act?.phone?.trim() || null,
          email: body.departmentContacts?.act?.email?.trim() || null
        },
        odt: {
          name: body.departmentContacts?.odt?.name?.trim() || null,
          phone: body.departmentContacts?.odt?.phone?.trim() || null,
          email: body.departmentContacts?.odt?.email?.trim() || null
        },
        scm: {
          name: body.departmentContacts?.scm?.name?.trim() || null,
          phone: body.departmentContacts?.scm?.phone?.trim() || null,
          email: body.departmentContacts?.scm?.email?.trim() || null
        },
        routePlanner: {
          name: body.departmentContacts?.routePlanner?.name?.trim() || null,
          phone: body.departmentContacts?.routePlanner?.phone?.trim() || null,
          email: body.departmentContacts?.routePlanner?.email?.trim() || null
        }
      },
      outlets: formattedOutlets,
      locations: [
        {
          outletName: "Main Branch",
          address: address?.trim() || "",
          city: city?.trim() || "",
          state: state?.trim() || "",
          pincode: pincode?.trim() || "",
          contactPerson: body.locations?.[0]?.contactPerson?.trim() || name?.trim() || null,
          contactPhone: body.locations?.[0]?.contactPhone?.trim() || phone?.trim() || null,
          contactEmail: body.locations?.[0]?.contactEmail?.trim() || email?.trim() || null,
          assignedRoute: body.locations?.[0]?.assignedRoute || body.assignedRoute || null,
          routeName: body.locations?.[0]?.routeName || body.routeName || null,
          routeCode: body.locations?.[0]?.routeCode || body.routeCode || null,
          lat: finalLat,
          lng: finalLng,
          isPrimary: true
        },
        ...formattedOutlets.map(o => ({
          outletName: o.outletName,
          address: o.address,
          city: o.city,
          state: o.state,
          pincode: o.pincode,
          contactPerson: o.contactPerson,
          contactPhone: o.contactPhone,
          contactEmail: o.contactEmail,
          assignedRoute: o.assignedRoute,
          routeName: o.routeName,
          routeCode: o.routeCode,
          lat: o.lat,
          lng: o.lng,
          isPrimary: false,
          hasFssai: o.hasFssai,
          fssaiNumber: o.fssaiNumber,
          fssaiExpiryDate: o.fssaiExpiryDate,
          fssaiDocUrl: o.fssaiDocUrl,
          fssaiUndertakingDocUrl: o.fssaiUndertakingDocUrl
        }))
      ],
      urdDocUrl: body.urdDocUrl || body.urcDocUrl || null,
      hasFssai: body.hasFssai !== undefined ? Boolean(body.hasFssai) : true,
      fssaiNumber: body.fssaiNumber ? body.fssaiNumber.trim() : null,
      fssaiExpiryDate: body.fssaiExpiryDate ? new Date(body.fssaiExpiryDate) : null,
      fssaiDocUrl: body.fssaiDocUrl || null,
      fssaiUndertakingDocUrl: body.fssaiUndertakingDocUrl || null,
      licenseExpiryDate: body.licenseExpiryDate ? new Date(body.licenseExpiryDate) : null,
      isContractBased: Boolean(isContractBased),
      contract: isContractBased && Array.isArray(contracts) && contracts.length > 0 ? {
        contractType: contracts[0].contractType || null,
        documentUrl: contracts[0].documentUrl || null,
        startDate: contracts[0].startDate ? new Date(contracts[0].startDate) : null,
        expiryDate: contracts[0].expiryDate ? new Date(contracts[0].expiryDate) : null,
        notes: contracts[0].notes || null,
        uploadedAt: new Date()
      } : (isContractBased ? {
        contractType: contract?.contractType || contractType || null,
        documentUrl: contract?.documentUrl || contractDocumentUrl || null,
        startDate: contract?.startDate || contractStartDate ? new Date(contract?.startDate || contractStartDate) : null,
        expiryDate: contract?.expiryDate || contractExpiryDate ? new Date(contract?.expiryDate || contractExpiryDate) : null,
        notes: contract?.notes || contractNotes || null,
        uploadedAt: new Date()
      } : undefined),
      contracts: isContractBased && Array.isArray(contracts) ? contracts.map(c => ({
        brandId: c.brandId || null,
        brandName: c.brandName || null,
        contractType: c.contractType || null,
        documentUrl: c.documentUrl || null,
        startDate: c.startDate ? new Date(c.startDate) : null,
        expiryDate: c.expiryDate ? new Date(c.expiryDate) : null,
        notes: c.notes || null,
        uploadedAt: new Date()
      })) : [],
      lastLoginAt: new Date(),
    });

    console.log("🟢 Customer Created:", newCustomer._id);

    // 📧 Send Automated Welcome Email to Customer
    try {
      if (newCustomer.email) {
        const isUrgCustomer = body.isUrg || body.gstNumber === "URG" || newCustomer.gstNumber === "URG";
        await sendCustomerWelcomeEmail({
          email: newCustomer.email,
          name: newCustomer.name || newCustomer.businessName,
          businessName: newCustomer.businessName || newCustomer.name || "Valued Business",
          username: newCustomer.username || newCustomer.phone,
          password: rawPassword,
          gstNumber: isUrgCustomer ? "URG" : (newCustomer.gstNumber || "URG"),
          creditTerm: newCustomer.creditTerm || 0,
          creditLimit: newCustomer.creditLimit || 0,
          customerId: newCustomer._id.toString()
        });
        console.log(`[Email Notification] Welcome email sent to ${newCustomer.email}`);
      }
    } catch (mailErr) {
      console.error("[Email Notification Error] Failed to send email:", mailErr);
    }

    // Create separate accounts for each additional outlet/branch in manual creation
    if (hasMultipleOutlets && Array.isArray(formattedOutlets)) {
      for (let i = 0; i < formattedOutlets.length; i++) {
        const o = formattedOutlets[i];
        
        let outletRawPassword = o.password ? o.password.trim() : "";
        if (!outletRawPassword) {
          outletRawPassword = generateSystemPassword();
        }
        const outletSalt = await bcrypt.genSalt(10);
        const outletHashedPassword = await bcrypt.hash(outletRawPassword, outletSalt);

        // Normalize Phone for outlet
        const outPhone = o.contactPhone.trim();
        const numericOutPhone = outPhone.replace(/\D/g, "");
        const standardizedOutPhone = (numericOutPhone.length === 10) ? `+91${numericOutPhone}` :
          (numericOutPhone.length === 12 && numericOutPhone.startsWith("91")) ? `+${numericOutPhone}` :
            outPhone;

        const outletUser = await Customer.create({
          username: o.contactEmail.toLowerCase().trim(),
          password: outletHashedPassword,
          phone: standardizedOutPhone,
          name: `${newCustomer.businessName} - ${o.outletName}`,
          email: o.contactEmail.toLowerCase().trim(),
          address: o.address,
          city: o.city,
          state: o.state,
          pincode: o.pincode,
          lat: o.lat,
          lng: o.lng,
          location: o.lat != null && o.lng != null ? { type: "Point", coordinates: [o.lng, o.lat] } : undefined,
          businessName: newCustomer.businessName,
          gstNumber: newCustomer.gstNumber,
          gstEffectiveDate: newCustomer.gstEffectiveDate,
          gstDocUrl: newCustomer.gstDocUrl,
          category: newCustomer.category,
          customerGroup: newCustomer.customerGroup,
          assignedRoute: o.assignedRoute,
          routeName: o.routeName,
          routeCode: o.routeCode,
          hasFssai: o.hasFssai,
          fssaiNumber: o.fssaiNumber,
          fssaiExpiryDate: o.fssaiExpiryDate,
          fssaiDocUrl: o.fssaiDocUrl,
          fssaiUndertakingDocUrl: o.fssaiUndertakingDocUrl,
          licenseImage: newCustomer.licenseImage,
          hasMultipleOutlets: false,
          source: newCustomer.source,
          lastLoginAt: new Date()
        });

        // Send Welcome Email to outlet email
        if (o.contactEmail) {
          try {
            const isUrgCustomer = newCustomer.gstNumber === "URD" || newCustomer.gstNumber === "URG" || !newCustomer.gstNumber;
            console.log(`[Email Dispatcher] Sending manual outlet welcome email to: ${o.contactEmail}`);
            const outMailRes = await sendCustomerWelcomeEmail({
              email: o.contactEmail.toLowerCase().trim(),
              name: `${newCustomer.businessName} - ${o.outletName}`,
              businessName: newCustomer.businessName,
              username: o.contactEmail.toLowerCase().trim(),
              password: outletRawPassword,
              gstNumber: isUrgCustomer ? "URD" : (newCustomer.gstNumber ? newCustomer.gstNumber.trim().toUpperCase() : "URD"),
              creditTerm: Number(newCustomer.creditTerm || 0),
              creditLimit: Number(newCustomer.creditLimit || 0),
              customerId: outletUser._id.toString()
            });
            console.log(`[Email Dispatcher] Manual outlet welcome email result for ${o.contactEmail}:`, outMailRes);
          } catch (emailErr) {
            console.error(`[Email Dispatcher] Failed to send welcome email to manual outlet ${o.contactEmail}:`, emailErr);
          }
        }
      }
    }

    // Sync Customer Ledger to Tally Prime 9
    const tallyUrl = process.env.TALLY_URL || 'https://yummy-freebee-circular.ngrok-free.dev';
    let tallyCustomerSynced = false;
    let tallyCustomerError = null;

    try {
      const xmlPayload = buildCustomerXML(newCustomer);
      console.log(`[Tally Sync] Sending POST to Tally at URL: ${tallyUrl}`);
      console.log(`[Tally Sync] Generated XML Payload:\n${xmlPayload}`);

      const tallyResponse = await fetch(tallyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml',
          'ngrok-skip-browser-warning': 'true'
        },
        body: xmlPayload
      });

      console.log(`[Tally Sync] Received response from Tally. Status: ${tallyResponse.status} ${tallyResponse.statusText}`);

      if (tallyResponse.ok) {
        const responseText = await tallyResponse.text();
        console.log(`[Tally Sync] Raw Tally Response Text:\n${responseText}`);

        const parsed = parseTallyResponse(responseText);
        console.log(`[Tally Sync] Parsed Response Success:`, parsed.success);

        if (parsed.success) {
          tallyCustomerSynced = true;
          console.log(`[Tally Sync] Customer synced successfully to Tally.`);
          
          // Fetch the generated GUID from Tally and store it
          try {
            const guidPayload = `<ENVELOPE>
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
                    <SVCURRENTCOMPANY>${escapeXML(process.env.TALLY_SALES_COMPANY || 'Unifoods')}</SVCURRENTCOMPANY>
                  </STATICVARIABLES>
                  <TDL>
                    <TDLMESSAGE>
                      <COLLECTION NAME="LedgerCollection">
                        <TYPE>Ledger</TYPE>
                        <FETCH>GUID</FETCH>
                        <FILTER>NameFilter</FILTER>
                      </COLLECTION>
                      <SYSTEM TYPE="Formulae" NAME="NameFilter">
                        $_Id = "${escapeXML(newCustomer._id.toString())}"
                      </SYSTEM>
                    </TDLMESSAGE>
                  </TDL>
                </DESC>
              </BODY>
            </ENVELOPE>`;
            
            const guidResponse = await fetch(tallyUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'text/xml' },
              body: guidPayload
            });
            
            if (guidResponse.ok) {
              const guidXml = await guidResponse.text();
              const guidMatch = guidXml.match(/<GUID>([^<]+)<\/GUID>/);
              if (guidMatch && guidMatch[1]) {
                newCustomer.tallyId = guidMatch[1];
                await newCustomer.save();
                console.log(`[Tally Sync] Fetched and stored Tally GUID: ${newCustomer.tallyId}`);
              }
            }
          } catch (guidErr) {
            console.error(`[Tally Sync] Failed to fetch GUID for customer:`, guidErr);
          }
        } else {
          tallyCustomerError = parsed.error;
          console.error(`[Tally Sync] Tally error syncing customer:`, parsed.error);
        }
      } else {
        tallyCustomerError = `Tally server responded with status ${tallyResponse.status}`;
        console.error(`[Tally Sync] Tally server responded with status ${tallyResponse.status}`);
      }
    } catch (err) {
      tallyCustomerError = err.message || String(err);
      console.error(`[Tally Sync] Exception syncing customer:`, err);
    }

    return NextResponse.json({
      success: true,
      message: "Customer created successfully",
      data: newCustomer,
      tallyCustomerSynced,
      tallyCustomerError
    });
  } catch (err) {
    console.error("❌ ERROR in /api/customers/create:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Server error" },
      { status: 500 }
    );
  }
}
